'use strict';

const packageData = require('../package.json');
const libmime = require('libmime');
const addressparser = require('nodemailer/lib/addressparser');
const { htmlToText } = require('@postalsys/email-text-tools');
const punycode = require('punycode.js');
const { default: GPT3Tokenizer } = require('gpt3-tokenizer');
const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });
const util = require('util');
const linkifyIt = require('linkify-it');
const tlds = require('tlds');
const crypto = require('crypto');

const linkify = linkifyIt()
    .tlds(tlds) // Reload with full tlds list
    .tlds('onion', true) // Add unofficial `.onion` domain
    .add('git:', 'http:') // Add `git:` protocol as "alias"
    .set({ fuzzyIP: true });

const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });

const OPENAI_API_BASE_URL = 'https://api.openai.com';

const OPENAI_API_URL = '/v1/embeddings';

function getApiUrl(baseApiUrl, path) {
    let url = new URL(path || '/', baseApiUrl || OPENAI_API_BASE_URL);
    return url.href;
}

async function getChunkEmbeddings(chunk, apiToken, opts) {
    let { gptModel, verbose, baseApiUrl } = opts || {};

    baseApiUrl = baseApiUrl || OPENAI_API_BASE_URL;

    gptModel = gptModel || 'text-embedding-ada-002';

    let headers = {
        'User-Agent': `${packageData.name}/${packageData.version}`,
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
    };

    let payload = {
        model: gptModel,
        input: chunk
    };

    if (opts.user) {
        payload.user = opts.user;
    }

    let requestId = crypto.randomBytes(8).toString('base64');

    let res;
    let data;
    let retries = 0;

    const openAiAPIURL = getApiUrl(baseApiUrl, OPENAI_API_URL);

    if (verbose) {
        console.error(util.inspect({ requestId, payload }, false, 8, true));
    }

    let run = async () => {
        res = await fetchCmd(openAiAPIURL, {
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

    if (opts.verbose) {
        console.error(util.inspect({ requestId, apiUrl: openAiAPIURL, output: data }, false, 8, true));
    }

    let embedding = data?.data?.[0]?.embedding;
    return {
        chunk,
        embedding,
        _time: reqEndTime - reqStartTime
    };
}

class Embedder {
    constructor(message, apiToken, opts) {
        this.message = message;
        this.apiToken = apiToken;

        opts = opts || {};
        this.chunkSize = opts.chunkSize || 400;
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
                    } catch {
                        // ignore?
                    }
                    if (subject) {
                        this.subject = subject;
                    }
                    break;
                }

                case 'date': {
                    let date;
                    try {
                        date = new Date((value || '').toString().trim());
                        if (date && date.toString() !== 'Invalid Date') {
                            this.date = date.toUTCString();
                        }
                    } catch {
                        // ignore?
                    }
                    break;
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

        // replace links

        this.text = this.prepareLinks(text);
    }

    prepareLinks(text) {
        try {
            let links = linkify.match(text);
            if (links && links.length) {
                let parts = [];
                let cursor = 0;
                for (let link of links) {
                    if (cursor < link.index) {
                        parts.push({
                            type: 'text',
                            content: text.substring(cursor, link.index)
                        });
                        cursor = link.index;
                    }
                    parts.push(Object.assign({ type: 'link' }, link));
                    cursor = link.lastIndex;
                }

                if (cursor < text.length) {
                    parts.push({
                        type: 'text',
                        content: text.substr(cursor)
                    });
                }

                return parts
                    .map(part => {
                        switch (part.type) {
                            case 'text': {
                                // normal text, escape HTML
                                return part.content;
                            }
                            case 'link':
                                // URL with html escaped text content and URL
                                try {
                                    const parsedUrl = new URL(part.url);
                                    return `${parsedUrl.protocol}//${parsedUrl.host}`;
                                } catch {
                                    return ' ';
                                }
                        }
                        return '';
                    })
                    .join('');
            }
        } catch {
            // ignore?
        }

        // No links or exception, so HTML escape everything
        return text;
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
                } catch {
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
        if (this.date) {
            headerLines.push(`date: ${this.date}`);
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
            let preparedText = this.text
                .replace(/\r?\n/g, '\n')
                .replace(/^\s*>.*$/gm, '')
                .replace(/^\s*>$/gm)
                .replace(/^\s+$/gm, '')
                .replace(/\n\n+/g, '\n\n');

            let textTokens = tokenizer.encode(preparedText);

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

    async getEmbeddings() {
        let chunks = this.getChunks();

        let embeddings = [];

        for (let chunk of chunks) {
            embeddings.push(
                await getChunkEmbeddings(chunk, this.apiToken, {
                    gptModel: this.gptModel,
                    verbose: this.verbose
                })
            );
        }

        return { model: this.gptModel, embeddings };
    }
}

module.exports.getChunkEmbeddings = getChunkEmbeddings;
module.exports.generateEmbeddings = async (message, apiToken) => {
    let embedder = new Embedder(message, apiToken);
    return await embedder.getEmbeddings();
};
