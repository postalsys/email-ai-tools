'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, chatResponse, instructResponse, errorResponse } = require('./helpers/mock-server');
const { generateSummary } = require('../lib/generate-summary');

describe('generateSummary', () => {
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
            { key: 'subject', value: 'Test Subject' }
        ],
        text: 'Hello, this is a test email.'
    };

    const summaryResult = {
        sentiment: 'neutral',
        summary: 'A test email greeting.',
        shouldReply: false,
        riskAssessment: { risk: 1, assessment: 'Low risk message.' }
    };

    it('returns structured response from chat API', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const result = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.sentiment, 'neutral');
        assert.equal(result.summary, 'A test email greeting.');
        assert.equal(result.shouldReply, false);
        assert.deepEqual(result.riskAssessment, { risk: 1, assessment: 'Low risk message.' });
        assert.equal(result.id, 'chatcmpl-test123');
        assert.equal(result.tokens, 150);
        assert.equal(result.model, 'gpt-5-mini');
    });

    it('sends correct request to chat API endpoint', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'my-api-key', {
            baseApiUrl: mock.url,
            user: 'user123',
            temperature: 0.7,
            topP: 0.9
        });

        const req = mock.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        assert.ok(req.headers.authorization.includes('Bearer my-api-key'));
        assert.equal(req.body.model, 'gpt-5-mini');
        assert.equal(req.body.user, 'user123');
        assert.equal(req.body.temperature, 0.7);
        assert.equal(req.body.top_p, 0.9);
        assert.ok(Array.isArray(req.body.messages));
        assert.equal(req.body.messages.length, 2);
        assert.equal(req.body.messages[0].role, 'system');
        assert.equal(req.body.messages[1].role, 'user');
    });

    it('converts HTML to text when HTML is longer', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const htmlMessage = {
            headers: [{ key: 'from', value: 'test@example.com' }],
            text: 'Short',
            html: '<p>This is a much longer HTML content that should be converted to text and used instead of the short plain text version.</p>'
        };

        await generateSummary(htmlMessage, 'test-token', { baseApiUrl: mock.url });

        const req = mock.requests[0];
        const userContent = req.body.messages[1].content;
        assert.ok(userContent.includes('This is a much longer HTML content'));
        assert.ok(!userContent.includes('<p>'));
    });

    it('filters headers using whitelist', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const messageWithExtraHeaders = {
            headers: [
                { key: 'from', value: 'test@example.com' },
                { key: 'subject', value: 'Test' },
                { key: 'x-custom-header', value: 'should be filtered' },
                { key: 'received', value: 'should be filtered' },
                { key: 'authentication-results', value: 'spf=pass' }
            ],
            text: 'Test email'
        };

        await generateSummary(messageWithExtraHeaders, 'test-token', { baseApiUrl: mock.url });

        const userContent = mock.requests[0].body.messages[1].content;
        assert.ok(userContent.includes('authentication-results'));
        assert.ok(!userContent.includes('x-custom-header'));
        assert.ok(!userContent.includes('received'));
    });

    it('deduplicates authentication headers', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const messageWithDupAuth = {
            headers: [
                { key: 'from', value: 'test@example.com' },
                { key: 'authentication-results', value: 'first result' },
                { key: 'authentication-results', value: 'second result' }
            ],
            text: 'Test'
        };

        await generateSummary(messageWithDupAuth, 'test-token', { baseApiUrl: mock.url });

        const userContent = mock.requests[0].body.messages[1].content;
        assert.ok(userContent.includes('first result'));
        assert.ok(!userContent.includes('second result'));
    });

    it('merges custom allowedHeaders with defaults', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const messageWithCustomHeader = {
            headers: [
                { key: 'from', value: 'test@example.com' },
                { key: 'x-priority', value: '1 (Highest)' }
            ],
            text: 'Urgent email'
        };

        await generateSummary(messageWithCustomHeader, 'test-token', {
            baseApiUrl: mock.url,
            allowedHeaders: ['x-priority']
        });

        const userContent = mock.requests[0].body.messages[1].content;
        assert.ok(userContent.includes('x-priority'));
        assert.ok(userContent.includes('1 (Highest)'));
    });

    it('uses instruct endpoint for gpt-3.5-turbo-instruct', async () => {
        mock.setHandler(() => instructResponse(JSON.stringify(summaryResult)));

        const result = await generateSummary(simpleMessage, 'test-token', {
            baseApiUrl: mock.url,
            gptModel: 'gpt-3.5-turbo-instruct'
        });

        assert.equal(result.model, 'gpt-3.5-turbo-instruct');
        const req = mock.requests[0];
        assert.equal(req.url, '/v1/completions');
        assert.ok(typeof req.body.prompt === 'string');
        assert.ok(req.body.max_tokens > 0);
        assert.ok(!req.body.messages);
    });

    it('removes null and empty string values from response', async () => {
        mock.setHandler(() =>
            chatResponse({
                sentiment: 'neutral',
                summary: 'Test',
                shouldReply: false,
                riskAssessment: { risk: 1, assessment: null },
                events: null,
                replyText: ''
            })
        );

        const result = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.sentiment, 'neutral');
        assert.ok(!('assessment' in result.riskAssessment));
        assert.ok(!('events' in result));
        assert.ok(!('replyText' in result));
    });

    it('extracts JSON from response with surrounding text', async () => {
        mock.setHandler(() =>
            chatResponse(
                'Here is my analysis:\n' +
                    '{"sentiment":"positive","summary":"Extracted JSON","shouldReply":true,"riskAssessment":{"risk":1}}\n' +
                    'End of analysis.'
            )
        );

        const result = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.sentiment, 'positive');
        assert.equal(result.summary, 'Extracted JSON');
    });

    it('uses custom system and user prompts', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'test-token', {
            baseApiUrl: mock.url,
            systemPrompt: 'Custom system prompt here',
            userPrompt: 'Custom user prompt here'
        });

        const req = mock.requests[0];
        assert.equal(req.body.messages[0].content, 'Custom system prompt here');
        assert.ok(req.body.messages[1].content.startsWith('Custom user prompt here'));
    });

    it('handles message with attachments', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const messageWithAttachments = {
            headers: [{ key: 'from', value: 'test@example.com' }],
            text: 'See attached.',
            attachments: [
                { filename: 'document.pdf', contentType: 'application/pdf' },
                { filename: 'image.png', contentType: 'image/png' }
            ]
        };

        const result = await generateSummary(messageWithAttachments, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.sentiment, 'neutral');
        const userContent = mock.requests[0].body.messages[1].content;
        assert.ok(userContent.includes('document.pdf'));
        assert.ok(userContent.includes('image.png'));
    });

    it('handles empty message', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const result = await generateSummary({ headers: [], text: '' }, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.sentiment, 'neutral');
    });

    it('retries on 429 rate limit', { timeout: 10000 }, async () => {
        let callCount = 0;
        mock.setHandler(() => {
            callCount++;
            if (callCount === 1) {
                return errorResponse(429, 'Rate limit exceeded');
            }
            return chatResponse(summaryResult);
        });

        const result = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.summary, 'A test email greeting.');
        assert.equal(callCount, 2);
    });

    it('throws on non-429 API errors with error details', async () => {
        mock.setHandler(() => errorResponse(500, 'Internal server error', 'server_error'));

        await assert.rejects(
            () => generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.equal(err.message, 'Internal server error');
                assert.equal(err.code, 'server_error');
                assert.equal(err.statusCode, 500);
                return true;
            }
        );
    });

    it('throws generic error on API failure without error details', async () => {
        mock.setHandler(() => ({ status: 503, body: {} }));

        await assert.rejects(
            () => generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.equal(err.message, 'Failed to run API request');
                assert.equal(err.statusCode, 503);
                return true;
            }
        );
    });

    it('throws on invalid JSON response', async () => {
        mock.setHandler(() => chatResponse('This response contains no JSON at all'));

        await assert.rejects(
            () => generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.ok(err.message.includes('Failed to parse'));
                return true;
            }
        );
    });

    it('includes verbose fields when verbose is true', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const result = await generateSummary(simpleMessage, 'test-token', {
            baseApiUrl: mock.url,
            verbose: true
        });

        assert.ok('_text' in result);
        assert.ok('_time' in result);
        assert.ok('_cr' in result);
        assert.equal(typeof result._time, 'number');
        assert.ok(result._time >= 0);
    });

    it('does not include verbose fields by default', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const result = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.ok(!('_text' in result));
        assert.ok(!('_time' in result));
        assert.ok(!('_cr' in result));
    });
});
