// ─── Standards checker — commented-out code: annotations left alone, recall pinned per language ───
//
// Two failure directions, both blocking for a gate with no waiver:
//   - a call-shaped ANNOTATION (`// O(1)`, `// rgb(0, 0, 0)`, `// ts(2378)`) flagged as code;
//   - ordinary commented-out code in a language without statement terminators reported `passed`.
// The recall table pins, sample by sample, what the rule catches today, so a change that
// loses a shape fails here instead of going unnoticed.

import { strict as assert } from 'assert';
import { StandardsCheckFile, StandardsCheckInput, checkStandards } from '../../../standards/checker';
import { BUILT_IN_PROFILES } from '../../../standards/built-in-profiles';
import { StandardsProfile } from '../../../standards/profile';

const RULE = 'comment-policy/commented-out-code';

function profile(): StandardsProfile {
  return JSON.parse(JSON.stringify(BUILT_IN_PROFILES.other)) as StandardsProfile;
}

function added(path: string, lines: string[]): StandardsCheckFile {
  return { path, status: 'added', addedLines: lines.map((_, i) => i + 1), content: lines.join('\n') };
}

function input(files: StandardsCheckFile[]): StandardsCheckInput {
  return { baseRef: 'abc123', files, existingDirs: [], topLevel: [], goModulePath: null };
}

/** Lines of `file` flagged as commented-out code when `lines` is the whole new file. */
function flagged(file: string, lines: string[]): number[] {
  return checkStandards(profile(), input([added(file, lines)])).findings.filter((f) => f.rule === RULE).map((f) => f.line);
}

/** A commented block on its own: live code above and below, so it is neither header nor neighbour. */
function isolated(ext: string, block: string[]): number[] {
  const live = ext === 'py' ? ['value = 1', ''] : ext === 'go' ? ['package main', ''] : ['class A {}', ''];
  const tail = ext === 'py' ? ['', 'other = 2'] : ['', ext === 'go' ? 'var other = 2' : 'class B {}'];
  return flagged(`src/sample.${ext}`, [...live, ...block, ...tail]).map((n) => n - live.length);
}

describe('standards checker — call-shaped annotations are not commented-out code', () => {
  const C_LIKE = ['O(1)', 'O(n)', 'O(n^2)', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'ts(2378)', 'f(x)', 'RFC(2119)', 'deprecated(v2)', 'min(a, b)'];
  const PYTHON = ['O(n)', 'mypy(strict)', 'f(x)'];

  for (const note of C_LIKE) {
    it(`// ${note} — standalone and trailing`, () => {
      assert.deepEqual(flagged('src/lookup.ts', ['export function get(m: Map<string, number>, k: string) {', `  // ${note}`, '  return m.get(k);', '}']), []);
      assert.deepEqual(flagged('src/lookup.ts', ['export function get(m: Map<string, number>, k: string) {', `  return m.get(k); // ${note}`, '}']), []);
    });
  }

  for (const note of PYTHON) {
    it(`# ${note} — standalone and trailing`, () => {
      assert.deepEqual(flagged('src/lookup.py', ['def get(m, k):', `    # ${note}`, '    return m[k]']), []);
      assert.deepEqual(flagged('src/lookup.py', ['def get(m, k):', `    return m[k]  # ${note}`]), []);
    });
  }

  it('two annotations in a row do not corroborate each other', () => {
    assert.deepEqual(flagged('src/cost.ts', ['const a = 1;', '// O(n)', '// O(1)', 'const b = 2;']), []);
    assert.deepEqual(flagged('src/cost.py', ['a = 1', '# O(n)', '# O(log(n))', 'b = 2']), []);
  });

  it('a one-line doc comment that is an annotation is left alone', () => {
    assert.deepEqual(flagged('src/cost.ts', ['const a = 1;', '/** O(1) */', 'export const b = 2;']), []);
  });

  it('a bare call still counts with a second signal: a terminator, a receiver, await/new, or code beside it', () => {
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// load(a);', 'const b = 2;']), [2], 'terminator');
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// cache.get(id)', 'const b = 2;']), [2], 'member call');
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// await load(a)', 'const b = 2;']), [2], 'await');
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// new Worker(a)', 'const b = 2;']), [2], 'new');
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// load(a).then(use)', 'const b = 2;']), [2], 'chained');
    assert.deepEqual(flagged('src/a.ts', ['const a = 1;', '// if (ready) {', '// start(a)', '// }', 'const b = 2;']), [2, 3, 4], 'code-shaped neighbours');
  });

  it('trailing live code, a call needs its terminator', () => {
    assert.deepEqual(flagged('src/a.ts', ['const v = m.get(k); // cache.get(k)']), []);
    assert.deepEqual(flagged('src/a.ts', ['const v = m.get(k); // cache.get(k);']), [1]);
    assert.deepEqual(flagged('src/a.ts', ['const v = m.get(k); // const cached = cache.get(k);']), [1]);
  });
});

describe('standards checker — commented-out code without statement terminators', () => {
  it('keyword-led declarations are code with or without a semicolon', () => {
    assert.deepEqual(flagged('src/no-semi.ts', ['export const live = 1', '// const a = load()', '// const b = parse(a)', 'export const other = 2']), [2, 3]);
    assert.deepEqual(flagged('src/no-semi.ts', ['export const live = 1', '// let total = 0', 'export const other = 2']), [2]);
    assert.deepEqual(flagged('src/no-semi.ts', ['export const live = 1', '// var legacy = require("../old")', 'export const other = 2']), [2]);
  });

  it('a declaration given words rather than an expression is prose', () => {
    assert.deepEqual(flagged('src/a.ts', ['export const live = 1', '// let x = the number of items in the cart', 'export const other = 2']), []);
  });

  it('two bare assignments still do not corroborate each other', () => {
    assert.deepEqual(flagged('src/a.py', ['live = 1', '# width = columns * cell', '# height = rows * cell', 'other = 2']), []);
  });

  it('a Python `if <name>:` counts when an indented commented line follows, and only then', () => {
    assert.deepEqual(flagged('src/a.py', ['live = 1', '# if enabled:', '#     return value', 'other = 2']), [2, 3]);
    assert.deepEqual(flagged('src/a.py', ['live = 1', '# if enabled:', '# return value', 'other = 2']), [], 'same indentation is a sentence and a note');
    assert.deepEqual(flagged('src/a.py', ['live = 1', '# if enabled:', 'other = 2']), [], 'nothing follows');
  });

  it('throw, raise, assert, defer and go are as sure as what they lead', () => {
    assert.deepEqual(flagged('src/a.ts', ['const a = 1', '// throw new Error("bad")', 'const b = 2']), [2]);
    assert.deepEqual(flagged('src/a.py', ['a = 1', '# raise errors.NotFound(key)', 'b = 2']), [2]);
    assert.deepEqual(flagged('src/a.py', ['a = 1', '# raise ValueError("bad")', 'b = 2']), [], 'a bare call needs company');
    assert.deepEqual(flagged('src/a.py', ['a = 1', '# assert count > 0', '# raise ValueError("bad")', 'b = 2']), [2, 3]);
    assert.deepEqual(flagged('src/a.go', ['package a', '', '// defer f.Close()', 'var b = 2']), [3]);
    assert.deepEqual(flagged('src/a.go', ['package a', '', '// var x int', '// go worker(jobs)', 'var b = 2']), [3, 4]);
    assert.deepEqual(flagged('src/a.ts', ['const a = 1', '// throw away the cache when it is stale', 'const b = 2']), []);
    assert.deepEqual(flagged('src/a.py', ['a = 1', '# assert that the user is signed in', 'b = 2']), []);
  });

  it('typed declarations count beside other code', () => {
    assert.deepEqual(flagged('src/A.java', ['class A {}', '', '// String name = user.getName();', '// return name;', 'class B {}']), [3, 4]);
    assert.deepEqual(flagged('src/A.cs', ['class A {}', '', '// List<int> xs = new List<int>();', '// xs.Add(1);', 'class B {}']), [3, 4]);
  });

  // One isolated commented block per sample. `expect` is the lines of the block that flag.
  const RECALL: Record<string, Array<{ block: string[]; expect: number[] }>> = {
    ts: [
      { block: ['// const a = load()', '// const b = parse(a)'], expect: [1, 2] },
      { block: ['// const a = load()'], expect: [1] },
      { block: ['// let count = 0'], expect: [1] },
      { block: ['// throw new Error("bad")'], expect: [1] },
      { block: ['// await save(user)'], expect: [1] },
      { block: ['// cache.set(id, value)'], expect: [1] },
      { block: ['// if (ready) {', '//   start()', '// }'], expect: [1, 2, 3] },
      { block: ['// for (const x of xs) {', '//   total += x', '// }'], expect: [1, 2, 3] },
      { block: ['// export function old() {', '//   return 1', '// }'], expect: [1, 2, 3] },
      { block: ['// import { a } from "./a"'], expect: [] },
      { block: ['// return result'], expect: [] },
      { block: ['// start()'], expect: [] },
    ],
    py: [
      { block: ['# if enabled:', '#     return value'], expect: [1, 2] },
      { block: ['# if x > 0:', '#     total += x'], expect: [1, 2] },
      { block: ['# for item in items:', '#     handle(item)'], expect: [1, 2] },
      { block: ['# def old(a, b):', '#     return a + b'], expect: [1, 2] },
      { block: ['# result = compute(a, b)'], expect: [1] },
      { block: ['# with open(path) as f:', '#     data = f.read()'], expect: [1, 2] },
      { block: ['# raise errors.NotFound(key)'], expect: [1] },
      { block: ['# assert count > 0', '# raise ValueError("bad")'], expect: [1, 2] },
      { block: ['# import os', '# from a import b'], expect: [1, 2] },
      { block: ['# raise ValueError("bad")'], expect: [] },
      { block: ['# x = 1', '# y = 2'], expect: [] },
      { block: ['# return value'], expect: [] },
    ],
    go: [
      { block: ['// x := load()'], expect: [1] },
      { block: ['// defer f.Close()'], expect: [1] },
      { block: ['// var x int', '// x = 5'], expect: [1, 2] },
      { block: ['// if err != nil {', '//   return err', '// }'], expect: [1, 2, 3] },
      { block: ['// go worker(jobs)', '// defer wg.Done()'], expect: [1, 2] },
      { block: ['// fmt.Println(x)'], expect: [1] },
      { block: ['// for _, v := range xs {', '//   sum += v', '// }'], expect: [1, 2, 3] },
      { block: ['// var x int'], expect: [] },
      { block: ['// return nil'], expect: [] },
    ],
    java: [
      { block: ['// String name = user.getName();', '// return name;'], expect: [1, 2] },
      { block: ['// return result;'], expect: [1] },
      { block: ['// user.save();'], expect: [1] },
      { block: ['// throw new IllegalStateException("bad");'], expect: [1] },
      { block: ['// if (ready) {', '//   start();', '// }'], expect: [1, 2, 3] },
      { block: ['// private static final int MAX = 5;'], expect: [1] },
      { block: ['// for (int i = 0; i < n; i++) {', '//   sum += i;', '// }'], expect: [1, 2, 3] },
      { block: ['// String name = user.getName();'], expect: [] },
    ],
    cs: [
      { block: ['// List<int> xs = new List<int>();', '// xs.Add(1);'], expect: [1, 2] },
      { block: ['// var total = 0;'], expect: [1] },
      { block: ['// await SaveAsync(user);'], expect: [1] },
      { block: ['// using System.Linq;'], expect: [1] },
      { block: ['// if (ready) {', '//   Start();', '// }'], expect: [1, 2, 3] },
      { block: ['// throw new InvalidOperationException("bad");'], expect: [1] },
      { block: ['// int count = 0;'], expect: [] },
    ],
  };

  /** Samples caught in full, per language. A lower number is a regression; a higher one updates this table. */
  const CAUGHT: Record<string, string> = { ts: '9/12', py: '9/12', go: '7/9', java: '7/8', cs: '6/7' };

  for (const [ext, samples] of Object.entries(RECALL)) {
    it(`recall for .${ext} is pinned at ${CAUGHT[ext]}`, () => {
      let caught = 0;
      for (const sample of samples) {
        assert.deepEqual(isolated(ext, sample.block), sample.expect, `${ext}: ${sample.block.join(' | ')}`);
        if (sample.expect.length === sample.block.length) { caught++; }
      }
      assert.equal(`${caught}/${samples.length}`, CAUGHT[ext]);
    });
  }
});

describe('standards checker — extensionless scripts', () => {
  const script = added('bin/todo', ['#!/usr/bin/env node', '', 'const run = 1;', '// const legacy = require("../old")', '// implementation goes here']);
  const clean = added('src/b.ts', ['export const b = 1;']);
  const COMMENT_RULES = ['comment-policy/commented-out-code', 'comment-policy/banned-phrase', 'comment-policy/density'];

  it('a shebang script with no extension is source the checker cannot read: not-checked, even beside a clean file', () => {
    const p = profile();
    p.comments.bannedPhrases = ['implementation goes here'];
    const report = checkStandards(p, input([script, clean]));
    for (const rule of COMMENT_RULES) {
      const row = report.rules.find((r) => r.rule === rule)!;
      assert.equal(row.result, 'not-checked', rule);
      assert.match(row.reason ?? '', /No checker for files without an extension \(bin\/todo\)/);
    }
  });

  it('LICENSE, Dockerfile and Makefile stay out of scope by name, shebang-shaped first line or not', () => {
    const files = [
      added('LICENSE', ['MIT License', '// const a = load();']),
      added('Dockerfile', ['FROM node:20', '# const a = load();']),
      added('Makefile', ['#!/usr/bin/make -f', '# const a = load();']),
      clean,
    ];
    const report = checkStandards(profile(), input(files));
    assert.equal(report.rules.find((r) => r.rule === RULE)!.result, 'passed');
    assert.deepEqual(report.findings, []);
  });

  it('an extensionless file that could not be read is undecided, not out of scope', () => {
    const unread: StandardsCheckFile = { path: 'bin/todo', status: 'modified', addedLines: [], content: null, skipped: 'Binary content' };
    const report = checkStandards(profile(), input([unread, clean]));
    assert.equal(report.rules.find((r) => r.rule === RULE)!.result, 'not-checked');
  });
});

describe('standards checker — vendored and generated files', () => {
  const COMMENTED = '// const a = load();';

  it('Go vendoring fails no rule: placement, naming and comments leave vendor/ out and say so', () => {
    const p = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.go)) as StandardsProfile;
    const report = checkStandards(p, {
      baseRef: 'abc123', existingDirs: ['cmd', 'internal'], topLevel: ['cmd', 'internal', 'go.mod'], goModulePath: 'example.com/app',
      files: [
        added('vendor/github.com/acme/lib/main.go', ['package main', '', COMMENTED]),
        added('vendor/github.com/acme/lib/HTTPClient.go', ['package lib']),
        added('internal/store/store.go', ['package store']),
      ],
    });
    assert.deepEqual(report.findings, []);
    for (const rule of ['structure/placement', 'naming/files', RULE]) {
      const row = report.rules.find((r) => r.rule === rule)!;
      assert.equal(row.result, 'passed', rule);
      assert.match(row.reason ?? '', /^2 vendored or generated files not checked \(vendor\//, rule);
    }
    // Left out of the rules, never out of sight: both are listed, with the reason.
    assert.deepEqual(report.notCheckedFiles, [
      { file: 'vendor/github.com/acme/lib/HTTPClient.go', reason: 'vendored code, added by this change' },
      { file: 'vendor/github.com/acme/lib/main.go', reason: 'vendored code, added by this change' },
    ]);
    assert.equal(report.totals.notCheckedFiles, 2);
  });

  it('a diff of nothing but vendored files passes nothing', () => {
    const p = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.go)) as StandardsProfile;
    const report = checkStandards(p, {
      baseRef: 'abc123', existingDirs: ['cmd', 'internal'], topLevel: ['cmd', 'internal', 'vendor'], goModulePath: null,
      files: [added('vendor/github.com/acme/lib/main.go', ['package main', COMMENTED])],
    });
    for (const rule of ['structure/placement', 'naming/files', RULE, 'comment-policy/density']) {
      const row = report.rules.find((r) => r.rule === rule)!;
      assert.equal(row.result, 'not-checked', rule);
      assert.match(row.reason ?? '', /^1 vendored or generated file not checked \(/, rule);
    }
    assert.equal(report.totals.notCheckedFiles, 1);
  });

  it('generated files are recognised by name and by the marker in their first lines', () => {
    const files = [
      added('internal/userpb/user.pb.go', ['package userpb', COMMENTED]),
      added('src/Views/Main.Designer.cs', ['namespace X {}', COMMENTED]),
      added('src/Gen/Model.g.cs', ['namespace X {}', COMMENTED]),
      added('src/api/Client.ts', ['// Code generated by openapi-gen. DO NOT EDIT.', '', COMMENTED]),
      added('src/api/Query.ts', ['/**', ' * @generated', ' */', COMMENTED]),
      added('src/api/Types.cs', ['// <auto-generated />', COMMENTED]),
    ];
    const p = profile();
    p.naming.files = [{ globs: ['src/**/*.ts'], style: 'kebab-case' }];
    const report = checkStandards(p, input(files));
    // No rule read these files, so none of the commented-out lines is found. What IS found
    // is the marker itself, on the three files whose marker this change wrote; a file that
    // is generated by its name carries no marker and is no finding.
    assert.deepEqual(report.findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.severity}`), [
      'src/api/Client.ts:1 exemption/newly-generated advisory',
      'src/api/Query.ts:2 exemption/newly-generated advisory',
      'src/api/Types.cs:1 exemption/newly-generated advisory',
    ]);
    assert.equal(report.rules.find((r) => r.rule === RULE)!.result, 'not-checked');
    assert.equal(report.rules.find((r) => r.rule === 'naming/files')!.result, 'not-checked');
    assert.deepEqual(report.notCheckedFiles?.map((f) => f.file), files.map((f) => f.path).sort((a, b) => a.localeCompare(b)));
    assert.ok(report.notCheckedFiles?.every((f) => f.reason === 'generated file, added or newly marked by this change'));
  });

  it('a marker below the first lines, or a hand-written neighbour, exempts nothing', () => {
    const late = added('src/late.ts', ['export const a = 1;', '', '', '', '', '', '// @generated', COMMENTED]);
    const report = checkStandards(profile(), input([late, added('vendor/x/y.ts', [COMMENTED])]));
    assert.deepEqual(report.findings.map((f) => `${f.file}:${f.line}`), ['src/late.ts:8']);
    const row = report.rules.find((r) => r.rule === RULE)!;
    assert.equal(row.result, 'failed');
    assert.match(row.reason ?? '', /1 vendored or generated file not checked \(vendor\/x\/y\.ts\)/);
  });

  it('a directory that merely contains the word is not vendored', () => {
    assert.deepEqual(flagged('src/vendors/list.ts', ['export const a = 1;', COMMENTED]), [2]);
  });
});
