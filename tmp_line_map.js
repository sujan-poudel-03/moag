const fs = require('fs');
const path = require('path');

// Load compiled modules
const ds = require('./out/ui/design-system.js');
const cssTokens = ds.designSystemCssTokens();
const cssTokenLines = cssTokens.split('\n');
console.log('CSS tokens lines:', cssTokenLines.length);

// Read VS Code webview host
const vsHostPath = path.join(
  'C:/Users/nepan/AppData/Local/Programs/Microsoft VS Code',
  '10c8e557c8/resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html'
);
const vsHost = fs.readFileSync(vsHostPath, 'utf8');

// Extract defaultStyles content
const dsMarker = 'defaultStyles.textContent = `';
const dsStart = vsHost.indexOf(dsMarker) + dsMarker.length;
let dsEnd = dsStart;
while (dsEnd < vsHost.length && vsHost[dsEnd] !== '`') dsEnd++;
const defaultStylesContent = vsHost.substring(dsStart, dsEnd);
const dsLines = defaultStylesContent.split('\n');
console.log('defaultStyles content lines:', dsLines.length);

// Extract API script content
const apiMarker = 'return /* js */ `';
const apiStart = vsHost.indexOf(apiMarker) + apiMarker.length;
let apiEnd = apiStart;
while (apiEnd < vsHost.length && vsHost[apiEnd] !== '`') apiEnd++;
const apiContent = vsHost.substring(apiStart, apiEnd);
const apiLines = apiContent.split('\n');
console.log('API script lines:', apiLines.length);

// Read our compiled JS to get the CSS and JS blocks
const src = fs.readFileSync('./out/ui/prompt-input-view.js', 'utf8');
const srcLines = src.split('\n');  // normalize to \n

// CSS content: lines 446..2058 of compiled JS (0-indexed: 445..2057)
// But line 446 (0-indexed 445) is the cssTokens expression, which we handle separately
// Lines 447..2058 (0-indexed 446..2057) are the literal CSS text
const ourCssLines = srcLines.slice(446, 2058); // lines 447 to 2058
console.log('Our CSS lines (after cssTokens):', ourCssLines.length);

// Our JS content: lines 2285..4208 (0-indexed: 2284..4207)
const ourJsLines = srcLines.slice(2284, 4208);
console.log('Our JS lines:', ourJsLines.length);

// HTML body: lines after </script> to end of template
// </script> is at line 4209 (0-indexed: 4208)
// </head> and <body> etc. follow
const afterScriptLines = srcLines.slice(4208, 4215);
console.log('After script lines:', afterScriptLines);

// Now simulate the final document that document.write() receives
// This is the outerHTML after VS Code prepends its content
const finalLines = [];
const add = (text) => {
  const parts = text.split('\n');
  for (const p of parts) finalLines.push(p);
};

// outerHTML starts with <html>, not <!DOCTYPE html>
add('<html lang="en">');
add('<head>');

// VS Code prepends defaultStyles first (innermost prepend = appears at top)
add('<style id="_defaultStyles">');
for (const l of dsLines) add(l);
add('</style>');

// VS Code prepends defaultScript second (appears after defaultStyles)
add('<script id="_vscodeApiScript">');
for (const l of apiLines) add(l);
add('</script>');

// Our original head content
add('  <meta charset="UTF-8">');
add('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');
add('  <style>');

// The CSS template has:
// line 446 in JS: `    ${(0, design_system_1.designSystemCssTokens)()}`
// This evaluates as: 4 spaces + cssTokens content
// cssTokens starts with \n, so: '    ' + '\n    :root {...}' + '\n  '
// That means the first line is '    ' (4 spaces) and then the rest of cssTokens
const firstCssLine = '    ' + cssTokenLines[0];  // '    ' + '' = '    '
add(firstCssLine);
for (let i = 1; i < cssTokenLines.length; i++) add(cssTokenLines[i]);

// Then the rest of our CSS (lines 447-2058 of compiled JS, 0-indexed 446-2057)
for (const l of ourCssLines) add(l);

// Check: we already have the </style> in ourCssLines (the last one being '  </style>')
// Lines 2285..4208 of compiled JS contain the script section
add('  <script>');
for (const l of ourJsLines) add(l);
add('  </script>');

console.log('\nTotal final document lines:', finalLines.length);

// Show line 1086
console.log('\nLine 1086:', JSON.stringify(finalLines[1085]));
console.log('Line 1084:', JSON.stringify(finalLines[1083]));
console.log('Line 1085:', JSON.stringify(finalLines[1084]));
console.log('Line 1087:', JSON.stringify(finalLines[1086]));
console.log('Line 1088:', JSON.stringify(finalLines[1087]));

// Show what section line 1086 is in
if (1086 <= 2 + 1 + dsLines.length + 1) {
  console.log('Line 1086 is in: defaultStyles');
} else if (1086 <= 2 + 1 + dsLines.length + 1 + 1 + apiLines.length + 1) {
  console.log('Line 1086 is in: defaultScript (API)');
} else {
  console.log('Line 1086 is in: our content');
}
