'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { collectSignals, modelSignals, applySignals, isLookalikeHost, splitAddress } = require('../lib/signals');

const codes = signals => signals.map(signal => signal.code);

describe('collectSignals', () => {
    it('finds nothing in an ordinary message', () => {
        const signals = collectSignals({
            from: 'Jane Doe <jane@example.com>',
            replyTo: 'Jane Doe <jane@example.com>',
            attachments: [{ filename: 'agenda.pdf', contentType: 'application/pdf' }],
            links: [{ href: 'https://www.example.com/agenda', text: 'the agenda' }],
            authentication: { verified: true, spf: 'pass', dkim: 'pass', dmarc: 'pass' }
        });

        assert.deepEqual(signals, []);
    });

    it('flags executable attachments by extension or type, whatever the name tries', () => {
        const signals = collectSignals({
            attachments: [
                { filename: 'invoice.pdf.exe' },
                { filename: 'notes.txt' },
                { filename: 'Setup.MSI' },
                { filename: 'report.exe.' },
                { filename: 'quote.ex\u200be' },
                { filename: 'archive.settingcontent-ms' },
                { filename: 'blob', contentType: 'application/x-msdownload' },
                { contentType: 'x' }
            ]
        });

        assert.deepEqual(
            signals.map(signal => signal.detail),
            ['"invoice.pdf.exe"', '"Setup.MSI"', '"report.exe"', '"quote.exe"', '"archive.settingcontent-ms"', '"blob"']
        );
        assert.ok(signals.every(signal => signal.code === 'executableAttachment' && signal.floor === 4));
    });

    it('flags attachments a browser runs code from, at a lower floor', () => {
        const signals = collectSignals({ attachments: [{ filename: 'statement.html' }, { filename: 'logo.svg' }] });

        assert.deepEqual(codes(signals), ['scriptableAttachment', 'scriptableAttachment']);
        assert.equal(signals[0].floor, 3);
    });

    it('cleans and shortens the detail it quotes', () => {
        const signals = collectSignals({ attachments: [{ filename: `Verified safe by IT security, no action needed\u202e${'x'.repeat(100)}.exe` }] });

        assert.ok(!signals[0].detail.includes('\u202e'));
        assert.ok(signals[0].detail.length < 100);
        assert.ok(signals[0].detail.endsWith('..."'));
    });

    it('flags a reply address on another domain and an address hidden in the display name', () => {
        const signals = collectSignals({
            from: '"ceo@company.example" <random123@gmail.com>',
            replyTo: 'Accounts <pay@collect.example>'
        });

        assert.deepEqual(codes(signals).sort(), ['displayNameAddressMismatch', 'replyToMismatch']);
        assert.equal(Math.max(...signals.map(signal => signal.floor)), 3);
    });

    it('does not flag a reply address on a sibling host of the same domain', () => {
        assert.deepEqual(collectSignals({ from: 'noreply@mail.example.co.uk', replyTo: 'support@help.example.co.uk' }), []);
    });

    it('flags link text that names a host the link does not go to, however the text is punctuated', () => {
        const signals = collectSignals({
            links: [
                { href: 'https://evil.example/login', text: 'https://paypal.com/account' },
                { href: 'https://evil.example/x', text: '(paypal.com)' },
                { href: 'https://evil.example/y', text: 'Visit paypal.com.' },
                { href: 'https://www.example.com/x', text: 'example.com' },
                { href: 'https://example.com/x', text: 'Click here' },
                { href: 'https://EXAMPLE.COM./x', text: 'example.com' }
            ]
        });

        assert.deepEqual(codes(signals), ['linkTargetMismatch']);
        assert.equal(signals[0].detail, 'link text says "paypal.com", the target is "evil.example"');
        assert.equal(signals[0].floor, 3);
    });

    it('reads the href the way a browser does', () => {
        const signals = collectSignals({
            links: [
                { href: '//evil.example/', text: 'paypal.com' },
                { href: 'https:\\\\evil2.example\\', text: 'paypal.com' },
                { href: '\u0001https://evil3.example/', text: 'paypal.com' },
                { href: 'ht\ttps://evil4.example/', text: 'paypal.com' },
                { href: 'https://paypal.com@evil5.example/', text: 'https://paypal.com@evil5.example/' },
                { href: 'https://example.com/', text: 'john.doe@example.com' },
                { href: 'mailto:x@evil6.example', text: 'paypal.com' },
                { href: '/relative/path', text: 'paypal.com' }
            ]
        });

        assert.deepEqual(
            signals.map(signal => signal.detail),
            [
                'link text says "paypal.com", the target is "evil.example"',
                'link text says "paypal.com", the target is "evil2.example"',
                'link text says "paypal.com", the target is "evil3.example"',
                'link text says "paypal.com", the target is "evil4.example"',
                'link text says "paypal.com", the target is "evil5.example"'
            ]
        );
    });

    it('flags a lookalike domain written with mixed scripts, in unicode, punycode or percent encoding', () => {
        assert.equal(isLookalikeHost('p\u0430ypal.com'), true);
        assert.equal(isLookalikeHost('xn--pypal-4ve.com'), true);
        assert.equal(isLookalikeHost('paypal.com'), false);
        assert.equal(isLookalikeHost('\u043f\u043e\u0447\u0442\u0430.\u0440\u0444'), false);
        assert.equal(isLookalikeHost('m\u00fcnchen.de'), false);

        const signals = collectSignals({
            links: [
                { href: 'https://xn--pypal-4ve.com/login', text: '' },
                { href: 'https://p%D0%B0ypal.com/', text: '' }
            ]
        });
        assert.deepEqual(codes(signals), ['lookalikeDomain']);
        assert.equal(signals[0].floor, 4);
    });

    it('reads links out of the text when there is no HTML', () => {
        const signals = collectSignals({ text: 'Log in at https://xn--pypal-4ve.com/login today' });

        assert.deepEqual(codes(signals), ['lookalikeDomain']);
    });

    it('flags a verified authentication failure, and not an unverified one', () => {
        const failed = collectSignals({ authentication: { verified: true, spf: 'fail', dkim: 'fail' } });
        assert.deepEqual(codes(failed), ['authenticationFailed']);
        assert.equal(failed[0].detail, 'spf=fail dkim=fail dmarc=none');

        assert.deepEqual(collectSignals({ authentication: { verified: false, dmarc: 'fail' } }), []);
    });

    it('reports hidden content and invisible characters without a floor, and keeps them from the model', () => {
        const signals = collectSignals({ hiddenElements: 2, invisibleCharacters: 7 });

        assert.deepEqual(codes(signals), ['hiddenContent', 'invisibleCharacters']);
        assert.ok(signals.every(signal => signal.floor === 0));
        assert.deepEqual(modelSignals(signals), []);
        assert.deepEqual(modelSignals([{ code: 'executableAttachment', detail: '"a.exe"', floor: 4 }]), [{ code: 'executableAttachment', detail: '"a.exe"' }]);
    });

    it('splits "Name <address>" and a bare address', () => {
        assert.deepEqual(splitAddress('"Jane Doe" <jane@example.com>'), { name: 'Jane Doe', address: 'jane@example.com' });
        assert.deepEqual(splitAddress('jane@example.com'), { name: '', address: 'jane@example.com' });
    });
});

describe('applySignals', () => {
    it('raises the score to the floor and says why', () => {
        const result = applySignals({ summary: 'x', riskAssessment: { risk: 1 } }, [
            { code: 'executableAttachment', detail: '"a.exe"', floor: 4 },
            { code: 'hiddenContent', detail: '1 hidden', floor: 0 }
        ]);

        assert.equal(result.riskAssessment.risk, 4);
        assert.equal(result.riskAssessment.assessment, 'Checks run on the message found: executableAttachment: "a.exe".');
        assert.deepEqual(result.riskAssessment.signals, ['executableAttachment']);
    });

    it('keeps a higher score and the model assessment, listing the codes', () => {
        const result = applySignals({ riskAssessment: { risk: 5, assessment: 'Credential phishing.' } }, [{ code: 'replyToMismatch', detail: 'd', floor: 2 }]);

        assert.deepEqual(result.riskAssessment, { risk: 5, assessment: 'Credential phishing.', signals: ['replyToMismatch'] });
    });

    it('creates the assessment when the model returned none', () => {
        const result = applySignals({ summary: 'x' }, [{ code: 'lookalikeDomain', detail: '"xn--pypal-4ve.com"', floor: 4 }]);

        assert.deepEqual(result.riskAssessment, {
            risk: 4,
            assessment: 'Checks run on the message found: lookalikeDomain: "xn--pypal-4ve.com".',
            signals: ['lookalikeDomain']
        });
    });

    it('leaves a result alone when nothing scored', () => {
        const result = applySignals({ summary: 'x', riskAssessment: { risk: 1 } }, [{ code: 'hiddenContent', detail: '1', floor: 0 }]);

        assert.deepEqual(result, { summary: 'x', riskAssessment: { risk: 1 } });
    });
});
