'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, chatResponse, errorResponse } = require('./helpers/mock-server');
const riskAnalysis = require('../lib/risk-analysis');

describe('riskAnalysis', () => {
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

    const simpleMessage = {
        headers: [
            { key: 'from', value: 'sender@example.com' },
            { key: 'to', value: 'recipient@example.com' },
            { key: 'subject', value: 'Test Subject' },
            { key: 'authentication-results', value: 'spf=pass; dkim=pass; dmarc=pass' }
        ],
        text: 'Hello, this is a test email.'
    };

    const riskResult = { risk: 1, assessment: 'Low risk, authenticated sender.' };

    it('returns risk score and assessment', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        const result = await riskAnalysis(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.risk, 1);
        assert.equal(result.assessment, 'Low risk, authenticated sender.');
        assert.equal(result.id, 'chatcmpl-test123');
        assert.equal(result.tokens, 150);
        assert.equal(result.model, 'gpt-5-mini');
    });

    it('sends correct request payload', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        await riskAnalysis(simpleMessage, 'my-api-key', {
            baseApiUrl: mock.url,
            user: 'user123',
            temperature: 0.5
        });

        const req = mock.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        assert.ok(req.headers.authorization.includes('Bearer my-api-key'));
        assert.equal(req.body.model, 'gpt-5-mini');
        assert.equal(req.body.user, 'user123');
        assert.equal(req.body.temperature, 0.5);
        assert.equal(req.body.messages.length, 2);
        assert.equal(req.body.messages[0].role, 'system');
        assert.equal(req.body.messages[1].role, 'user');
    });

    it('converts risk to number', async () => {
        mock.setHandler(() => chatResponse({ risk: '3', assessment: 'Medium risk.' }));

        const result = await riskAnalysis(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.risk, 3);
        assert.equal(typeof result.risk, 'number');
    });

    it('returns -1 for non-numeric risk', async () => {
        mock.setHandler(() => chatResponse({ risk: 'high', assessment: 'Could not parse.' }));

        const result = await riskAnalysis(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.risk, -1);
    });

    it('filters headers with whitelist', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        const messageWithExtraHeaders = {
            headers: [
                { key: 'from', value: 'test@example.com' },
                { key: 'x-mailer', value: 'Thunderbird' },
                { key: 'received', value: 'from mail.example.com' }
            ],
            text: 'Test email'
        };

        await riskAnalysis(messageWithExtraHeaders, 'test-token', { baseApiUrl: mock.url });

        const userContent = mock.requests[0].body.messages[1].content;
        assert.ok(!userContent.includes('x-mailer'));
        assert.ok(!userContent.includes('Thunderbird'));
    });

    it('deduplicates authentication-results header', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        const messageWithDupAuth = {
            headers: [
                { key: 'from', value: 'test@example.com' },
                { key: 'authentication-results', value: 'spf=pass' },
                { key: 'authentication-results', value: 'spf=fail' }
            ],
            text: 'Test'
        };

        await riskAnalysis(messageWithDupAuth, 'test-token', { baseApiUrl: mock.url });

        const userContent = mock.requests[0].body.messages[1].content;
        assert.ok(userContent.includes('spf=pass'));
    });

    it('converts HTML to text when significantly longer', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        const htmlMessage = {
            headers: [{ key: 'from', value: 'test@example.com' }],
            text: 'Short',
            html: '<div><p>This is much longer HTML content for the risk analysis test that should be used instead of the short text because it is more than twice as long.</p></div>'
        };

        await riskAnalysis(htmlMessage, 'test-token', { baseApiUrl: mock.url });

        const userContent = mock.requests[0].body.messages[1].content;
        assert.ok(userContent.includes('This is much longer HTML content'));
    });

    it('uses custom prompts', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        await riskAnalysis(simpleMessage, 'test-token', {
            baseApiUrl: mock.url,
            systemPrompt: 'Custom security prompt',
            userPrompt: 'Custom analysis instructions:'
        });

        const req = mock.requests[0];
        assert.equal(req.body.messages[0].content, 'Custom security prompt');
        assert.ok(req.body.messages[1].content.startsWith('Custom analysis instructions:'));
    });

    it('always includes _text, _time, _cr in response', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        const result = await riskAnalysis(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.ok('_text' in result);
        assert.ok('_time' in result);
        assert.ok('_cr' in result);
        assert.equal(typeof result._time, 'number');
    });

    it('retries on 429 rate limit', { timeout: 10000 }, async () => {
        let callCount = 0;
        mock.setHandler(() => {
            callCount++;
            if (callCount === 1) {
                return errorResponse(429, 'Rate limit exceeded');
            }
            return chatResponse(riskResult);
        });

        const result = await riskAnalysis(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.risk, 1);
        assert.equal(callCount, 2);
    });

    it('throws on API errors', async () => {
        mock.setHandler(() => errorResponse(401, 'Invalid API key', 'invalid_api_key'));

        await assert.rejects(
            () => riskAnalysis(simpleMessage, 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.equal(err.message, 'Invalid API key');
                assert.equal(err.code, 'invalid_api_key');
                assert.equal(err.statusCode, 401);
                return true;
            }
        );
    });

    it('throws on invalid JSON response', async () => {
        mock.setHandler(() => chatResponse('Not a JSON response'));

        await assert.rejects(
            () => riskAnalysis(simpleMessage, 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.ok(err.message.includes('Failed to parse'));
                return true;
            }
        );
    });

    it('handles empty message', async () => {
        mock.setHandler(() => chatResponse(riskResult));

        const result = await riskAnalysis({ headers: [], text: '' }, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.risk, 1);
    });
});
