'use strict';

const packageData = require('../package.json');
const { htmlToText } = require('@postalsys/email-text-tools');
const { default: GPT3Tokenizer } = require('gpt3-tokenizer');
const util = require('util');
const crypto = require('crypto');
const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: 90 * 1000 } });

const tokenizer = new GPT3Tokenizer({ type: 'gpt3' });

const MAX_ALLOWED_TEXT_LENGTH = 64 * 1024;
const DEFAULT_MAX_ALLOWED_TOKENS = 30000;
const MAX_INSTRUCT_TOKENS = 4000;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

const OPENAI_API_BASE_URL = 'https://api.openai.com';

const OPENAI_API_URL_CHAT = '/v1/chat/completions';
const OPENAI_API_URL_INSTRUCT = '/v1/completions';

const DEFAULT_ALLOWED_HEADERS = [
    'from',
    'to',
    'cc',
    'bcc',
    'subject',
    'mime-version',
    'authentication-results',
    'arc-authentication-results',
    'arc-message-signature',
    'arc-seal',
    'date',
    'content-type',
    'list-id'
];

const DEFAULT_SYSTEM_PROMPT = `
You are an executive assistant that processes emails for reporting. Your role is to analyze emails for important information and identify potential security threats.
`.trim();

const DEFAULT_USER_PROMPT = `
Instructions:

RETURN A JSON OBJECT with the following structure:

REQUIRED FIELDS:
- "sentiment": Must be exactly one of: "positive", "neutral", or "negative"
- "summary": A concise one-sentence summary (maximum 150 characters)
- "shouldReply": Boolean - true if the sender expects a reply, false otherwise
- "riskAssessment": Object containing:
  - "risk": Integer from 1 to 5 (1=low risk, 5=high risk)
  - "assessment": Single sentence describing only the risk factors (if risk > 1)

OPTIONAL FIELDS (only include if applicable):
- "replyText": If this is a reply or forward, extract only the new content written by the current sender (exclude quoted text, signatures, and reply markers)
- "events": Array of event objects (only include if confidence is medium or high)
  - "description": Event description in English
  - "location": Event location (if mentioned)
  - "startTime": ISO 8601 format (YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD)
  - "endTime": ISO 8601 format (only if clearly stated)
  - "type": One of "meeting", "appointment", "task", "event", or "general"
  - "confidence": One of "high", "medium", "low"
- "actions": Array of action objects (only if recipient must take action)
  - "description": Action description in English
  - "dueDate": ISO 8601 format (YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD)
  - "confidence": One of "high", "medium", "low"

SECURITY ANALYSIS - Assess risk based on these factors:
HIGH RISK INDICATORS (risk 4-5):
- Links with typosquatted or homoglyph domains (e.g., paypa1.com, g00gle.com)
- Sender address mismatches claimed identity (e.g., from "support@random.com" claiming to be "Microsoft")
- Promises of large unclaimed money, inheritances, or lottery winnings
- Threats of severe penalties, account suspension, or legal action
- Requests to verify account credentials or update payment information urgently
- Attachments with double extensions (e.g., invoice.pdf.exe) or executable extensions (.exe, .scr, .bat, .vbs, .js)

MEDIUM RISK INDICATORS (risk 2-3):
- Vague business opportunities with no specific details
- Claims of technical issues requiring immediate action
- Sender uses suspicious email patterns (long random strings, excessive numbers in username)
- Missing or failed email authentication (no SPF/DKIM/DMARC pass)
- Offers of adult content or age-restricted services

LOW RISK INDICATORS (risk 1):
- Valid SPF, DKIM, and DMARC authentication (all pass)
- Professional email from recognized organization
- No urgency pressure or suspicious requests

EMAIL AUTHENTICATION FACTS:
- "authentication-results" header shows SPF, DKIM, DMARC, and ARC validation
- Look for: "spf=pass", "dkim=pass", "dmarc=pass", "arc=pass"
- Passing all checks significantly reduces spoofing risk
- Failed or missing authentication increases risk

TIMESTAMP GUIDELINES:
- Use ISO 8601 format: YYYY-MM-DDTHH:mm:ss (24-hour time)
- For date-only: YYYY-MM-DD
- If email uses relative dates (e.g., "tomorrow", "next week"), calculate from the "date" header
- Do not include timezone information

REPLY/FORWARD DETECTION:
- Email is a reply if it has an "in-reply-to" header
- Email is a forward if it has "references" header but no "in-reply-to" header
- For replies/forwards, extract only the new content, excluding:
  - Lines starting with ">" (quoted text)
  - Email signatures
  - Previous email headers (From:, Sent:, To:, etc.)
  - Forwarding markers (------Original Message------)

Always return response in English, regardless of input language.
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

/**
 * Generates a comprehensive summary and analysis of an email message using OpenAI's API
 *
 * @param {Object} message - The email message object to analyze
 * @param {Array} message.headers - Array of header objects with {key, value} structure
 * @param {Array} [message.attachments] - Array of attachment objects with {filename, contentType}
 * @param {string} [message.text] - Plain text content of the email
 * @param {string} [message.html] - HTML content of the email (will be converted to text)
 * @param {string} apiToken - OpenAI API authentication token
 * @param {Object} [opts] - Configuration options
 * @param {string} [opts.baseApiUrl] - Custom API base URL (default: OpenAI API)
 * @param {string} [opts.gptModel='gpt-5-mini'] - Model to use (gpt-3.5-turbo, gpt-4, etc.)
 * @param {string} [opts.systemPrompt] - Override default system prompt
 * @param {string} [opts.userPrompt] - Override default user prompt
 * @param {number} [opts.maxTokens=4000] - Maximum tokens for the prompt
 * @param {number} [opts.temperature] - Sampling temperature (0-2)
 * @param {number} [opts.topP] - Nucleus sampling parameter (0-1)
 * @param {string} [opts.user] - OpenAI user identifier for tracking
 * @param {Array<string>} [opts.allowedHeaders] - Additional headers to include (merged with defaults)
 * @param {boolean} [opts.verbose=false] - Enable debug logging
 *
 * @returns {Promise<Object>} Analysis result object
 * @returns {string} return.sentiment - Email sentiment: 'positive', 'neutral', or 'negative'
 * @returns {string} return.summary - One-sentence summary of the email
 * @returns {boolean} return.shouldReply - Whether sender expects a reply
 * @returns {Object} return.riskAssessment - Security risk assessment
 * @returns {number} return.riskAssessment.risk - Risk score from 1 (low) to 5 (high)
 * @returns {string} [return.riskAssessment.assessment] - Description of risk factors (if risk > 1)
 * @returns {string} [return.replyText] - Extracted new content from reply/forward
 * @returns {Array<Object>} [return.events] - Extracted calendar events
 * @returns {Array<Object>} [return.actions] - Actions required from recipient
 * @returns {string} return.id - OpenAI request ID
 * @returns {number} return.tokens - Total tokens used
 * @returns {string} return.model - Model used for generation
 *
 * @throws {Error} If prompt is too long even after truncation
 * @throws {Error} If API request fails
 * @throws {Error} If response is not valid JSON
 *
 * @example
 * const result = await generateSummary(
 *   {
 *     headers: [{key: 'from', value: 'user@example.com'}],
 *     text: 'Meeting tomorrow at 2pm'
 *   },
 *   'sk-...',
 *   { gptModel: 'gpt-5-mini' }
 * );
 * console.log(result.summary);
 * console.log(result.events);
 */
async function generateSummary(message, apiToken, opts) {
    opts = opts || {};

    let baseApiUrl = opts.baseApiUrl || OPENAI_API_BASE_URL;

    let systemPrompt = (opts.systemPrompt || DEFAULT_SYSTEM_PROMPT).toString().trim();
    let userPrompt = (opts.userPrompt || DEFAULT_USER_PROMPT).toString().trim();

    let maxAllowedTokens = opts.maxTokens || DEFAULT_MAX_ALLOWED_TOKENS;
    let gptModel = opts.gptModel || 'gpt-5-mini';

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
                // only keep the latest authentication header
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
        promptText = promptText.substring(0, MAX_ALLOWED_TEXT_LENGTH);
    }

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
            charactersRemoved += 256;
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
            const error = new Error(
                `Unable to fit email content within token limit of ${maxAllowedTokens}. ` +
                    `Original text length: ${text.length} characters. ` +
                    `Removed ${charactersRemoved} characters but still exceeds limit. ` +
                    `Consider using a model with larger context window.`
            );
            error.code = 'PROMPT_TOO_LONG';
            error.originalLength = text.length;
            error.charactersRemoved = charactersRemoved;
            error.maxAllowedTokens = maxAllowedTokens;
            throw error;
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
                payload.max_tokens = MAX_INSTRUCT_TOKENS - tokens.bpe.length;
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
            if (res.status === 429 && ++retries < MAX_RETRIES) {
                // try again
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
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
