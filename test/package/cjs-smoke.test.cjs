'use strict';

// CommonJS checks of the built package, loaded by name the way EmailEngine loads it. `npm run test:cjs`
// runs this (with the rest of the suite) under NODE_OPTIONS=--no-experimental-require-module:
// EmailEngine bundles this package into a @yao-pkg/pkg binary that can only load a CommonJS module
// graph, and Node 22+ enables require(esm) by default, which would hide an ES module reached
// through require(). With the flag set, such a module throws ERR_REQUIRE_ESM here instead of in
// the binary. Kept as plain JavaScript on purpose: a TypeScript loader could transpile an ES
// module dependency to CommonJS and mask exactly the failure this guards against.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMockServer, chatResponse } = require('../helpers/mock-server.cjs');

const root = path.resolve(__dirname, '..', '..');
const LIB_MODULES = ['api-request', 'authentication', 'generate-summary', 'get-api-url', 'list-models', 'signals', 'token-estimate', 'visible-text'];

const PUBLIC_KEYS = [
    'generateSummary',
    'listModels',
    'describeModel',
    'DEFAULT_MODEL',
    'DEFAULT_REASONING_EFFORT',
    'DEFAULT_MAX_TOKENS',
    'DEFAULT_SYSTEM_PROMPT',
    'DEFAULT_INSTRUCTIONS',
    'REASONING_EFFORTS',
    'ALLOWED_HEADERS'
];

describe('CommonJS build', () => {
    it('resolves every entry point to dist/cjs', () => {
        for (const entry of ['', '/index', '/index.js']) {
            assert.equal(require.resolve('@postalsys/email-ai-tools' + entry), path.join(root, 'dist', 'cjs', 'index.js'));
        }
        for (const name of LIB_MODULES) {
            const file = path.join(root, 'dist', 'cjs', 'lib', name + '.js');
            assert.equal(require.resolve('@postalsys/email-ai-tools/lib/' + name), file);
            assert.equal(require.resolve('@postalsys/email-ai-tools/lib/' + name + '.js'), file);
        }
        assert.equal(require('@postalsys/email-ai-tools/package.json').name, '@postalsys/email-ai-tools');
    });

    it('keeps the shape of the pre-TypeScript module', () => {
        const ai = require('@postalsys/email-ai-tools');
        assert.deepEqual(Object.keys(ai), PUBLIC_KEYS);
        for (const key of PUBLIC_KEYS) {
            const descriptor = Object.getOwnPropertyDescriptor(ai, key);
            assert.ok(descriptor.writable && descriptor.enumerable && !descriptor.get, key);
        }
        // what TypeScript and Babel generated default imports read
        assert.equal(ai.default, ai);

        const summary = require('@postalsys/email-ai-tools/lib/generate-summary');
        assert.equal(ai.generateSummary, summary.generateSummary);
        assert.equal(ai.ALLOWED_HEADERS, summary.ALLOWED_HEADERS);
        assert.equal(typeof summary.isReasoningModel, 'function');
        assert.equal(typeof summary.resetParameterCache, 'function');
        assert.equal(ai.listModels, require('@postalsys/email-ai-tools/lib/list-models').listModels);
        assert.equal(typeof require('@postalsys/email-ai-tools/lib/list-models').nonChatModelPattern, 'function');
    });

    it('summarizes a message through the whole CommonJS runtime graph', async () => {
        const mock = await createMockServer();
        try {
            mock.setHandler(() => chatResponse({ summary: 'Hello', sentiment: 'neutral', shouldReply: false, riskAssessment: { risk: 1 } }));
            const { generateSummary } = require('@postalsys/email-ai-tools');
            const { result, usage } = await generateSummary(
                { subject: 'Hi', from: 'a@example.com', html: '<p>Hello <a href="https://example.com">example.com</a></p>', text: '' },
                'test-token',
                { baseApiUrl: mock.url }
            );
            assert.equal(result.summary, 'Hello');
            assert.equal(usage.tokens, 150);
            const version = require('@postalsys/email-ai-tools/package.json').version;
            assert.equal(mock.requests[0].headers['user-agent'], `@postalsys/email-ai-tools/${version}`);
        } finally {
            await mock.close();
        }
    });
});
