// Checks of the built package (dist/, built by the pretest script) through the package.json
// exports map, the way an installed copy is loaded: Node resolves the package name to the package
// itself when the specifier is used from inside it. The CommonJS side is covered in more detail by
// cjs-smoke.test.cjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import emailAiTools, { generateSummary, listModels, describeModel, DEFAULT_MODEL, ALLOWED_HEADERS } from '@postalsys/email-ai-tools';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = require.resolve('typescript/bin/tsc');
const { createMockServer, chatResponse } = require('../helpers/mock-server.cjs');

const LIB_MODULES = ['api-request', 'authentication', 'generate-summary', 'get-api-url', 'list-models', 'signals', 'token-estimate', 'visible-text'];

describe('ES module build', () => {
    it('resolves every entry point to dist/esm', () => {
        const esm = file => 'file://' + path.join(root, 'dist', 'esm', file);
        for (const entry of ['', '/index', '/index.js']) {
            assert.equal(import.meta.resolve('@postalsys/email-ai-tools' + entry), esm('index.js'));
        }
        for (const name of LIB_MODULES) {
            assert.equal(import.meta.resolve('@postalsys/email-ai-tools/lib/' + name), esm('lib/' + name + '.js'));
            assert.equal(import.meta.resolve('@postalsys/email-ai-tools/lib/' + name + '.js'), esm('lib/' + name + '.js'));
        }
    });

    it('exposes named exports and a default export object with the same members', async () => {
        const cjs = require('@postalsys/email-ai-tools');
        assert.deepEqual(Object.keys(emailAiTools), Object.keys(cjs));
        assert.equal(emailAiTools.generateSummary, generateSummary);
        assert.equal(emailAiTools.listModels, listModels);
        assert.equal(emailAiTools.describeModel, describeModel);
        assert.equal(DEFAULT_MODEL, cjs.DEFAULT_MODEL);
        assert.deepEqual(ALLOWED_HEADERS, cjs.ALLOWED_HEADERS);
        assert.equal((await import('@postalsys/email-ai-tools/lib/generate-summary')).generateSummary, generateSummary);
        assert.equal(typeof (await import('@postalsys/email-ai-tools/lib/signals.js')).collectSignals, 'function');
    });

    it('summarizes a message through the ES module runtime graph', async () => {
        const mock = await createMockServer();
        try {
            mock.setHandler(() => chatResponse({ summary: 'Hello', sentiment: 'neutral', shouldReply: false, riskAssessment: { risk: 1 } }));
            const { result } = await generateSummary({ subject: 'Hi', html: '<p>Hello</p>' }, 'test-token', { baseApiUrl: mock.url });
            assert.equal(result.summary, 'Hello');
        } finally {
            await mock.close();
        }
    });
});

describe('Packed package', () => {
    it('ships both builds and leaves the sources and tests out', () => {
        // Packs a copy without scripts: npm 10 runs prepare on `npm pack --dry-run` even with
        // --ignore-scripts, which would rebuild dist/ under the test files running in parallel
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-ai-tools-pack-'));
        let result;
        try {
            fs.cpSync(root, dir, { recursive: true, filter: source => !/[\\/](node_modules|\.git|test|coverage)$/.test(source) });
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            delete manifest.scripts;
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
            result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        assert.equal(result.status, 0, result.stderr);
        const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
        for (const format of ['cjs', 'esm']) {
            for (const name of ['index', 'package-info', ...LIB_MODULES.map(name => 'lib/' + name)]) {
                assert.ok(files.includes(`dist/${format}/${name}.js`), `dist/${format}/${name}.js is packed`);
                assert.ok(files.includes(`dist/${format}/${name}.d.ts`), `dist/${format}/${name}.d.ts is packed`);
            }
            assert.ok(files.includes(`dist/${format}/package.json`));
        }
        for (const file of files) {
            assert.ok(!/^(src|test|scripts|examples|coverage)\//.test(file), `${file} must not be packed`);
        }
    });
});

// each tsc run has its own temporary project, so they run side by side
describe('Type declarations', { concurrency: true, timeout: 120 * 1000 }, () => {
    const esmConsumer = `
import emailAiTools, { generateSummary, listModels } from '@postalsys/email-ai-tools';
import type { GenerateSummaryOptions, SummaryMessage, SummaryResult } from '@postalsys/email-ai-tools';
import { estimateTokens } from '@postalsys/email-ai-tools/lib/token-estimate';

export async function run(): Promise<string | undefined> {
    const message: SummaryMessage = { subject: 'S', from: { name: 'A', address: 'a@example.com' }, text: 'body', headers: [{ key: 'to', value: 'b@example.com' }] };
    const options: GenerateSummaryOptions = { gptModel: emailAiTools.DEFAULT_MODEL, trustedAuthservIds: ['mx.example.com'], temperature: 0.2 };
    const { result, usage } = await generateSummary(message, 'token', options);
    const typed: SummaryResult = result;
    const { models } = await listModels('token', { chatOnly: false });
    return typed.summary + usage.model + models.map(model => model.name).join() + estimateTokens('x');
}
`;

    const cjsConsumer = `
import emailAiTools = require('@postalsys/email-ai-tools');
import signals = require('@postalsys/email-ai-tools/lib/signals');

export async function run(): Promise<number> {
    const { result } = await emailAiTools.generateSummary({ text: 'x' }, 'token');
    return signals.collectSignals({ from: 'a@example.com' }).length + (result.riskAssessment?.risk ?? 0) + emailAiTools.REASONING_EFFORTS.length;
}
`;

    // Type-checks a consumer against the built declarations the way an installed copy is
    // resolved: the package is linked into a temporary project, so the specifier goes through the
    // package.json exports map
    const typeCheck = async (source, compilerOptions, type) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-ai-tools-types-'));
        try {
            fs.mkdirSync(path.join(dir, 'node_modules', '@postalsys'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
            fs.symlinkSync(root, path.join(dir, 'node_modules', '@postalsys', 'email-ai-tools'), 'dir');
            fs.symlinkSync(path.join(root, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'), 'dir');
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, ...(type ? { type } : {}) }));
            fs.writeFileSync(path.join(dir, 'consumer.ts'), source);
            fs.writeFileSync(
                path.join(dir, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        target: 'ES2022',
                        lib: ['ES2023'],
                        types: ['node'],
                        strict: true,
                        exactOptionalPropertyTypes: true,
                        skipLibCheck: true,
                        noEmit: true,
                        ...compilerOptions
                    },
                    include: ['consumer.ts']
                })
            );
            return await new Promise(resolve => {
                execFile(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], (err, stdout, stderr) =>
                    resolve({ status: err ? Number(err.code) || 1 : 0, output: stdout + stderr })
                );
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };

    const node16 = { module: 'node16', moduleResolution: 'node16' };

    for (const [label, options, type] of [
        ['a node16 ES module project', node16, 'module'],
        ['a node16 CommonJS project', node16, undefined],
        ['bundler resolution', { module: 'esnext', moduleResolution: 'bundler' }, 'module'],
        ['node10 resolution', { module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0' }, undefined]
    ]) {
        it(`type-check an ES module style consumer in ${label}`, async () => {
            const { status, output } = await typeCheck(esmConsumer, { ...options, esModuleInterop: true }, type);
            assert.equal(status, 0, output);
        });
    }

    it('type-check a CommonJS consumer', async () => {
        const { status, output } = await typeCheck(cjsConsumer, node16);
        assert.equal(status, 0, output);
    });
});
