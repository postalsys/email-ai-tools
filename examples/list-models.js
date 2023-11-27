'use strict';

const { listModels } = require('../lib/list-models');
const util = require('util');

async function main() {
    const result = await listModels(process.env.OPENAI_API_KEY, {
        verbose: true
    });

    console.log(util.inspect(result, false, 22, true));
}

main();
