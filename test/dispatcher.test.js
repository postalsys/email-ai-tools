'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('undici');
const { createMockServer, chatResponse, modelsResponse } = require('./helpers/mock-server');
const { generateSummary, listModels } = require('..');

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

// The request behaviour itself is covered in api-request.test.js; these only check that every
// entry point hands its dispatcher and signal down to it
describe('request option pass-through', () => {
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
            name: 'listModels',
            response: () => modelsResponse(),
            run: opts => listModels('token', opts)
        }
    ];

    for (const entry of cases) {
        it(`${entry.name} passes the dispatcher and the signal to the request`, { timeout: 5000 }, async () => {
            mock.setHandler(entry.response);

            await entry.run({ baseApiUrl: mock.url, dispatcher });

            assert.ok(mock.requests.length >= 1, 'the mock server should have been reached');
            assert.equal(dispatcher.dispatched, mock.requests.length);

            // aborted while the request is in flight, and the 429 would otherwise be retried
            mock.clearRequests();
            const controller = new AbortController();
            mock.setHandler(() => {
                controller.abort(new Error('stopped'));
                return { status: 429, raw: '', headers: { 'Retry-After': '10' } };
            });

            await assert.rejects(() => entry.run({ baseApiUrl: mock.url, signal: controller.signal }), { message: 'stopped' });
            assert.equal(mock.requests.length, 1);
        });
    }

    it('falls back to the built-in agent when no dispatcher is given', async () => {
        mock.setHandler(() => modelsResponse());

        await listModels('token', { baseApiUrl: mock.url });

        assert.equal(mock.requests.length, 1);
        assert.equal(dispatcher.dispatched, 0);
    });
});
