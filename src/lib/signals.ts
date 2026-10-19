import { getDomain, parse as parseDomain } from 'tldts';
import url from 'node:url';
import { authenticationFailed } from './authentication.js';
import type { AuthenticationBlock } from './authentication.js';
import { INVISIBLE_CHARS, MAX_LINK_TEXT_LENGTH } from './visible-text.js';
import type { MessageLink } from './visible-text.js';
import { truncate } from './token-estimate.js';

/** A fact established by a check run in code */
export interface Signal {
    code: string;
    detail: string;
    /** The least risk score a message carrying the signal gets, 0 for one that is only reported */
    floor: number;
}

/** What collectSignals() checks */
export interface SignalInput {
    /** Sender as "Name <address>" */
    from?: string | null | undefined;
    /** Reply-To as "Name <address>" */
    replyTo?: string | null | undefined;
    /** Attachments with filename and contentType */
    attachments?: Array<{ filename?: unknown; contentType?: unknown } | null | undefined> | null | undefined;
    /** Every link of the HTML, from visibleHtml() */
    links?: MessageLink[] | null | undefined;
    /** Text body, read for links when there is no HTML */
    text?: string | null | undefined;
    /** As returned by authenticationBlock() */
    authentication?: AuthenticationBlock | null | undefined;
    /** Hidden elements removed from the HTML */
    hiddenElements?: number | undefined;
    /** Invisible characters removed */
    invisibleCharacters?: number | undefined;
}

/** The part of the model's answer the signals apply to */
export interface RiskResult {
    riskAssessment?: { risk?: number; assessment?: string; signals?: string[]; [key: string]: unknown } | undefined;
    [key: string]: unknown;
}

// Checks run in code on the message before the model sees it. Each one is a fact the email
// cannot argue with: a model can be talked into a low score by text inside the message, code
// cannot. The floor is the least risk score a message carrying the signal gets, whatever the
// model says. A signal with no floor is only reported to the caller

// Files that run when opened. Double extensions ("invoice.pdf.exe") end in one of these too
const EXECUTABLE_EXTENSIONS = new Set([
    'exe',
    'scr',
    'pif',
    'com',
    'bat',
    'cmd',
    'vbs',
    'vbe',
    'js',
    'jse',
    'wsf',
    'wsh',
    'ws',
    'sct',
    'ps1',
    'psm1',
    'msi',
    'msp',
    'msix',
    'appx',
    'hta',
    'cpl',
    'reg',
    'lnk',
    'url',
    'scf',
    'inf',
    'chm',
    'xll',
    'jar',
    'apk',
    'iso',
    'img',
    'vhd',
    'vhdx',
    'dll',
    'settingcontent-ms',
    'library-ms'
]);

const EXECUTABLE_TYPES = new Set([
    'application/x-msdownload',
    'application/x-msdos-program',
    'application/x-ms-installer',
    'application/vnd.microsoft.portable-executable',
    'application/x-dosexec',
    'application/x-executable'
]);

// Files a mail client or browser runs code from when opened
const SCRIPTABLE_EXTENSIONS = new Set(['html', 'htm', 'shtml', 'xhtml', 'xht', 'svg', 'one']);

const FLOORS: Record<string, number> = {
    executableAttachment: 4,
    lookalikeDomain: 4,
    linkTargetMismatch: 3,
    scriptableAttachment: 3,
    displayNameAddressMismatch: 3,
    authenticationFailed: 3,
    replyToMismatch: 2
};

// A detail is attacker-written text that lands in the assessment and in front of the model, so
// it is cleaned of anything that could reorder or hide it, cut short and quoted

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const DETAIL_LENGTH = 80;

// How many signals are listed, to the model and in the assessment. A message with thousands of
// executable attachments or mismatched links carries that many signals, each of them true, and
// the first few say everything the list would
const MAX_LISTED_SIGNALS = 20;

const LATIN = /\p{Script=Latin}/u;
// a letter that is not Latin: the negation of (non-letters and Latin letters)
const NON_LATIN_LETTER = /[^\P{L}\p{Script=Latin}]/u;

function cleanText(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(CONTROL_CHARS, '')
        .replace(INVISIBLE_CHARS, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function quoted(value: unknown): string {
    const text = cleanText(value);
    return `"${text.length > DETAIL_LENGTH ? `${text.substring(0, DETAIL_LENGTH)}...` : text}"`;
}

function registrableDomain(input: unknown): string | null {
    const host = url.domainToASCII(String(input ?? '').toLowerCase()) || String(input ?? '').toLowerCase();
    return getDomain(host) || host || null;
}

function addressDomain(address: unknown): string | null {
    const match = /@([^\s>@]+)\s*>?\s*$/.exec(String(address ?? ''));
    return match ? registrableDomain(match[1]) : null;
}

// "Name <address>" or a bare address, as the From and Reply-To values are formatted
function splitAddress(input: unknown): { name: string; address: string } {
    const value = String(input ?? '').trim();
    const match = /^(.*?)\s*<([^<>]+)>\s*$/.exec(value);
    if (match) {
        return { name: match[1].replace(/^"|"$/g, '').trim(), address: match[2].trim() };
    }
    return { name: '', address: value };
}

// A label is a lookalike when it mixes Latin letters with letters of another script: "paypal"
// spelled with a Cyrillic "a" reads as the brand and resolves elsewhere. A label written entirely in
// another script is a normal internationalised name
function isLookalikeHost(host: unknown): boolean {
    return url
        .domainToUnicode(String(host ?? ''))
        .split('.')
        .some(label => LATIN.test(label) && NON_LATIN_LETTER.test(label));
}

// The host a browser would connect to: tabs and newlines are dropped, leading and trailing
// controls and spaces stripped, a scheme-relative or backslashed form resolved, the host
// lower-cased, percent-decoded and punycoded, all by the URL parser. Only http and https count
function linkHost(input: unknown): string | null {
    const href = String(input ?? '')
        .replace(/[\t\n\r]/g, '')

        .replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
    let parsed: URL;
    try {
        parsed = new URL(href, 'https://base.invalid/');
    } catch {
        return null;
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === 'base.invalid') {
        return null;
    }
    return parsed.hostname;
}

// Anchor text that names a host or URL itself, which a reader takes as the destination.
// Trailing punctuation is not part of it. A host written as userinfo ("paypal.com@evil.example")
// is what the reader takes in first, so it counts when it is a real name; otherwise the userinfo
// is dropped the way a browser drops it. The userinfo that is dropped is bounded: a local part is
// at most 64 octets (RFC 5321), and an unbounded run that backtracks for its "@" from every
// opening bracket in the text is quadratic
const HOST_START = /(?:^|[\s(<"'[])(?:https?:\/\/)?/.source;
const HOST = /((?:[\p{L}\p{N}-]+\.)+\p{L}{2,})/u.source;
const HOST_AS_USERINFO = new RegExp(`${HOST_START}${HOST}@`, 'iu');
const HOST_IN_TEXT = new RegExp(`${HOST_START}(?:[^\\s/@]{1,64}@)?${HOST}(?=$|[\\s/?#:,.;!)\\]>"'])`, 'iu');

function hostInText(input: unknown): string | null {
    // cut before anything runs on it: the links of visibleHtml() are cut already, a caller's own
    // may not be
    const text = cleanText(truncate(input, MAX_LINK_TEXT_LENGTH));
    const userinfo = HOST_AS_USERINFO.exec(text);
    if (userinfo && parseDomain(userinfo[1]).isIcann) {
        return userinfo[1].toLowerCase();
    }
    const match = HOST_IN_TEXT.exec(text);
    return match ? match[1].toLowerCase() : null;
}

function urlsInText(text: unknown): MessageLink[] {
    return (String(text ?? '').match(/https?:\/\/[^\s<>"')\]]+/gi) || []).map(url => ({ href: url, text: '' }));
}

function normalizedFilename(filename: unknown): string {
    let name = cleanText(filename);
    try {
        name = decodeURIComponent(name);
    } catch {
        // not percent-encoded, which is the usual case
    }
    // Windows drops trailing dots and spaces when saving
    return name.replace(/[.\s]+$/, '');
}

function extensionOf(name: string): string {
    const match = /\.([a-z0-9-]+)$/i.exec(name);
    return match ? match[1].toLowerCase() : '';
}

/**
 * Runs the checks on a message
 */
function collectSignals(message: SignalInput): Signal[] {
    const signals: Signal[] = [];
    const seen = new Set<string>();
    const add = (code: string, detail: string): void => {
        const key = `${code}\n${detail}`;
        if (!seen.has(key)) {
            seen.add(key);
            signals.push({ code, detail, floor: FLOORS[code] || 0 });
        }
    };

    for (const attachment of ([] as NonNullable<SignalInput['attachments']>).concat(message.attachments || [])) {
        const filename = normalizedFilename(attachment && attachment.filename);
        const extension = extensionOf(filename);
        const contentType = cleanText(attachment && attachment.contentType).toLowerCase();
        if (EXECUTABLE_EXTENSIONS.has(extension) || EXECUTABLE_TYPES.has(contentType)) {
            add('executableAttachment', quoted(filename || contentType));
        } else if (SCRIPTABLE_EXTENSIONS.has(extension)) {
            add('scriptableAttachment', quoted(filename));
        }
    }

    const from = splitAddress(message.from);
    const fromDomain = addressDomain(from.address);
    const replyTo = splitAddress(message.replyTo);
    const replyToDomain = addressDomain(replyTo.address);
    if (fromDomain && replyToDomain && fromDomain !== replyToDomain) {
        add('replyToMismatch', `from ${quoted(fromDomain)}, replies go to ${quoted(replyToDomain)}`);
    }

    const nameDomain = addressDomain(from.name);
    if (nameDomain && fromDomain && nameDomain !== fromDomain) {
        add('displayNameAddressMismatch', `the display name reads as an address at ${quoted(nameDomain)}, the sender is at ${quoted(fromDomain)}`);
    }

    const links = Array.isArray(message.links) ? message.links : urlsInText(message.text);
    const checked = new Set();
    for (const link of links) {
        const host = linkHost(link.href);
        const shown = hostInText(link.text);
        const key = `${host}\n${shown}`;
        if (!host || checked.has(key)) {
            continue;
        }
        checked.add(key);
        if (isLookalikeHost(host)) {
            add('lookalikeDomain', quoted(host));
        }
        if (shown && registrableDomain(shown) !== registrableDomain(host)) {
            add('linkTargetMismatch', `link text says ${quoted(shown)}, the target is ${quoted(host)}`);
        }
    }

    if (authenticationFailed(message.authentication)) {
        const auth = message.authentication!;
        add('authenticationFailed', (['spf', 'dkim', 'dmarc'] as const).map(method => `${method}=${auth[method] || 'none'}`).join(' '));
    }

    if ((message.hiddenElements ?? 0) > 0) {
        add('hiddenContent', `${message.hiddenElements} hidden element(s) with text were left out`);
    }
    if ((message.invisibleCharacters ?? 0) > 0) {
        add('invisibleCharacters', `${message.invisibleCharacters} invisible character(s) were left out`);
    }

    return signals;
}

/**
 * The signals the model gets to see: the ones that carry a floor, without it
 *
 * @param signals - As returned by collectSignals()
 */
function modelSignals(signals: Signal[]): Array<{ code: string; detail: string }> {
    return signals
        .filter(signal => signal.floor > 0)
        .slice(0, MAX_LISTED_SIGNALS)
        .map(({ code, detail }) => ({ code, detail }));
}

/**
 * Applies the signals to the model's answer: the risk score cannot be below their floor, and
 * the codes of the ones that carry one are listed with the assessment so a consumer sees what
 * was found. The list is always what the code found, an empty one when nothing did: the model
 * writes the rest of the assessment, and text in the message can talk it into writing this
 * field too, as facts no check established
 *
 * @param result - Normalized model output, changed in place
 * @param signals - As returned by collectSignals()
 * @returns The same result
 */
function applySignals<T extends RiskResult>(result: T, signals: Signal[]): T {
    const scored = signals.filter(signal => signal.floor > 0);
    const hasAssessment = !!result.riskAssessment && typeof result.riskAssessment === 'object';
    if (!scored.length && !hasAssessment) {
        return result;
    }

    const riskAssessment: NonNullable<RiskResult['riskAssessment']> = hasAssessment ? result.riskAssessment! : {};
    const risk = Number.isFinite(riskAssessment.risk) ? riskAssessment.risk! : 0;
    const floor = scored.length ? Math.max(...scored.map(signal => signal.floor)) : 0;

    if (floor > risk) {
        const raised = scored
            .filter(signal => signal.floor > risk)
            .slice(0, MAX_LISTED_SIGNALS)
            .map(signal => `${signal.code}: ${signal.detail}`);
        riskAssessment.risk = floor;
        riskAssessment.assessment = [riskAssessment.assessment, `Checks run on the message found: ${raised.join('; ')}.`].filter(Boolean).join(' ');
    }

    riskAssessment.signals = scored.slice(0, MAX_LISTED_SIGNALS).map(signal => signal.code);
    result.riskAssessment = riskAssessment;
    return result;
}

export { collectSignals, modelSignals, applySignals, isLookalikeHost, splitAddress };
