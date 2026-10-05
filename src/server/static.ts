// ─── Static front-end serving ───
//
// Serves the vanilla PO web app from `web/` at the repo root. Deliberately
// narrow: an extension allowlist, no dotfiles, no `..`, a realpath check that
// the file is still inside the web root (symlinks), no directory listing.
// Paths that look like app routes (no extension) fall back to `index.html` when
// the browser asks for HTML, so the History-API router can deep-link.
// `/assets/theme.css` is generated: the browser theme shim followed by the
// design-system tokens, so every `--ds-*` token resolves to a real value.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { designSystemCssTokens } from '../ui/design-system';
import { themeShimCss } from './theme-shim';
import { isPathInside } from './config';

/** `web/` resolved from both `out/server/` (compiled) and `src/server/` (ts-node). */
export const DEFAULT_WEB_ROOT = path.resolve(__dirname, '..', '..', 'web');

export const THEME_CSS_PATH = '/assets/theme.css';

/** The only file types ever served. */
export const STATIC_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
});

/** The generated `/assets/theme.css`: base `--vscode-*` values, then the `--ds-*` tokens. */
export function themeCss(): string {
  return `${themeShimCss()}\n${designSystemCssTokens()}`;
}

function etagOf(content: Buffer | string): string {
  return `"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`;
}

function notFound(res: ServerResponse): void {
  if (res.writableEnded) { return; }
  const body = 'Not found';
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendContent(req: IncomingMessage, res: ServerResponse, content: Buffer | string, contentType: string): void {
  const etag = etagOf(content);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(content));
  res.end(req.method === 'HEAD' ? undefined : content);
}

export interface StaticServer {
  /**
   * Serve `rawPathname` (still percent-encoded, as it arrived) for a GET/HEAD.
   * Always ends the response — a file, a 304, or a 404.
   */
  serve(req: IncomingMessage, res: ServerResponse, rawPathname: string): void;
}

/**
 * Split an encoded request path into safe segments, or null when it must 404:
 * undecodable, NUL or backslash anywhere, or any segment starting with `.`
 * (dotfiles, `.` and `..` — checked AFTER decoding, so `%2e%2e` and `..%2f`
 * are caught too).
 */
export function safeSegments(rawPathname: string): string[] | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rawPathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) { return null; }
  const segs = decoded.split('/').filter((s) => s.length > 0);
  if (segs.some((s) => s.startsWith('.') || s.includes(':'))) { return null; }
  return segs;
}

/** Create the static server over `root` (default: the repo's `web/`). */
export function createStaticServer(opts: { root?: string } = {}): StaticServer {
  const root = opts.root ?? DEFAULT_WEB_ROOT;
  const theme = themeCss();

  const resolveFile = (segs: string[]): string | null => {
    let realRoot: string;
    try { realRoot = fs.realpathSync.native(root); } catch { return null; }
    const candidate = path.join(realRoot, ...segs);
    let real: string;
    try { real = fs.realpathSync.native(candidate); } catch { return null; }
    if (real === realRoot || !isPathInside(realRoot, real)) { return null; }
    try { if (!fs.statSync(real).isFile()) { return null; } } catch { return null; }
    return real;
  };

  const sendFile = (req: IncomingMessage, res: ServerResponse, file: string): void => {
    const type = STATIC_MIME[path.extname(file).toLowerCase()];
    if (!type) { notFound(res); return; }
    let content: Buffer;
    try { content = fs.readFileSync(file); } catch { notFound(res); return; }
    sendContent(req, res, content, type);
  };

  return {
    serve(req, res, rawPathname) {
      if (rawPathname === THEME_CSS_PATH) {
        sendContent(req, res, theme, STATIC_MIME['.css']);
        return;
      }
      const segs = safeSegments(rawPathname);
      if (!segs) { notFound(res); return; }
      const last = segs[segs.length - 1] ?? '';
      const ext = path.extname(last).toLowerCase();

      if (segs.length === 0 || ext === '') {
        // An app route (or `/`): the SPA shell, but only for a browser asking for HTML.
        const accept = String(req.headers.accept ?? '');
        if (segs.length > 0 && !accept.includes('text/html')) { notFound(res); return; }
        const index = resolveFile(['index.html']);
        if (!index) { notFound(res); return; }
        sendFile(req, res, index);
        return;
      }
      if (!STATIC_MIME[ext]) { notFound(res); return; }
      const file = resolveFile(segs);
      if (!file) { notFound(res); return; }
      sendFile(req, res, file);
    },
  };
}
