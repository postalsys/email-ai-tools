'use strict';

const fs = require('fs').promises;
const { generateSummary } = require('../lib/generate-summary');
const simpleParser = require('mailparser').simpleParser;
const libmime = require('libmime');
const util = require('util');

async function main() {
    const eml = await fs.readFile(process.argv[2]);

    const parsed = await simpleParser(eml);

    const { result, usage } = await generateSummary(
        {
            headers: parsed.headerLines.map(header => libmime.decodeHeader(header.line)),
            attachments: parsed.attachments,
            html: parsed.html,
            text: parsed.text,
            subject: parsed.subject,
            from: parsed.from && parsed.from.value && parsed.from.value[0],
            date: parsed.date
        },
        process.env.OPENAI_API_KEY,
        {
            gptModel: process.env.OPENAI_MODEL,
            verbose: true
        }
    );

    console.log(util.inspect({ result, usage }, false, 22, true));
}

main();
