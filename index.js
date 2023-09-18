'use strict';

const { generateSummary, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT } = require('./lib/generate-summary');
const riskAnalysis = require('./lib/risk-analysis');
const generateEmbeddings = require('./lib/generate-embeddings');

module.exports = {
    generateSummary,
    generateEmbeddings,
    riskAnalysis,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_USER_PROMPT
};
