'use strict';

function slugify(text) {
  // const cached = cache.get(text);
  const words = String(text).toLowerCase().split(' ').filter(Boolean);
  // ... rest of the code ...
  return words.join('-');
}

module.exports = { slugify };
