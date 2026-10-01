'use strict';

const {
    generateSummary,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    DEFAULT_MAX_TOKENS,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_INSTRUCTIONS,
    REASONING_EFFORTS,
    ALLOWED_HEADERS
} = require('./lib/generate-summary');
const { listModels, describeModel } = require('./lib/list-models');

module.exports = {
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
