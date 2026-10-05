// ─── Static front-end serving: traversal, allowlist, headers, theme CSS ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startHarness, Harness } from './app-harness';
import { safeSegments, themeCss, DEFAULT_WEB_ROOT } from '../../../server/static';

interface RawResp { status: number; headers: http.IncomingHttpHeaders; body: string; }

/** Send a request with the path bytes exactly as given (no client-side URL normalisation). */
function raw(h: Harness, method: string, rawPath: string, headers: Record<string, string> = {}): Promise<RawResp> {
  const u = new URL(h.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: rawPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server static front-end', function () {
  this.timeout(20000);
  let h: Harness;
  let tmp: string;
  let web: string;
  const SECRET = 'TOP-SECRET-OUTSIDE-WEB-ROOT';

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-static-'));
    web = path.join(tmp, 'web');
    fs.mkdirSync(path.join(web, 'js'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>MOAG</title><script type="module" src="/js/app.js"></script>');
    fs.writeFileSync(path.join(web, 'js', 'app.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(web, 'app.css'), 'body { color: var(--ds-fg); }\n');
    fs.writeFileSync(path.join(web, '.env'), SECRET);
    fs.writeFileSync(path.join(web, 'notes.txt'), SECRET);
    fs.writeFileSync(path.join(tmp, 'package.json'), SECRET);
    h = await startHarness({ webRoot: web });
  });
  afterEach(async () => {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('encoded traversal is 404 and never leaks the file', async () => {
    for (const p of [
      '/..%2f..%2fpackage.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json',
      '/js/..%2f..%2fpackage.json', '/..%5cpackage.json', '/js%5c..%5c..%5cpackage.json', '/%00.js',
    ]) {
      const r = await raw(h, 'GET', p, { Accept: 'text/html' });
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes(SECRET), p);
    }
  });

  it('dotfiles, non-allowlisted extensions and directories are 404', async () => {
    for (const p of ['/.env', '/notes.txt', '/js', '/js/']) {
      const r = await raw(h, 'GET', p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes(SECRET), p);
    }
  });

  it('a symlink escaping the web root is 404', async function () {
    try {
      fs.symlinkSync(path.join(tmp, 'package.json'), path.join(web, 'leak.js'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') { this.skip(); }
      throw err;
    }
    const r = await raw(h, 'GET', '/leak.js');
    assert.equal(r.status, 404);
    assert.ok(!r.body.includes(SECRET));
  });

  it('an HTML response carries the strict CSP, nosniff and frame-ancestors none', async () => {
    const r = await raw(h, 'GET', '/', { Accept: 'text/html' });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /^text\/html/);
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes('unsafe-inline'), csp);
    assert.ok(!csp.includes('unsafe-eval'), csp);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });

  it('app routes fall back to index.html for browsers only; /api never does', async () => {
    const page = await raw(h, 'GET', '/p/abc/prd', { Accept: 'text/html,application/xhtml+xml' });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>MOAG<\/title>/);
    const notHtml = await raw(h, 'GET', '/p/abc/prd', { Accept: 'application/json' });
    assert.equal(notHtml.status, 404);
    const api = await raw(h, 'GET', '/api/nope', { Accept: 'text/html' });
    assert.equal(api.status, 404);
    assert.match(api.body, /not-found/);
    const post = await raw(h, 'POST', '/p/abc/prd', { Accept: 'text/html' });
    assert.equal(post.status, 404);
  });

  it('serves allowlisted files with a content type, ETag and no-cache, and honours If-None-Match', async () => {
    const js = await raw(h, 'GET', '/js/app.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /^text\/javascript/);
    assert.equal(js.headers['cache-control'], 'no-cache');
    const etag = String(js.headers.etag);
    assert.ok(etag.length > 2);
    const again = await raw(h, 'GET', '/js/app.js', { 'If-None-Match': etag });
    assert.equal(again.status, 304);
    assert.equal(again.body, '');
  });

  it('/assets/theme.css defines the base --vscode-* values and the --ds-* tokens', async () => {
    const r = await raw(h, 'GET', '/assets/theme.css');
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /^text\/css/);
    for (const name of ['--vscode-editor-background', '--vscode-editor-foreground', '--vscode-font-family']) {
      const m = new RegExp(`${name}:\\s*([^;]+);`).exec(r.body);
      assert.ok(m && m[1].trim().length > 0, `${name} must be non-empty`);
    }
    assert.match(r.body, /--ds-bg:/);
    assert.match(r.body, /prefers-color-scheme: light/);
  });

  it('every --vscode-* variable the design tokens read without a fallback is defined by the shim', () => {
    const css = themeCss();
    const tokens = css.slice(css.indexOf('--ds-font-family'));
    // `--ds-x: var(--vscode-y);` — a top-level reference with no fallback value.
    const noFallback = [...tokens.matchAll(/:\s*var\((--vscode-[A-Za-z-]+)\);/g)].map((m) => m[1]);
    assert.ok(noFallback.length > 0);
    for (const v of noFallback) { assert.match(css, new RegExp(`${v}:\\s*[^;]+;`), v); }
  });

  it('safeSegments rejects encoded dots, backslashes, NUL and drive-letter segments', () => {
    assert.equal(safeSegments('/..%2fx'), null);
    assert.equal(safeSegments('/%2e%2e/x'), null);
    assert.equal(safeSegments('/a%5cb.js'), null);
    assert.equal(safeSegments('/a%00.js'), null);
    assert.equal(safeSegments('/C:/x.js'), null);
    assert.equal(safeSegments('/%E0%A4%A'), null);
    assert.deepEqual(safeSegments('/js/app.js'), ['js', 'app.js']);
  });

  it('the default web root is the repo-level web/ directory', () => {
    assert.equal(path.basename(DEFAULT_WEB_ROOT), 'web');
    assert.equal(path.dirname(DEFAULT_WEB_ROOT), path.resolve(__dirname, '..', '..', '..', '..'));
  });
});
