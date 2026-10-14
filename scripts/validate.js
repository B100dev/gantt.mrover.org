#!/usr/bin/env node
// CI check: fails if data/schedule.json is malformed (bad dates, missing parents, cycles...).
'use strict';
const fs = require('fs');
const path = require('path');
const { validate } = require('../lib.js');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'schedule.json');
let doc;
try {
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`${file}: not valid JSON: ${err.message}`);
  process.exit(1);
}
const errors = validate(doc);
if (errors.length) {
  console.error(`${file}: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`${file}: OK (${doc.tasks.length} tasks)`);
