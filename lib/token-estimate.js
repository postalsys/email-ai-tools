'use strict';

// Token counts are estimated from characters instead of running a BPE tokenizer. The GPT-3
// tokenizer this library used to load does not match current model vocabularies anyway, costs
// ~15 MB of heap per instance, and is super-linear on long unbroken runs (a 64 KB CJK body took
// 25 s per encode). The estimate errs on the high side; the model's own context length error
// stays the backstop for the rare input that tokenizes worse than this.

// Prompt fitting: ASCII at 3 characters per token is below what English, code and base64-ish
// runs actually reach, and every non-ASCII UTF-16 code unit counts as a whole token.
const PROMPT_ESTIMATE = { charsPerToken: 3, margin: 1.1 };

// Input text beyond this many characters is never sent, whatever the token budget
const MAX_ALLOWED_TEXT_LENGTH = 64 * 1024;
// Default prompt budget when the caller does not set maxTokens
const DEFAULT_MAX_ALLOWED_TOKENS = 30000;

// Chunk sizing only needs to be roughly right, so it uses a typical English ratio instead.
const CHUNK_ESTIMATE = { charsPerToken: 4, margin: 1 };

// Cost of one UTF-16 code unit in "ASCII character" units
function charUnits(code, charsPerToken) {
    if (code < 0x20 || code === 0x22 || code === 0x5c) {
        // control characters, quotes and backslashes are escaped when the text is JSON encoded
        return 2;
    }
    if (code < 0x80) {
        return 1;
    }
    return charsPerToken;
}

/**
 * Estimates how many tokens a string takes
 *
 * @param {string} str
 * @param {Object} [opts]
 * @param {number} [opts.charsPerToken=3] - ASCII characters per token
 * @param {number} [opts.margin=1.1] - Safety factor applied to the estimate
 * @returns {number} Estimated token count
 */
function estimateTokens(str, opts) {
    const { charsPerToken, margin } = Object.assign({}, PROMPT_ESTIMATE, opts);
    str = (str || '').toString();

    let units = 0;
    for (let i = 0; i < str.length; i++) {
        units += charUnits(str.charCodeAt(i), charsPerToken);
    }

    // the epsilon keeps float noise (100 * 1.1 = 110.00000000000001) from adding a token
    return Math.ceil((units / charsPerToken) * margin - 1e-9);
}

/**
 * Returns the length of the longest prefix of `str` that fits into `maxTokens` by the same
 * estimate as estimateTokens(). Never ends between the two halves of a surrogate pair.
 *
 * @param {string} str
 * @param {number} maxTokens
 * @param {Object} [opts] - Same as for estimateTokens()
 * @returns {number} Prefix length in UTF-16 code units
 */
function fitLength(str, maxTokens, opts) {
    const { charsPerToken, margin } = Object.assign({}, PROMPT_ESTIMATE, opts);
    str = (str || '').toString();

    if (!(maxTokens > 0)) {
        return 0;
    }

    const maxUnits = Math.floor((maxTokens * charsPerToken) / margin);

    let units = 0;
    let i = 0;
    for (; i < str.length; i++) {
        const cost = charUnits(str.charCodeAt(i), charsPerToken);
        if (units + cost > maxUnits) {
            break;
        }
        units += cost;
    }

    return keepSurrogatePair(str, i);
}

// Moves a cut position back by one if it would separate a surrogate pair
function keepSurrogatePair(str, pos) {
    if (pos > 0 && pos < str.length) {
        const prev = str.charCodeAt(pos - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) {
            return pos - 1;
        }
    }
    return pos;
}

/**
 * Splits text into chunks of at most `maxTokens` estimated tokens each, preferring to break at
 * whitespace. Characters are never split, unlike slicing BPE token arrays.
 *
 * @param {string} str
 * @param {number} maxTokens
 * @param {Object} [opts] - Same as for estimateTokens(), defaults to the chunk sizing ratio
 * @returns {string[]}
 */
function splitByTokens(str, maxTokens, opts) {
    opts = Object.assign({}, CHUNK_ESTIMATE, opts);
    str = (str || '').toString();

    const chunks = [];
    let rest = str;
    while (rest.length) {
        let len = fitLength(rest, maxTokens, opts);
        if (len >= rest.length) {
            chunks.push(rest);
            break;
        }

        if (len < 1) {
            // a single character larger than the budget, take it (or its surrogate pair) anyway
            len = keepSurrogatePair(rest, 1) || 2;
        } else {
            // break at the last whitespace if it is not too far back, so words stay whole
            const ws = Math.max(rest.lastIndexOf(' ', len - 1), rest.lastIndexOf('\n', len - 1));
            if (ws >= len / 2) {
                len = ws + 1;
            }
        }

        chunks.push(rest.substring(0, len));
        rest = rest.substring(len);
    }

    return chunks;
}

/**
 * Cuts `text` so that the prompt built around it fits into `maxTokens` estimated tokens. The
 * text is sized in one step from an estimate of what the rest of the prompt takes.
 *
 * @param {Object} opts
 * @param {string} opts.text - Variable part of the prompt, the only part that gets shortened
 * @param {number} [opts.maxLength=MAX_ALLOWED_TEXT_LENGTH] - Hard cap on the text length
 * @param {number} [opts.maxTokens=DEFAULT_MAX_ALLOWED_TOKENS] - Token budget for the whole prompt
 * @param {Function} opts.build - Returns the full prompt for a given text
 * @returns {{prompt: string, text: string, charactersRemoved: number}}
 * @throws {Error} PROMPT_TOO_LONG if the prompt does not fit even without any text
 */
function fitPrompt({ text, maxLength, maxTokens, build }) {
    text = (text || '').toString();
    maxLength = maxLength || MAX_ALLOWED_TEXT_LENGTH;
    maxTokens = maxTokens || DEFAULT_MAX_ALLOWED_TOKENS;

    let fitted = text.length > maxLength ? text.substring(0, keepSurrogatePair(text, maxLength)) : text;

    const overheadTokens = estimateTokens(build(''));
    if (overheadTokens > maxTokens) {
        const error = new Error(
            `Unable to fit email content within token limit of ${maxTokens}. ` +
                `Original text length: ${text.length} characters. ` +
                `The prompt without the email text is already estimated at ${overheadTokens} tokens. ` +
                `Consider using a model with larger context window.`
        );
        error.code = 'PROMPT_TOO_LONG';
        error.originalLength = text.length;
        error.charactersRemoved = text.length;
        error.maxAllowedTokens = maxTokens;
        throw error;
    }

    fitted = fitted.substring(0, fitLength(fitted, maxTokens - overheadTokens));

    return { prompt: build(fitted), text: fitted, charactersRemoved: text.length - fitted.length };
}

module.exports = {
    estimateTokens,
    fitLength,
    fitPrompt,
    keepSurrogatePair,
    splitByTokens,
    CHUNK_ESTIMATE,
    MAX_ALLOWED_TEXT_LENGTH,
    DEFAULT_MAX_ALLOWED_TOKENS
};
