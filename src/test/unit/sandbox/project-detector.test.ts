// ─── Project detector tests ───
// Covers framework detection across web/mobile/desktop/unknown.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectProject } from '../../../sandbox/project-detector';

function makeTempProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function pkg(deps: Record<string, string>, devDeps: Record<string, string> = {}, scripts: Record<string, string> = {}): string {
  return JSON.stringify({ name: 'test', dependencies: deps, devDependencies: devDeps, scripts });
}

describe('detectProject', () => {
  describe('mobile', () => {
    it('detects Flutter from pubspec.yaml', () => {
      const root = makeTempProject({ 'pubspec.yaml': 'name: my_app\n' });
      const info = detectProject(root);
      assert.equal(info.type, 'mobile');
      assert.equal(info.framework, 'Flutter');
      assert.match(info.devCommand, /flutter run/);
    });

    it('detects Android from gradlew', () => {
      const root = makeTempProject({ 'gradlew': '#!/bin/sh\n' });
      const info = detectProject(root);
      assert.equal(info.type, 'mobile');
      assert.equal(info.framework, 'Android');
    });

    it('detects React Native from dependencies', () => {
      const root = makeTempProject({ 'package.json': pkg({ 'react-native': '0.73.0' }) });
      const info = detectProject(root);
      assert.equal(info.type, 'mobile');
      assert.equal(info.framework, 'React Native');
    });

    it('detects Expo from dependencies', () => {
      const root = makeTempProject({ 'package.json': pkg({ 'expo': '50.0.0', 'react-native': '0.73.0' }) });
      const info = detectProject(root);
      assert.equal(info.type, 'mobile');
      assert.equal(info.framework, 'Expo');
    });
  });

  describe('web', () => {
    it('detects Next.js', () => {
      const root = makeTempProject({
        'package.json': pkg({ 'next': '14.0.0' }, {}, { 'dev': 'next dev' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'web');
      assert.equal(info.framework, 'Next.js');
      assert.equal(info.defaultPort, 3000);
    });

    it('detects Vite', () => {
      const root = makeTempProject({
        'package.json': pkg({}, { 'vite': '5.0.0' }, { 'dev': 'vite' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'web');
      assert.equal(info.framework, 'Vite');
      assert.equal(info.defaultPort, 5173);
    });

    it('detects Create React App', () => {
      const root = makeTempProject({
        'package.json': pkg({ 'react-scripts': '5.0.0' }, {}, { 'start': 'react-scripts start' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'web');
      assert.equal(info.framework, 'Create React App');
      assert.equal(info.defaultPort, 3000);
    });

    it('detects Angular', () => {
      const root = makeTempProject({
        'package.json': pkg({ '@angular/core': '17.0.0' }, {}, { 'start': 'ng serve' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'web');
      assert.equal(info.framework, 'Angular');
      assert.equal(info.defaultPort, 4200);
    });

    it('detects Nuxt', () => {
      const root = makeTempProject({
        'package.json': pkg({ 'nuxt': '3.8.0' }, {}, { 'dev': 'nuxt dev' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'web');
      assert.equal(info.framework, 'Nuxt');
    });

    it('detects SvelteKit', () => {
      const root = makeTempProject({
        'package.json': pkg({ '@sveltejs/kit': '2.0.0' }, {}, { 'dev': 'vite dev' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'web');
      assert.equal(info.framework, 'SvelteKit');
    });

    it('falls back to generic web when only dev script is present', () => {
      const root = makeTempProject({
        'package.json': pkg({}, {}, { 'dev': 'webpack serve' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'web');
      assert.equal(info.framework, 'Web');
    });
  });

  describe('desktop', () => {
    it('detects Electron', () => {
      const root = makeTempProject({
        'package.json': pkg({ 'electron': '28.0.0' }, {}, { 'start': 'electron .' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'desktop');
      assert.equal(info.framework, 'Electron');
    });

    it('detects Tauri', () => {
      const root = makeTempProject({
        'package.json': pkg({}, { '@tauri-apps/cli': '1.5.0' }, { 'dev': 'tauri dev' }),
      });
      const info = detectProject(root);
      assert.equal(info.type, 'desktop');
      assert.equal(info.framework, 'Tauri');
    });
  });

  describe('unknown', () => {
    it('returns unknown when no manifest present', () => {
      const root = makeTempProject({ 'README.md': 'hello' });
      const info = detectProject(root);
      assert.equal(info.type, 'unknown');
      assert.equal(info.devCommand, '');
    });

    it('returns unknown when package.json is invalid', () => {
      const root = makeTempProject({ 'package.json': 'not json' });
      const info = detectProject(root);
      assert.equal(info.type, 'unknown');
    });
  });

  describe('priority ordering', () => {
    it('prefers Flutter over package.json if both present', () => {
      const root = makeTempProject({
        'pubspec.yaml': 'name: my_app\n',
        'package.json': pkg({ 'next': '14.0.0' }),
      });
      const info = detectProject(root);
      assert.equal(info.framework, 'Flutter');
    });

    it('prefers Expo label when both react-native and expo are present', () => {
      const root = makeTempProject({
        'package.json': pkg({ 'react-native': '0.73.0', 'expo': '50.0.0' }),
      });
      const info = detectProject(root);
      assert.equal(info.framework, 'Expo');
    });
  });
});
