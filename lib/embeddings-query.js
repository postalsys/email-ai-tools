'use strict';

const packageData = require('../package.json');
const { default: GPT3Tokenizer } = require('gpt3-tokenizer');
const util = require('util');
const crypto = require('crypto');
const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });

const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });

const MAX_ALLOWED_TEXT_LENGTH = 32 * 1024;
const MAX_ALLOWED_TOKENS = 4000;
const OPENAI_API_URL_CHAT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_API_URL_INSTRUCT = 'https://api.openai.com/v1/completions';

const DEFAULT_SYSTEM_PROMPT = `
You are an automated system designed to extract and provide information based on stored emails.
`.trim();

const SCHEMA_PROMPT = `
**Input Information:**

- **Question Format:** The query is presented using the JSON schema: \`{"question":"What was the date of our last meeting?"}\`

- **Email Context:** We are provided with a series of emails to analyze.

  - **Email Structure:** Each email is divided into two sections: a header and its content. These sections are separated by an empty line.
  
  - **Email Content:** This pertains exclusively to the plain text of the email. No attachments or their contents are provided.

  - **Sample Header:**
    \`\`\`
    - EMAIL #1:
    From: James <james@example.com>
    To: Andris <andris@example.com>
    Subject: Hello
    Message-ID: <example@value>
    Date: 1 Oct 2023 06:30:26 +0200
    Attachments: image.png, invoice.pdf
    \`\`\`

    - Every header starts with the string \`- EMAIL #\` followed by the email sequence number
    - **Mandatory Field:** Every email will contain a unique Message-ID.
    - **Date Field:** Represents the timestamp when the email was sent.
    - **Attachments:** This field, when present, lists the names of attachments included with the email, separated by commas.

**Output Guidelines:**

1. Your objective is to sift through the email context and pinpoint the answer that best addresses the given query.
2. If no email matches the query criteria, or if the match is ambiguous, refrain from providing an answer.
3. Limit your sources strictly to the provided email context. External references are not to be utilized.
4. Format your response as follows:
   - Start with \`Answer:\` followed by the relevant information.
   - On a new line, begin with \`Message-ID:\` and cite the unique Message-ID(s) of the emails you sourced your answer from. 
5. Ensure that the Message-ID is never embedded within the main body of your response.
6. Avoid including any additional commentary or annotations. 
`.trim();

const QUESTION_PROMPT = `
Instructions:

You are analyzing user questions regarding email retrieval from a database. From the user's query, determine:

1. **Order Preference**:
   - Retrieve older emails first ('older_first').
   - Retrieve newer emails first ('newer_first').
   - If no specific order is discernible from the query, identify the most relevant email ('best_match'), based on keywords or subjects that closely align with the user's question.

2. **Time Constraints**:
   - Identify the starting point for the query ('start_time').
   - Identify when to stop the query ('end_time').

**Context**:

- The current time is '${new Date().toUTCString()}'.

**Output Guidelines**:

- For terms implying a near-future context (e.g., "next", "newest", "upcoming"), opt for the 'newer_first' ordering.
- For terms implying a distant past (e.g., "first", "oldest"), use the 'older_first' ordering.
- If the user's query does not provide a clear time frame, or if the system's confidence in deducing a timeframe is below 70%, exclude 'start_time' and 'end_time' from the output.
- If the deduced 'end_time' aligns with current time, omit the 'end_time'.
- For unspecified time zones, timestamps should follow the 'YYYY-MM-DD hh:mm:ss' format.
- If only the date is known, use the 'YYYY-MM-DD' format.
- Assume the week starts on Monday.
- Your response should be structured in JSON, strictly adhering to the schema:
  \`\`\`
  {
    "ordering": "",
    "start_time": "",
    "end_time": ""
  }
  \`\`\`
- Example Queries and Responses:
  - **Query**: "When is the next conference event?"
    **Response**: \`{"ordering":"newer_first"}\`
  - **Query**: "What did James write to me about last Friday?" (assuming that current time is "2023-10-02")
    **Response**: \`{"ordering":"best_match", "start_time": "2023-09-29", "end_time": "2023-09-30"}\`
  - **Query**: "When did I receive my first Amazon invoice?"
    **Response**: \`{"ordering":"older_first"}\`

**User's Query**:
Process the user question:
`.trim();

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

    if (opts.user) {
        payload.user = opts.user;
    }

    if (opts.temperature && !isNaN(opts.temperature)) {
        payload.temperature = Number(opts.temperature);
    }

    if (opts.topP && !isNaN(opts.topP)) {
        payload.top_p = Number(opts.topP);
    }

    const requestId = crypto.randomBytes(8).toString('base64');

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
        console.error(util.inspect({ requestId, payload }, false, 8, true));
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

    let output =
        data &&
        data.choices &&
        data.choices
            .filter(msg => msg && ((msg.message && msg.message.role === 'assistant' && msg.message.content) || msg.text))
            .sort((a, b) => ((a && a.index) || 0) - ((b && b.index) || 0))
            .map(msg => (msg.message && msg.message.content) || msg.text)
            .join('')
            .trim();

    if (opts.verbose) {
        console.error(util.inspect({ requestId, output: data }, false, 8, true));
    }

    let responseValues = { answer: '', 'message-id': '' };
    let curKey;
    output
        .trim()
        .replace(/\r?\n/g, '\n')
        .split(/(^|\n)(Answer:|Message-ID:)/gi)
        .map(v => v.trim())
        .filter(v => v)
        .forEach(val => {
            if (/^(answer|message-id):$/i.test(val)) {
                curKey = val.replace(/:$/, '').trim().toLowerCase();
                return;
            }

            if (!curKey || !val) {
                return;
            }

            if (curKey === 'message-id') {
                val = val
                    .split(/,/)
                    .map(v => v.trim())
                    .filter(v => v)
                    .join('\n');
            }

            if (!responseValues[curKey]) {
                responseValues[curKey] = val;
            } else {
                responseValues[curKey] += '\n' + val;
            }
        });

    if (responseValues['message-id']) {
        responseValues.messageId = Array.from(new Set(responseValues['message-id'].split(/\n/)));
    }
    delete responseValues['message-id'];

    const response = Object.assign({ id: null, tokens: null, model: null }, responseValues, {
        id: data && data.id,
        tokens: data && data.usage && data.usage.total_tokens,
        model: gptModel
    });

    if (opts.verbose) {
        response._time = reqEndTime - reqStartTime;
        response._cr = charactersRemoved;

        console.error(util.inspect({ requestId, response }, false, 8, true));
    }

    return response;
}

async function questionQuery(question, apiToken, opts) {
    opts = opts || {};

    let systemPrompt = (opts.systemPrompt || DEFAULT_SYSTEM_PROMPT).toString().trim();
    question = (question || '').toString().trim();
    if (!question) {
        let error = new Error('Question not provided');
        error.code = 'EmptyInput';
        throw error;
    }

    let gptModel = opts.gptModel || 'gpt-3.5-turbo-instruct';

    let prompt = `${QUESTION_PROMPT}
${question}
`;

    let headers = {
        'User-Agent': `${packageData.name}/${packageData.version}`,
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
    };

    let payload = {
        model: gptModel
    };

    if (opts.user) {
        payload.user = opts.user;
    }

    if (opts.temperature && !isNaN(opts.temperature)) {
        payload.temperature = Number(opts.temperature);
    } else {
        payload.temperature = 0.2;
    }

    if (opts.topP && !isNaN(opts.topP)) {
        payload.top_p = Number(opts.topP);
    }

    const requestId = crypto.randomBytes(8).toString('base64');

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
        console.error(util.inspect({ requestId, payload }, false, 8, true));
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

    if (opts.verbose) {
        console.error(util.inspect({ requestId, output: data }, false, 8, true));
    }

    try {
        let objStart = output.indexOf('{');
        let objEnd = output.lastIndexOf('}');

        if (objStart < 0 || objEnd < 0 || objEnd <= objStart) {
            let error = new Error('Invalid JSON object');
            error.objStart = objStart;
            error.objEnd = objEnd;
            throw error;
        }

        // remove potential comments before and after the JSON output
        if (objEnd < output.length - 1) {
            output = output.substring(0, objEnd + 1);
        }

        if (objStart > 0) {
            output = output.substring(objStart);
        }

        values = JSON.parse(output);

        let walkAndRemoveNull = branch => {
            if (typeof branch !== 'object' || !branch) {
                return;
            }
            for (let key of Object.keys(branch)) {
                let subBranch = branch[key];
                if (Array.isArray(subBranch)) {
                    for (let entry of subBranch) {
                        walkAndRemoveNull(entry);
                    }
                } else if (subBranch && typeof subBranch === 'object') {
                    walkAndRemoveNull(subBranch);
                } else if (!['boolean', 'string', 'number'].includes(typeof subBranch) || subBranch === '') {
                    delete branch[key];
                }
            }
        };

        walkAndRemoveNull(values);
    } catch (err) {
        let error = new Error('Failed to parse output from OpenAI API', { cause: err });
        error.textContent = output;
        error.code = 'OutputParseFailed';
        throw error;
    }

    const response = Object.assign({ id: null, tokens: null, model: null }, values || {}, {
        id: data && data.id,
        tokens: data && data.usage && data.usage.total_tokens,
        model: gptModel
    });

    if (opts.verbose) {
        response._time = reqEndTime - reqStartTime;
    }

    return response;
}

module.exports = { embeddingsQuery, questionQuery };
