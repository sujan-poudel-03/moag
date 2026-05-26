// Mock VS Code module to allow loading prompt-input-view
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      WebviewViewProvider: class {},
      Uri: { file: (p) => ({ fsPath: p }), joinPath: () => ({ fsPath: '' }) },
      window: {},
      commands: {},
    };
  }
  return originalLoad.apply(this, arguments);
};

const piv = require('./out/ui/prompt-input-view.js');
const ds = require('./out/ui/design-system.js');

// Create an instance and call _getHtml
const provider = new piv.PromptInputViewProvider(
  { fsPath: '' },
  async () => false,
  () => {},
);

// Access private method
const html = provider._getHtml();

const fs = require('fs');
fs.writeFileSync('./tmp_generated.html', html, 'utf8');
console.log('HTML generated, length:', html.length, 'chars,', html.split('\n').length, 'lines');

// Check for problematic patterns
const lines = html.split('\n');

// Find script block in generated HTML
let scriptStart = -1, scriptEnd = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '<script>') scriptStart = i;
  if (lines[i].trim() === '</script>') scriptEnd = i;
}
console.log('Script block:', scriptStart + 1, 'to', scriptEnd + 1, '(', scriptEnd - scriptStart - 1, 'lines)');

// Extract script content and run syntax check
const scriptContent = lines.slice(scriptStart + 1, scriptEnd).join('\n');
fs.writeFileSync('./tmp_webview_script.js', scriptContent, 'utf8');
console.log('Script content written to tmp_webview_script.js');

// Check for common issues
let issues = 0;
for (let i = 0; i < lines.length; i++) {
  const lower = lines[i].toLowerCase();
  if (lower.includes('</script') && i !== scriptEnd) {
    console.log('POTENTIAL ISSUE at line', i+1, ':', lines[i].substring(0, 100));
    issues++;
  }
}
if (issues === 0) console.log('No </script> issues found outside script close tag');
