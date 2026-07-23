'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getApiUrl, OPENAI_API_BASE_URL } = require('../lib/get-api-url');

describe('getApiUrl', () => {
    it('defaults to the OpenAI API base URL', () => {
        assert.equal(getApiUrl(null, '/v1/models'), 'https://api.openai.com/v1/models');
        assert.equal(getApiUrl('', '/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
        assert.equal(OPENAI_API_BASE_URL, 'https://api.openai.com');
    });

    it('resolves against a base URL without a path', () => {
        assert.equal(getApiUrl('https://api.example.com', '/v1/models'), 'https://api.example.com/v1/models');
    });

    it('keeps the path prefix of the base URL', () => {
        // Azure OpenAI style resource with the API mounted under a path
        assert.equal(getApiUrl('https://myres.openai.azure.com/openai/v1', '/v1/models'), 'https://myres.openai.azure.com/openai/v1/models');
        assert.equal(
            getApiUrl('https://myres.openai.azure.com/openai/v1', '/v1/chat/completions'),
            'https://myres.openai.azure.com/openai/v1/chat/completions'
        );
        assert.equal(getApiUrl('https://myres.openai.azure.com/openai', '/v1/embeddings'), 'https://myres.openai.azure.com/openai/v1/embeddings');
    });

    it('ignores a trailing slash on the base URL', () => {
        assert.equal(getApiUrl('https://api.example.com/', '/v1/models'), 'https://api.example.com/v1/models');
        assert.equal(getApiUrl('https://myres.openai.azure.com/openai/v1/', '/v1/models'), 'https://myres.openai.azure.com/openai/v1/models');
    });

    it('does not duplicate a /v1 suffix already present on the base URL', () => {
        assert.equal(getApiUrl('https://api.example.com/v1', '/v1/models'), 'https://api.example.com/v1/models');
        assert.equal(getApiUrl('http://127.0.0.1:11434/v1', '/v1/chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
        assert.equal(getApiUrl('https://openrouter.example.com/api/v1', '/v1/models'), 'https://openrouter.example.com/api/v1/models');
    });

    it('does not treat a /v1 mid-path segment as a version suffix', () => {
        assert.equal(getApiUrl('https://api.example.com/v1/proxy', '/v1/models'), 'https://api.example.com/v1/proxy/v1/models');
    });

    it('handles a missing request path', () => {
        assert.equal(getApiUrl('https://api.example.com'), 'https://api.example.com/');
        assert.equal(getApiUrl('https://api.example.com/v1'), 'https://api.example.com/v1/');
    });
});
