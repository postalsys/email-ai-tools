import { fetch as fetchCmd, Agent } from 'undici';
import type { Dispatcher, Response } from 'undici';
import timers from 'node:timers/promises';
import crypto from 'node:crypto';
import util from 'node:util';
import { name as packageName, version as packageVersion } from '../package-info.js';

/** An error from apiRequest(), with what the API said about it */
export interface ApiRequestError extends Error {
    code?: string;
    statusCode?: number;
    /** Which request parameter a 400 is about, when the API says */
    param?: string;
    type?: string;
    /** Seconds the API asked to wait, from a 429 */
    retryAfter?: number;
    /** The start of a response that was not JSON */
    responseText?: string;
}

export interface ApiRequestOptions {
    /** Default 'post' */
    method?: string | undefined;
    /** Sent as a Bearer token */
    apiToken: string;
    /** JSON request body */
    payload?: unknown;
    /** undici Dispatcher, the module's own agent when omitted */
    dispatcher?: Dispatcher | undefined;
    /** Aborts the request and any retry wait; without one the call is given `timeout` in all */
    signal?: AbortSignal | undefined;
    /** Deadline in milliseconds for the whole call when no signal is given (default DEFAULT_TIMEOUT) */
    timeout?: number | undefined;
    /** Logs the request and the response to stderr */
    verbose?: boolean | undefined;
}

const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });

// How long one call may take in all, retries included, when the caller sets no deadline of its
// own. undici bounds each phase of a request but nothing bounds the sum, and a chat completion
// waits for its headers until the answer is complete
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;
// A 429 asking for a longer pause than this fails right away instead of holding the caller
const MAX_RETRY_DELAY_MS = 20 * 1000;
// Large enough for a batch of 3072-dimension embeddings, small enough to not buffer anything
const MAX_RESPONSE_SIZE = 8 * 1024 * 1024;
const RESPONSE_SNIPPET_LENGTH = 512;

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    try {
        await timers.setTimeout(ms, undefined, { signal });
    } catch (err) {
        // report the caller's own abort reason, not the generic AbortError of the timer
        if ((err as Error).name === 'AbortError' && signal && signal.aborted) {
            throw signal.reason;
        }
        throw err;
    }
}

// Returns the requested delay in milliseconds, or null if the response does not name one
function getRetryAfter(headers: Response['headers']): number | null {
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

async function readBody(res: Response, maxSize: number): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxSize) {
        await res.body?.cancel().catch(() => false);
        throw responseTooLarge(res, maxSize);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
        for await (const chunk of res.body) {
            size += chunk.length;
            if (size > maxSize) {
                // leaving the loop cancels the stream
                throw responseTooLarge(res, maxSize);
            }
            chunks.push(chunk as Buffer);
        }
    }
    return Buffer.concat(chunks).toString('utf-8');
}

function responseTooLarge(res: Response, maxSize: number): ApiRequestError {
    const error: ApiRequestError = new Error(`API response exceeds the maximum allowed size of ${maxSize} bytes`);
    error.code = 'ResponseTooLarge';
    error.statusCode = res.status;
    return error;
}

function errorMessage(apiError: any): string {
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
 * @param url - Request URL
 * @returns Parsed response body and the time the request took in milliseconds
 */
async function apiRequest(url: string, opts: ApiRequestOptions): Promise<{ data: any; time: number }> {
    const { method, apiToken, payload, dispatcher, verbose } = opts;
    const signal = opts.signal || AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT);

    const headers = {
        'User-Agent': `${packageName}/${packageVersion}`,
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
            body: payload ? JSON.stringify(payload) : null,
            dispatcher: dispatcher || fetchAgent,
            signal
        });

        const text = await readBody(res, MAX_RESPONSE_SIZE);

        let data: any = null;
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

            let error: ApiRequestError;
            if (data && data.error) {
                error = new Error(errorMessage(data.error));
                if (data.error.code) {
                    error.code = data.error.code;
                }
                // which request parameter a 400 is about, when the API says
                if (typeof data.error.param === 'string' && data.error.param) {
                    error.param = data.error.param;
                }
                if (typeof data.error.type === 'string' && data.error.type) {
                    error.type = data.error.type;
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
            const error: ApiRequestError = new Error('Invalid JSON in API response');
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

export { apiRequest, MAX_RESPONSE_SIZE, DEFAULT_TIMEOUT };
