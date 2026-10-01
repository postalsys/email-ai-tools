'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, chatResponse, errorResponse } = require('./helpers/mock-server');
const {
    generateSummary,
    isReasoningModel,
    resetParameterCache,
    DEFAULT_MODEL,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_INSTRUCTIONS
} = require('../lib/generate-summary');

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
        resetParameterCache();
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

    const userObject = req => JSON.parse(req.body.messages[1].content);

    it('returns the model output as the result and the request usage beside it', async () => {
        mock.setHandler(() => chatResponse(summaryResult, { id: 'chatcmpl-abc', tokens: 200, model: 'gpt-6-luna-2026-09-22' }));

        const { result, usage } = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.deepEqual(result, summaryResult);
        assert.equal(usage.id, 'chatcmpl-abc');
        assert.equal(usage.model, DEFAULT_MODEL);
        assert.equal(usage.servedModel, 'gpt-6-luna-2026-09-22');
        assert.equal(usage.tokens, 200);
        assert.equal(usage.promptTokens, 170);
        assert.equal(usage.completionTokens, 30);
        assert.equal(typeof usage.time, 'number');
        assert.equal(usage.charactersRemoved, 0);
        assert.ok(!('text' in usage));
    });

    it('puts the instructions in the system message and only the email in the user message', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'my-api-key', { baseApiUrl: mock.url, user: 'user123' });

        const req = mock.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        assert.ok(req.headers.authorization.includes('Bearer my-api-key'));
        assert.equal(req.body.model, DEFAULT_MODEL);
        assert.equal(req.body.user, 'user123');
        assert.deepEqual(req.body.response_format, { type: 'json_object' });
        assert.equal(req.body.messages.length, 2);

        const [system, user] = req.body.messages;
        assert.equal(system.role, 'system');
        assert.ok(system.content.startsWith(DEFAULT_SYSTEM_PROMPT));
        assert.ok(system.content.includes(DEFAULT_INSTRUCTIONS));
        assert.ok(system.content.includes('JSON'), 'JSON mode needs the word in the prompt');

        assert.equal(user.role, 'user');
        assert.deepEqual(JSON.parse(user.content), {
            subject: 'Test Subject',
            from: 'sender@example.com',
            date: '',
            headers: { to: 'recipient@example.com' },
            attachments: [],
            text: 'Hello, this is a test email.'
        });
    });

    it('decodes encoded words and flattens list values in headers', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(
            {
                headers: [
                    { key: 'Subject', value: ['=?UTF-8?Q?T=C3=A4na_on_=F0=9F=98=80?='] },
                    { key: 'From', value: '=?ISO-8859-1?Q?J=F5gi?= <jogi@example.com>' },
                    { key: 'To', value: ['a@example.com', 'b@example.com'] },
                    { key: 'Date', value: 'Mon, 17 Oct 2022 09:42:07 +0300' }
                ],
                text: 'Tere'
            },
            'test-token',
            { baseApiUrl: mock.url }
        );

        const input = userObject(mock.requests[0]);
        assert.equal(input.subject, 'Täna on \u{1F600}');
        assert.equal(input.from, 'Jõgi <jogi@example.com>');
        assert.equal(input.date, 'Mon, 17 Oct 2022 09:42:07 +0300');
        assert.deepEqual(input.headers, { to: 'a@example.com, b@example.com' });
    });

    it('prefers the decoded subject, sender object and date over the headers', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(
            {
                subject: 'Decoded subject',
                from: { name: 'Andris', address: 'andris@example.com' },
                date: new Date('2026-10-01T10:00:00.000Z'),
                headers: [
                    { key: 'subject', value: '=?UTF-8?Q?Something_else?=' },
                    { key: 'from', value: 'other@example.com' }
                ],
                text: 'Hi'
            },
            'test-token',
            { baseApiUrl: mock.url }
        );

        const input = userObject(mock.requests[0]);
        assert.equal(input.subject, 'Decoded subject');
        assert.equal(input.from, 'Andris <andris@example.com>');
        assert.equal(input.date, '2026-10-01T10:00:00.000Z');
        assert.deepEqual(input.headers, {});
    });

    it('keeps the path prefix of a custom base URL', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'my-api-key', { baseApiUrl: `${mock.url}/openai/v1` });

        assert.equal(mock.requests[0].url, '/openai/v1/chat/completions');
    });

    it('converts HTML to text when HTML is longer', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(
            {
                headers: [{ key: 'from', value: 'test@example.com' }],
                text: 'Short',
                html: '<p>This is a much longer HTML content that should be converted to text and used instead of the short plain text version.</p>'
            },
            'test-token',
            { baseApiUrl: mock.url }
        );

        const input = userObject(mock.requests[0]);
        assert.ok(input.text.includes('This is a much longer HTML content'));
        assert.ok(!input.text.includes('<p>'));
    });

    it('passes only whitelisted headers and keeps the topmost authentication result', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(
            {
                headers: [
                    { key: 'from', value: 'test@example.com' },
                    { key: 'x-custom-header', value: 'should be filtered' },
                    { key: 'received', value: 'should be filtered' },
                    { key: 'arc-seal', value: 'i=1; a=rsa-sha256; b=AAAA' },
                    { key: 'in-reply-to', value: '<parent@example.com>' },
                    { key: 'authentication-results', value: 'first result' },
                    { key: 'authentication-results', value: 'second result' }
                ],
                text: 'Test email'
            },
            'test-token',
            { baseApiUrl: mock.url }
        );

        const input = userObject(mock.requests[0]);
        assert.deepEqual(input.headers, {
            'in-reply-to': '<parent@example.com>',
            'authentication-results': 'first result'
        });
    });

    it('merges custom allowedHeaders with defaults', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(
            {
                headers: [
                    { key: 'from', value: 'test@example.com' },
                    { key: 'x-priority', value: '1 (Highest)' }
                ],
                text: 'Urgent email'
            },
            'test-token',
            { baseApiUrl: mock.url, allowedHeaders: ['X-Priority'] }
        );

        const input = userObject(mock.requests[0]);
        assert.equal(input.headers['x-priority'], '1 (Highest)');
    });

    it('lists attachments by name and type', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(
            {
                headers: [{ key: 'from', value: 'test@example.com' }],
                text: 'See attached.',
                attachments: [
                    { filename: 'document.pdf', contentType: 'application/pdf', content: Buffer.from('x') },
                    { filename: 'image.png', contentType: 'image/png' },
                    { id: 'no-name-no-type' }
                ]
            },
            'test-token',
            { baseApiUrl: mock.url }
        );

        const input = userObject(mock.requests[0]);
        assert.deepEqual(input.attachments, [
            { filename: 'document.pdf', contentType: 'application/pdf' },
            { filename: 'image.png', contentType: 'image/png' }
        ]);
    });

    it('sends a low reasoning effort to reasoning models and nothing to others', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-5-mini' });
        assert.equal(mock.requests[0].body.reasoning_effort, 'low');

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-4.1-mini' });
        assert.ok(!('reasoning_effort' in mock.requests[1].body));

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-4.1-mini', reasoningEffort: 'High' });
        assert.equal(mock.requests[2].body.reasoning_effort, 'high');
    });

    it('sends temperature and top_p when given, including zero', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-4.1', temperature: 0, topP: '0.9' });

        const req = mock.requests[0];
        assert.equal(req.body.temperature, 0);
        assert.equal(req.body.top_p, 0.9);

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-4.1', temperature: '', topP: null });
        assert.ok(!('temperature' in mock.requests[1].body));
        assert.ok(!('top_p' in mock.requests[1].body));
    });

    it('drops a parameter the backend refuses and remembers it', async () => {
        mock.setHandler((req, body) => {
            if ('reasoning_effort' in body) {
                // the structured field names the parameter, the text does not
                return errorResponse(400, 'Unsupported parameter for this model.', 'unsupported_parameter', 'reasoning_effort');
            }
            if ('temperature' in body) {
                return errorResponse(
                    400,
                    "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.",
                    'unsupported_value'
                );
            }
            return chatResponse(summaryResult);
        });

        const opts = { baseApiUrl: mock.url, gptModel: 'gpt-4.1', temperature: 0.7, reasoningEffort: 'low' };
        const first = await generateSummary(simpleMessage, 'test-token', opts);
        assert.equal(first.result.summary, 'A test email greeting.');
        assert.equal(mock.requests.length, 3);
        assert.ok(!('reasoning_effort' in mock.requests[2].body));
        assert.ok(!('temperature' in mock.requests[2].body));
        assert.deepEqual(mock.requests[2].body.response_format, { type: 'json_object' }, 'an accepted parameter stays');
        assert.ok(first.usage.time >= 0);

        mock.clearRequests();
        await generateSummary(simpleMessage, 'test-token', opts);
        assert.equal(mock.requests.length, 1, 'the refusal is remembered for the next call');
        assert.ok(!('reasoning_effort' in mock.requests[0].body));
        assert.ok(!('temperature' in mock.requests[0].body));

        mock.clearRequests();
        await generateSummary(simpleMessage, 'test-token', Object.assign({}, opts, { gptModel: 'gpt-4o' }));
        assert.equal(mock.requests.length, 3, 'another model starts afresh');
    });

    it('drops every parameter one refusal names', async () => {
        mock.setHandler((req, body) => {
            if ('temperature' in body || 'top_p' in body) {
                return errorResponse(400, "Unsupported parameters: 'temperature' and 'top_p' are not supported with this model.", 'unsupported_parameter');
            }
            return chatResponse(summaryResult);
        });

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-4.1-nano', temperature: 0.2, topP: 0.5 });

        assert.equal(mock.requests.length, 2);
        assert.ok(!('temperature' in mock.requests[1].body));
        assert.ok(!('top_p' in mock.requests[1].body));
    });

    it('does not send sampling parameters to a model that is reasoning', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-5-mini', temperature: 0.5, topP: 0.9 });
        assert.equal(mock.requests[0].body.reasoning_effort, 'low');
        assert.ok(!('temperature' in mock.requests[0].body));
        assert.ok(!('top_p' in mock.requests[0].body));

        // with the reasoning switched off the model takes them again
        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, gptModel: 'gpt-5.1', temperature: 0.5, reasoningEffort: 'none' });
        assert.equal(mock.requests[1].body.reasoning_effort, 'none');
        assert.equal(mock.requests[1].body.temperature, 0.5);
    });

    it('does not retry a 400 that names no optional parameter', async () => {
        mock.setHandler(() => errorResponse(400, "This model's maximum context length is 128000 tokens.", 'context_length_exceeded'));

        await assert.rejects(() => generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url }), {
            code: 'context_length_exceeded',
            statusCode: 400
        });
        assert.equal(mock.requests.length, 1);
    });

    it('can switch JSON mode off', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, jsonMode: false });

        assert.ok(!('response_format' in mock.requests[0].body));
    });

    it('normalizes the documented properties and keeps custom ones', async () => {
        mock.setHandler(() =>
            chatResponse({
                sentiment: ' Positive ',
                summary: '  Trimmed  ',
                shouldReply: 'true',
                riskAssessment: { risk: '7', assessment: null },
                events: { description: 'single event', startTime: '2026-10-02' },
                actions: ['not an object'],
                language: 'et',
                emailType: 'inquiry',
                replyText: ''
            })
        );

        const { result } = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.deepEqual(result, {
            sentiment: 'positive',
            summary: 'Trimmed',
            shouldReply: true,
            riskAssessment: { risk: 5 },
            events: [{ description: 'single event', startTime: '2026-10-02' }],
            language: 'et',
            emailType: 'inquiry'
        });
    });

    it('drops documented properties that cannot be made to fit', async () => {
        mock.setHandler(() =>
            chatResponse({
                sentiment: 'mixed',
                summary: { text: 'not a string' },
                shouldReply: 'maybe',
                riskAssessment: 'unknown',
                events: null,
                actions: []
            })
        );

        const { result } = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.deepEqual(result, {});
    });

    it('accepts a bare risk number as the risk assessment', async () => {
        mock.setHandler(() => chatResponse({ summary: 'x', riskAssessment: 3 }));

        const { result } = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.deepEqual(result.riskAssessment, { risk: 3 });
    });

    it('extracts the JSON object from a response with surrounding text', async () => {
        mock.setHandler(() =>
            chatResponse(
                'Here is my analysis:\n```json\n' +
                    '{"sentiment":"positive","summary":"Extracted JSON","shouldReply":true,"riskAssessment":{"risk":1}}\n```\n' +
                    'End of analysis.'
            )
        );

        const { result } = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.sentiment, 'positive');
        assert.equal(result.summary, 'Extracted JSON');
    });

    it('uses custom system prompt and instructions', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        await generateSummary(simpleMessage, 'test-token', {
            baseApiUrl: mock.url,
            systemPrompt: 'Custom system prompt here',
            instructions: 'Return the JSON property "language".'
        });

        const system = mock.requests[0].body.messages[0].content;
        assert.ok(system.startsWith('Custom system prompt here\n\nReturn the JSON property "language".'));
        assert.ok(!system.includes(DEFAULT_INSTRUCTIONS));
        assert.ok(system.includes('The user message is a JSON object'), 'the input format stays');
    });

    it('handles an empty message', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const { result } = await generateSummary({}, 'test-token', { baseApiUrl: mock.url });

        assert.equal(result.sentiment, 'neutral');
        assert.deepEqual(userObject(mock.requests[0]), { subject: '', from: '', date: '', headers: {}, attachments: [], text: '' });
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

        const { result } = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url });

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

    it('throws on a response without a JSON object and reports why the model stopped', async () => {
        mock.setHandler(() => chatResponse('', { finishReason: 'length' }));

        await assert.rejects(
            () => generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url }),
            err => {
                assert.ok(err.message.includes('Failed to parse'));
                assert.equal(err.finishReason, 'length');
                assert.equal(err.textContent, '');
                return true;
            }
        );
    });

    it('throws when the model returns a list of objects instead of one', async () => {
        mock.setHandler(() => chatResponse('[{"summary":"x"},{"summary":"y"}]'));

        await assert.rejects(() => generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url }), /Failed to parse/);
    });

    it('includes the prompt text in the usage when verbose', async () => {
        mock.setHandler(() => chatResponse(summaryResult));

        const { usage } = await generateSummary(simpleMessage, 'test-token', { baseApiUrl: mock.url, verbose: true });

        assert.equal(usage.text, 'Hello, this is a test email.');
    });
});

describe('isReasoningModel', () => {
    it('recognizes the reasoning families', () => {
        for (const model of [
            'gpt-5',
            'gpt-5-mini',
            'gpt-5.1',
            'gpt-5.4-nano',
            'gpt-5.6-luna',
            'gpt-6-luna',
            'gpt-6.1-sol',
            'gpt-10',
            'gpt-oss-20b',
            'o1',
            'o3-mini',
            'o4-mini'
        ]) {
            assert.equal(isReasoningModel(model), true, model);
        }
    });

    it('leaves out chat variants, older families and unknown names', () => {
        for (const model of ['gpt-5-chat-latest', 'chat-latest', 'gpt-4.1', 'gpt-4o-mini', 'gpt-3.5-turbo', 'llama3.2', 'mistral-nemo', '', undefined]) {
            assert.equal(isReasoningModel(model), false, String(model));
        }
    });
});
