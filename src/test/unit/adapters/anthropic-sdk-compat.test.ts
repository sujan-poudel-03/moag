// ─── Anthropic SDK compatibility: the adapter against a local Messages API ───
//
// The adapter types the SDK as `any`, so tsc cannot tell when an SDK upgrade
// changes what it relies on: the default export, `new X({ apiKey })`,
// `messages.stream(params, { signal })`, async iteration over stream events,
// `finalMessage()`, and the APIUserAbortError / AbortError names. These tests
// drive the real adapter and the real installed SDK against a 127.0.0.1 HTTP
// server that serves canned server-sent events. No network, no key, no cost.
//
// The SDK reads ANTHROPIC_BASE_URL when no baseURL is passed, which is how the
// adapter's client ends up talking to the local server.

import { strict as assert } from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { AnthropicAdapter } from '../../../adapters/anthropic-adapter';
import { setMockConfig, clearMockConfig } from '../mocks/vscode';

// ─── Canned server ───

interface SeenRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Behaviour = 'text' | 'hang-after-first-delta' | 'bad-request';

/** One SSE frame. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_ID = 'msg_local_0001';

/** message_start + one text block streamed as two deltas. */
function headFrames(): string[] {
  return [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: MESSAGE_ID, type: 'message', role: 'assistant', model: 'claude-test', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
  ];
}

function tailFrames(): string[] {
  return [
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }),
    sse('message_stop', { type: 'message_stop' }),
  ];
}

describe('Anthropic SDK compatibility (adapter against a local Messages API)', function () {
  this.timeout(20_000);

  let server: http.Server;
  let behaviour: Behaviour = 'text';
  const seen: SeenRequest[] = [];
  /** Resolves when the server sees the client close a hanging stream. */
  let socketClosed: Promise<void> = Promise.resolve();
  let markSocketClosed: () => void = () => { /* replaced per request */ };
  const savedEnv: Record<string, string | undefined> = {};

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* not JSON */ }
        seen.push({ url: String(req.url ?? ''), headers: req.headers, body });

        if (behaviour === 'bad-request') {
          res.writeHead(400, { 'Content-Type': 'application/json', 'x-should-retry': 'false', 'request-id': 'req_local_400' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: canned rejection from the local server' } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        for (const f of headFrames()) { res.write(f); }
        if (behaviour === 'hang-after-first-delta') {
          // Never finish: only the client hanging up ends this response.
          res.on('close', () => markSocketClosed());
          return;
        }
        for (const f of tailFrames()) { res.write(f); }
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) { savedEnv[k] = process.env[k]; }
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-local-test-key';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  after(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
    }
    clearMockConfig();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
    behaviour = 'text';
    // An empty configured key: the adapter falls back to ANTHROPIC_API_KEY, the way it reads it today.
    setMockConfig('agentTaskPlayer.engines.anthropic', { apiKey: '', multiTurn: false, model: 'claude-test' });
    socketClosed = new Promise<void>((resolve) => { markSocketClosed = resolve; });
  });

  it('a streamed text reply: stdout is the text, tokens come from usage, exit 0', async () => {
    const chunks: string[] = [];
    const r = await new AnthropicAdapter().runTask({ prompt: 'say hello', cwd: process.cwd(), onOutput: (t: string) => { chunks.push(t); } });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, 'Hello, world');
    assert.equal(r.stderr, '');
    assert.equal(r.tokenUsage?.inputTokens, 42);
    assert.equal(r.tokenUsage?.outputTokens, 7);
    assert.equal(r.tokenUsage?.totalTokens, 49);
    assert.ok(chunks.join('').includes('Hello, world'), 'the text is streamed through onOutput');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url.split('?')[0], '/v1/messages');
    assert.equal(seen[0].body.stream, true);
    assert.equal(seen[0].body.model, 'claude-test');
  });

  it('abort mid-stream: a stop, not a failure ("Request cancelled", exit 0), and the connection is closed', async () => {
    behaviour = 'hang-after-first-delta';
    const ac = new AbortController();
    const chunks: string[] = [];
    let aborted = false;
    const r = await new AnthropicAdapter().runTask({
      prompt: 'say hello slowly',
      cwd: process.cwd(),
      signal: ac.signal,
      onOutput: (t: string) => {
        chunks.push(t);
        // Abort once the first delta has arrived, while the SDK waits for the next one.
        if (t === 'Hello' && !aborted) { aborted = true; setTimeout(() => ac.abort(), 20); }
      },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, 'Hello', 'what streamed before the abort is kept');
    assert.ok(chunks.join('').includes('Request cancelled'), `no cancellation notice in: ${JSON.stringify(chunks)}`);
    await Promise.race([
      socketClosed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the server never saw the connection close')), 5_000)),
    ]);
  });

  it('a 400 with x-should-retry: false fails once with the API message on stderr (exit 1)', async () => {
    behaviour = 'bad-request';
    const chunks: string[] = [];
    const r = await new AnthropicAdapter().runTask({ prompt: 'bad', cwd: process.cwd(), onOutput: (t: string) => { chunks.push(t); } });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /canned rejection from the local server/);
    assert.equal(seen.length, 1, 'x-should-retry: false means no retry');
    assert.ok(chunks.join('').includes('[Anthropic Error]'));
  });

  it('sends the key and anthropic-version 2023-06-01', async () => {
    await new AnthropicAdapter().runTask({ prompt: 'headers', cwd: process.cwd() });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(seen[0].headers['x-api-key'], 'sk-ant-local-test-key');
  });
});
