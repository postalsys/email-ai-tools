// The public entry point. Every member is declared here as its own constant rather than
// re-exported (`export { x } from`), because the CommonJS output of a re-export is a getter and
// `require('@postalsys/email-ai-tools')` has always returned plain writable properties.

import * as summary from './lib/generate-summary.js';
import * as models from './lib/list-models.js';

export type { GenerateSummaryOptions, SummaryAddress, SummaryError, SummaryMessage, SummaryResult, SummaryUsage } from './lib/generate-summary.js';
export type { ListModelsOptions, ModelDescription, ModelEntry } from './lib/list-models.js';
export type { Signal } from './lib/signals.js';

export const generateSummary = summary.generateSummary;
export const listModels = models.listModels;
export const describeModel = models.describeModel;
export const DEFAULT_MODEL = summary.DEFAULT_MODEL;
export const DEFAULT_REASONING_EFFORT = summary.DEFAULT_REASONING_EFFORT;
export const DEFAULT_MAX_TOKENS = summary.DEFAULT_MAX_TOKENS;
export const DEFAULT_SYSTEM_PROMPT = summary.DEFAULT_SYSTEM_PROMPT;
export const DEFAULT_INSTRUCTIONS = summary.DEFAULT_INSTRUCTIONS;
export const REASONING_EFFORTS = summary.REASONING_EFFORTS;
export const ALLOWED_HEADERS = summary.ALLOWED_HEADERS;

// For `import emailAiTools from '@postalsys/email-ai-tools'`. In the CommonJS build the default
// export is replaced by the exports object itself, non-enumerable (scripts/build.js)
const emailAiTools = {
    generateSummary,
    listModels,
    describeModel,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    DEFAULT_MAX_TOKENS,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_INSTRUCTIONS,
    REASONING_EFFORTS,
    ALLOWED_HEADERS
};

export default emailAiTools;
