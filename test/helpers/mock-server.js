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
    const total = opts.tokens || 150;
    return {
        status: 200,
        body: {
            id: opts.id || 'chatcmpl-test123',
            model: opts.model || 'test-model-2026-01-01',
            choices: [
                {
                    index: 0,
                    finish_reason: opts.finishReason || 'stop',
                    message: {
                        role: 'assistant',
                        content: typeof content === 'string' ? content : JSON.stringify(content)
                    }
                }
            ],
            usage: { prompt_tokens: total - 30, completion_tokens: 30, total_tokens: total }
        }
    };
}

function modelsResponse(models) {
    return {
        status: 200,
        body: {
            data: models || [
                { id: 'gpt-6-luna', owned_by: 'system' },
                { id: 'gpt-5-mini', owned_by: 'system' },
                { id: 'text-embedding-3-small', owned_by: 'system' }
            ]
        }
    };
}

function errorResponse(status, message, code, param) {
    return {
        status,
        body: {
            error: {
                message,
                code,
                param
            }
        }
    };
}

module.exports = {
    createMockServer,
    chatResponse,
    modelsResponse,
    errorResponse
};
