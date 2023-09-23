'use strict';

const fs = require('fs').promises;
const { generateEmbeddings } = require('../lib/generate-embeddings');
const simpleParser = require('mailparser').simpleParser;
const libmime = require('libmime');
const util = require('util');

async function main() {
    const eml = await fs.readFile(process.argv[2]);

    const parsed = await simpleParser(eml);

    const result = await generateEmbeddings(
        {
            headers: parsed.headerLines.map(header => libmime.decodeHeader(header.line)),
            attachments: parsed.attachments,
            html: parsed.html,
            text: parsed.text
        },
        process.env.OPENAI_API_KEY,
        {
            //gptModel: 'gpt-3.5-turbo',
            gptModel: 'gpt-4',
            maxTokens: 6000,
            verbose: true
        }
    );

    console.log(util.inspect(result, false, 22, true));

    for (let e of result?.embeddings || []) {
        console.log('CHUNK');
        console.log(e.chunk);
    }
}

main();
