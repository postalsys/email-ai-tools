'use strict';

const { generateSummary, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT } = require('./lib/generate-summary');
const riskAnalysis = require('./lib/risk-analysis');
const { generateEmbeddings, getChunkEmbeddings } = require('./lib/generate-embeddings');
const { embeddingsQuery, questionQuery } = require('./lib/embeddings-query');
const { listModels } = require('./lib/list-models');

module.exports = {
    generateSummary,
    generateEmbeddings,
    getChunkEmbeddings,
    embeddingsQuery,
    questionQuery,
    riskAnalysis,
    listModels,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_USER_PROMPT
};
