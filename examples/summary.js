'use strict';

const fs = require('fs').promises;
const generateSummary = require('../lib/generate-summary');
const simpleParser = require('mailparser').simpleParser;
const libmime = require('libmime');

async function main() {
    const eml = await fs.readFile(process.argv[2]);

    const parsed = await simpleParser(eml);

    const summary = await generateSummary(
        {
            headers: parsed.headerLines.map(header => libmime.decodeHeader(header.line)),
            attachments: parsed.attachments,
            html: parsed.html,
            text: parsed.text
        },
        process.env.OPENAI_API_KEY,
        {
            //gptModel: 'gpt-3.5-turbo'
            gptModel: 'gpt-4',
            maxTokens: 6000
        }
    );

    console.log(summary);
}

main();
