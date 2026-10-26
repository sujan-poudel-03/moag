import { defineConfig } from '@vscode/test-cli';

// Two runs of the same integration suite:
//
//   stable   the current VS Code release, on every CI platform;
//   minimum  the oldest VS Code that engines.vscode admits (^1.90.0), on Linux
//            only. It proves the extension still activates on the floor we
//            declare, not just on whatever is newest.
//
// Pick one with `npx vscode-test --label stable` (or `--label minimum`); with no
// --label, both run.
//
// History: the harness used to be pinned to VS Code 1.109.5. VS Code 1.110
// renamed the macOS bundle executable from `Contents/MacOS/Electron` to the
// product name, and @vscode/test-electron before 3.1.0 still looked for the old
// name, so every 1.110+ build died on macOS with `spawn ... ENOENT`. 3.1.0 fixed
// it but needs Node 22+, which the repo now runs (Node 24, .nvmrc), so the pin
// is gone.
//
// Keep `minimum` in step with engines.vscode in package.json.

const shared = {
  files: 'out/test/integration/**/*.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
  download: {
    // Idle timeout while fetching the VS Code build. The library default is 15s,
    // which is not enough to resolve the version list on a slow or proxied link —
    // it fails at "Resolving version..." before the download even starts.
    timeout: 120_000,
  },
};

export default defineConfig([
  { label: 'stable', version: 'stable', ...shared },
  { label: 'minimum', version: '1.90.0', ...shared },
]);
