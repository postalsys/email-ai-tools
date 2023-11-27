'use strict';

const packageData = require('../package.json');
const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });
const util = require('util');
const crypto = require('crypto');

const OPENAI_API_BASE_URL = 'https://api.openai.com';
const OPENAI_API_MODELS = '/v1/models';

function getApiUrl(baseApiUrl, path) {
    let url = new URL(path || '/', baseApiUrl || OPENAI_API_BASE_URL);
    return url.href;
}

async function listModels(apiToken, opts) {
    opts = opts || {};

    let baseApiUrl = opts.baseApiUrl || OPENAI_API_BASE_URL;

    let openAiAPIURL = getApiUrl(baseApiUrl, OPENAI_API_MODELS);

    let headers = {
        'User-Agent': `${packageData.name}/${packageData.version}`,
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
    };

    const requestId = crypto.randomBytes(8).toString('base64');

    let res;
    let data;
    let retries = 0;

    if (opts.verbose) {
        console.error(util.inspect({ requestId, apiUrl: openAiAPIURL }, false, 8, true));
    }

    let run = async () => {
        res = await fetchCmd(openAiAPIURL, {
            method: 'get',
            headers,
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

    const response = { models: [].concat((data && data.data) || []).filter(entry => !['openai-dev'].includes(entry.owned_by)) };

    if (opts.verbose) {
        response._time = reqEndTime - reqStartTime;

        console.error(util.inspect({ requestId, response }, false, 8, true));
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
            .replace(/^(gpt|tts)\s/gi, (o, n) => `${n.toUpperCase()}-`);
    });

    return response;
}

module.exports = { listModels };
