'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../index');

describe('index exports', () => {
    it('exports generateSummary as a function', () => {
        assert.equal(typeof lib.generateSummary, 'function');
    });

    it('exports generateEmbeddings as a function', () => {
        assert.equal(typeof lib.generateEmbeddings, 'function');
    });

    it('exports getChunkEmbeddings as a function', () => {
        assert.equal(typeof lib.getChunkEmbeddings, 'function');
    });

    it('exports embeddingsQuery as a function', () => {
        assert.equal(typeof lib.embeddingsQuery, 'function');
    });

    it('exports questionQuery as a function', () => {
        assert.equal(typeof lib.questionQuery, 'function');
    });

    it('exports riskAnalysis as a function', () => {
        assert.equal(typeof lib.riskAnalysis, 'function');
    });

    it('exports listModels as a function', () => {
        assert.equal(typeof lib.listModels, 'function');
    });

    it('exports DEFAULT_SYSTEM_PROMPT as a non-empty string', () => {
        assert.equal(typeof lib.DEFAULT_SYSTEM_PROMPT, 'string');
        assert.ok(lib.DEFAULT_SYSTEM_PROMPT.length > 0);
    });

    it('exports DEFAULT_USER_PROMPT as a non-empty string', () => {
        assert.equal(typeof lib.DEFAULT_USER_PROMPT, 'string');
        assert.ok(lib.DEFAULT_USER_PROMPT.length > 0);
    });
});
