'use strict';

const OPENAI_API_BASE_URL = 'https://api.openai.com';

/**
 * Resolves a request URL against a custom API base URL, keeping any path prefix
 * of the base URL intact. This is what makes OpenAI-compatible services that
 * mount the API under a path work, e.g. Azure OpenAI
 * (https://resource.openai.azure.com/openai/v1) or a local Ollama server
 * (http://127.0.0.1:11434/v1).
 *
 * If the base URL path already ends with "/v1" and the request path starts with
 * "/v1", the duplicate segment is dropped, so both "https://api.example.com"
 * and "https://api.example.com/v1" style base URLs resolve to the same request
 * URL.
 *
 * @param {string} [baseApiUrl] - Base API URL (default: OpenAI API)
 * @param {string} [path] - Request path, e.g. "/v1/chat/completions"
 * @returns {string} Absolute request URL
 */
function getApiUrl(baseApiUrl, path) {
    let url = new URL(baseApiUrl || OPENAI_API_BASE_URL);

    let basePath = url.pathname.replace(/\/+$/, '');
    let requestPath = path || '/';

    if (/\/v1$/.test(basePath) && /^\/v1(?=\/|$)/.test(requestPath)) {
        requestPath = requestPath.slice('/v1'.length) || '/';
    }

    url.pathname = basePath + requestPath;

    return url.href;
}

module.exports = { getApiUrl, OPENAI_API_BASE_URL };
