'use strict';

const packageData = require('../package.json');
const { htmlToText } = require('@postalsys/email-text-tools');
const { default: GPT3Tokenizer } = require('gpt3-tokenizer');
const util = require('util');
const crypto = require('crypto');
const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });

const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });

const MAX_ALLOWED_TEXT_LENGTH = 32 * 1024;
const MAX_ALLOWED_TOKENS = 4000;

const OPENAI_API_BASE_URL = 'https://api.openai.com';

const OPENAI_API_URL_CHAT = '/v1/chat/completions';
const OPENAI_API_URL_INSTRUCT = '/v1/completions';

const DEFAULT_ALLOWED_HEADERS = ['from', 'to', 'cc', 'bcc', 'subject', 'mime-version', 'authentication-results', 'date', 'content-type', 'list-id'];

const DEFAULT_SYSTEM_PROMPT = `
I want you to act as an executive assistant that processes emails for reporting.
`.trim();

const DEFAULT_USER_PROMPT = `
Instructions:
- You are an executive assistant scanning incoming emails to report what is important and what is not, and also to inform about obvious fraud attempts.
- Describe the sentiment of the email using one word. Use either "positive", "neutral", or "negative". Include this value in the response as a "sentiment" property.
- Generate a one-sentence summary of the email. Include this value in the response as a "summary" property.
- Does it seem like the sender of the email would expect a reply to this email? Include this information in the response as a "shouldReply" property with the value "true" if they expect it and "false" if not.
- If this email is a reply to a previous email or a forwarded email, then extract the text content that only the email's sender wrote, and include this as a "replyText" property in the response.
- Do not include message signatures in the extracted reply text
- If the email text mentions events, return these events as separate event objects in an "events" array
- In the event object include the following properties
  - "description" property that describes the event in English
  - "location" property that defines the expected location of the event
  - "startTime" property that includes a timestamp without a timezone for the start of the event
  - "endTime" property that includes a timestamp without timezone for the expected end of the event if there is high confidence for the value
  - "type" property that includes a keyword that describes the type of the event.
    - "event" is a regular calendar event
    - "meeting" is a scheduled meeting
    - "appointment" is a scheduled appointment
    - "task" if the event describes a task that needs to be completed by the due date
    - "general" describes a generic event, like a fair or a competition
- If the email text mentions actions that the recipient must take, return these actions as separate action objects in an "actions" array
- In the action object, include the following properties
  - "description" property that summarises the action in English
  - "dueDate" property that includes a timestamp without a timezone for the due date of the action
- Do not include the event in the "events" array if the confidence for it being an event is low
- Generate a security analysis of the email and store the security analysis in "riskAssessment" property as an object value.
- The "riskAssessment" object should include the following properties
  - "risk" property that contains a risk score for the email using the following scale: 1 - 5 (where 1 is low risk, and 5 is high risk), taking into account what may happen if a user acts by the instructions given in the email.
  - "assessment" property, a single-sentence assessment text that includes details about issues that increase the risk score. Do not disclose details that decrease the risk score or do not affect it.
- Your security analysis should contain (but is not limited to) the following risk factors:
  - Does the email include links with domain names that contain typos or homoglyphs that might mislead the user about the actual target of the link
  - Does the sender address of the email not seem to match the persona or organization the sender email claims to be
  - Does the email promise the user an extremely good financial outcome
  - Does the email promise unclaimed money or goods
  - Does the email offer a vague business opportunity with no specific details
  - Does the email suggest there is a severe penalty if the user does not act as requested
  - Does the email claim that there are technical issues with the user's email account
  - Does the email offer services or activities that are not suitable for underage persons
  - Does the sender's email look like a throwaway address
  - Does the sender's email look like it might be spoofed
  - Does the email contain attachments where the name of the attachment might be misleading and suggest a different file format than is actually used
  - Does the email contain attachments that might be executable files
- Always return the response in English

Facts:

- An email might contain an "authentication-results" result header that indicates if the message passed SPF, DKIM, ARC, and DMARC checks
- Having a valid SPF, DKIM, and DMARC increases the chances that the sender domain name is not spoofed
- For valid SPF, the "authentication-results" header must include "spf=pass"
- For valid DKIM, the "authentication-results" header must include "dkim=pass"
- For valid DMARC, the "authentication-results" header must include "dmarc=pass"
- For valid ARC, the "authentication-results" header must include "arc=pass"
- Throwaway email addresses might contain a word or a name and more than one number in the username of the email address
- Throwaway email addresses might use a randomly generated or hex text string as the username of the email address
- Throwaway email addresses might use free email services like gmail.com, outlook.com, hotmail.com, yahoo.com, aol.com, etc
- An email is a reply to a previous email only if it includes an "in-reply-to" header
- An email is a forwarded email only if it includes the "references" header but not the "in-reply-to" header
- The email structure includes a property "headers" that contains an array of header values.
- For timestamps without a timezone, use the "YYYY-MM-DD hh:mm:ss" format
- For timestamps without known time, use the "YYYY-MM-DD" format
- If the email uses relative dates, then use the date from the "date" header as the base value to calculate actual dates
`.trim();

const SCHEMA_PROMPT = `

Input facts:

- An email consists of message headers, an attachments list, and text content
- The email to analyze is formatted in a JSON format using the following schema:

\`\`\`
{
  "headers": [{"key": <Header-Name>, "value": <Header-Value>}],
  "attachments": [{"filename": "<File-Name>", "contentType": "<File-Type>"}],
  "subject": "<Subject>",
  "text": "<Plaintext-Content>"
}
\`\`\`

  - "<Header-Name>" defines the name part of a header line, e.g., "MIME-Version"
  - "<Header-Value>" defines the value part of a header line, e.g., "1.0"
  - "<File-Name>" defines the file name of the attachment, e.g., "document.pdf"
  - "<File-Type>" defines the file content type of the attachment, e.g., "application/pdf"
  - "<Subject>" defines the subject line of the email, e.g., "Sending documents."
  - "<Plaintext-Content>" defines the email body formatted as plaintext, e.g., "Documents are attached."

Output facts:

- You do not comment or explain anything
- Respond with a JSON formatted structure. Do not write any other explanations

Analyze the following email:`.trim();

function getApiUrl(baseApiUrl, path) {
    let url = new URL(path || '/', baseApiUrl || OPENAI_API_BASE_URL);
    return url.href;
}

async function generateSummary(message, apiToken, opts) {
    opts = opts || {};

    let baseApiUrl = opts.baseApiUrl || OPENAI_API_BASE_URL;

    let systemPrompt = (opts.systemPrompt || DEFAULT_SYSTEM_PROMPT).toString().trim();
    let userPrompt = (opts.userPrompt || DEFAULT_USER_PROMPT).toString().trim();

    let maxAllowedTokens = opts.maxTokens || MAX_ALLOWED_TOKENS;
    let gptModel = opts.gptModel || 'gpt-3.5-turbo';

    let text = message.text || '';
    if (message.html && (!text || message.html.length >= text.length)) {
        text = htmlToText(message.html);
    }

    const allowedHeaders = !opts.allowedHeaders
        ? DEFAULT_ALLOWED_HEADERS
        : Array.from(
              new Set(
                  []
                      .concat(opts.allowedHeaders || [])
                      .concat(DEFAULT_ALLOWED_HEADERS)
                      .map(header => (header || '').toString().trim().toLowerCase())
                      .filter(header => header)
              )
          );

    let prompt;
    const headerSeen = new Set();

    const content = {
        headers: []
            .concat(message.headers || [])
            .filter(
                // use a whitelist
                header => allowedHeaders.includes(header.key)
            )
            .filter(header => {
                // only keept the latest authentication header
                if (['authentication-results', 'arc-authentication-results', 'arc-message-signature', 'arc-seal'].includes(header.key)) {
                    if (headerSeen.has(header.key)) {
                        return false;
                    }
                    headerSeen.add(header.key);
                }
                return true;
            }),
        attachments: []
            .concat(message.attachments || [])
            .map(attachment => ({ filename: attachment.filename, contentType: attachment.contentType }))
            .filter(attachment => attachment.filename || attachment.contentType)
    };

    let charactersRemoved = 0;
    let promptText = text;

    if (promptText.length > MAX_ALLOWED_TEXT_LENGTH) {
        charactersRemoved += promptText.length - MAX_ALLOWED_TEXT_LENGTH;
        promptText = promptText.substr(0, MAX_ALLOWED_TEXT_LENGTH);
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
        content.text = promptText;
        prompt = `${userPrompt}
${SCHEMA_PROMPT}

${JSON.stringify(content)}`;

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

    let requestId = crypto.randomBytes(8).toString('base64');

    let res;
    let data;
    let retries = 0;

    let openAiAPIURL;
    switch (gptModel) {
        case 'gpt-3.5-turbo-instruct':
            {
                openAiAPIURL = getApiUrl(baseApiUrl, OPENAI_API_URL_INSTRUCT);
                payload.prompt = `${systemPrompt}\n${prompt}`;
                let tokens = tokenizer.encode(payload.prompt);
                payload.max_tokens = 4000 - tokens.bpe.length;
            }
            break;

        case 'gpt-3.5-turbo':
        case 'gpt-4':
        default:
            openAiAPIURL = getApiUrl(baseApiUrl, OPENAI_API_URL_CHAT);
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
        console.error(util.inspect({ requestId, apiUrl: openAiAPIURL, payload }, false, 8, true));
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
        console.error(util.inspect({ requestId, output, data }, false, 8, true));
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
        throw error;
    }

    const response = Object.assign({ id: null, tokens: null, model: null }, values, {
        id: data && data.id,
        tokens: data && data.usage && data.usage.total_tokens,
        model: gptModel
    });

    if (opts.verbose) {
        response._text = content.text;
        response._time = reqEndTime - reqStartTime;
        response._cr = charactersRemoved;
    }

    return response;
}

module.exports = { generateSummary, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT };
