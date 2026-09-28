'use strict';

const { apiRequest } = require('./api-request');

const { getApiUrl, OPENAI_API_BASE_URL } = require('./get-api-url');

const OPENAI_API_MODELS = '/v1/models';

async function listModels(apiToken, opts) {
    opts = opts || {};

    let baseApiUrl = opts.baseApiUrl || OPENAI_API_BASE_URL;

    let openAiAPIURL = getApiUrl(baseApiUrl, OPENAI_API_MODELS);

    const { data, time } = await apiRequest(openAiAPIURL, {
        method: 'get',
        apiToken,
        dispatcher: opts.dispatcher,
        signal: opts.signal,
        verbose: opts.verbose
    });

    const response = { models: [].concat((data && data.data) || []).filter(entry => !['openai-dev'].includes(entry.owned_by)) };

    if (opts.verbose) {
        response._time = time;
    }

    response.models.sort((a, b) => {
        if (/^gpt/.test(a.id) && !/^gpt/.test(b.id)) {
            return -1;
        }

        if (/^gpt/.test(b.id) && !/^gpt/.test(a.id)) {
            return 1;
        }

        if (/-\d{4,}$/.test(b.id) && !/-\d{4,}$/.test(a.id)) {
            return -1;
        }

        if (/-\d{4,}$/.test(a.id) && !/-\d{4,}$/.test(b.id)) {
            return 1;
        }

        if (/-preview/.test(b.id) && !/-preview/.test(a.id)) {
            return -1;
        }

        if (/-preview/.test(a.id) && !/-preview/.test(b.id)) {
            return 1;
        }

        return a.id.localeCompare(b.id);
    });

    response.models.forEach(entry => {
        entry.name = entry.id
            .replace(/-/g, ' ')
            .replace(/^.| ./g, c => c.toUpperCase())
            .replace(/\bhd\b/gi, c => c.toUpperCase())
            .replace(/\b\d+k\b/gi, c => c.toUpperCase())
            .replace(/Dall E/g, 'Dall-E')
            .replace(/^Whisper /g, 'Whisper-')
            .replace(/(\d{4}) (\d{2}) (\d{2})/g, (o, y, m, d) => `${y}-${m}-${d}`)
            .replace(/^(gpt|tts)\s/gi, (o, n) => `${n.toUpperCase()}-`);
    });

    return response;
}

module.exports = { listModels };
