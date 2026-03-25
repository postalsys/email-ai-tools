'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, chatResponse, instructResponse, errorResponse } = require('./helpers/mock-server');
const { embeddingsQuery, questionQuery } = require('../lib/embeddings-query');

describe('embeddings-query', () => {
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

    describe('embeddingsQuery', () => {
        it('returns answer and message IDs from response', async () => {
            mock.setHandler(() => chatResponse('Answer: The meeting is on Friday.\nMessage-ID: <msg001@example.com>'));

            const result = await embeddingsQuery('test-token', {
                baseApiUrl: mock.url,
                question: 'When is the meeting?',
                contextChunks: '- EMAIL #1:\nFrom: test@example.com\nSubject: Meeting\nMessage-ID: <msg001@example.com>\n\nMeeting on Friday.'
            });

            assert.equal(result.answer, 'The meeting is on Friday.');
            assert.deepEqual(result.messageId, ['<msg001@example.com>']);
            assert.equal(result.id, 'chatcmpl-test123');
            assert.equal(result.tokens, 150);
            assert.equal(result.model, 'gpt-5-mini');
        });

        it('deduplicates message IDs', async () => {
            mock.setHandler(() =>
                chatResponse('Answer: Found in multiple emails.\nMessage-ID: <msg001@example.com>, <msg001@example.com>, <msg002@example.com>')
            );

            const result = await embeddingsQuery('test-token', {
                baseApiUrl: mock.url,
                question: 'Test?',
                contextChunks: 'context'
            });

            assert.deepEqual(result.messageId, ['<msg001@example.com>', '<msg002@example.com>']);
        });

        it('sends correct request payload with chat model', async () => {
            mock.setHandler(() => chatResponse('Answer: Test\nMessage-ID: <test@example.com>'));

            await embeddingsQuery('my-api-key', {
                baseApiUrl: mock.url,
                question: 'What happened?',
                contextChunks: 'email context here',
                userData: { name: 'John', email: 'john@example.com' },
                user: 'user123',
                temperature: 0.5
            });

            const req = mock.requests[0];
            assert.equal(req.method, 'POST');
            assert.equal(req.url, '/v1/chat/completions');
            assert.equal(req.body.model, 'gpt-5-mini');
            assert.equal(req.body.user, 'user123');
            assert.equal(req.body.temperature, 0.5);
            assert.equal(req.body.messages.length, 2);
            assert.ok(req.body.messages[1].content.includes('What happened?'));
            assert.ok(req.body.messages[1].content.includes('email context here'));
            assert.ok(req.body.messages[1].content.includes('John'));
            assert.ok(req.body.messages[1].content.includes('john@example.com'));
        });

        it('uses instruct endpoint for gpt-3.5-turbo-instruct', async () => {
            mock.setHandler(() => instructResponse('Answer: Instruct answer\nMessage-ID: <test@example.com>'));

            const result = await embeddingsQuery('test-token', {
                baseApiUrl: mock.url,
                question: 'Test?',
                contextChunks: 'context',
                gptModel: 'gpt-3.5-turbo-instruct'
            });

            assert.equal(result.answer, 'Instruct answer');
            assert.equal(result.model, 'gpt-3.5-turbo-instruct');
            const req = mock.requests[0];
            assert.equal(req.url, '/v1/completions');
            assert.ok(typeof req.body.prompt === 'string');
            assert.ok(req.body.max_tokens > 0);
        });

        it('handles response with no answer section', async () => {
            mock.setHandler(() => chatResponse('I could not find relevant information.'));

            const result = await embeddingsQuery('test-token', {
                baseApiUrl: mock.url,
                question: 'Unknown topic?',
                contextChunks: 'irrelevant context'
            });

            assert.equal(result.answer, '');
        });

        it('retries on 429 rate limit', { timeout: 10000 }, async () => {
            let callCount = 0;
            mock.setHandler(() => {
                callCount++;
                if (callCount === 1) {
                    return errorResponse(429, 'Rate limited');
                }
                return chatResponse('Answer: Success after retry\nMessage-ID: <test@example.com>');
            });

            const result = await embeddingsQuery('test-token', {
                baseApiUrl: mock.url,
                question: 'Test?',
                contextChunks: 'context'
            });

            assert.equal(result.answer, 'Success after retry');
            assert.equal(callCount, 2);
        });

        it('throws on API errors', async () => {
            mock.setHandler(() => errorResponse(500, 'Server error', 'internal_error'));

            await assert.rejects(
                () =>
                    embeddingsQuery('test-token', {
                        baseApiUrl: mock.url,
                        question: 'Test?',
                        contextChunks: 'context'
                    }),
                err => {
                    assert.equal(err.message, 'Server error');
                    assert.equal(err.statusCode, 500);
                    return true;
                }
            );
        });
    });

    describe('questionQuery', () => {
        it('parses ordering and topic from JSON response', async () => {
            mock.setHandler(() => instructResponse({ ordering: 'newer_first', topic: 'Conference event' }));

            const result = await questionQuery('When is the next conference?', 'test-token', { baseApiUrl: mock.url });

            assert.equal(result.ordering, 'newer_first');
            assert.equal(result.topic, 'Conference event');
            assert.equal(result.id, 'cmpl-test123');
            assert.equal(result.tokens, 100);
            assert.equal(result.model, 'gpt-3.5-turbo-instruct');
        });

        it('parses time constraints from response', async () => {
            mock.setHandler(() =>
                instructResponse({
                    ordering: 'best_match',
                    start_time: '2024-01-01',
                    end_time: '2024-01-31',
                    topic: 'January emails'
                })
            );

            const result = await questionQuery('Show me emails from January 2024', 'test-token', {
                baseApiUrl: mock.url
            });

            assert.equal(result.ordering, 'best_match');
            assert.equal(result.start_time, '2024-01-01');
            assert.equal(result.end_time, '2024-01-31');
        });

        it('removes null values from response', async () => {
            mock.setHandler(() =>
                instructResponse({
                    ordering: 'newer_first',
                    start_time: null,
                    end_time: null,
                    topic: 'Test topic'
                })
            );

            const result = await questionQuery('Show me recent emails', 'test-token', { baseApiUrl: mock.url });

            assert.ok(!('start_time' in result));
            assert.ok(!('end_time' in result));
            assert.equal(result.ordering, 'newer_first');
        });

        it('extracts JSON from response with surrounding text', async () => {
            mock.setHandler(() => instructResponse('Based on the question:\n{"ordering":"older_first","topic":"First Amazon invoice"}\nDone.'));

            const result = await questionQuery('When did I get my first Amazon invoice?', 'test-token', {
                baseApiUrl: mock.url
            });

            assert.equal(result.ordering, 'older_first');
            assert.equal(result.topic, 'First Amazon invoice');
        });

        it('throws on empty question', async () => {
            await assert.rejects(
                () => questionQuery('', 'test-token', { baseApiUrl: mock.url }),
                err => {
                    assert.equal(err.message, 'Question not provided');
                    assert.equal(err.code, 'EmptyInput');
                    return true;
                }
            );
        });

        it('throws on null question', async () => {
            await assert.rejects(
                () => questionQuery(null, 'test-token', { baseApiUrl: mock.url }),
                err => {
                    assert.equal(err.code, 'EmptyInput');
                    return true;
                }
            );
        });

        it('defaults to gpt-3.5-turbo-instruct model', async () => {
            mock.setHandler(() => instructResponse({ ordering: 'best_match', topic: 'Test' }));

            await questionQuery('Test question', 'test-token', { baseApiUrl: mock.url });

            const req = mock.requests[0];
            assert.equal(req.url, '/v1/completions');
            assert.equal(req.body.model, 'gpt-3.5-turbo-instruct');
        });

        it('uses chat endpoint for chat models', async () => {
            mock.setHandler(() => chatResponse({ ordering: 'best_match', topic: 'Test' }));

            await questionQuery('Test question', 'test-token', {
                baseApiUrl: mock.url,
                gptModel: 'gpt-4'
            });

            const req = mock.requests[0];
            assert.equal(req.url, '/v1/chat/completions');
            assert.equal(req.body.model, 'gpt-4');
            assert.ok(Array.isArray(req.body.messages));
        });

        it('sets default temperature to 0.2', async () => {
            mock.setHandler(() => instructResponse({ ordering: 'best_match', topic: 'Test' }));

            await questionQuery('Test question', 'test-token', { baseApiUrl: mock.url });

            assert.equal(mock.requests[0].body.temperature, 0.2);
        });

        it('throws on invalid JSON response', async () => {
            mock.setHandler(() => instructResponse('I cannot understand the question'));

            await assert.rejects(
                () => questionQuery('Test?', 'test-token', { baseApiUrl: mock.url }),
                err => {
                    assert.ok(err.message.includes('Failed to parse'));
                    assert.equal(err.code, 'OutputParseFailed');
                    return true;
                }
            );
        });

        it('retries on 429 rate limit', { timeout: 10000 }, async () => {
            let callCount = 0;
            mock.setHandler(() => {
                callCount++;
                if (callCount === 1) {
                    return errorResponse(429, 'Rate limited');
                }
                return instructResponse({ ordering: 'best_match', topic: 'Retry success' });
            });

            const result = await questionQuery('Test?', 'test-token', { baseApiUrl: mock.url });

            assert.equal(result.topic, 'Retry success');
            assert.equal(callCount, 2);
        });

        it('throws on API errors', async () => {
            mock.setHandler(() => errorResponse(403, 'Forbidden', 'access_denied'));

            await assert.rejects(
                () => questionQuery('Test?', 'test-token', { baseApiUrl: mock.url }),
                err => {
                    assert.equal(err.message, 'Forbidden');
                    assert.equal(err.code, 'access_denied');
                    assert.equal(err.statusCode, 403);
                    return true;
                }
            );
        });
    });
});
