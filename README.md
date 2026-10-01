# email-ai-tools

Summarize and risk-score email messages with an OpenAI-compatible chat model. This is the library behind the AI processing feature of [EmailEngine](https://emailengine.app/).

## Install

```
npm install @postalsys/email-ai-tools
```

Node.js 20 or later. Plain CommonJS with no build step and no native dependencies.

## generateSummary(message, apiToken, options)

Sends one email to the chat completions endpoint and returns what the model reported about it.

```js
const { generateSummary } = require('@postalsys/email-ai-tools');

const { result, usage } = await generateSummary(
    {
        subject: 'Meeting tomorrow at 2pm',
        from: { name: 'Jane Doe', address: 'jane@example.com' },
        date: 'Mon, 17 Oct 2022 09:42:07 +0300',
        headers: [{ key: 'authentication-results', value: 'mx.example.com; spf=pass; dkim=pass; dmarc=pass' }],
        attachments: [{ filename: 'agenda.pdf', contentType: 'application/pdf' }],
        text: 'Can we go through the Q4 roadmap tomorrow at 2pm in room A?'
    },
    process.env.OPENAI_API_KEY
);

console.log(result);
// {
//   summary: 'Jane asks to review the Q4 roadmap tomorrow at 2pm in room A.',
//   sentiment: 'positive',
//   shouldReply: true,
//   riskAssessment: { risk: 1 },
//   events: [{ description: 'Q4 roadmap review', type: 'meeting', startTime: '2022-10-18T14:00:00', location: 'room A' }],
//   actions: [{ description: 'Confirm the meeting' }]
// }

console.log(usage);
// { id: 'chatcmpl-...', model: 'gpt-6-luna', servedModel: 'gpt-6-luna-2026-09-22', tokens: 812, promptTokens: 790, completionTokens: 22, time: 1430, charactersRemoved: 0 }
```

### Message

| Property      | Description                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject`     | Decoded subject line. Falls back to the `subject` header                                                                                             |
| `from`        | Sender, as a string or as `{ name, address }`. Falls back to the `from` header                                                                       |
| `date`        | `Date` object or the raw header value. Falls back to the `date` header                                                                               |
| `headers`     | Array of `{ key, value }` objects; `value` may be a string or a list of strings. Encoded words are decoded. Only whitelisted headers reach the model |
| `attachments` | Array of `{ filename, contentType }` objects. Other properties are ignored                                                                           |
| `text`        | Plain text body                                                                                                                                      |
| `html`        | HTML body, converted to text when it is at least as long as `text`                                                                                   |

The whitelisted headers are `from`, `reply-to`, `to`, `cc`, `bcc`, `date`, `subject`, `in-reply-to`, `references`, `list-id`, `auto-submitted`, `precedence`, `authentication-results` and `arc-authentication-results`. Of the authentication results only the topmost value, the one added by the receiving server, is passed on. Add more with `options.allowedHeaders`.

### Options

| Option            | Default                    | Description                                                                                                                                              |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseApiUrl`      | `https://api.openai.com`   | Base URL of an OpenAI-compatible API, including any path prefix the service mounts it under, for example `https://<resource>.openai.azure.com/openai/v1` |
| `gptModel`        | `DEFAULT_MODEL`            | Model name                                                                                                                                               |
| `instructions`    | `DEFAULT_INSTRUCTIONS`     | The analysis instructions, including the JSON properties to return. Replaces the default block as a whole                                                |
| `systemPrompt`    | `DEFAULT_SYSTEM_PROMPT`    | The role and the untrusted-data rule at the top of the system message                                                                                    |
| `maxTokens`       | `30000`                    | Budget for the whole prompt as an estimated token count. The email text is cut to fit                                                                    |
| `reasoningEffort` | `low` for reasoning models | Sent as `reasoning_effort`. Reasoning models are GPT-5 and later, gpt-oss and the o-series; others get nothing unless a value is given                   |
| `temperature`     |                            | Sampling temperature                                                                                                                                     |
| `topP`            |                            | Nucleus sampling cutoff                                                                                                                                  |
| `jsonMode`        | `true`                     | Asks for a JSON object response (`response_format`)                                                                                                      |
| `user`            |                            | End-user identifier passed to the API                                                                                                                    |
| `allowedHeaders`  |                            | Header names to pass on in addition to the whitelist                                                                                                     |
| `dispatcher`      | the module's own agent     | undici dispatcher the request goes through, for example a `ProxyAgent`                                                                                   |
| `signal`          |                            | `AbortSignal` that cancels the request and any rate limit wait                                                                                           |
| `verbose`         | `false`                    | Logs the request and the response to stderr and includes the fitted text as `usage.text`                                                                 |

A parameter the backend refuses with a 400 that names it (`response_format`, `reasoning_effort`, `temperature`, `top_p`) is dropped, the request is repeated, and the refusal is remembered for that endpoint and model. That is what makes one configuration work across OpenAI's reasoning models, its chat models, which reject `reasoning_effort`, and compatible servers that know neither. The sampling parameters are not even sent to a model that is reasoning, since every such model refuses them; with the effort set to `none` they are sent again.

### Prompt layout

The system message carries the role, the rule that the email is untrusted data, the instructions and a description of the input format. The user message is a single JSON object with the email: `subject`, `from`, `date`, `headers`, `attachments` and `text`. Nothing of the email is mixed into the instructions.

### Result

`result` is the JSON object the model returned, with `null` and empty values removed. The properties the default instructions ask for are normalized: `sentiment` is lower-cased and must be one of `positive`, `neutral` or `negative`, `shouldReply` is a boolean, `riskAssessment.risk` is an integer from 1 to 5, and `events` and `actions` are arrays of objects. A value that cannot be made to fit is dropped. Properties that custom instructions ask for are passed on as they came.

`usage` holds the request id, the model name requested and the one the API reports it served, the token counts, the request time in milliseconds and how many characters were cut from the text to fit the budget.

### Errors

The promise rejects with an `Error` carrying `statusCode` and, when the API gave one, `code`. A 429 is retried up to five times honoring `Retry-After`. A response without a JSON object fails with `Failed to parse output from OpenAI API`, `textContent` holding the output and `finishReason` the reason the model stopped. A prompt that does not fit the budget even without any text fails with the code `PROMPT_TOO_LONG` before any request is made.

## listModels(apiToken, options)

Lists the models the endpoint serves, newest family first, each with a display name.

```js
const { listModels } = require('@postalsys/email-ai-tools');

const { models } = await listModels(process.env.OPENAI_API_KEY);
// [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', ... }, { id: 'gpt-6-luna', name: 'GPT-6 Luna', ... }, ...]
```

Models that are not chat models are left out unless `chatOnly: false` is set. On OpenAI's own endpoint the names are known, so embeddings, speech, images, video, moderation, the legacy completion models and specialised variants such as codex or search are all dropped; on another endpoint the names are whatever the operator pulled, so only embeddings, speech and reranking models are. `baseApiUrl`, `dispatcher`, `signal` and `verbose` work as above.

## Other exports

`DEFAULT_MODEL`, `DEFAULT_REASONING_EFFORT`, `DEFAULT_SYSTEM_PROMPT` and `DEFAULT_INSTRUCTIONS`, for a UI that lets the operator edit the instructions or pick the model.

## Upgrading from 1.x

- `generateSummary()` returns `{ result, usage }`. The request id, token count and model name are no longer merged into the model's own output; read them from `usage`
- The analysis instructions live in the system message and are overridden with `options.instructions`. `options.userPrompt` and `DEFAULT_USER_PROMPT` are gone
- Header values are decoded and lists are flattened, and `subject`, `from` and `date` are passed to the model as their own properties
- The default model is `gpt-6-luna`, the default instructions no longer ask for `replyText`, and reasoning models get `reasoning_effort: "low"`
- `riskAnalysis()`, `generateEmbeddings()`, `getChunkEmbeddings()`, `embeddingsQuery()` and `questionQuery()` were removed, along with the completions endpoint branch for `gpt-3.5-turbo-instruct`

## License

MIT
