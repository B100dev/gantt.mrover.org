'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib.js');

const task = (id, extra = {}) => L.normTask({ id, name: id, ...extra });
const doc = (...tasks) => ({ title: 'T', tasks });

test('toDay / fromDay round-trip and reject invalid dates', () => {
  assert.equal(L.fromDay(L.toDay('2026-10-13')), '2026-10-13');
  assert.equal(L.toDay('2026-02-30'), null);
  assert.equal(L.toDay('10/13/2026'), null);
  assert.equal(L.toDay(''), null);
});

test('sanitize removes orphans, duplicate ids and cycles', () => {
  const d = L.sanitize({ tasks: [
    { id: 'a', parent: 'b' }, { id: 'b', parent: 'a' },
    { id: 'c', parent: 'missing' }, { id: 'c' }, { id: 'd', parent: 'd' },
  ] });
  const ids = d.tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(d.tasks.find((t) => t.id === 'c').parent, null);
  assert.equal(d.tasks.find((t) => t.id === 'd').parent, null);
  assert.ok(d.tasks.filter((t) => t.id === 'a' || t.id === 'b').some((t) => t.parent === null));
  assert.deepEqual(L.validate(d), []);
});

test('serialize round-trips through JSON.parse', () => {
  const d = doc(task('a', { notes: 'line\n"quoted" ✓' }), task('b', { parent: 'a' }));
  assert.deepEqual(JSON.parse(L.serialize(d)), d);
  assert.deepEqual(JSON.parse(L.serialize(doc())), doc());
});

test('merge keeps non-overlapping edits from both sides', () => {
  const base = doc(task('a'), task('b'));
  const mine = doc(task('a', { status: 'done' }), task('b'), task('mine-new', { parent: 'a' }));
  const theirs = doc(task('a', { owner: 'Sam' }), task('b', { name: 'B2' }), task('their-new'));
  const { doc: out, conflicts } = L.merge(base, mine, theirs);
  const get = (id) => out.tasks.find((t) => t.id === id);
  assert.equal(get('a').status, 'done');
  assert.equal(get('a').owner, 'Sam');
  assert.equal(get('b').name, 'B2');
  assert.ok(get('mine-new'));
  assert.ok(get('their-new'));
  assert.deepEqual(conflicts, []);
});

test('merge: same field edited on both sides keeps mine and reports it', () => {
  const base = doc(task('a', { end: '2026-10-01' }));
  const { doc: out, conflicts } = L.merge(base, doc(task('a', { end: '2026-10-05' })), doc(task('a', { end: '2026-10-09' })));
  assert.equal(out.tasks[0].end, '2026-10-05');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'end');
});

test('merge handles deletions', () => {
  const base = doc(task('a'), task('b'), task('c'));
  // I delete b; they delete c; nobody touched the other.
  const { doc: out } = L.merge(base, doc(task('a'), task('c')), doc(task('a'), task('b')));
  assert.deepEqual(out.tasks.map((t) => t.id), ['a']);
});

test('merge: their edit survives my deletion (reported), child of a deleted parent is kept', () => {
  const base = doc(task('p'), task('x'));
  const mine = doc(task('p'), task('kid', { parent: 'p' }));          // deleted x, added kid under p
  const theirs = doc(task('x', { status: 'done' }));                  // deleted p, edited x
  const { doc: out, conflicts } = L.merge(base, mine, theirs);
  assert.ok(out.tasks.find((t) => t.id === 'x'));
  assert.equal(out.tasks.find((t) => t.id === 'kid').parent, null);
  assert.equal(conflicts.length, 1);
});

test('merge with no remote changes returns mine exactly', () => {
  const base = doc(task('a'), task('b'));
  const mine = doc(task('b'), task('a', { name: 'renamed' }));
  assert.equal(L.serialize(L.merge(base, mine, base).doc), L.serialize(mine));
});

test('merge places their new tasks after their predecessor', () => {
  const base = doc(task('a'), task('b'));
  const theirs = doc(task('a'), task('n'), task('b'));
  const { doc: out } = L.merge(base, base, theirs);
  assert.deepEqual(out.tasks.map((t) => t.id), ['a', 'n', 'b']);
});

test('validate catches bad data', () => {
  const errs = L.validate({ title: 'x', tasks: [
    { id: 'a', start: '2026-10-10', end: '2026-10-01' },
    { id: 'a' },
    { id: 'b', parent: 'zzz', status: 'nope' },
    { id: 'c', start: '13/10/2026' },
  ] });
  assert.equal(errs.length, 5);
});

test('shipped schedule.json is valid', () => {
  const d = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'schedule.json'), 'utf8'));
  assert.deepEqual(L.validate(d), []);
});
