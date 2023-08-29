'use strict';

const { generateSummary, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT } = require('./lib/generate-summary');
const riskAnalysis = require('./lib/risk-analysis');

module.exports = {
    generateSummary,
    riskAnalysis,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_USER_PROMPT
};
