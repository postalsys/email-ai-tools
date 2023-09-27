'use strict';

const packageData = require('../package.json');
const { default: GPT3Tokenizer } = require('gpt3-tokenizer');
const util = require('util');
const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });

const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });

const MAX_ALLOWED_TEXT_LENGTH = 32 * 1024;
const MAX_ALLOWED_TOKENS = 4000;
const OPENAI_API_URL_CHAT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_API_URL_INSTRUCT = 'https://api.openai.com/v1/completions';

const DEFAULT_SYSTEM_PROMPT = `
You are a helpful executive assistant that looks for requested information from stored emails.
`.trim();

const SCHEMA_PROMPT = `
Input facts:
- The question to process is encoded in the following JSON schema:
  {"question":""}
- A list of emails is provided as the context
- Each context email consists of a header, and the content
- The header consists of comma-separated key-value pairs
- An empty line separates the header and content of an email 

Output facts:
- Select the best matching email from the context emails and compose an answer for the question based on that email
- If there is no matching email or confidence about the match is low, do not write a response
- Do not use an email that is not listed in the context emails list
- On the first line of the response, write a prefix "Message-ID": that follows with the Message-ID header value of the matching email
- On the second line of the response, write the answer to the question
- Do not mention the Message-ID value in the answer text
- Do not comment anything`.trim();

async function embeddingsQuery(apiToken, opts) {
    opts = opts || {};

    let systemPrompt = (opts.systemPrompt || DEFAULT_SYSTEM_PROMPT).toString().trim();
    let question = (opts.question || '').toString().trim();
    let contextChunks = (opts.contextChunks || '').toString().trim();

    let maxAllowedTokens = opts.maxTokens || MAX_ALLOWED_TOKENS;
    let gptModel = opts.gptModel || 'gpt-3.5-turbo';

    let prompt;

    let charactersRemoved = 0;
    let promptText = contextChunks;

    if (promptText.length > MAX_ALLOWED_TEXT_LENGTH) {
        charactersRemoved += promptText.length - MAX_ALLOWED_TEXT_LENGTH;
        promptText = promptText.substr(0, MAX_ALLOWED_TEXT_LENGTH);
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
        prompt = `${SCHEMA_PROMPT}

Input:
${JSON.stringify({ question })}

Context emails:

${promptText}
`;

        let tokens = tokenizer.encode(prompt);
        if (tokens.bpe.length <= maxAllowedTokens) {
            break;
        }
        if (promptText.length > 2 * 1024 * 1024) {
            promptText = promptText.substring(0, promptText.length - 1024 * 1024);
            charactersRemoved += 1024 * 1024;
        } else if (promptText.length > 2 * 1024) {
            promptText = promptText.substring(0, promptText.length - 1024);
            charactersRemoved += 1024;
        } else if (promptText.length > 2 * 256) {
            promptText = promptText.substring(0, promptText.length - 256);
            charactersRemoved += 255;
        } else if (promptText.length > 2 * 100) {
            promptText = promptText.substring(0, promptText.length - 100);
            charactersRemoved += 100;
        } else if (promptText.length > 2 * 10) {
            promptText = promptText.substring(0, promptText.length - 10);
            charactersRemoved += 10;
        } else if (promptText.length > 1) {
            promptText = promptText.substring(0, promptText.length - 1);
            charactersRemoved += 1;
        } else {
            throw new Error(`Prompt too long. Removed ${charactersRemoved} characters.`);
        }
    }

    let headers = {
        'User-Agent': `${packageData.name}/${packageData.version}`,
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
    };

    let payload = {
        model: gptModel
    };

    if (opts.temperature && !isNaN(opts.temperature)) {
        payload.temperature = Number(opts.temperature);
    }

    if (opts.topP && !isNaN(opts.topP)) {
        payload.top_p = Number(opts.topP);
    }

    let res;
    let data;
    let retries = 0;

    let openAiAPIURL;
    switch (gptModel) {
        case 'gpt-3.5-turbo-instruct':
            {
                openAiAPIURL = OPENAI_API_URL_INSTRUCT;
                payload.prompt = `${systemPrompt}\n${prompt}`;
                let tokens = tokenizer.encode(payload.prompt);
                payload.max_tokens = 4000 - tokens.bpe.length;
            }
            break;

        case 'gpt-3.5-turbo':
        case 'gpt-4':
        default:
            openAiAPIURL = OPENAI_API_URL_CHAT;
            payload.messages = [
                {
                    role: 'system',
                    content: `${systemPrompt}`
                },
                {
                    role: 'user',
                    content: prompt
                }
            ];
            break;
    }

    if (opts.verbose) {
        console.log(util.inspect(payload, false, 5, true));
    }

    let run = async () => {
        res = await fetchCmd(openAiAPIURL, {
            method: 'post',
            headers,
            body: JSON.stringify(payload),
            dispatcher: fetchAgent
        });

        data = await res.json();

        if (!res.ok) {
            if (res.status === 429 && ++retries < 5) {
                // try again
                await new Promise(r => setTimeout(r, 1000));
                return await run();
            }

            if (data && data.error) {
                let error = new Error(data.error.message || data.error);
                if (data.error.code) {
                    error.code = data.error.code;
                }

                error.statusCode = res.status;
                throw error;
            }

            let error = new Error('Failed to run API request');
            error.statusCode = res.status;
            throw error;
        }

        if (!data) {
            throw new Error(`Failed to POST API request`);
        }
    };

    const reqStartTime = Date.now();
    await run();
    const reqEndTime = Date.now();

    let values;
    let output =
        data &&
        data.choices &&
        data.choices
            .filter(msg => msg && ((msg.message && msg.message.role === 'assistant' && msg.message.content) || msg.text))
            .sort((a, b) => ((a && a.index) || 0) - ((b && b.index) || 0))
            .map(msg => (msg.message && msg.message.content) || msg.text)
            .join('')
            .trim();

    let prefixMatch = output.match(/Message[-_]ID:?/i);
    if (prefixMatch) {
        output = output.substring(prefixMatch.index + prefixMatch[0].length).trim();
    }

    output = output
        .trim()
        .replace(/^(message[-_]?id|output|answer|response):?\s*/i, '')
        .trim();
    let lineBreakMatch = output.match(/[\r\n]+/);
    if (lineBreakMatch) {
        values = {
            messageId: output.substring(0, lineBreakMatch.index).trim(),
            answer: output
                .substring(lineBreakMatch.index + lineBreakMatch[0].length)
                .trim()
                .replace(/^answer:?\s*/i, '')
        };
    }

    const response = Object.assign({ id: null, tokens: null, model: null }, values, {
        id: data && data.id,
        tokens: data && data.usage && data.usage.total_tokens,
        model: gptModel
    });

    if (opts.verbose) {
        response._time = reqEndTime - reqStartTime;
        response._cr = charactersRemoved;
    }

    return response;
}

module.exports = { embeddingsQuery };
