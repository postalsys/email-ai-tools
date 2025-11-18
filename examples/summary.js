'use strict';

const fs = require('fs').promises;
const { generateSummary } = require('../lib/generate-summary');
const simpleParser = require('mailparser').simpleParser;
const libmime = require('libmime');
const util = require('util');

async function main() {
    const eml = await fs.readFile(process.argv[2]);

    const parsed = await simpleParser(eml);

    const summary = await generateSummary(
        {
            headers: parsed.headerLines.map(header => libmime.decodeHeader(header.line)),
            attachments: parsed.attachments,
            html: parsed.html,
            text: parsed.text,
            subject: parsed.subject
        },
        process.env.OPENAI_API_KEY,
        {
            gptModel: 'gpt-5-mini',
            maxTokens: 30000,
            verbose: true
        }
    );

    console.log(util.inspect(summary, false, 22, true));
}

main();
