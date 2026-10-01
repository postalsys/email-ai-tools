'use strict';

// The Authentication-Results header (RFC 8601) is where the receiving server records what it
// verified about the sender. A sender can add one of its own, so only a header the receiving
// server added counts, and that is told by its authserv-id: the name of the server that wrote
// it. The caller says which names it trusts for the mailbox at hand

const METHODS = ['spf', 'dkim', 'dmarc', 'arc'];

// Splits a header value on the semicolons outside comments and quoted strings, which may carry
// semicolons of their own and whose content a trusted server copies from the message. Comments
// nest, and both are dropped from the pieces, since the grammar needs neither
function splitResinfo(value) {
    const segments = [];
    let current = '';
    let depth = 0;
    let quoted = false;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (quoted) {
            if (char === '\\') {
                i++;
            } else if (char === '"') {
                quoted = false;
            }
            continue;
        }
        if (depth) {
            // a quote inside a comment is not a quoted string by the grammar, but a server that
            // echoes an address into a comment may write one, and a parenthesis in it must not
            // end the comment
            if (char === '\\') {
                i++;
            } else if (char === '"') {
                quoted = true;
            } else if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
            }
            continue;
        }
        if (char === '"') {
            quoted = true;
        } else if (char === '(') {
            depth = 1;
        } else if (char === ';') {
            segments.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    segments.push(current.trim());

    return segments.filter(Boolean);
}

/**
 * Parses one Authentication-Results header value
 *
 * @param {string} value - Header value, unfolded
 * @returns {{authservId: string|null, results: Object}|null} The authserv-id (null when the header carries none, as Microsoft's do) and the first result per method
 */
function parseAuthenticationResults(value) {
    const segments = splitResinfo(String(value ?? ''));
    if (!segments.length) {
        return null;
    }

    let authservId = null;
    const first = segments[0];
    const firstToken = first.split(/\s+/)[0];
    if (!first.includes('=')) {
        // "authserv-id" or "authserv-id version"
        authservId = firstToken.toLowerCase();
        segments.shift();
    } else if (!firstToken.includes('=') && /\s[a-z0-9-]+\s*=/i.test(first)) {
        // "authserv-id method=result" in one segment, which some servers write
        authservId = firstToken.toLowerCase();
        segments[0] = first.substring(firstToken.length).trim();
    }

    const results = {};
    for (const segment of segments) {
        const match = /^([a-z0-9-]+)\s*=\s*([a-z0-9-]+)/i.exec(segment);
        if (!match) {
            continue;
        }
        const method = match[1].toLowerCase();
        const result = match[2].toLowerCase();
        if (!METHODS.includes(method)) {
            continue;
        }
        // the first result per method: a second DKIM entry is another signature on the message,
        // a mailing list's broken one as often as not, and not a verdict on the first
        if (!(method in results)) {
            results[method] = result;
        }
    }

    return { authservId, results };
}

/**
 * Tells whether an authserv-id names a server the caller trusts: the name itself or a host
 * under it
 *
 * @param {string|null} authservId
 * @param {string[]} trusted - Trusted names, lower case
 * @param {boolean} acceptUnnamed - Whether a header without an authserv-id counts, for providers that write none
 * @returns {boolean}
 */
function isTrustedAuthservId(authservId, trusted, acceptUnnamed) {
    if (!authservId) {
        return !!acceptUnnamed;
    }
    const id = authservId.toLowerCase();
    return [].concat(trusted || []).some(name => name && (id === name || id.endsWith(`.${name}`)));
}

/**
 * The authentication block of the model's input: the receiving server's verdict, marked as
 * verified when the server that wrote it is one the caller trusts
 *
 * @param {string} value - The topmost Authentication-Results header value
 * @param {Object} trust
 * @param {string[]} trust.trustedAuthservIds - Lower-case names
 * @param {boolean} trust.acceptUnnamedAuthentication
 * @returns {Object|null}
 */
function authenticationBlock(value, trust) {
    const parsed = parseAuthenticationResults(value);
    if (!parsed) {
        return null;
    }
    return Object.assign(
        {
            verified: isTrustedAuthservId(parsed.authservId, trust.trustedAuthservIds, trust.acceptUnnamedAuthentication),
            authservId: parsed.authservId || undefined
        },
        parsed.results
    );
}

/**
 * Whether a verified verdict says the sender failed: DMARC failed outright, or both SPF and
 * DKIM did without DMARC saying otherwise
 *
 * @param {Object|null} authentication - As returned by authenticationBlock()
 * @returns {boolean}
 */
function authenticationFailed(authentication) {
    if (!authentication || !authentication.verified) {
        return false;
    }
    if (authentication.dmarc === 'fail') {
        return true;
    }
    const failed = result => ['fail', 'softfail', 'permerror'].includes(result);
    return !authentication.dmarc && failed(authentication.spf) && failed(authentication.dkim);
}

module.exports = { parseAuthenticationResults, isTrustedAuthservId, authenticationBlock, authenticationFailed };
