'use strict';

const { questionQuery } = require('../lib/embeddings-query');
const util = require('util');

async function main() {
    const question = process.argv[2] || 'How much did my last purchase on Amazon cost?';

    const info = await questionQuery(question, process.env.OPENAI_API_KEY, {
        //gptModel: 'gpt-3.5-turbo',
        //gptModel: 'gpt-4',
        verbose: true
    });

    console.log(util.inspect(info, false, 22, true));
}

main();
