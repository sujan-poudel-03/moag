import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // Pinned, deliberately, and not just for determinism.
  //
  // VS Code 1.110 renamed the macOS bundle executable from
  // `Contents/MacOS/Electron` to the product name (`Code` on Stable). Every
  // @vscode/test-electron up to 2.5.2 still resolves the old name, so any
  // 1.110+ build dies on macOS with `spawn .../Contents/MacOS/Electron ENOENT`
  // before a single test runs — which is exactly what CI showed on 1.135.0,
  // while Windows and Linux passed on the same build.
  //
  // The upstream fix landed in @vscode/test-electron 3.1.0, which requires
  // Node >= 22. This repo pins Node 20 on purpose: on 22.6+ the runtime strips
  // TypeScript natively and loads .ts as ESM, which breaks ts-node/register
  // (see the Node version note in CLAUDE.md). Taking the upgrade means taking
  // that fight first, so until then we test against the last release that
  // predates the rename. 1.109.5 is far above the ^1.85.0 this extension
  // declares it supports.
  version: '1.109.5',
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
});
