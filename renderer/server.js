/**
 * The Lambda handler behind plain HTTP, for local development (an io-docker service):
 * POST /render with render()'s input as JSON, get its output back. GET /health answers ok.
 */

import { createServer } from 'node:http';

import { handler } from './lambda.js';

const PORT = Number(process.env.PORT) || 3080;
// a document with an embedded image runs to about a megabyte
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/render') return send(res, 404, { error: 'not found' });

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { send(res, 413, { error: 'document too large' }); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, { error: 'expected JSON' });
    }
    const out = await handler(input);
    send(res, out.error ? 422 : 200, out);
  });
}).listen(PORT, () => console.log(`marquee renderer listening on :${PORT}`));
