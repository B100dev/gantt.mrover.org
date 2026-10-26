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

test('enforceDeps pushes a chain of dependents later, keeping durations', () => {
  const tasks = [
    task('layout', { start: '2026-10-08', end: '2026-11-21' }),
    task('review', { start: '2026-10-22', end: '2026-10-24', deps: ['layout'] }),
    task('fab', { start: '2026-10-26', end: '2026-10-27', deps: ['review'] }),
    task('parts', { start: '2026-12-15', end: '2026-12-16', deps: ['layout'] }), // already late enough
  ];
  const moved = L.enforceDeps(tasks);
  const get = (id) => tasks.find((t) => t.id === id);
  assert.deepEqual([get('review').start, get('review').end], ['2026-11-22', '2026-11-24']);
  assert.deepEqual([get('fab').start, get('fab').end], ['2026-11-25', '2026-11-26']);
  assert.equal(get('parts').start, '2026-12-15');
  assert.deepEqual(moved.sort(), ['fab', 'review']);
});

test('enforceDeps shifts every leaf under a dependent parent and respects parent predecessors', () => {
  const tasks = [
    task('bmc'), task('bmc-a', { parent: 'bmc', start: '2026-10-01', end: '2026-10-10' }),
    task('gear'), task('gear-a', { parent: 'gear', start: '2026-10-01', end: '2026-10-20' }),
    task('integ'), task('i1', { parent: 'integ', start: '2026-10-05', end: '2026-10-06' }),
    task('i2', { parent: 'integ', start: '2026-10-07', end: '2026-10-08' }),
  ];
  tasks.find((t) => t.id === 'integ').deps = ['bmc', 'gear'];
  L.enforceDeps(tasks);
  const get = (id) => tasks.find((t) => t.id === id);
  assert.equal(get('i1').start, '2026-10-21');
  assert.equal(get('i2').end, '2026-10-24');
});

test('wouldCycle / pruneDeps reject loops, including through parents', () => {
  const tasks = [
    task('p'), task('a', { parent: 'p', start: '2026-10-01', end: '2026-10-02' }),
    task('b', { start: '2026-10-05', end: '2026-10-06' }),
    task('c', { start: '2026-10-07', end: '2026-10-08', deps: ['b'] }),
  ];
  const g = L.graph(tasks);
  assert.equal(L.wouldCycle(g, 'c', 'b'), true);   // b after c after b
  assert.equal(L.wouldCycle(g, 'p', 'a'), true);   // child after its own parent
  assert.equal(L.wouldCycle(g, 'a', 'p'), true);   // parent after its own child
  assert.equal(L.wouldCycle(g, 'b', 'a'), false);
  // a after c, and b after p: shifting a stretches p, which pushes b, then c, then a again
  tasks.find((t) => t.id === 'a').deps = ['c'];
  tasks.find((t) => t.id === 'b').deps = ['p'];
  assert.equal(L.pruneDeps(tasks), 1);
  const doc2 = { title: 't', tasks };
  assert.deepEqual(L.validate(doc2), []);
  L.enforceDeps(tasks); // terminates
});

test('validate reports bad dependencies; sanitize drops them', () => {
  const bad = { title: 'x', tasks: [
    { id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['nope'] },
  ] };
  assert.equal(L.validate(bad).length, 1); // missing task (loop check runs once ids are valid)
  bad.tasks[2].deps = [];
  assert.match(L.validate(bad)[0], /loop/);
  const clean = L.sanitize(bad);
  assert.deepEqual(L.validate(clean), []);
  assert.equal(clean.tasks.filter((t) => t.deps.length).length, 1);
});

test('merge combines dependency edits like any other field', () => {
  const base = doc(task('a'), task('b'), task('c'));
  const mine = doc(task('a'), task('b', { deps: ['a'] }), task('c'));
  const theirs = doc(task('a'), task('b', { name: 'B!' }), task('c', { deps: ['a'] }));
  const { doc: out, conflicts } = L.merge(base, mine, theirs);
  assert.deepEqual(out.tasks.find((t) => t.id === 'b').deps, ['a']);
  assert.equal(out.tasks.find((t) => t.id === 'b').name, 'B!');
  assert.deepEqual(out.tasks.find((t) => t.id === 'c').deps, ['a']);
  assert.deepEqual(conflicts, []);
});
