const fs = require('fs');
const src = fs.readFileSync('./out/ui/prompt-input-view.js', 'utf8');
const lines = src.split('\n');

// HTML body: lines 2060-2283 (0-indexed: 2059-2282)
const bodyLines = lines.slice(2059, 2283);

// Script content: lines 2285-4208 (0-indexed: 2284-4207)
const scriptLines = lines.slice(2284, 4208);

console.log('=== HTML BODY SECTION CHECKS ===');
let issues = [];

bodyLines.forEach((line, i) => {
  const lineNum = i + 2060;
  const lower = line.toLowerCase();

  // Check for <script in html body
  if (lower.includes('<script')) {
    issues.push({type: '<script in body', lineNum, content: line.trim().substring(0, 100)});
  }
  // Check for </script in html body
  if (lower.includes('</script')) {
    issues.push({type: '</script in body', lineNum, content: line.trim().substring(0, 100)});
  }
  // Check for <!-- in html body (could affect script parsing context)
  if (line.includes('<!--')) {
    issues.push({type: '<!-- comment in body', lineNum, content: line.trim().substring(0, 100)});
  }
});

console.log('Body section issues:', issues.length);
issues.forEach(i => console.log(`  ${i.type} at line ${i.lineNum}: ${i.content}`));

// Now look for inline event handlers or data attributes with HTML
console.log('\n=== CHECKING FOR COMPLEX ATTRIBUTES ===');
const attrIssues = [];
bodyLines.forEach((line, i) => {
  const lineNum = i + 2060;
  // Event handlers in HTML
  if (/on\w+\s*=\s*["'][^"']*<[^"']*/i.test(line)) {
    attrIssues.push({lineNum, content: line.trim().substring(0, 100)});
  }
});
console.log('Complex attribute issues:', attrIssues.length);
attrIssues.forEach(i => console.log(`  Line ${i.lineNum}: ${i.content}`));

// Look for any unescaped < or > in attribute values that might confuse the parser
// This is hard to detect without actual HTML parsing, but let's look for suspicious patterns
console.log('\n=== SCRIPT SECTION: LOOKING FOR HTML TAG PATTERNS ===');
const scriptIssues = [];
scriptLines.forEach((line, i) => {
  const lineNum = i + 2285;
  const lower = line.toLowerCase();
  if (lower.includes('<script') || lower.includes('</script')) {
    scriptIssues.push({lineNum, content: line.trim().substring(0, 100)});
  }
});
console.log('Script section HTML tag issues:', scriptIssues.length);
scriptIssues.forEach(i => console.log(`  Line ${i.lineNum}: ${i.content}`));

// Final check: make sure the template literal is well-formed
// Look for orphaned backticks outside of strings
console.log('\n=== TEMPLATE LITERAL STRUCTURE ===');
const htmlStart = src.indexOf('`<!DOCTYPE html>');
const htmlStartLine = src.substring(0, htmlStart).split('\n').length;
console.log('HTML template starts at JS line:', htmlStartLine);
// The template should end at </html>`;
const htmlEnd = src.indexOf('\n</html>`;\n');
if (htmlEnd >= 0) {
  const htmlEndLine = src.substring(0, htmlEnd).split('\n').length;
  console.log('HTML template ends at JS line:', htmlEndLine + 1);
} else {
  console.log('Could not find clean end of HTML template!');
  // Try alternate endings
  const alt = src.indexOf('</html>`;');
  if (alt >= 0) {
    const altLine = src.substring(0, alt).split('\n').length;
    console.log('Alternate ending at JS line:', altLine + 1, ':', src.substring(alt, alt + 20));
  }
}
