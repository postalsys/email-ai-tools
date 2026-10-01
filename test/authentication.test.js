'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAuthenticationResults, isTrustedAuthservId, authenticationBlock, authenticationFailed } = require('../lib/authentication');

describe('parseAuthenticationResults', () => {
    it('reads the authserv-id and the first result of each method', () => {
        const parsed = parseAuthenticationResults(
            'mx.google.com; dkim=pass header.i=@example.com header.s=sel header.b=abc; spf=pass (google.com: domain of a@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=a@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com; dkim=fail header.i=@other.example'
        );

        assert.deepEqual(parsed, { authservId: 'mx.google.com', results: { dkim: 'pass', spf: 'pass', dmarc: 'pass' } });
    });

    it('reads a header with a version and comments carrying semicolons', () => {
        const parsed = parseAuthenticationResults('mail.example.org 1; spf=softfail (reason; with semicolon) smtp.mailfrom=x@y.example; arc=none');

        assert.equal(parsed.authservId, 'mail.example.org');
        assert.deepEqual(parsed.results, { spf: 'softfail', arc: 'none' });
    });

    it('reads the Microsoft form, which names no server', () => {
        const parsed = parseAuthenticationResults(
            'spf=pass (sender IP is 40.107.1.2) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100'
        );

        assert.equal(parsed.authservId, null);
        assert.deepEqual(parsed.results, { spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    });

    it('keeps a method=result inside a comment or a quoted string from counting', () => {
        const parsed = parseAuthenticationResults(
            'mx.google.com; spf=fail (google.com: domain of "x);dmarc=pass;("@evil.example designates) smtp.mailfrom=x; dkim=pass (a (b) ; dmarc=pass ; (c) d); dmarc=fail'
        );

        assert.deepEqual(parsed, { authservId: 'mx.google.com', results: { spf: 'fail', dkim: 'pass', dmarc: 'fail' } });
    });

    it('returns null for an empty value', () => {
        assert.equal(parseAuthenticationResults(''), null);
        assert.equal(parseAuthenticationResults(undefined), null);
    });
});

describe('isTrustedAuthservId', () => {
    it('matches the name itself and hosts under it, whatever the case of the id', () => {
        assert.equal(isTrustedAuthservId('MX.google.com', ['mx.google.com']), true);
        assert.equal(isTrustedAuthservId('mx.google.com.evil.example', ['mx.google.com']), false);
        assert.equal(isTrustedAuthservId('evilmx.google.com', ['mx.google.com']), false);
        assert.equal(isTrustedAuthservId('mx1.example.com', ['example.com']), true);
        assert.equal(isTrustedAuthservId('notexample.com', ['example.com']), false);
        assert.equal(isTrustedAuthservId('example.com', ['mx1.example.com']), false);
        assert.equal(isTrustedAuthservId('mx.google.com', []), false);
    });

    it('accepts a missing name only when told to', () => {
        assert.equal(isTrustedAuthservId(null, ['mx.google.com']), false);
        assert.equal(isTrustedAuthservId(null, ['mx.google.com'], true), true);
    });
});

describe('authenticationBlock', () => {
    it('marks a verdict from a trusted server as verified', () => {
        assert.deepEqual(
            authenticationBlock('mx.google.com; spf=pass; dkim=pass; dmarc=pass', {
                trustedAuthservIds: ['mx.google.com'],
                acceptUnnamedAuthentication: false
            }),
            {
                verified: true,
                authservId: 'mx.google.com',
                spf: 'pass',
                dkim: 'pass',
                dmarc: 'pass'
            }
        );
    });

    it('keeps an unverified verdict, marked as such', () => {
        const block = authenticationBlock('attacker.example; spf=pass; dkim=pass; dmarc=pass', {
            trustedAuthservIds: ['mx.google.com'],
            acceptUnnamedAuthentication: false
        });

        assert.equal(block.verified, false);
        assert.equal(block.authservId, 'attacker.example');
        assert.equal(block.dmarc, 'pass');
    });

    it('returns null without a header', () => {
        assert.equal(authenticationBlock('', { trustedAuthservIds: [], acceptUnnamedAuthentication: false }), null);
    });
});

describe('authenticationFailed', () => {
    it('is true for a verified DMARC failure, or SPF and DKIM both failing without DMARC', () => {
        assert.equal(authenticationFailed({ verified: true, dmarc: 'fail', spf: 'pass' }), true);
        assert.equal(authenticationFailed({ verified: true, spf: 'fail', dkim: 'fail' }), true);
        assert.equal(authenticationFailed({ verified: true, spf: 'softfail', dkim: 'permerror' }), true);
    });

    it('is false for a pass, a partial failure, an unverified verdict or no verdict', () => {
        assert.equal(authenticationFailed({ verified: true, spf: 'pass', dkim: 'pass', dmarc: 'pass' }), false);
        assert.equal(authenticationFailed({ verified: true, spf: 'fail', dkim: 'pass' }), false);
        assert.equal(authenticationFailed({ verified: true, spf: 'fail', dkim: 'fail', dmarc: 'pass' }), false);
        assert.equal(authenticationFailed({ verified: false, dmarc: 'fail' }), false);
        assert.equal(authenticationFailed(null), false);
    });
});
