const fs = require('fs');
const src = fs.readFileSync('./out/ui/prompt-input-view.js', 'utf8');
const lines = src.split('\n');
// Script section: lines 2285-4208 (1-indexed), 0-indexed 2284-4207
const scriptLines = lines.slice(2284, 4208);
const backtickLines = [];
scriptLines.forEach((line, i) => {
  if (line.indexOf('`') !== -1) {
    backtickLines.push({line: i + 2285, content: line.trim().substring(0, 100)});
  }
});
console.log('Lines with backticks in script section:', backtickLines.length);
backtickLines.forEach(b => console.log('Line', b.line, ':', b.content));
