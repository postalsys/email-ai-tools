'use strict';

// Loads every runtime dependency through require(), including the jsdom-backed mimeHtml getter of
// email-text-tools that the summary code never reaches. Under `npm run test:cjs` (require(esm)
// disabled) this fails as soon as anything in the runtime graph is ESM-only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dependencies } = require('../package.json');

describe('CommonJS dependency graph', () => {
    for (const name of Object.keys(dependencies)) {
        it(`require('${name}') loads`, () => {
            assert.ok(require(name));
        });
    }

    it('loads the jsdom-backed mimeHtml from email-text-tools', () => {
        assert.equal(typeof require('@postalsys/email-text-tools').mimeHtml, 'function');
    });
});
