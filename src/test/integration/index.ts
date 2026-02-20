// ─── Integration test runner entry point ───
// Discovers and runs all *.test.js files in the integration test directory.

import * as path from 'path';
import * as fs from 'fs';

function findTestFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.name.endsWith('.test.js')) {
      results.push(path.relative(dir, full));
    }
  }
  return results;
}

export async function run(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Mocha = require('mocha');
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 20000,
  });

  const testsRoot = path.resolve(__dirname);
  const files = findTestFiles(testsRoot);

  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
