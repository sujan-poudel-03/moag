// ─── Screenshot capture ───
// Web: uses Playwright CLI (npx playwright screenshot) if available.
// Mobile Android: adb exec-out screencap -p
// Mobile iOS: xcrun simctl io booted screenshot

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectType } from './project-detector';

export interface ScreenshotOptions {
  projectType: ProjectType;
  /** Required for web screenshots */
  url: string | null;
  /** Workspace root — screenshots saved to <cwd>/.moag/screenshots/ */
  cwd: string;
}

/**
 * Capture a screenshot of the running sandbox and return the saved file path.
 * Returns null if no screenshot tool is available or the capture fails.
 */
export async function captureScreenshot(opts: ScreenshotOptions): Promise<string | null> {
  const { projectType, url, cwd } = opts;

  const screenshotsDir = path.join(cwd, '.moag', 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(screenshotsDir, `screenshot-${timestamp}.png`);

  if (projectType === 'web') {
    if (!url) { return null; }
    return captureWebScreenshot(url, outputPath, cwd);
  }

  if (projectType === 'mobile') {
    return captureMobileScreenshot(outputPath);
  }

  return null;
}

// ── Web ───────────────────────────────────────────────────────────────────────

async function captureWebScreenshot(url: string, outputPath: string, cwd: string): Promise<string | null> {
  // Prefer a locally-installed playwright binary over npx to avoid the
  // interactive install prompt on first run.
  const playwrightBin = findLocalPlaywright(cwd);

  return new Promise((resolve) => {
    const args = playwrightBin
      ? [playwrightBin, 'screenshot', '--full-page', url, outputPath]
      : ['npx', '--yes', 'playwright', 'screenshot', '--full-page', url, outputPath];

    const proc = spawn(args[0], args.slice(1), {
      cwd,
      shell: true,
      stdio: 'pipe',
    });

    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 30000);

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(outputPath);
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function findLocalPlaywright(cwd: string): string | null {
  // Look for playwright in node_modules/.bin relative to the workspace/sandbox cwd
  const candidates = [
    path.join(cwd, 'node_modules', '.bin', 'playwright'),
    path.join(cwd, 'node_modules', '.bin', 'playwright.cmd'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

// ── Mobile ────────────────────────────────────────────────────────────────────

function captureMobileScreenshot(outputPath: string): string | null {
  // Android: adb screencap
  if (tryAdbScreenshot(outputPath)) { return outputPath; }

  // iOS: xcrun simctl
  if (tryXcrunScreenshot(outputPath)) { return outputPath; }

  return null;
}

function tryAdbScreenshot(outputPath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execSync(`adb exec-out screencap -p > "${outputPath}"`, { shell: true, timeout: 10000 } as any);
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

function tryXcrunScreenshot(outputPath: string): boolean {
  try {
    execSync(`xcrun simctl io booted screenshot "${outputPath}"`, {
      timeout: 10000,
      stdio: 'ignore',
    });
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}
