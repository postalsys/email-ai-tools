'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer, chatResponse } = require('./helpers/mock-server');
const { estimateTokens, fitLength, fitPrompt } = require('../lib/token-estimate');
const { generateSummary } = require('..');

// 64 KB of CJK text with no whitespace or punctuation, the input that made the old tokenizer
// loop take 24 s per encode
const cjk = size => '\u6f22\u5b57\u4eee\u540d\u4e2d\u6587\u65e5\u672c\u8a9e\u6587\u5b57'.repeat(Math.ceil(size / 11)).substring(0, size);

function timeIt(fn, reps) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) {
        fn();
    }
    return Number(process.hrtime.bigint() - start) / 1e6;
}

describe('token estimate', () => {
    it('counts ASCII at 3 characters per token plus the margin', () => {
        assert.equal(estimateTokens('a'.repeat(300)), 110);
    });

    it('counts every non-ASCII character as a token', () => {
        assert.equal(estimateTokens(cjk(100)), 110);
    });

    it('counts characters that JSON escaping doubles as two', () => {
        assert.equal(estimateTokens('\n'.repeat(300)), 220);
    });

    it('fitLength returns a prefix whose estimate fits', () => {
        const text = 'Hello world. ' + cjk(5000) + ' done';
        const len = fitLength(text, 1000);
        assert.ok(len > 0 && len < text.length);
        assert.ok(estimateTokens(text.substring(0, len)) <= 1000);
        assert.ok(estimateTokens(text.substring(0, len + 1)) > 1000);
    });

    it('fitLength never cuts a surrogate pair in half', () => {
        const text = '\u{1F600}'.repeat(100);
        for (let tokens = 1; tokens < 50; tokens++) {
            const len = fitLength(text, tokens);
            assert.equal(len % 2, 0);
        }
    });

    it('fits a 64 KB CJK body in well under 100 ms', () => {
        const text = cjk(64 * 1024);
        const ms = timeIt(() => fitLength(text, 18000), 1);
        assert.ok(ms < 100, `took ${ms} ms`);
    });

    it('scales linearly with the input size', () => {
        const small = cjk(256 * 1024);
        const large = cjk(512 * 1024);
        // warm up
        timeIt(() => estimateTokens(small) + fitLength(small, 1e9), 3);
        const t1 = timeIt(() => estimateTokens(small) + fitLength(small, 1e9), 10);
        const t2 = timeIt(() => estimateTokens(large) + fitLength(large, 1e9), 10);
        assert.ok(t2 < t1 * 3 + 20, `256K: ${t1} ms, 512K: ${t2} ms`);
    });
});

describe('prompt fitting', () => {
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

    it('fitPrompt cuts only the text and reports what it removed', () => {
        const overhead = 'Prefix\n';
        const result = fitPrompt({ text: 'word '.repeat(1000), maxTokens: 100, overhead });

        assert.ok(estimateTokens(overhead) + estimateTokens(result.text) <= 100);
        assert.ok('word '.repeat(1000).startsWith(result.text));
        assert.equal(result.charactersRemoved, 5000 - result.text.length);
        assert.ok(result.charactersRemoved > 0);
    });

    it('fitPrompt applies the length cap without splitting a surrogate pair', () => {
        const text = 'a'.repeat(9) + '\ud83d\ude00' + 'b'.repeat(10);
        const result = fitPrompt({ text, maxLength: 10, maxTokens: 1000 });

        assert.equal(result.text, 'a'.repeat(9));
        assert.equal(result.charactersRemoved, text.length - 9);
    });

    it('fitPrompt takes the overhead as strings or token counts already estimated', () => {
        const fitted = fitPrompt({ text: 'hello world, hello world', maxTokens: 6, overhead: [2, 'xx'] });
        assert.ok(estimateTokens(fitted.text) <= 3);
        assert.ok(fitted.charactersRemoved > 0);

        assert.throws(
            () => fitPrompt({ text: 'hello', maxTokens: 5, overhead: 'x'.repeat(100) }),
            err => {
                assert.equal(err.code, 'PROMPT_TOO_LONG');
                assert.equal(err.originalLength, 5);
                assert.equal(err.charactersRemoved, 5);
                return true;
            }
        );
        assert.throws(() => fitPrompt({ text: 'hello', maxTokens: 5, overhead: [3, 'xxxxxx'] }), { code: 'PROMPT_TOO_LONG' });
    });

    it('generateSummary prepares a 64 KB CJK body in one step and fits the limit', { timeout: 5000 }, async () => {
        mock.setHandler(() => chatResponse({ sentiment: 'neutral', summary: 'ok', shouldReply: false, riskAssessment: { risk: 1 } }));

        const text = cjk(64 * 1024);
        // the old loop took minutes here, the test timeout is the regression catch
        const { result, usage } = await generateSummary({ headers: [], text }, 'token', { baseApiUrl: mock.url, maxTokens: 18000 });
        assert.equal(result.summary, 'ok');
        assert.ok(usage.charactersRemoved > 0);

        // the budget covers the system message and the email object together
        const [system, user] = mock.requests[0].body.messages;
        const sent = JSON.parse(user.content);
        const sentText = sent.text;
        const estimate = estimateTokens(system.content) + estimateTokens(JSON.stringify(Object.assign({}, sent, { text: '' }))) + estimateTokens(sentText);
        assert.ok(estimate <= 18000, `estimate ${estimate}`);
        assert.ok(sentText.length > 10000 && sentText.length < text.length);
        assert.ok(text.startsWith(sentText));
        assert.equal(usage.charactersRemoved, text.length - sentText.length);
    });

    it('generateSummary keeps short text intact', async () => {
        mock.setHandler(() => chatResponse({ sentiment: 'neutral', summary: 'ok', shouldReply: false, riskAssessment: { risk: 1 } }));

        const { usage } = await generateSummary({ headers: [], text: 'Short message' }, 'token', { baseApiUrl: mock.url, verbose: true });
        assert.equal(usage.charactersRemoved, 0);
        assert.equal(usage.text, 'Short message');
    });

    it('generateSummary throws PROMPT_TOO_LONG when the prompt alone exceeds the limit', async () => {
        await assert.rejects(() => generateSummary({ headers: [], text: 'hello' }, 'token', { baseApiUrl: mock.url, maxTokens: 50 }), {
            code: 'PROMPT_TOO_LONG'
        });
        assert.equal(mock.requests.length, 0);
    });
});
