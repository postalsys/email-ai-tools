'use strict';

const libmime = require('libmime');
const addressparser = require('nodemailer/lib/addressparser');
const { htmlToText } = require('@postalsys/email-text-tools');
const punycode = require('punycode.js');
const { apiRequest } = require('./api-request');
const { estimateTokens, splitByTokens, keepSurrogatePair, CHUNK_ESTIMATE, MAX_ALLOWED_TEXT_LENGTH } = require('./token-estimate');
const linkifyIt = require('linkify-it');
const tlds = require('tlds');

const linkify = linkifyIt()
    .tlds(tlds) // Reload with full tlds list
    .tlds('onion', true) // Add unofficial `.onion` domain
    .add('git:', 'http:') // Add `git:` protocol as "alias"
    .set({ fuzzyIP: true });

const { getApiUrl, OPENAI_API_BASE_URL } = require('./get-api-url');

const OPENAI_API_URL = '/v1/embeddings';

// Chunks sent in one embeddings request. OpenAI accepts far more, but some compatible services
// (older Azure OpenAI deployments) cap the input array at 16.
const DEFAULT_CHUNKS_PER_REQUEST = 16;
const MAX_CHUNKS_PER_REQUEST = 64;

// Sends one embeddings request for a string or an array of strings. Resolves with the
// embeddings in input order and the request time. The response must carry exactly one entry per
// input, so a reply without a `data` array is rejected with InvalidResponse even for a single
// string input (it used to resolve with an undefined embedding).
async function requestEmbeddings(input, apiToken, opts) {
    opts = opts || {};

    const payload = {
        model: opts.gptModel || 'text-embedding-ada-002',
        input
    };

    if (opts.user) {
        payload.user = opts.user;
    }

    const { data, time } = await apiRequest(getApiUrl(opts.baseApiUrl || OPENAI_API_BASE_URL, OPENAI_API_URL), {
        apiToken,
        payload,
        dispatcher: opts.dispatcher,
        signal: opts.signal,
        verbose: opts.verbose
    });

    const inputCount = [].concat(input).length;
    const entries = Array.isArray(data.data) ? data.data.slice() : [];
    if (entries.length !== inputCount) {
        const error = new Error(`Embeddings response has ${entries.length} entries for ${inputCount} inputs`);
        error.code = 'InvalidResponse';
        throw error;
    }
    // entries carry their input position, do not rely on the array order
    entries.sort((a, b) => ((a && a.index) || 0) - ((b && b.index) || 0));

    return { vectors: entries.map(entry => entry && entry.embedding), time };
}

/**
 * Returns the embedding vector for a single chunk of text
 *
 * @throws {Error} InvalidResponse if the API reply does not carry exactly one embedding
 */
async function getChunkEmbeddings(chunk, apiToken, opts) {
    const {
        vectors: [embedding],
        time
    } = await requestEmbeddings(chunk, apiToken, opts);

    return {
        chunk,
        embedding,
        _time: time
    };
}

class Embedder {
    constructor(message, apiToken, opts) {
        this.message = message;
        this.apiToken = apiToken;

        opts = opts || {};
        this.chunkSize = opts.chunkSize || 400;
        this.gptModel = opts.gptModel || 'text-embedding-ada-002';
        this.maxTextLength = opts.maxTextLength || MAX_ALLOWED_TEXT_LENGTH;
        this.chunksPerRequest = Math.min(Math.max(Number(opts.chunksPerRequest) || DEFAULT_CHUNKS_PER_REQUEST, 1), MAX_CHUNKS_PER_REQUEST);
        this.signal = opts.signal;

        // Forwarded to every per-chunk embeddings request
        this.requestOpts = {
            gptModel: this.gptModel,
            baseApiUrl: opts.baseApiUrl,
            user: opts.user,
            dispatcher: opts.dispatcher,
            signal: opts.signal,
            verbose: opts.verbose
        };

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

        if (text.length > this.maxTextLength) {
            text = text.substring(0, keepSurrogatePair(text, this.maxTextLength));
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

        let prefixTokens = estimateTokens(prompt, CHUNK_ESTIMATE);
        // If prefix is very large, then use larger chunks, so that each chunk contains at least 200 tokens of text
        let allowedTokens = Math.max(prefixTokens + 200, this.chunkSize);

        let textTokensChunkSize = allowedTokens - prefixTokens;

        let textChunks = [];
        if (this.text) {
            let preparedText = this.text
                .replace(/\r?\n/g, '\n')
                .replace(/^\s*>.*$/gm, '')
                .replace(/^\s+$/gm, '')
                .replace(/\n\n+/g, '\n\n');

            textChunks = splitByTokens(preparedText, textTokensChunkSize);
        } else {
            textChunks.push('');
        }

        return textChunks.map(value => `${prompt}${value}`);
    }

    async getEmbeddings() {
        let chunks = this.getChunks();

        let embeddings = [];

        for (let i = 0; i < chunks.length; i += this.chunksPerRequest) {
            this.signal?.throwIfAborted();

            const batch = chunks.slice(i, i + this.chunksPerRequest);

            // a single chunk goes out as a plain string, as it always did
            const { vectors, time } = await requestEmbeddings(batch.length === 1 ? batch[0] : batch, this.apiToken, this.requestOpts);

            batch.forEach((chunk, j) => {
                embeddings.push({ chunk, embedding: vectors[j], _time: time });
            });
        }

        return { model: this.gptModel, embeddings };
    }
}

module.exports.getChunkEmbeddings = getChunkEmbeddings;
module.exports.generateEmbeddings = async (message, apiToken, opts) => {
    let embedder = new Embedder(message, apiToken, opts);
    return await embedder.getEmbeddings();
};
