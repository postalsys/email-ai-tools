'use strict';

const { apiRequest } = require('./api-request');

const { getApiUrl, OPENAI_API_BASE_URL } = require('./get-api-url');

const OPENAI_API_MODELS = '/v1/models';
const OPENAI_API_HOST = new URL(OPENAI_API_BASE_URL).hostname;

// On OpenAI's own endpoint the names are known, and these are not chat models: embeddings,
// speech, images, video, moderation, the legacy completion models, and the chat models that are
// specialised for something else
const OPENAI_NON_CHAT_MODEL =
    /embedding|tts|whisper|transcribe|dall-e|image|realtime|^gpt-live|audio|moderation|babbage|davinci|sora|instruct|codex|search|computer-use|cyber|daybreak|rosalind/i;

// Elsewhere the names are whatever the operator pulled ("Llama-3.1-8B-Instruct" is a chat model
// there), so only the unmistakable ones are left out
const GENERIC_NON_CHAT_MODEL = /embed|whisper|tts|rerank/i;

const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{4,}$/;

// What a model is good for, by family, for a picker that shows more than a name. Recommended
// marks the ones that suit email triage: capable enough for it and cheap enough to run on every
// message. Prices change, so the notes stay qualitative
const MODEL_NOTES = [
    [/^gpt-6-luna/, 'Fast and inexpensive, built for high-volume work like this', true],
    [/^gpt-6(?:\.\d+)?-sol/, 'Mid-priced reasoning model', true],
    [/^gpt-6-astra/, 'Most capable and most expensive', false],
    [/^gpt-5\.6-luna/, 'Inexpensive, previous generation', true],
    [/^gpt-5\.6-terra/, 'Mid-priced, previous generation', false],
    [/^gpt-5\.6-sol/, 'Expensive, previous generation', false],
    [/-nano/, 'Smallest and cheapest of its generation', true],
    [/-mini/, 'Small and inexpensive', true],
    [/-pro/, 'Premium reasoning, very expensive', false],
    [/^gpt-5(?:\.\d+)?$/, 'Full-size reasoning model of its generation', false],
    [/^gpt-4\.1|^gpt-4o/, 'Previous generation without reasoning', false],
    [/^o\d/, 'Earlier reasoning series', false],
    [/chat/, 'Conversational model, not a reasoning model', false],
    [/^gpt-oss/, 'Open-weight reasoning model', false]
];

/**
 * A short note on a model and whether it suits email triage
 *
 * @param {string} id - Model name
 * @returns {{description: string, recommended: boolean}} An empty description for a name nothing is known about
 */
function describeModel(id) {
    id = String(id ?? '');
    const dated = DATED_SNAPSHOT.test(id);
    for (const [pattern, description, recommended] of MODEL_NOTES) {
        if (pattern.test(id)) {
            return { description: dated ? `${description}, pinned snapshot` : description, recommended: recommended && !dated };
        }
    }
    return { description: dated ? 'Pinned snapshot' : '', recommended: false };
}

const collator = new Intl.Collator('en', { numeric: true });

/**
 * The pattern of model names listModels() leaves out for an endpoint
 *
 * @param {string} [baseApiUrl] - Base API URL (default: OpenAI API)
 * @returns {RegExp}
 */
function isOpenAiEndpoint(baseApiUrl) {
    return new URL(baseApiUrl || OPENAI_API_BASE_URL).hostname === OPENAI_API_HOST;
}

function nonChatModelPattern(baseApiUrl) {
    return isOpenAiEndpoint(baseApiUrl) ? OPENAI_NON_CHAT_MODEL : GENERIC_NON_CHAT_MODEL;
}

// Sort key: GPT families first, newest first, then the o-series, then everything else; within a
// family the plain name before dated snapshots and previews
function decorate(entry) {
    const match = /^(gpt-|o)(\d+(?:\.\d+)?)/i.exec(entry.id);
    return {
        entry,
        group: match ? (match[1].toLowerCase() === 'o' ? 1 : 0) : 2,
        version: match ? parseFloat(match[2]) : 0,
        dated: DATED_SNAPSHOT.test(entry.id),
        preview: /preview/i.test(entry.id)
    };
}

function compare(a, b) {
    return a.group - b.group || b.version - a.version || a.dated - b.dated || a.preview - b.preview || collator.compare(a.entry.id, b.entry.id);
}

function formatName(id) {
    return id
        .replace(/-/g, ' ')
        .replace(/^.| ./g, c => c.toUpperCase())
        .replace(/\bhd\b/gi, c => c.toUpperCase())
        .replace(/\b\d+k\b/gi, c => c.toUpperCase())
        .replace(/Dall E/g, 'Dall-E')
        .replace(/^Whisper /g, 'Whisper-')
        .replace(/(\d{4}) (\d{2}) (\d{2})/g, (o, y, m, d) => `${y}-${m}-${d}`)
        .replace(/^(gpt|tts)\s/gi, (o, n) => `${n.toUpperCase()}-`);
}

/**
 * Lists the models the API endpoint serves, newest family first, with a display name for each
 *
 * @param {string} apiToken - API authentication token
 * @param {Object} [opts]
 * @param {string} [opts.baseApiUrl] - Custom API base URL (default: OpenAI API)
 * @param {boolean} [opts.chatOnly=true] - Leave out models that are not chat models
 * @param {boolean} [opts.verbose] - Log the request and include the request time
 * @param {Object} [opts.dispatcher] - undici Dispatcher the request is sent through
 * @param {AbortSignal} [opts.signal] - Aborts the request
 * @returns {Promise<{models: Array<{id: string, name: string, description: string, recommended: boolean}>}>}
 */
async function listModels(apiToken, opts) {
    opts = opts || {};

    const baseApiUrl = opts.baseApiUrl || OPENAI_API_BASE_URL;

    const { data, time } = await apiRequest(getApiUrl(baseApiUrl, OPENAI_API_MODELS), {
        method: 'get',
        apiToken,
        dispatcher: opts.dispatcher,
        signal: opts.signal,
        verbose: opts.verbose
    });

    const nonChat = nonChatModelPattern(baseApiUrl);
    // the notes are about OpenAI's names; another endpoint's "mini" is whatever its operator pulled
    const describe = isOpenAiEndpoint(baseApiUrl) ? describeModel : () => ({ description: '', recommended: false });

    const response = {
        models: []
            .concat((data && data.data) || [])
            .filter(
                entry =>
                    entry && typeof entry.id === 'string' && entry.id && entry.owned_by !== 'openai-dev' && (opts.chatOnly === false || !nonChat.test(entry.id))
            )
            .map(decorate)
            .sort(compare)
            .map(({ entry }) => Object.assign(entry, { name: formatName(entry.id) }, describe(entry.id)))
    };

    if (opts.verbose) {
        response._time = time;
    }

    return response;
}

module.exports = { listModels, describeModel, nonChatModelPattern };
