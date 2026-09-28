'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, modelsResponse } = require('./helpers/mock-server');
const { apiRequest, MAX_RESPONSE_SIZE } = require('../lib/api-request');

const HTML_502 = '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>';

// A short per-test timeout catches a regression that waits for a long Retry-After instead of failing
const TIMEOUT = { timeout: 5000 };

describe('apiRequest', () => {
    let mock;
    let url;

    before(async () => {
        mock = await createMockServer();
        url = `${mock.url}/v1/models`;
    });

    after(async () => {
        await mock.close();
    });

    beforeEach(() => {
        mock.clearRequests();
    });

    it('sends the token, user agent and JSON payload and returns the parsed body', TIMEOUT, async () => {
        mock.setHandler(() => modelsResponse());

        const { data, time } = await apiRequest(url, { apiToken: 'secret', payload: { a: 1 } });

        assert.ok(Array.isArray(data.data));
        assert.equal(typeof time, 'number');
        assert.equal(mock.requests.length, 1);
        assert.equal(mock.requests[0].method, 'POST');
        assert.equal(mock.requests[0].headers.authorization, 'Bearer secret');
        assert.equal(mock.requests[0].headers['content-type'], 'application/json');
        assert.ok(/^@postalsys\/email-ai-tools\//.test(mock.requests[0].headers['user-agent']));
        assert.deepEqual(mock.requests[0].body, { a: 1 });
    });

    it('reports an HTML 502 with its status code instead of a JSON SyntaxError', TIMEOUT, async () => {
        mock.setHandler(() => ({ status: 502, raw: HTML_502 }));

        await assert.rejects(
            () => apiRequest(url, { apiToken: 'token' }),
            err => {
                assert.notEqual(err.name, 'SyntaxError');
                assert.equal(err.message, 'Failed to run API request');
                assert.equal(err.statusCode, 502);
                assert.ok(err.responseText.includes('502 Bad Gateway'));
                return true;
            }
        );
        assert.equal(mock.requests.length, 1);
    });

    it('retries an HTML 429 after the Retry-After delay', TIMEOUT, async () => {
        let calls = 0;
        mock.setHandler(() => {
            calls++;
            if (calls === 1) {
                return { status: 429, raw: '<html>Too Many Requests</html>', headers: { 'retry-after-ms': '50' } };
            }
            return modelsResponse();
        });

        const { data } = await apiRequest(url, { apiToken: 'token' });

        assert.equal(calls, 2);
        assert.ok(Array.isArray(data.data));
    });

    it('fails right away when Retry-After is longer than it is willing to wait', TIMEOUT, async () => {
        mock.setHandler(() => ({ status: 429, raw: '<html>Too Many Requests</html>', headers: { 'Retry-After': '3600' } }));

        await assert.rejects(
            () => apiRequest(url, { apiToken: 'token' }),
            err => {
                assert.equal(err.statusCode, 429);
                assert.equal(err.retryAfter, 3600);
                return true;
            }
        );
        assert.equal(mock.requests.length, 1);
    });

    it('does not produce "[object Object]" for an error object without a message', TIMEOUT, async () => {
        mock.setHandler(() => ({ status: 400, body: { error: { type: 'invalid_request_error', code: 'bad_input' } } }));

        await assert.rejects(
            () => apiRequest(url, { apiToken: 'token' }),
            err => {
                assert.ok(!err.message.includes('[object Object]'), err.message);
                assert.ok(err.message.includes('invalid_request_error'));
                assert.equal(err.code, 'bad_input');
                assert.equal(err.statusCode, 400);
                return true;
            }
        );
    });

    it('uses a string error as the message', TIMEOUT, async () => {
        mock.setHandler(() => ({ status: 400, body: { error: 'Model not found' } }));

        await assert.rejects(
            () => apiRequest(url, { apiToken: 'token' }),
            err => {
                assert.equal(err.message, 'Model not found');
                assert.equal(err.statusCode, 400);
                return true;
            }
        );
    });

    it('rejects a 200 response that is not JSON with the status and a snippet', TIMEOUT, async () => {
        mock.setHandler(() => ({ status: 200, raw: '<html>Login required</html>' }));

        await assert.rejects(
            () => apiRequest(url, { apiToken: 'token' }),
            err => {
                assert.equal(err.code, 'InvalidResponse');
                assert.equal(err.statusCode, 200);
                assert.ok(err.responseText.includes('Login required'));
                return true;
            }
        );
    });

    it('rejects a 200 response with a JSON null body', TIMEOUT, async () => {
        mock.setHandler(() => ({ status: 200, raw: 'null' }));

        await assert.rejects(() => apiRequest(url, { apiToken: 'token' }), { code: 'InvalidResponse', statusCode: 200 });
    });

    it('stops reading a response larger than the size cap', TIMEOUT, async () => {
        const big = 'x'.repeat(MAX_RESPONSE_SIZE + 1024);
        mock.setHandler(() => ({ status: 200, raw: big }));

        await assert.rejects(
            () => apiRequest(url, { apiToken: 'token' }),
            err => {
                assert.equal(err.code, 'ResponseTooLarge');
                assert.equal(err.statusCode, 200);
                return true;
            }
        );
    });

    it('stops waiting for a 429 retry when the signal is aborted', TIMEOUT, async () => {
        mock.setHandler(() => ({ status: 429, raw: '', headers: { 'Retry-After': '10' } }));

        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('stopped')), 100);

        await assert.rejects(() => apiRequest(url, { apiToken: 'token', signal: controller.signal }), { message: 'stopped' });
        assert.equal(mock.requests.length, 1);
    });
});
