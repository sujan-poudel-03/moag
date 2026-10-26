#!/usr/bin/env node
'use strict';
// ─── Release notes for a tag, from CHANGELOG.md ───
//
//   node scripts/release-notes.js v1.2.3 > notes.md
//
// Prints the CHANGELOG.md section for the tag's version, for `gh release create
// --notes-file`. Exits 1, printing why on stderr, when:
//   - the tag is not `v` + package.json's version (a tag on the wrong commit);
//   - CHANGELOG.md has no section for that version;
//   - the section is empty.
//
// Needs the compiled parser: run `npm run compile:ext` first (out/utils/changelog.js).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** The notes for `tag`, or an error message. Pure apart from the two reads. */
function releaseNotes(tag, root = ROOT) {
  const { extractSection } = require(path.join(root, 'out', 'utils', 'changelog'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;
  if (tag !== `v${version}`) {
    return { error: `tag ${tag || '(none)'} does not match package.json version ${version} (expected v${version})` };
  }
  const section = extractSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8'), version);
  if (section === null) { return { error: `CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section` }; }
  if (section.trim() === '') { return { error: `the CHANGELOG.md section for ${version} is empty` }; }
  return { notes: section };
}

module.exports = { releaseNotes };

if (require.main === module) {
  let result;
  try {
    result = releaseNotes(process.argv[2]);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  if (result.error) {
    console.error(`release-notes: ${result.error}`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${result.notes}\n`);
  }
}
