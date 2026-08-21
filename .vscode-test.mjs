import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
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
