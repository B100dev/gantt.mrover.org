// Pure schedule logic shared by the browser app (window.GanttLib) and the
// Node tests / CI validator (module.exports). No DOM access in here.
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.GanttLib = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const STATUSES = ['todo', 'in-progress', 'blocked', 'done'];
  const TASK_DEFAULTS = {
    id: '', parent: null, name: '', owner: '', status: 'todo',
    start: '', end: '', milestone: false, link: '', notes: '',
  };
  const TASK_KEYS = Object.keys(TASK_DEFAULTS);
  const STRING_KEYS = ['id', 'name', 'owner', 'start', 'end', 'link', 'notes'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Dates are handled as integer UTC day numbers so DST never shifts a bar.
  function toDay(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d);
    const dt = new Date(ms);
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(ms / DAY_MS);
  }

  function fromDay(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }

  function newId(taken) {
    let id;
    do { id = Math.random().toString(36).slice(2, 10); } while (id.length < 4 || (taken && taken.has(id)));
    return id;
  }

  function normTask(t) {
    const o = {};
    for (const k of TASK_KEYS) o[k] = t[k] === undefined ? TASK_DEFAULTS[k] : t[k];
    for (const k of STRING_KEYS) o[k] = o[k] == null ? '' : String(o[k]);
    o.parent = o.parent ? String(o.parent) : null;
    o.milestone = !!o.milestone;
    if (!STATUSES.includes(o.status)) o.status = 'todo';
    return o;
  }

  // Normalise any loaded/merged document: unique ids, no orphans, no cycles.
  function sanitize(doc) {
    const src = doc && typeof doc === 'object' ? doc : {};
    const tasks = [];
    const seen = new Set();
    for (const raw of Array.isArray(src.tasks) ? src.tasks : []) {
      if (!raw || typeof raw !== 'object') continue;
      const t = normTask(raw);
      if (!t.id || seen.has(t.id)) t.id = newId(seen);
      seen.add(t.id);
      tasks.push(t);
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (t.parent && (!byId.has(t.parent) || t.parent === t.id)) t.parent = null;
    }
    for (const t of tasks) {
      const path = new Set([t.id]);
      let p = t.parent;
      while (p) {
        if (p === t.id) { t.parent = null; break; }
        if (path.has(p)) break; // cycle elsewhere; broken when its member is visited
        path.add(p);
        p = byId.get(p).parent;
      }
    }
    const title = typeof src.title === 'string' && src.title.trim() ? src.title : 'MRover Gantt';
    return { title, tasks };
  }

  // One task per line keeps git diffs and blame readable.
  function serialize(doc) {
    const tasks = doc.tasks.length
      ? '[\n' + doc.tasks.map((t) => '    ' + JSON.stringify(normTask(t))).join(',\n') + '\n  ]'
      : '[]';
    return '{\n  "title": ' + JSON.stringify(doc.title) + ',\n  "tasks": ' + tasks + '\n}\n';
  }

  function taskEqual(a, b) {
    return JSON.stringify(normTask(a)) === JSON.stringify(normTask(b));
  }

  function byIdMap(tasks) {
    return new Map((tasks || []).map((t) => [t.id, normTask(t)]));
  }

  // Three-way merge by task id. Non-overlapping edits from both sides are kept;
  // when the same field was changed on both sides, "mine" wins and it is reported.
  function merge(base, mine, theirs) {
    base = base || { title: '', tasks: [] };
    const B = byIdMap(base.tasks), M = byIdMap(mine.tasks), T = byIdMap(theirs.tasks);
    const conflicts = [];
    const out = new Map();

    for (const id of new Set([...M.keys(), ...T.keys()])) {
      const b = B.get(id), m = M.get(id), t = T.get(id);
      let r;
      if (!b) {
        r = m || t;
      } else {
        const mineChanged = !m || !taskEqual(m, b);
        const theirsChanged = !t || !taskEqual(t, b);
        if (!mineChanged) r = t;
        else if (!theirsChanged) r = m;
        else if (!m) { r = t; conflicts.push({ id, name: t.name, field: null, kept: 'theirs' }); }
        else if (!t) { r = m; conflicts.push({ id, name: m.name, field: null, kept: 'mine' }); }
        else {
          r = {};
          for (const k of TASK_KEYS) {
            if (m[k] !== b[k]) {
              r[k] = m[k];
              if (t[k] !== b[k] && t[k] !== m[k]) conflicts.push({ id, name: m.name, field: k, kept: 'mine' });
            } else {
              r[k] = t[k];
            }
          }
        }
      }
      if (r) out.set(id, normTask(r));
    }

    // Keep my ordering; slot tasks only they have in after their predecessor.
    const order = mine.tasks.map((t) => t.id).filter((id) => out.has(id));
    const theirIds = theirs.tasks.map((t) => t.id);
    theirIds.forEach((id, i) => {
      if (!out.has(id) || order.includes(id)) return;
      let pos = -1;
      for (let j = i - 1; j >= 0 && pos === -1; j--) pos = order.indexOf(theirIds[j]);
      order.splice(pos + 1, 0, id);
    });

    const title = mine.title !== base.title ? mine.title : theirs.title;
    return { doc: sanitize({ title, tasks: order.map((id) => out.get(id)) }), conflicts };
  }

  function diffCount(a, b) {
    const A = byIdMap(a.tasks), B = byIdMap(b.tasks);
    let n = a.title !== b.title ? 1 : 0;
    for (const id of new Set([...A.keys(), ...B.keys()])) {
      const x = A.get(id), y = B.get(id);
      if (!x || !y || !taskEqual(x, y)) n++;
    }
    return n;
  }

  // Strict check used by CI so a hand-edited schedule.json can't break the site.
  function validate(doc) {
    const errors = [];
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['document must be a JSON object'];
    if (typeof doc.title !== 'string') errors.push('"title" must be a string');
    if (!Array.isArray(doc.tasks)) return errors.concat('"tasks" must be an array');
    const ids = new Map();
    doc.tasks.forEach((t, i) => {
      const where = `task #${i + 1}${t && t.name ? ` ("${t.name}")` : ''}`;
      if (!t || typeof t !== 'object') { errors.push(`${where}: must be an object`); return; }
      if (typeof t.id !== 'string' || !t.id) errors.push(`${where}: missing "id"`);
      else if (ids.has(t.id)) errors.push(`${where}: duplicate id "${t.id}"`);
      else ids.set(t.id, t);
      if (t.status !== undefined && !STATUSES.includes(t.status)) errors.push(`${where}: unknown status "${t.status}"`);
      for (const k of ['start', 'end']) {
        if (t[k] && toDay(t[k]) === null) errors.push(`${where}: "${k}" must be YYYY-MM-DD`);
      }
      if (toDay(t.start) !== null && toDay(t.end) !== null && toDay(t.end) < toDay(t.start)) {
        errors.push(`${where}: end is before start`);
      }
    });
    for (const t of doc.tasks) {
      if (!t || !t.parent) continue;
      if (!ids.has(t.parent)) { errors.push(`task "${t.id}": parent "${t.parent}" does not exist`); continue; }
      const seen = new Set([t.id]);
      let p = t.parent;
      while (p && ids.has(p)) {
        if (seen.has(p)) { errors.push(`task "${t.id}": parent chain contains a cycle`); break; }
        seen.add(p);
        p = ids.get(p).parent;
      }
    }
    return errors;
  }

  return {
    DAY_MS, STATUSES, TASK_KEYS,
    toDay, fromDay, newId, normTask, sanitize, serialize, taskEqual, merge, diffCount, validate,
  };
});
