'use strict';

const fs = require('fs');
const path = require('path');

const PLACEHOLDER = /\/\/\s*\.{3}\s*rest of the code\s*\.{3}/;
const sourceDir = path.join(__dirname, '..', 'src');
const problems = [];

for (const name of fs.readdirSync(sourceDir)) {
  const lines = fs.readFileSync(path.join(sourceDir, name), 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (PLACEHOLDER.test(line)) {
      problems.push(`src/${name}:${index + 1} placeholder comment left in the code`);
    }
  });
}

for (const problem of problems) {
  console.error(problem);
}
process.exit(problems.length > 0 ? 1 : 0);
