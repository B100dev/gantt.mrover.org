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
    start: '', end: '', milestone: false, link: '', notes: '', deps: [], keyDate: false,
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
    o.keyDate = !!o.keyDate;
    if (!STATUSES.includes(o.status)) o.status = 'todo';
    o.deps = Array.isArray(o.deps) ? [...new Set(o.deps.filter((d) => d && typeof d === 'string'))] : [];
    return o;
  }

  // ---- dependencies (finish-to-start: a task starts after all its deps end) ----

  function graph(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const children = new Map();
    const dependents = new Map();
    for (const t of tasks) {
      const p = t.parent && byId.has(t.parent) ? t.parent : '';
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(t);
      for (const d of t.deps || []) {
        if (!dependents.has(d)) dependents.set(d, []);
        dependents.get(d).push(t.id);
      }
    }
    return { byId, children, dependents };
  }

  function subtreeIds(g, id) {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const c of g.children.get(out[i]) || []) out.push(c.id);
    return out;
  }

  // Would making succ depend on pred create a loop? Shifting succ moves its whole
  // subtree and can push out the end of its ancestors; that in turn shifts their
  // dependents. If that chain reaches pred, rescheduling would never settle.
  function wouldCycle(g, predId, succId) {
    const shifted = new Set(), raised = new Set();
    const queue = [succId];
    while (queue.length) {
      const n = queue.pop();
      if (shifted.has(n) || !g.byId.has(n)) continue;
      shifted.add(n);
      const touched = subtreeIds(g, n);
      for (let p = g.byId.get(n).parent; p && g.byId.has(p); p = g.byId.get(p).parent) touched.push(p);
      for (const m of touched) {
        if (raised.has(m)) continue;
        raised.add(m);
        for (const d of g.dependents.get(m) || []) queue.push(d);
      }
    }
    return raised.has(predId);
  }

  // Drop dependencies on missing tasks and any that would form a loop.
  function pruneDeps(tasks) {
    const wanted = new Map(tasks.map((t) => [t.id, t.deps || []]));
    for (const t of tasks) t.deps = [];
    const g = graph(tasks);
    let dropped = 0;
    for (const t of tasks) {
      for (const d of wanted.get(t.id)) {
        if (!g.byId.has(d) || wouldCycle(g, d, t.id)) { dropped++; continue; }
        t.deps.push(d);
        if (!g.dependents.has(d)) g.dependents.set(d, []);
        g.dependents.get(d).push(t.id);
      }
    }
    return dropped;
  }

  // Start/end day numbers for every task; parents span their children.
  function spans(g) {
    const out = new Map();
    const visit = (t) => {
      const kids = g.children.get(t.id) || [];
      let start = null, end = null;
      if (!kids.length) {
        start = toDay(t.start); end = toDay(t.end);
        if (start == null) start = end;
        if (end == null || end < start) end = start;
        if (t.milestone) start = end;
      } else {
        for (const k of kids) {
          const c = visit(k);
          if (c.start != null && (start == null || c.start < start)) start = c.start;
          if (c.end != null && (end == null || c.end > end)) end = c.end;
        }
      }
      const r = { start, end };
      out.set(t.id, r);
      return r;
    };
    for (const t of g.children.get('') || []) visit(t);
    return out;
  }

  // Push tasks later so each one starts the day after its latest dependency ends.
  // Never pulls work earlier. Mutates tasks; returns the ids that moved.
  function enforceDeps(tasks) {
    const g = graph(tasks);
    const moved = new Set();
    for (let guard = 0; guard < tasks.length * 4 + 10; guard++) {
      const S = spans(g);
      let changed = false;
      for (const t of tasks) {
        const r = S.get(t.id);
        if (!t.deps.length || !r || r.start == null) continue;
        let need = -Infinity;
        for (const d of t.deps) { const p = S.get(d); if (p && p.end != null) need = Math.max(need, p.end + 1); }
        if (r.start >= need) continue;
        const delta = need - r.start;
        for (const id of subtreeIds(g, t.id)) {
          const x = g.byId.get(id);
          if ((g.children.get(id) || []).length) continue;
          if (toDay(x.start) != null) x.start = fromDay(toDay(x.start) + delta);
          if (toDay(x.end) != null) x.end = fromDay(toDay(x.end) + delta);
        }
        moved.add(t.id);
        changed = true;
        break; // spans changed; recompute before checking the next task
      }
      if (!changed) break;
    }
    return [...moved];
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
    pruneDeps(tasks);
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

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
            if (!same(m[k], b[k])) {
              r[k] = m[k];
              if (!same(t[k], b[k]) && !same(t[k], m[k])) conflicts.push({ id, name: m.name, field: k, kept: 'mine' });
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
    for (const t of doc.tasks) {
      if (!t || t.deps === undefined) continue;
      if (!Array.isArray(t.deps)) { errors.push(`task "${t.id}": "deps" must be an array of task ids`); continue; }
      for (const d of t.deps) {
        if (!ids.has(d)) errors.push(`task "${t.id}": depends on missing task "${d}"`);
        else if (d === t.id) errors.push(`task "${t.id}": depends on itself`);
      }
    }
    if (!errors.length) {
      const tasks = doc.tasks.map(normTask);
      if (pruneDeps(tasks)) errors.push('dependencies form a loop (a task ends up waiting on itself, its parent or its subtasks)');
    }
    return errors;
  }

  return {
    DAY_MS, STATUSES, TASK_KEYS,
    toDay, fromDay, newId, normTask, sanitize, serialize, taskEqual, merge, diffCount, validate,
    graph, wouldCycle, pruneDeps, spans, enforceDeps,
  };
});
