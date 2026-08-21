// ─── Browser driver — Playwright-backed screenshot and test runner ───
// Used by visual-test tasks to capture screenshots and run spec files.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// 30s is the right ceiling now that the lazy `npx --yes playwright` install path
// is gone: every spawn here runs an already-provisioned local binary, so the only
// thing being waited on is a page load and a PNG write — never a package download.
const SCREENSHOT_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_TIMEOUT_MS = 120_000;

/** Hint shown whenever the workspace has no usable Playwright binary. */
const UNPROVISIONED_REASON =
  'Playwright is not installed in this workspace. Run "MOAG: Provision Browsers" ' +
  '(or npm i -D @playwright/test && npx playwright install chromium).';

/** Either a real local Playwright binary, or an explanation of why there isn't one. */
export type BrowserRunner =
  | { kind: 'local'; bin: string }
  | { kind: 'unprovisioned'; reason: string };

function findLocalPlaywright(cwd: string): string | null {
  const candidates = [
    path.join(cwd, 'node_modules', '.bin', 'playwright'),
    path.join(cwd, 'node_modules', '.bin', 'playwright.cmd'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

/**
 * Resolve how (or whether) browser automation can run in `cwd`.
 *
 * There is deliberately no `npx --yes` fallback: that silently downloaded and
 * installed Playwright inside a 30s timeout, so the first call always "failed"
 * while leaving an install running. Provisioning is now an explicit command.
 */
export function resolveBrowserRunner(cwd: string): BrowserRunner {
  const bin = findLocalPlaywright(cwd);
  if (bin) {
    return { kind: 'local', bin };
  }
  return { kind: 'unprovisioned', reason: UNPROVISIONED_REASON };
}

/**
 * Capture a full-page screenshot of a URL and return it as a base64 PNG string.
 * Returns null if Playwright is unprovisioned or the capture fails.
 */
export async function capturePageScreenshotBase64(url: string, cwd: string): Promise<string | null> {
  return (await capturePageScreenshotDetailed(url, cwd)).base64;
}

/**
 * Same capture as {@link capturePageScreenshotBase64}, but reports *why* it failed
 * so callers can distinguish "no browser tooling" from "the page did not render".
 */
export async function capturePageScreenshotDetailed(
  url: string,
  cwd: string,
): Promise<{ base64: string | null; reason: string }> {
  const runner = resolveBrowserRunner(cwd);
  if (runner.kind === 'unprovisioned') {
    // Return immediately — never spawn, never burn the 30s timeout on an install.
    return { base64: null, reason: runner.reason };
  }

  const screenshotsDir = path.join(cwd, '.moag', 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(screenshotsDir, `visual-test-${timestamp}.png`);
  const args = [runner.bin, 'screenshot', '--full-page', url, outputPath];

  const success = await new Promise<boolean>((resolve) => {
    const proc = spawn(args[0], args.slice(1), { cwd, shell: true, stdio: 'pipe' });
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, SCREENSHOT_TIMEOUT_MS);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });

  if (!success) {
    return { base64: null, reason: `Playwright screenshot of ${url} failed.` };
  }

  try {
    const data = fs.readFileSync(outputPath);
    return { base64: data.toString('base64'), reason: outputPath };
  } catch {
    return { base64: null, reason: `Screenshot file could not be read: ${outputPath}` };
  }
}

/** Run a Playwright test spec file and return its combined output. */
export async function runPlaywrightSpec(specFile: string, cwd: string): Promise<string> {
  const runner = resolveBrowserRunner(cwd);
  if (runner.kind === 'unprovisioned') {
    return runner.reason;
  }
  const args = [runner.bin, 'test', specFile, '--reporter=line'];

  return new Promise((resolve) => {
    const proc = spawn(args[0], args.slice(1), { cwd, shell: true, stdio: 'pipe' });
    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      resolve(`[Timeout after ${PLAYWRIGHT_TIMEOUT_MS / 1000}s]\n${output}`);
    }, PLAYWRIGHT_TIMEOUT_MS);

    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output || '(all tests passed)' : `[exit ${code}]\n${output}`);
    });
    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve(`Error: ${err.message}\n${output}`);
    });
  });
}
