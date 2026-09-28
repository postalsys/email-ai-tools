'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, embeddingResponse, errorResponse } = require('./helpers/mock-server');
const { getChunkEmbeddings, generateEmbeddings } = require('../lib/generate-embeddings');

// Answers a single or batched embeddings request with one vector per input
function batchEmbeddingResponse(body) {
    const inputs = [].concat(body.input);
    return {
        status: 200,
        body: {
            // reversed on purpose, entries carry their input position
            data: inputs.map((input, index) => ({ index, embedding: [index, input.length] })).reverse()
        }
    };
}

const cjkText = size => '\u6f22\u5b57\u4eee\u540d\u4e2d\u6587\u65e5\u672c\u8a9e\u6587\u5b57'.repeat(Math.ceil(size / 11)).substring(0, size);

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

    it('rejects a reply without embedding data instead of returning an undefined vector', async () => {
        mock.setHandler(() => ({ status: 200, body: { object: 'list' } }));

        await assert.rejects(() => getChunkEmbeddings('Test', 'test-token', { baseApiUrl: mock.url }), { code: 'InvalidResponse' });
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

describe('generateEmbeddings', () => {
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

    const headers = [
        { key: 'from', value: 'sender@example.com' },
        { key: 'subject', value: 'Hello' }
    ];

    it('sends a short message as a single string input', async () => {
        mock.setHandler((req, body) => batchEmbeddingResponse(body));

        const result = await generateEmbeddings({ headers, text: 'Short message' }, 'token', { baseApiUrl: mock.url });

        assert.equal(mock.requests.length, 1);
        assert.equal(typeof mock.requests[0].body.input, 'string');
        assert.equal(result.embeddings.length, 1);
        assert.ok(result.embeddings[0].chunk.endsWith('Short message'));
    });

    it('caps the input, batches chunks and never splits characters', { timeout: 5000 }, async () => {
        mock.setHandler((req, body) => batchEmbeddingResponse(body));

        const text = cjkText(1024 * 1024);
        const result = await generateEmbeddings({ headers, text }, 'token', { baseApiUrl: mock.url });

        const prefix = 'from: <sender@example.com>\nsubject: Hello\n\n';
        const chunks = result.embeddings.map(entry => entry.chunk);

        // capped at 64 KB instead of embedding the whole megabyte
        const joined = chunks.map(chunk => chunk.substring(prefix.length)).join('');
        assert.equal(joined, text.substring(0, 64 * 1024));

        for (const chunk of chunks) {
            assert.ok(chunk.startsWith(prefix));
            assert.ok(!chunk.includes('\ufffd'));
        }

        // one request per 16 chunks, not one per chunk
        assert.equal(mock.requests.length, Math.ceil(chunks.length / 16));
        assert.ok(Array.isArray(mock.requests[0].body.input));

        // every chunk gets the vector answered for its own position
        result.embeddings.forEach((entry, i) => {
            assert.deepEqual(entry.embedding, [i % 16, entry.chunk.length]);
        });
    });

    it('honours maxTextLength and chunksPerRequest', async () => {
        mock.setHandler((req, body) => batchEmbeddingResponse(body));

        const result = await generateEmbeddings({ headers, text: 'word '.repeat(10000) }, 'token', {
            baseApiUrl: mock.url,
            maxTextLength: 8000,
            chunksPerRequest: 2
        });

        assert.ok(result.embeddings.length > 2);
        assert.equal(mock.requests.length, Math.ceil(result.embeddings.length / 2));
        for (const entry of result.embeddings) {
            // chunks end at word boundaries
            assert.ok(/(word |word)$/.test(entry.chunk));
        }
    });

    it('caps the text without splitting a surrogate pair', async () => {
        mock.setHandler((req, body) => batchEmbeddingResponse(body));

        // the cap falls between the two halves of the emoji
        const result = await generateEmbeddings({ headers, text: 'a'.repeat(99) + '\ud83d\ude00' + 'b'.repeat(100) }, 'token', {
            baseApiUrl: mock.url,
            maxTextLength: 100
        });

        const sent = result.embeddings.map(entry => entry.chunk).join('');
        assert.ok(sent.endsWith('a'.repeat(99)), JSON.stringify(sent.slice(-5)));
    });

    it('stops sending requests once the signal is aborted', async () => {
        const controller = new AbortController();
        mock.setHandler((req, body) => {
            controller.abort(new Error('stopped'));
            return batchEmbeddingResponse(body);
        });

        await assert.rejects(() => generateEmbeddings({ headers, text: cjkText(64 * 1024) }, 'token', { baseApiUrl: mock.url, signal: controller.signal }), {
            message: 'stopped'
        });

        assert.equal(mock.requests.length, 1);
    });

    it('rejects a batch response with the wrong number of entries', async () => {
        mock.setHandler(() => embeddingResponse());

        await assert.rejects(() => generateEmbeddings({ headers, text: cjkText(8000) }, 'token', { baseApiUrl: mock.url }), { code: 'InvalidResponse' });
    });
});
