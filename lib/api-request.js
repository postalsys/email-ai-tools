'use strict';

const { fetch: fetchCmd, Agent } = require('undici');
const { setTimeout: delay } = require('timers/promises');
const crypto = require('crypto');
const util = require('util');
const packageData = require('../package.json');

const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;
// A 429 asking for a longer pause than this fails right away instead of holding the caller
const MAX_RETRY_DELAY_MS = 20 * 1000;
// Large enough for a batch of 3072-dimension embeddings, small enough to not buffer anything
const MAX_RESPONSE_SIZE = 8 * 1024 * 1024;
const RESPONSE_SNIPPET_LENGTH = 512;

async function sleep(ms, signal) {
    try {
        await delay(ms, undefined, { signal });
    } catch (err) {
        // report the caller's own abort reason, not the generic AbortError of the timer
        if (err.name === 'AbortError' && signal && signal.aborted) {
            throw signal.reason;
        }
        throw err;
    }
}

// Returns the requested delay in milliseconds, or null if the response does not name one
function getRetryAfter(headers) {
    // Azure OpenAI sends the millisecond variant
    const retryAfterMs = (headers.get('retry-after-ms') || '').trim();
    if (/^\d+(\.\d+)?$/.test(retryAfterMs)) {
        return Number(retryAfterMs);
    }

    const retryAfter = (headers.get('retry-after') || '').trim();
    if (!retryAfter) {
        return null;
    }
    if (/^\d+(\.\d+)?$/.test(retryAfter)) {
        return Number(retryAfter) * 1000;
    }
    const date = Date.parse(retryAfter);
    if (!isNaN(date)) {
        return Math.max(date - Date.now(), 0);
    }
    return null;
}

async function readBody(res, maxSize) {
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxSize) {
        await res.body?.cancel().catch(() => false);
        throw responseTooLarge(res, maxSize);
    }

    const chunks = [];
    let size = 0;
    if (res.body) {
        for await (const chunk of res.body) {
            size += chunk.length;
            if (size > maxSize) {
                // leaving the loop cancels the stream
                throw responseTooLarge(res, maxSize);
            }
            chunks.push(chunk);
        }
    }
    return Buffer.concat(chunks).toString('utf-8');
}

function responseTooLarge(res, maxSize) {
    const error = new Error(`API response exceeds the maximum allowed size of ${maxSize} bytes`);
    error.code = 'ResponseTooLarge';
    error.statusCode = res.status;
    return error;
}

function errorMessage(apiError) {
    if (typeof apiError === 'string') {
        return apiError;
    }
    if (apiError && typeof apiError.message === 'string' && apiError.message) {
        return apiError.message;
    }
    try {
        return JSON.stringify(apiError);
    } catch {
        return 'Failed to run API request';
    }
}

/**
 * Sends a request to an OpenAI-compatible API and returns the parsed JSON response body
 *
 * @param {string} url - Request URL
 * @param {Object} opts
 * @param {string} [opts.method='post']
 * @param {string} opts.apiToken - Sent as a Bearer token
 * @param {Object} [opts.payload] - JSON request body
 * @param {Object} [opts.dispatcher] - undici Dispatcher, the module's own agent when omitted
 * @param {AbortSignal} [opts.signal] - Aborts the request and any retry wait
 * @param {boolean} [opts.verbose] - Logs the request and the response to stderr
 * @returns {Promise<{data: Object, time: number}>} Parsed response body and the time the request took in milliseconds
 */
async function apiRequest(url, opts) {
    const { method, apiToken, payload, dispatcher, signal, verbose } = opts;

    const headers = {
        'User-Agent': `${packageData.name}/${packageData.version}`,
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
    };

    const requestId = crypto.randomBytes(8).toString('base64');
    if (verbose) {
        console.error(util.inspect({ requestId, apiUrl: url, payload }, false, 8, true));
    }

    const startTime = Date.now();

    for (let attempt = 1; ; attempt++) {
        const res = await fetchCmd(url, {
            method: method || 'post',
            headers,
            body: payload ? JSON.stringify(payload) : undefined,
            dispatcher: dispatcher || fetchAgent,
            signal
        });

        const text = await readBody(res, MAX_RESPONSE_SIZE);

        let data = null;
        try {
            data = JSON.parse(text);
        } catch {
            // handled below, an HTML error page from a proxy is the usual case
        }

        if (!res.ok) {
            const retryAfter = res.status === 429 ? getRetryAfter(res.headers) : null;

            if (res.status === 429 && attempt < MAX_RETRIES) {
                const wait = retryAfter !== null ? retryAfter : RETRY_DELAY_MS * 2 ** (attempt - 1);
                if (wait <= MAX_RETRY_DELAY_MS) {
                    await sleep(wait, signal);
                    continue;
                }
            }

            let error;
            if (data && data.error) {
                error = new Error(errorMessage(data.error));
                if (data.error.code) {
                    error.code = data.error.code;
                }
            } else {
                error = new Error('Failed to run API request');
            }
            error.statusCode = res.status;

            if (retryAfter !== null) {
                error.retryAfter = Math.ceil(retryAfter / 1000);
            }

            if (!data && text) {
                error.responseText = text.substring(0, RESPONSE_SNIPPET_LENGTH);
            }
            throw error;
        }

        if (!data) {
            // not JSON at all, or a JSON null
            const error = new Error('Invalid JSON in API response');
            error.code = 'InvalidResponse';
            error.statusCode = res.status;
            error.responseText = text.substring(0, RESPONSE_SNIPPET_LENGTH);
            throw error;
        }

        const time = Date.now() - startTime;

        if (verbose) {
            console.error(util.inspect({ requestId, output: data }, false, 8, true));
        }

        return { data, time };
    }
}

module.exports = { apiRequest, MAX_RESPONSE_SIZE };
