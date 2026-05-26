const fs = require('fs');
const src = fs.readFileSync('./out/ui/prompt-input-view.js', 'utf8');
const lines = src.split('\n');
const line = lines[4162]; // Line 4163 (0-indexed: 4162)
console.log('Line 4163:', JSON.stringify(line));

// Check the characters around split('\n')
const idx = line.indexOf("split('");
if (idx >= 0) {
  const after = line.substring(idx, idx + 30);
  console.log('Around split:', JSON.stringify(after));
  const codes = [];
  for (let i = idx; i < Math.min(idx + 30, line.length); i++) {
    codes.push(lines[4162].charCodeAt(i).toString(16));
  }
  console.log('Char codes:', codes.join(' '));
}

// Also check the generated HTML around line 1879
const genHtml = fs.readFileSync('./tmp_generated.html', 'utf8');
const genLines = genHtml.split('\n');
console.log('\nGenerated HTML line 1878:', JSON.stringify(genLines[1877]));
console.log('Generated HTML line 1879:', JSON.stringify(genLines[1878]));
console.log('Generated HTML line 1880:', JSON.stringify(genLines[1879]));
