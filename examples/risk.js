'use strict';

const fs = require('fs').promises;
const { generateSummary } = require('..');
const simpleParser = require('mailparser').simpleParser;
const libmime = require('libmime');
const Path = require('path');

const BASE_PATH = process.argv[2] || '.';
const MAX_ENTRIES = Math.abs(Number(process.argv[3]) || 0);

async function analyzeEmail(path) {
    const eml = await fs.readFile(path);

    const parsed = await simpleParser(eml);

    const result = await generateSummary(
        {
            headers: parsed.headerLines.map(header => libmime.decodeHeader(header.line)),
            attachments: parsed.attachments,
            html: parsed.html,
            text: parsed.text,
            subject: parsed.subject
        },
        process.env.OPENAI_API_KEY,
        {
            //gptModel: 'gpt-3.5-turbo'
            gptModel: 'gpt-4',
            maxTokens: 6000
        }
    );

    result.file = Path.basename(path);

    console.log(JSON.stringify(result));
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        let temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

async function main() {
    const stat = await fs.stat(BASE_PATH);
    if (stat.isDirectory()) {
        // process as directory

        let processed = 0;
        let list = await fs.readdir(BASE_PATH);

        for (let file of shuffleArray(list)) {
            if (Path.extname(file).toLowerCase() === '.eml') {
                if (processed) {
                    process.stdout.write(',');
                }
                try {
                    await analyzeEmail(Path.join(BASE_PATH, file));
                    console.error(`Processed ${file} [${processed + 1}]`);
                } catch (err) {
                    console.log(JSON.stringify({ file, error: err.message }));
                    console.error(`Failed processing ${file} [${processed + 1}]`);
                    console.error(err);
                }
                processed++;

                if (MAX_ENTRIES && processed >= MAX_ENTRIES) {
                    break;
                }
            }
        }
        console.error(`Processed ${processed} files from ${BASE_PATH}`);
    } else {
        // process as file
        await analyzeEmail(BASE_PATH);
    }
}

console.log('[');
main().then(() => {
    console.log(']');
});
