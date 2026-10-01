'use strict';

const { generateSummary, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_SYSTEM_PROMPT, DEFAULT_INSTRUCTIONS } = require('./lib/generate-summary');
const { listModels } = require('./lib/list-models');

module.exports = {
    generateSummary,
    listModels,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_INSTRUCTIONS
};
