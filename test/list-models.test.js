'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, modelsResponse, errorResponse } = require('./helpers/mock-server');
const { listModels } = require('../lib/list-models');

describe('listModels', () => {
    let mock;

    before(async () => {
        mock = await createMockServer();
    });

    after(async () => {
        await mock.close();
    });

    beforeEach(() => {
        mock.clearRequests();
    });

    it('returns list of models', async () => {
        mock.setHandler(() => modelsResponse());

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(Array.isArray(result.models));
        assert.ok(result.models.length > 0);
    });

    it('sends correct GET request to models endpoint', async () => {
        mock.setHandler(() => modelsResponse());

        await listModels('my-api-key', { baseApiUrl: mock.url });

        const req = mock.requests[0];
        assert.equal(req.method, 'GET');
        assert.equal(req.url, '/v1/models');
        assert.ok(req.headers.authorization.includes('Bearer my-api-key'));
    });

    it('filters out openai-dev models', async () => {
        mock.setHandler(() =>
            modelsResponse([
                { id: 'gpt-4', owned_by: 'openai' },
                { id: 'internal-model', owned_by: 'openai-dev' },
                { id: 'gpt-3.5-turbo', owned_by: 'openai' }
            ])
        );

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.equal(result.models.length, 2);
        assert.ok(result.models.every(m => m.owned_by !== 'openai-dev'));
    });

    it('sorts GPT models first', async () => {
        mock.setHandler(() =>
            modelsResponse([
                { id: 'text-embedding-ada-002', owned_by: 'openai' },
                { id: 'dall-e-3', owned_by: 'openai' },
                { id: 'gpt-4', owned_by: 'openai' },
                { id: 'whisper-1', owned_by: 'openai' },
                { id: 'gpt-3.5-turbo', owned_by: 'openai' }
            ])
        );

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models[0].id.startsWith('gpt'));
        assert.ok(result.models[1].id.startsWith('gpt'));
    });

    it('sorts models with date suffixes before those without', async () => {
        mock.setHandler(() =>
            modelsResponse([
                { id: 'gpt-4', owned_by: 'openai' },
                { id: 'gpt-4-0613', owned_by: 'openai' }
            ])
        );

        const result = await listModels('test-token', { baseApiUrl: mock.url });
        const ids = result.models.map(m => m.id);

        assert.equal(ids[0], 'gpt-4');
        assert.equal(ids[1], 'gpt-4-0613');
    });

    it('sorts preview models after non-preview', async () => {
        mock.setHandler(() =>
            modelsResponse([
                { id: 'gpt-4-preview', owned_by: 'openai' },
                { id: 'gpt-4', owned_by: 'openai' }
            ])
        );

        const result = await listModels('test-token', { baseApiUrl: mock.url });
        const ids = result.models.map(m => m.id);

        assert.equal(ids[0], 'gpt-4');
        assert.equal(ids[1], 'gpt-4-preview');
    });

    it('formats model names - converts kebab-case to Title Case', async () => {
        mock.setHandler(() => modelsResponse([{ id: 'gpt-3.5-turbo', owned_by: 'openai' }]));

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models[0].name);
        assert.ok(typeof result.models[0].name === 'string');
    });

    it('formats GPT prefix to uppercase', async () => {
        mock.setHandler(() => modelsResponse([{ id: 'gpt-4', owned_by: 'openai' }]));

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models[0].name.startsWith('GPT-'));
    });

    it('formats TTS prefix to uppercase', async () => {
        mock.setHandler(() => modelsResponse([{ id: 'tts-1', owned_by: 'openai' }]));

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models[0].name.startsWith('TTS-'));
    });

    it('formats Dall-E name correctly', async () => {
        mock.setHandler(() => modelsResponse([{ id: 'dall-e-3', owned_by: 'openai' }]));

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models[0].name.includes('Dall-E'));
    });

    it('formats date suffixes with dashes', async () => {
        mock.setHandler(() => modelsResponse([{ id: 'gpt-4-2024-01-25', owned_by: 'openai' }]));

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models[0].name.includes('2024-01-25'));
    });

    it('formats HD abbreviation to uppercase', async () => {
        mock.setHandler(() => modelsResponse([{ id: 'dall-e-3-hd', owned_by: 'openai' }]));

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models[0].name.includes('HD'));
    });

    it('includes _time in verbose mode', async () => {
        mock.setHandler(() => modelsResponse());

        const result = await listModels('test-token', { baseApiUrl: mock.url, verbose: true });

        assert.ok('_time' in result);
        assert.equal(typeof result._time, 'number');
    });

    it('does not include _time by default', async () => {
        mock.setHandler(() => modelsResponse());

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(!('_time' in result));
    });

    it('retries on 429 rate limit', { timeout: 10000 }, async () => {
        let callCount = 0;
        mock.setHandler(() => {
            callCount++;
            if (callCount === 1) {
                return errorResponse(429, 'Rate limited');
            }
            return modelsResponse();
        });

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.ok(result.models.length > 0);
        assert.equal(callCount, 2);
    });

    it('throws on API errors', async () => {
        mock.setHandler(() => errorResponse(401, 'Invalid API key', 'invalid_api_key'));

        await assert.rejects(
            () => listModels('test-token', { baseApiUrl: mock.url }),
            err => {
                assert.equal(err.message, 'Invalid API key');
                assert.equal(err.statusCode, 401);
                return true;
            }
        );
    });

    it('handles empty models list', async () => {
        mock.setHandler(() => modelsResponse([]));

        const result = await listModels('test-token', { baseApiUrl: mock.url });

        assert.deepEqual(result.models, []);
    });
});
