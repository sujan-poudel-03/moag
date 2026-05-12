// ─── Browser driver — Playwright-backed screenshot and test runner ───
// Used by visual-test tasks to capture screenshots and run spec files.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOT_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_TIMEOUT_MS = 120_000;

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
 * Capture a full-page screenshot of a URL and return it as a base64 PNG string.
 * Returns null if Playwright is unavailable or the capture fails.
 */
export async function capturePageScreenshotBase64(url: string, cwd: string): Promise<string | null> {
  const screenshotsDir = path.join(cwd, '.moag', 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(screenshotsDir, `visual-test-${timestamp}.png`);

  const playwrightBin = findLocalPlaywright(cwd);
  const args = playwrightBin
    ? [playwrightBin, 'screenshot', '--full-page', url, outputPath]
    : ['npx', '--yes', 'playwright', 'screenshot', '--full-page', url, outputPath];

  const success = await new Promise<boolean>((resolve) => {
    const proc = spawn(args[0], args.slice(1), { cwd, shell: true, stdio: 'pipe' });
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, SCREENSHOT_TIMEOUT_MS);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });

  if (!success) { return null; }

  try {
    const data = fs.readFileSync(outputPath);
    return data.toString('base64');
  } catch {
    return null;
  }
}

/** Run a Playwright test spec file and return its combined output. */
export async function runPlaywrightSpec(specFile: string, cwd: string): Promise<string> {
  const playwrightBin = findLocalPlaywright(cwd);
  const args = playwrightBin
    ? [playwrightBin, 'test', specFile, '--reporter=line']
    : ['npx', '--yes', 'playwright', 'test', specFile, '--reporter=line'];

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
