// Token counts are estimated from characters instead of running a BPE tokenizer. The GPT-3
// tokenizer this library used to load does not match current model vocabularies anyway, costs
// ~15 MB of heap per instance, and is super-linear on long unbroken runs (a 64 KB CJK body took
// 25 s per encode). The estimate errs on the high side; the model's own context length error
// stays the backstop for the rare input that tokenizes worse than this.

// ASCII at 3 characters per token is below what English, code and base64-ish runs actually
// reach, every non-ASCII UTF-16 code unit counts as a whole token, and the margin goes on top
const CHARS_PER_TOKEN = 3;
const MARGIN = 1.1;

// Input text beyond this many characters is never sent, whatever the token budget
const MAX_ALLOWED_TEXT_LENGTH = 64 * 1024;
// Default prompt budget when the caller does not set maxTokens
const DEFAULT_MAX_ALLOWED_TOKENS = 30000;

// Cost of one UTF-16 code unit in "ASCII character" units. The text travels JSON encoded, so the
// characters that encoding escapes count double
function charUnits(code: number): number {
    if (code < 0x20 || code === 0x22 || code === 0x5c) {
        return 2;
    }
    if (code < 0x80) {
        return 1;
    }
    return CHARS_PER_TOKEN;
}

/**
 * Estimates how many tokens a string takes
 *
 * @returns Estimated token count
 */
function estimateTokens(input?: string | null): number {
    const str = (input || '').toString();

    let units = 0;
    for (let i = 0; i < str.length; i++) {
        units += charUnits(str.charCodeAt(i));
    }

    // the epsilon keeps float noise (100 * 1.1 = 110.00000000000001) from adding a token
    return Math.ceil((units / CHARS_PER_TOKEN) * MARGIN - 1e-9);
}

/**
 * Returns the length of the longest prefix of `str` that fits into `maxTokens` by the same
 * estimate as estimateTokens(). Never ends between the two halves of a surrogate pair.
 *
 * @returns Prefix length in UTF-16 code units
 */
function fitLength(input: string | null | undefined, maxTokens: number): number {
    const str = (input || '').toString();

    if (!(maxTokens > 0)) {
        return 0;
    }

    const maxUnits = Math.floor((maxTokens * CHARS_PER_TOKEN) / MARGIN);

    let units = 0;
    let i = 0;
    for (; i < str.length; i++) {
        const cost = charUnits(str.charCodeAt(i));
        if (units + cost > maxUnits) {
            break;
        }
        units += cost;
    }

    return keepSurrogatePair(str, i);
}

// Moves a cut position back by one if it would separate a surrogate pair
function keepSurrogatePair(str: string, pos: number): number {
    if (pos > 0 && pos < str.length) {
        const prev = str.charCodeAt(pos - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) {
            return pos - 1;
        }
    }
    return pos;
}

/**
 * Cuts a string to at most `maxLength` UTF-16 code units, never between the halves of a
 * surrogate pair
 */
function truncate(input: unknown, maxLength: number): string {
    const str = ((input || '') as { toString(): string }).toString();
    return str.length > maxLength ? str.substring(0, keepSurrogatePair(str, maxLength)) : str;
}

export interface FitPromptOptions {
    /** Variable part of the prompt, the only part that gets shortened */
    text?: string | null | undefined;
    /** Hard cap on the text length (default MAX_ALLOWED_TEXT_LENGTH) */
    maxLength?: number | undefined;
    /** Token budget for the whole prompt (default DEFAULT_MAX_ALLOWED_TOKENS) */
    maxTokens?: number | null | undefined;
    /** The fixed parts, as strings to estimate or as token counts already estimated */
    overhead?: Array<string | number> | string | number | undefined;
}

export interface PromptTooLongError extends Error {
    code?: string;
    originalLength?: number;
    charactersRemoved?: number;
    maxAllowedTokens?: number;
}

/**
 * Cuts `text` so that it fits into `maxTokens` estimated tokens next to the fixed parts of the
 * prompt
 *
 * @throws Error with code PROMPT_TOO_LONG if the fixed parts alone do not fit
 */
function fitPrompt({ text, maxLength, maxTokens, overhead }: FitPromptOptions): { text: string; charactersRemoved: number } {
    text = (text || '').toString();
    maxLength = maxLength || MAX_ALLOWED_TEXT_LENGTH;
    maxTokens = maxTokens || DEFAULT_MAX_ALLOWED_TOKENS;

    const overheadTokens = ([] as Array<string | number>)
        .concat(overhead === undefined ? [] : overhead)
        .reduce((sum: number, part) => sum + (typeof part === 'number' ? part : estimateTokens(part)), 0);

    if (overheadTokens > maxTokens) {
        const error: PromptTooLongError = new Error(
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

    let fitted = truncate(text, maxLength);
    fitted = fitted.substring(0, fitLength(fitted, maxTokens - overheadTokens));

    return { text: fitted, charactersRemoved: text.length - fitted.length };
}

export { estimateTokens, fitLength, fitPrompt, truncate, DEFAULT_MAX_ALLOWED_TOKENS };
