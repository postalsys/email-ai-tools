'use strict';

const packageData = require('../package.json');
const { htmlToText } = require('@postalsys/email-text-tools');
const GPT3Tokenizer = require('gpt3-tokenizer').default;

const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });

const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });

const MAX_ALLOWED_TEXT_LENGTH = 32 * 1024;
const MAX_ALLOWED_TOKENS = 4000;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `
I want you to act as are an IT security expert that monitors emails for suspicious and risky activity.
`
    .replace(/\s+/g, ' ')
    .trim();

const USER_PROMPT = `
Instructions:
- You are an IT security expert scanning incoming emails to detect and block fraud attempts.
- Your task is to monitor and analyze incoming emails, which consist of the message headers, a list of attachments, and text content
- Your analysis should contain (but is not limited to) the following risk factors:
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
- Provide a risk score for the email using the following scale: 1 - 5 (where 1 is low risk, and 5 is high risk), taking into account what may happen if a user acts by the instructions given in the email.
- Provide a short single-sentence assessment text that includes details about issues that increase the risk score, do not disclose details that decrease the risk score or do not affect it.
- Respond with a JSON formatted structure with a numeric risk score as "risk" property and the assessment as the "assessment" property. Do not write any other explanations.

Facts:
- An email consists of message headers, an attachments list, and text content
- An email might contain an "authentication-results" result header that indicates if the message passed SPF, DKIM, ARC, and DMARC checks
- Having a valid SPF, DKIM, and DMARC increases the chances that the sender domain name is not spoofed
- For valid SPF, the "authentication-results" header must include "spf=pass"
- For valid DKIM, the "authentication-results" header must include "dkim=pass"
- For valid DMARC, the "authentication-results" header must include "dmarc=pass"
- For valid ARC, the "authentication-results" header must include "arc=pass"
- Throwaway email addresses might contain a word or a name and more than one number in the username of the email address
- Throwaway email addresses might use a randomly generated or hex text string as the username of the email address
- Throwaway email addresses might use free email services like gmail.com, outlook.com, hotmail.com, yahoo.com, aol.com, etc
- The email to analyze is formatted in a JSON format
- The email structure includes a property "headers" that contains an array of header values.
- Each header contains two properties, "key" as the header field key name and "value" as the header value without the key prefix
- The email structure includes a property "attachments" that contains an array of attachments.
- Each attachment includes a "filename" property that describes the file name, "contentType" property that describes the Content-Type value of the attachment
- The email includes a "text" property for the text content

Analyze the following email:
`.trim();

async function riskAnalysis(message, apiToken, opts) {
    opts = opts || {};

    let maxAllowedTokens = opts.maxTokens || MAX_ALLOWED_TOKENS;
    let gptModel = opts.gptModel || 'gpt-3.5-turbo';

    let text = message.text || '';
    if (message.html && (!text || message.html.length > text.length * 2)) {
        text = htmlToText(message.html);
    }

    let prompt;

    const headerSeen = new Set();
    const content = {
        headers: []
            .concat(message.headers || [])
            .filter(
                // use a whitelist
                header =>
                    ['from', 'to', 'cc', 'bcc', 'subject', 'mime-version', 'authentication-results', 'date', 'content-type', 'list-id'].includes(header.key)
            )
            .filter(header => {
                // only keept the latest
                if (['authentication-results'].includes(header.key)) {
                    if (headerSeen.has(header.key)) {
                        return false;
                    }
                    headerSeen.add(header.key);
                }
                return true;
            }),
        attachments: [].concat(message.attachments || []).map(attachment => ({ filename: attachment.filename, contentType: attachment.contentType }))
    };

    let charactersRemoved = 0;
    let promptText = text;

    if (promptText.length > MAX_ALLOWED_TEXT_LENGTH) {
        charactersRemoved += promptText.length - MAX_ALLOWED_TEXT_LENGTH;
        promptText = promptText.substr(0, MAX_ALLOWED_TEXT_LENGTH);
    }

    while (promptText.length) {
        content.text = promptText;
        prompt = `${USER_PROMPT}

${JSON.stringify(content)}`;

        let tokens = tokenizer.encode(prompt);
        if (tokens.text.length <= maxAllowedTokens) {
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
        model: gptModel,
        messages: [
            {
                role: 'system',
                content: `${SYSTEM_PROMPT}`
            },
            {
                role: 'user',
                content: prompt
            }
        ]
    };

    let res;
    let data;
    let retries = 0;

    let run = async () => {
        res = await fetchCmd(OPENAI_API_URL, {
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
    const output =
        data &&
        data.choices &&
        data.choices
            .filter(msg => msg && msg.message && msg.message.role === 'assistant' && msg.message.content)
            .sort((a, b) => ((a && a.index) || 0) - ((b && b.index) || 0))
            .map(msg => msg.message.content)
            .join('\n')
            .trim()
            .replace(/^\s*"|"\s*$/g, '')
            .trim();

    try {
        values = JSON.parse(output);
        values.risk = Number(values.risk) || -1;
    } catch (err) {
        let error = new Error('Failed to parse output from OpenAI API');
        error.textContent = output;
        throw error;
    }

    const response = Object.assign({ id: null, tokens: null, model: null }, values, {
        id: data && data.id,
        tokens: data && data.usage && data.usage.total_tokens,
        model: gptModel,

        _text: content.text,
        _time: reqEndTime - reqStartTime,
        _cr: charactersRemoved
    });

    return response;
}

module.exports = riskAnalysis;
