'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, embeddingResponse, errorResponse } = require('./helpers/mock-server');
const { getChunkEmbeddings } = require('../lib/generate-embeddings');

describe('getChunkEmbeddings', () => {
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

    it('returns embedding data for a text chunk', async () => {
        const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
        mock.setHandler(() => embeddingResponse(embedding));

        const result = await getChunkEmbeddings('Hello world', 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.chunk, 'Hello world');
        assert.deepEqual(result.embedding, embedding);
        assert.equal(typeof result._time, 'number');
        assert.ok(result._time >= 0);
    });

    it('sends correct request to embeddings endpoint', async () => {
        mock.setHandler(() => embeddingResponse());

        await getChunkEmbeddings('Test chunk', 'my-api-key', {
            baseApiUrl: mock.url,
            gptModel: 'text-embedding-3-small',
            user: 'user123'
        });

        const req = mock.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/embeddings');
        assert.ok(req.headers.authorization.includes('Bearer my-api-key'));
        assert.equal(req.body.model, 'text-embedding-3-small');
        assert.equal(req.body.input, 'Test chunk');
        assert.equal(req.body.user, 'user123');
    });

    it('defaults to text-embedding-ada-002 model', async () => {
        mock.setHandler(() => embeddingResponse());

        await getChunkEmbeddings('Test', 'test-token', { baseApiUrl: mock.url });

        assert.equal(mock.requests[0].body.model, 'text-embedding-ada-002');
    });

    it('retries on 429 rate limit', { timeout: 10000 }, async () => {
        let callCount = 0;
        mock.setHandler(() => {
            callCount++;
            if (callCount === 1) {
                return errorResponse(429, 'Rate limited');
            }
            return embeddingResponse([0.1, 0.2]);
        });

        const result = await getChunkEmbeddings('Test', 'test-token', { baseApiUrl: mock.url });

        assert.deepEqual(result.embedding, [0.1, 0.2]);
        assert.equal(callCount, 2);
    });

    it('throws on API errors', async () => {
        mock.setHandler(() => errorResponse(401, 'Unauthorized', 'invalid_api_key'));

        await assert.rejects(
            () => getChunkEmbeddings('Test', 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.equal(err.message, 'Unauthorized');
                assert.equal(err.code, 'invalid_api_key');
                assert.equal(err.statusCode, 401);
                return true;
            }
        );
    });

    it('throws generic error on failure without error details', async () => {
        mock.setHandler(() => ({ status: 500, body: {} }));

        await assert.rejects(
            () => getChunkEmbeddings('Test', 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.equal(err.message, 'Failed to run API request');
                assert.equal(err.statusCode, 500);
                return true;
            }
        );
    });
});
