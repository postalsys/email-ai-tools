'use strict';

const packageData = require('../package.json');
const libmime = require('libmime');
const addressparser = require('nodemailer/lib/addressparser');
const { htmlToText } = require('@postalsys/email-text-tools');
const punycode = require('punycode/');
const { default: GPT3Tokenizer } = require('gpt3-tokenizer');
const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });
const util = require('util');

const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });

const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';

class Embedder {
    constructor(message, apiToken, opts) {
        this.message = message;
        this.apiToken = apiToken;

        opts = opts || {};
        this.chunkSize = opts.chunkSize || 600;
        this.gptModel = opts.gptModel || 'text-embedding-ada-002';

        this.addressHeaders = new Map();

        let subject;

        for (const { key: headerKey, value } of message.headers || []) {
            switch (headerKey) {
                case 'from':
                case 'to':
                case 'cc':
                case 'bcc':
                    {
                        //  join to, cc, and bcc entries
                        let key = headerKey === 'from' ? headerKey : 'to';

                        let addressList;

                        if (this.addressHeaders.has(key)) {
                            addressList = this.addressHeaders.get(key);
                        } else {
                            addressList = [];
                            this.addressHeaders.set(key, addressList);
                        }

                        addressList.push(...this.formatAddresses(addressparser(value, { flatten: true })));
                    }
                    break;
                case 'subject': {
                    subject = (value || '').toString().trim();
                    try {
                        subject = libmime.decodeWords(subject);
                    } catch (err) {
                        // ignore?
                    }
                    if (subject) {
                        this.subject = subject;
                    }
                }
            }
        }

        for (let key of ['from', 'to']) {
            if (this.addressHeaders.has(key)) {
                const addressList = this.addressHeaders.get(key);
                if (!addressList || !addressList.length) {
                    this.addressHeaders.delete(key);
                    continue;
                }
                this.addressHeaders.set(key, this.getAddressString(addressList));
            }
        }

        let text = (message.text || '').toString().trim();
        if (message.html && (!text || message.html.length >= text.length)) {
            text = (htmlToText(message.html) || '').trim();
        }

        this.text = text;

        this.remainingText = text;
    }

    formatAddresses(addresses) {
        let result = [];
        for (let address of [].concat(addresses || [])) {
            if (address.group) {
                result = result.concat(this.formatAddresses(address.group));
            } else {
                let name = address.name || '';
                let addr = address.address || '';
                try {
                    name = libmime.decodeWords(name);
                } catch (err) {
                    // ignore?
                }

                if (/@xn--/.test(addr)) {
                    addr = addr.substr(0, addr.lastIndexOf('@') + 1) + punycode.toUnicode(addr.substr(addr.lastIndexOf('@') + 1));
                }

                result.push({ name, address: addr });
            }
        }
        return result;
    }

    getAddressString(addresses) {
        return []
            .concat(addresses)
            .map(address => {
                let res = [];
                if (address.name) {
                    res.push(address.name);
                }
                if (address.address) {
                    res.push(`<${address.address}>`);
                }
                return res.join(' ');
            })
            .filter(val => val)
            .join(' ; ');
    }

    getChunks() {
        let headerLines = [];
        for (let [key, value] of this.addressHeaders.entries()) {
            headerLines.push(`${key}: ${value.replace(/\s/g, ' ')}`);
        }
        if (this.subject) {
            headerLines.push(`subject: ${this.subject}`);
        }

        if (this.message.attachments?.length) {
            let attachments = this.message.attachments.map(attachment => attachment.filename?.replace(/\s/g, ' ').trim()).filter(val => val);
            if (attachments.length) {
                headerLines.push(`attachments: ${attachments.join(' ; ')}`);
            }
        }

        let prompt = `${headerLines.join('\n')}\n\n`;

        let prefixTokens = tokenizer.encode(prompt);
        // If prefix is very large, then use larger chunks, so that each chunk contains at least 200 tokens of text
        let allowedTokens = Math.max(prefixTokens.text.length + 200, this.chunkSize);

        let textTokensChunkSize = allowedTokens - prefixTokens.text.length;

        let textChunks = [];
        if (this.text) {
            let textTokens = tokenizer.encode(this.text.replace(/[\r\n]+/g, '\n'));

            let pos = 0;
            while (pos < textTokens.bpe.length) {
                textChunks.push(tokenizer.decode(textTokens.bpe.slice(pos, pos + textTokensChunkSize)));
                pos += textTokensChunkSize;
            }
        } else {
            textChunks.push('');
        }

        return textChunks.map(value => `${prompt}${value}`);
    }

    async getChunkEmbeddings(chunk) {
        let headers = {
            'User-Agent': `${packageData.name}/${packageData.version}`,
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json'
        };

        let payload = {
            model: this.gptModel,
            input: chunk
        };

        let res;
        let data;
        let retries = 0;

        if (this.verbose) {
            console.log(util.inspect(payload, false, 5, true));
        }

        let run = async () => {
            res = await fetchCmd(OPENAI_API_URL, {
                method: 'post',
                headers,
                body: JSON.stringify(payload),
                dispatcher: fetchAgent
            });

            data = await res.json();
            if (!res.ok) {
                if (res.status === 429 && ++retries < 5) {
                    // try again
                    await new Promise(r => setTimeout(r, 1000));
                    return await run();
                }

                if (data && data.error) {
                    let error = new Error(data.error.message || data.error);
                    if (data.error.code) {
                        error.code = data.error.code;
                    }

                    error.statusCode = res.status;
                    throw error;
                }

                let error = new Error('Failed to run API request');
                error.statusCode = res.status;
                throw error;
            }

            if (!data) {
                throw new Error(`Failed to POST API request`);
            }
        };

        const reqStartTime = Date.now();
        await run();
        const reqEndTime = Date.now();

        let embedding = data?.data?.[0]?.embedding;
        return {
            chunk,
            embedding,
            _time: reqEndTime - reqStartTime
        };
    }

    async getEmbeddings() {
        let chunks = this.getChunks();

        let result = [];

        for (let chunk of chunks) {
            result.push(await this.getChunkEmbeddings(chunk));
        }

        return result;
    }
}

module.exports.generateEmbeddings = async (message, apiToken) => {
    let embedder = new Embedder(message, apiToken);
    return embedder.getEmbeddings();
};
