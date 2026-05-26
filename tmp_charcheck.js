const fs = require('fs');
const src = fs.readFileSync('./out/ui/prompt-input-view.js', 'utf8');
const lines = src.split('\n');

// Script section: lines 2285-4208 (1-indexed), 0-indexed 2284-4207
const scriptContent = lines.slice(2284, 4208).join('\n');

// Check for null bytes and other control characters
let issues = [];
for (let i = 0; i < scriptContent.length; i++) {
  const code = scriptContent.charCodeAt(i);
  if (code === 0) {
    issues.push({pos: i, char: 'NULL', code});
  } else if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
    issues.push({pos: i, char: `\\x${code.toString(16).padStart(2,'0')}`, code});
  }
}
console.log('Control character issues:', issues.length);
issues.forEach(i => console.log(i));

// Check for unicode BOM or other problematic sequences
const bom = scriptContent.charCodeAt(0) === 0xFEFF;
console.log('Starts with BOM:', bom);

// Count high-code unicode chars (potential emoji or unusual chars)
const highChars = [];
for (let i = 0; i < scriptContent.length; i++) {
  const code = scriptContent.charCodeAt(i);
  if (code > 0x7E && code < 0xD800) {
    const context = scriptContent.substring(Math.max(0,i-20), i+20);
    highChars.push({pos: i, code: code.toString(16), char: scriptContent[i], context});
  } else if (code >= 0xD800 && code <= 0xDFFF) {
    // Surrogate pair (emoji)
    const context = scriptContent.substring(Math.max(0,i-20), i+20);
    highChars.push({pos: i, code: 'SURROGATE ' + code.toString(16), char: scriptContent[i], context});
  }
}
console.log('\nHigh-codepoint unicode chars:', highChars.length);
highChars.slice(0, 20).forEach(c => {
  console.log(`  pos=${c.pos} U+${c.code} '${c.char}' context: ${JSON.stringify(c.context)}`);
});
if (highChars.length > 20) console.log(`  ... and ${highChars.length - 20} more`);
