'use strict';

const http = require('node:http');

async function createMockServer() {
    let requestHandler = () => ({ status: 500, body: { error: 'No handler set' } });
    const requests = [];

    const server = http.createServer((req, res) => {
        // collect Buffers, decoding chunk by chunk would split multi-byte characters
        const chunks = [];
        req.on('data', chunk => {
            chunks.push(chunk);
        });
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            let parsedBody = null;
            try {
                if (body) {
                    parsedBody = JSON.parse(body);
                }
            } catch {
                parsedBody = body;
            }

            requests.push({
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: parsedBody
            });

            const response = requestHandler(req, parsedBody);
            if (typeof response.raw === 'string') {
                // a non-JSON body, for example an HTML error page from a proxy
                res.writeHead(response.status || 200, Object.assign({ 'Content-Type': 'text/html' }, response.headers));
                res.end(response.raw);
                return;
            }
            res.writeHead(response.status || 200, Object.assign({ 'Content-Type': 'application/json' }, response.headers));
            res.end(JSON.stringify(response.body || {}));
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        url: `http://127.0.0.1:${port}`,
        get requests() {
            return requests;
        },
        clearRequests() {
            requests.length = 0;
        },
        setHandler(fn) {
            requestHandler = fn;
        },
        async close() {
            await new Promise(resolve => server.close(resolve));
        }
    };
}

function chatResponse(content, opts) {
    opts = opts || {};
    return {
        status: 200,
        body: {
            id: opts.id || 'chatcmpl-test123',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: typeof content === 'string' ? content : JSON.stringify(content)
                    }
                }
            ],
            usage: { total_tokens: opts.tokens || 150 }
        }
    };
}

function instructResponse(content, opts) {
    opts = opts || {};
    return {
        status: 200,
        body: {
            id: opts.id || 'cmpl-test123',
            choices: [
                {
                    index: 0,
                    text: typeof content === 'string' ? content : JSON.stringify(content)
                }
            ],
            usage: { total_tokens: opts.tokens || 100 }
        }
    };
}

function embeddingResponse(embedding) {
    return {
        status: 200,
        body: {
            data: [{ embedding: embedding || [0.1, 0.2, 0.3] }],
            usage: { total_tokens: 50 }
        }
    };
}

function modelsResponse(models) {
    return {
        status: 200,
        body: {
            data: models || [
                { id: 'gpt-4', owned_by: 'openai' },
                { id: 'gpt-3.5-turbo', owned_by: 'openai' },
                { id: 'text-embedding-ada-002', owned_by: 'openai' }
            ]
        }
    };
}

function errorResponse(status, message, code) {
    return {
        status,
        body: {
            error: {
                message,
                code
            }
        }
    };
}

module.exports = {
    createMockServer,
    chatResponse,
    instructResponse,
    embeddingResponse,
    modelsResponse,
    errorResponse
};
