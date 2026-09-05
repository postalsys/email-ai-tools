'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('undici');
const { createMockServer, chatResponse, embeddingResponse, modelsResponse } = require('./helpers/mock-server');
const { generateSummary, generateEmbeddings, getChunkEmbeddings, embeddingsQuery, questionQuery, riskAnalysis, listModels } = require('..');

// A real undici Agent that counts what was dispatched through it, so a test can tell the request
// used the dispatcher it was given and not the module's own agent.
class CountingAgent extends Agent {
    constructor() {
        super();
        this.dispatched = 0;
    }

    dispatch(opts, handler) {
        this.dispatched++;
        return super.dispatch(opts, handler);
    }
}

const message = {
    headers: [
        { key: 'from', value: 'sender@example.com' },
        { key: 'to', value: 'recipient@example.com' },
        { key: 'subject', value: 'Test Subject' }
    ],
    text: 'Hello, this is a test email.'
};

describe('dispatcher option', () => {
    let mock;
    let dispatcher;

    before(async () => {
        mock = await createMockServer();
    });

    after(async () => {
        await mock.close();
    });

    beforeEach(() => {
        mock.clearRequests();
        dispatcher = new CountingAgent();
    });

    const cases = [
        {
            name: 'generateSummary',
            response: () => chatResponse({ sentiment: 'neutral', summary: 'ok', shouldReply: false, riskAssessment: { risk: 1 } }),
            run: opts => generateSummary(message, 'token', opts)
        },
        {
            name: 'riskAnalysis',
            response: () => chatResponse({ risk: 1, assessment: 'fine' }),
            run: opts => riskAnalysis(message, 'token', opts)
        },
        {
            name: 'getChunkEmbeddings',
            response: () => embeddingResponse(),
            run: opts => getChunkEmbeddings('chunk', 'token', opts)
        },
        {
            name: 'generateEmbeddings',
            response: () => embeddingResponse(),
            run: opts => generateEmbeddings(message, 'token', opts)
        },
        {
            name: 'embeddingsQuery',
            response: () => chatResponse('Answer.\n\nMessage IDs: id1'),
            run: opts => embeddingsQuery('token', Object.assign({ question: 'What?', contextChunks: 'id1: hello' }, opts))
        },
        {
            name: 'questionQuery',
            response: () => chatResponse({ ordering: 'best_match', topic: 'conference' }),
            run: opts => questionQuery('When is the next conference?', 'token', opts)
        },
        {
            name: 'listModels',
            response: () => modelsResponse(),
            run: opts => listModels('token', opts)
        }
    ];

    for (const entry of cases) {
        it(`${entry.name} sends its request through the given dispatcher`, async () => {
            mock.setHandler(entry.response);

            await entry.run({ baseApiUrl: mock.url, dispatcher });

            assert.ok(mock.requests.length >= 1, 'the mock server should have been reached');
            assert.equal(dispatcher.dispatched, mock.requests.length);
        });
    }

    it('generateEmbeddings forwards the request options to every chunk request', async () => {
        mock.setHandler(() => embeddingResponse());

        const result = await generateEmbeddings(message, 'token', {
            baseApiUrl: mock.url,
            dispatcher,
            gptModel: 'text-embedding-3-small',
            user: 'user-1'
        });

        assert.equal(result.model, 'text-embedding-3-small');
        assert.ok(mock.requests.length >= 1);
        for (const req of mock.requests) {
            assert.equal(req.url, '/v1/embeddings');
            assert.equal(req.body.model, 'text-embedding-3-small');
            assert.equal(req.body.user, 'user-1');
        }
    });

    it('falls back to the built-in agent when no dispatcher is given', async () => {
        mock.setHandler(() => modelsResponse());

        await listModels('token', { baseApiUrl: mock.url });

        assert.equal(mock.requests.length, 1);
        assert.equal(dispatcher.dispatched, 0);
    });
});
