'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('../src/slug.js');

test('R-1: lowercases and joins words with single dashes', () => {
  assert.equal(slugify('Hello  Big World'), 'hello-big-world');
  assert.equal(slugify('one'), 'one');
});

test('R-1: an empty title gives an empty slug', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('   '), '');
});
