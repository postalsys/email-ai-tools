'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');

describe('index exports', () => {
    it('exports generateSummary as a function', () => {
        assert.equal(typeof lib.generateSummary, 'function');
    });

    it('exports listModels as a function', () => {
        assert.equal(typeof lib.listModels, 'function');
    });

    it('exports the default model, reasoning effort and token budget', () => {
        assert.equal(typeof lib.DEFAULT_MODEL, 'string');
        assert.ok(lib.DEFAULT_MODEL.length > 0);
        assert.equal(lib.DEFAULT_REASONING_EFFORT, 'low');
        assert.ok(lib.REASONING_EFFORTS.includes(lib.DEFAULT_REASONING_EFFORT));
        assert.equal(lib.DEFAULT_MAX_TOKENS, 30000);
    });

    it('exports the header whitelist as a frozen list', () => {
        assert.ok(Object.isFrozen(lib.ALLOWED_HEADERS));
        assert.ok(lib.ALLOWED_HEADERS.includes('authentication-results'));
        assert.ok(lib.ALLOWED_HEADERS.includes('subject'));
    });

    it('exports DEFAULT_SYSTEM_PROMPT as a non-empty string', () => {
        assert.equal(typeof lib.DEFAULT_SYSTEM_PROMPT, 'string');
        assert.ok(lib.DEFAULT_SYSTEM_PROMPT.length > 0);
    });

    it('exports DEFAULT_INSTRUCTIONS as a non-empty string', () => {
        assert.equal(typeof lib.DEFAULT_INSTRUCTIONS, 'string');
        assert.ok(lib.DEFAULT_INSTRUCTIONS.length > 0);
    });

    it('no longer exports the removed modules', () => {
        for (const name of [
            'riskAnalysis',
            'generateEmbeddings',
            'getChunkEmbeddings',
            'embeddingsQuery',
            'questionQuery',
            'DEFAULT_USER_PROMPT',
            'resetParameterCache'
        ]) {
            assert.ok(!(name in lib), name);
        }
    });
});
