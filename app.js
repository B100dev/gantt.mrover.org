(function () {
  'use strict';

  const L = window.GanttLib;

  // Where the shared schedule lives. Everyone who saves needs a token that can
  // write to this repo (see README).
  const CONFIG = {
    owner: 'B100dev',
    repo: 'gantt.mrover.org',
    branch: 'main',
    path: 'data/schedule.json',
  };
  const API_URL = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.path}`;
  const HISTORY_URL = `https://github.com/${CONFIG.owner}/${CONFIG.repo}/commits/${CONFIG.branch}/${CONFIG.path}`;

  const STATUS_LABELS = { 'todo': 'Not started', 'in-progress': 'In progress', 'blocked': 'Blocked', 'done': 'Done' };
  const ZOOMS = {
    day: { ppd: 28, top: 'month', bottom: 'day' },
    week: { ppd: 10, top: 'month', bottom: 'week' },
    month: { ppd: 3.5, top: 'year', bottom: 'month' },
  };
  // Standard breakdowns that can be stamped under any task: [name, days, after].
  // `after` lists the steps (by index) that must finish first; default is the previous step.
  const TEMPLATES = {
    pcb: {
      label: 'PCB / electronics board',
      steps: [['Schematic', 14], ['Schematic review', 3], ['Layout', 14], ['Layout review', 3],
        ['Parts ordered', 7, [1]], ['Board fab ordered', 10, [3]], ['Assembly', 5, [4, 5]], ['Bring-up & test', 7]],
    },
    mech: {
      label: 'Mechanical part / assembly',
      steps: [['CAD', 14], ['Design review', 3], ['Drawings', 5], ['Stock / parts ordered', 7, [1]],
        ['Manufacturing', 14, [2, 3]], ['Assembly', 5], ['Testing', 7]],
    },
    software: {
      label: 'Software feature',
      steps: [['Design', 5], ['Implementation', 14], ['Code review', 3], ['Sim testing', 5], ['On-rover testing', 5]],
    },
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const REMOTE_CHECK_MS = 60000;

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '');

  const store = {
    get(k) { try { return localStorage.getItem('gantt:' + k); } catch { return null; } },
    set(k, v) {
      try { if (v == null) localStorage.removeItem('gantt:' + k); else localStorage.setItem('gantt:' + k, v); } catch { /* storage unavailable */ }
    },
  };

  function readCollapsed() {
    try { return new Set(JSON.parse(store.get('collapsed') || '[]')); } catch { return new Set(); }
  }

  const S = {
    doc: { title: 'MRover Gantt', tasks: [] },
    base: null,       // last version known to be on GitHub; used for 3-way merge
    sha: null,
    source: 'none',   // 'github' | 'static' | 'none'
    dirty: false,
    saving: false,
    zoom: ZOOMS[store.get('zoom')] ? store.get('zoom') : 'week',
    collapsed: readCollapsed(),
    filters: { q: '', owner: '', status: '' },
    undo: [],
    redo: [],
    lastRemoteCheck: 0,
    editing: null,    // { id, isNew }
    tree: null,
    info: null,
    range: { min: 0, max: 0 },
  };

  // ---------- dates ----------

  function today() {
    const t = new Date();
    return Math.round(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / L.DAY_MS);
  }
  const utc = (n) => new Date(n * L.DAY_MS);
  const weekday = (n) => (utc(n).getUTCDay() + 6) % 7; // Monday = 0

  function fmt(n) {
    const d = utc(n);
    const s = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    return d.getUTCFullYear() === utc(today()).getUTCFullYear() ? s : `${s} '${String(d.getUTCFullYear()).slice(2)}`;
  }

  // "Jan 10 – 23 '27" style: only mention the year once, and only when it isn't this year.
  function fmtRange(a, b) {
    if (a === b) return fmt(a);
    const da = utc(a), db = utc(b);
    const y = da.getUTCFullYear();
    if (y !== db.getUTCFullYear() || y === utc(today()).getUTCFullYear()) return `${fmt(a)} – ${fmt(b)}`;
    const end = da.getUTCMonth() === db.getUTCMonth() ? db.getUTCDate() : `${MONTHS[db.getUTCMonth()]} ${db.getUTCDate()}`;
    return `${MONTHS[da.getUTCMonth()]} ${da.getUTCDate()} – ${end} '${String(y).slice(2)}`;
  }

  function segments(unit, min, max) {
    const out = [];
    let d = min;
    while (d <= max) {
      const dt = utc(d), y = dt.getUTCFullYear(), m = dt.getUTCMonth();
      let next, label;
      if (unit === 'day') { next = d + 1; label = dt.getUTCDate(); }
      else if (unit === 'week') { next = d + 7 - weekday(d); label = fmt(d); }
      else if (unit === 'month') { next = Math.round(Date.UTC(y, m + 1, 1) / L.DAY_MS); label = MONTHS[m]; }
      else { next = Math.round(Date.UTC(y + 1, 0, 1) / L.DAY_MS); label = y; }
      out.push({ start: d, end: Math.min(next, max + 1), label, d });
      d = next;
    }
    return out;
  }

  // ---------- tree ----------

  function buildTree() {
    const byId = new Map(S.doc.tasks.map((t) => [t.id, t]));
    const children = new Map([['', []]]);
    for (const t of S.doc.tasks) {
      const p = t.parent && byId.has(t.parent) ? t.parent : '';
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(t);
    }
    return { byId, children };
  }

  const kidsOf = (id) => S.tree.children.get(id) || [];

  function descendants(id) {
    const out = [];
    const walk = (pid) => { for (const k of kidsOf(pid)) { out.push(k.id); walk(k.id); } };
    walk(id);
    return out;
  }

  // Parents roll up dates, completion and status from their leaves.
  function computeRollups(tree) {
    const info = new Map();
    const now = today();
    const visit = (t) => {
      const kids = tree.children.get(t.id) || [];
      let r;
      if (!kids.length) {
        let s = L.toDay(t.start), e = L.toDay(t.end);
        if (s == null) s = e;
        if (e == null || e < s) e = s;
        if (t.milestone) s = e;
        r = {
          start: s, end: e, leaves: 1, done: t.status === 'done' ? 1 : 0, hasKids: false,
          status: t.status, overdue: t.status !== 'done' && e != null && e < now,
        };
      } else {
        let start = null, end = null, leaves = 0, done = 0, blocked = false, started = false;
        for (const k of kids) {
          const c = visit(k);
          if (c.start != null && (start == null || c.start < start)) start = c.start;
          if (c.end != null && (end == null || c.end > end)) end = c.end;
          leaves += c.leaves; done += c.done;
          blocked = blocked || c.status === 'blocked';
          started = started || c.status !== 'todo';
        }
        const status = done === leaves ? 'done' : blocked ? 'blocked' : started ? 'in-progress' : 'todo';
        r = { start, end, leaves, done, hasKids: true, status, overdue: status !== 'done' && end != null && end < now };
      }
      info.set(t.id, r);
      return r;
    };
    for (const root of tree.children.get('')) visit(root);
    return info;
  }

  function filtering() {
    const f = S.filters;
    return !!(f.q || f.owner || f.status);
  }

  function visibleRows() {
    const f = S.filters;
    let show = null;
    if (filtering()) {
      show = new Set();
      const q = f.q.toLowerCase();
      for (const t of S.doc.tasks) {
        const r = S.info.get(t.id);
        const ok = (!q || `${t.name} ${t.owner} ${t.notes}`.toLowerCase().includes(q))
          && (!f.owner || splitOwners(t.owner).includes(f.owner))
          && (!f.status || r.status === f.status);
        if (!ok) continue;
        for (let p = t; p; p = S.tree.byId.get(p.parent)) show.add(p.id);
        if (q && !f.owner && !f.status) descendants(t.id).forEach((id) => show.add(id));
      }
    }
    const rows = [];
    const walk = (pid, depth) => {
      for (const t of kidsOf(pid)) {
        if (show && !show.has(t.id)) continue;
        rows.push({ t, depth });
        if (show || !S.collapsed.has(t.id)) walk(t.id, depth + 1);
      }
    };
    walk('', 0);
    return rows;
  }

  function splitOwners(s) {
    return s.split(/[,/&]+/).map((x) => x.trim()).filter(Boolean);
  }

  function computeRange() {
    let min = Infinity, max = -Infinity;
    for (const r of S.info.values()) {
      if (r.start != null) min = Math.min(min, r.start);
      if (r.end != null) max = Math.max(max, r.end);
    }
    const now = today();
    min = Math.min(min, now) - 14;
    max = Math.max(max, now) + 60;
    if (S.zoom === 'week') min -= weekday(min);
    if (S.zoom === 'month') { const d = utc(min); min = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / L.DAY_MS); }
    return { min, max };
  }

  // ---------- rendering ----------

  const scroller = $('#scroller');
  const gantt = $('#gantt');

  function leftWidth() {
    return window.innerWidth < 760 ? 230 : 470;
  }

  function render() {
    S.tree = buildTree();
    S.info = computeRollups(S.tree);
    S.range = computeRange();
    const { min, max } = S.range;
    const z = ZOOMS[S.zoom];
    const ppd = z.ppd;
    const width = Math.ceil((max - min + 1) * ppd);
    const x = (d) => (d - min) * ppd;
    const rows = visibleRows();
    const now = today();
    const LEFT = leftWidth();
    gantt.style.setProperty('--left', LEFT + 'px');
    gantt.style.setProperty('--tl', width + 'px');

    const tier = (unit, cls) => segments(unit, min, max).map((s) => {
      const extra = unit === 'day' && weekday(s.d) >= 5 ? ' weekend' : '';
      const long = (unit === 'month' && cls === 'top') ? `${MONTHS_LONG[utc(s.d).getUTCMonth()]} ${utc(s.d).getUTCFullYear()}` : s.label;
      return `<div class="seg${extra}" style="left:${x(s.start)}px;width:${(s.end - s.start) * ppd}px"><span>${esc(long)}</span></div>`;
    }).join('');

    let lines = segments(z.bottom, min, max).map((s) => {
      const major = utc(s.start).getUTCDate() === 1 ? ' major' : '';
      const wk = z.bottom === 'day' && weekday(s.d) >= 5 ? `<div class="weekend-bg" style="left:${x(s.start)}px;width:${ppd}px"></div>` : '';
      return `${wk}<div class="vline${major}" style="left:${x(s.start)}px"></div>`;
    }).join('');
    lines += `<div class="today" style="left:${x(now) + ppd / 2}px" title="Today"></div>`;

    let h = `<div class="g-head">
      <div class="g-corner"><span class="c-name">Task</span><span class="c-owner">Owner</span><span class="c-dates">Dates</span></div>
      <div class="g-scale"><div class="tier top">${tier(z.top, 'top')}</div><div class="tier bottom">${tier(z.bottom, 'bottom')}</div>
      <div class="today-tag" style="left:${x(now) + ppd / 2}px">Today</div></div>
    </div>
    <div class="g-body"><div class="g-lines">${lines}</div>`;

    h += depArrows(rows, x, ppd);
    for (const { t, depth } of rows) h += rowHtml(t, depth, x, ppd);

    if (!rows.length) {
      h += `<div class="empty">${filtering()
        ? 'No tasks match the current filter.'
        : 'No tasks yet. Use <b>+ Task</b> to add the first one (e.g. "Rolling Rover").'}</div>`;
    }
    h += '</div>';
    gantt.innerHTML = h;
    renderFilters();
    updateSync();
  }

  // Elbow arrows from the end of each dependency to the start of the task that waits on it.
  function depArrows(rows, x, ppd) {
    const rowOf = new Map(rows.map((r, i) => [r.t.id, i]));
    const H = 30, mid = H / 2;
    let paths = '';
    for (const { t } of rows) {
      const r = S.info.get(t.id);
      if (!t.deps.length || r.start == null) continue;
      const i2 = rowOf.get(t.id);
      for (const d of t.deps) {
        const p = S.info.get(d);
        if (!p || p.end == null || !rowOf.has(d)) continue;
        const i1 = rowOf.get(d);
        const pt = S.tree.byId.get(d);
        const x1 = pt.milestone && !p.hasKids ? x(p.end) + ppd / 2 + 6 : x(p.end + 1);
        const x2 = t.milestone && !r.hasKids ? x(r.end) + ppd / 2 - 7 : x(r.start);
        const y1 = i1 * H + mid, y2 = i2 * H + mid;
        let path;
        if (x2 - x1 >= 12) {
          path = `M${x1} ${y1}H${x1 + 6}V${y2}H${x2}`;
        } else {
          const yc = y2 + (y2 > y1 ? -mid : mid);
          path = `M${x1} ${y1}H${x1 + 6}V${yc}H${x2 - 8}V${y2}H${x2}`;
        }
        const late = r.start <= p.end;
        paths += `<path class="dep${late ? ' late' : ''}" d="${path}"><title>${esc(t.name)} waits on ${esc(pt.name)}${late ? ' (starts too early!)' : ''}</title></path>`;
      }
    }
    if (!paths) return '';
    return `<svg class="g-deps" width="100%" height="${rows.length * H}" aria-hidden="true">
      <defs><marker id="arrow" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L6 3L0 6z" class="arrow-head"/></marker>
      <marker id="arrow-late" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L6 3L0 6z" class="arrow-head late"/></marker></defs>
      ${paths}</svg>`;
  }

  function rowHtml(t, depth, x, ppd) {
    const r = S.info.get(t.id);
    const hasKids = r.hasKids;
    const collapsed = hasKids && S.collapsed.has(t.id) && !filtering();
    let dates = '';
    if (r.start != null) dates = fmtRange(r.start, r.end);
    const link = safeUrl(t.link);
    return `<div class="row${hasKids ? ' is-parent' : ''}${depth === 0 ? ' is-root' : ''}" data-id="${esc(t.id)}" style="--depth:${depth}">
      <div class="cell-left">
        <div class="c-name">
          ${hasKids
            ? `<button class="toggle" data-act="toggle" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(t.name)}">${collapsed ? '▸' : '▾'}</button>`
            : '<span class="toggle"></span>'}
          <span class="dot s-${r.status}" title="${STATUS_LABELS[r.status]}"></span>
          <button class="name" data-act="edit" title="Edit ${esc(t.name)}">${esc(t.name || 'Untitled')}</button>
          ${hasKids ? `<span class="count" title="${r.done} of ${r.leaves} steps done">${r.done}/${r.leaves}</span>` : ''}
          ${link ? `<a class="ext" href="${esc(link)}" target="_blank" rel="noopener" title="Open link">↗</a>` : ''}
          <button class="add" data-act="add-child" title="Add subtask under ${esc(t.name)}" aria-label="Add subtask">+</button>
        </div>
        <div class="c-owner" title="${esc(t.owner)}">${esc(t.owner)}</div>
        <div class="c-dates${r.overdue ? ' overdue' : ''}">${dates}</div>
      </div>
      <div class="cell-right">${barHtml(t, r, x, ppd)}</div>
    </div>`;
  }

  function barHtml(t, r, x, ppd) {
    if (r.start == null) return '';
    const days = r.end - r.start + 1;
    const tip = esc(`${t.name}\n${r.start === r.end ? fmt(r.start) : `${fmt(r.start)} – ${fmt(r.end)} (${days} days)`}`
      + `\n${STATUS_LABELS[r.status]}${t.owner ? ` · ${t.owner}` : ''}${r.overdue ? '\nOverdue' : ''}`);
    const label = `<span class="bar-label">${esc(t.name)}${t.owner && !r.hasKids ? ` <span class="bar-owner">· ${esc(t.owner)}</span>` : ''}</span>`;
    const od = r.overdue ? ' overdue' : '';
    if (r.hasKids) {
      const pct = r.leaves ? Math.round((r.done / r.leaves) * 100) : 0;
      return `<div class="bar parent s-${r.status}${od}" style="left:${x(r.start)}px;width:${days * ppd}px" title="${tip}\n${pct}% complete"><div class="fill" style="width:${pct}%"></div>${label}</div>`;
    }
    if (t.milestone) {
      return `<div class="ms s-${r.status}${od}" data-drag="move" style="left:${x(r.end) + ppd / 2}px" title="${tip}">${label}</div>`;
    }
    return `<div class="bar leaf s-${r.status}${od}" data-drag="move" style="left:${x(r.start)}px;width:${days * ppd}px" title="${tip}">`
      + `<span class="h h-l" data-drag="l"></span><span class="h h-r" data-drag="r"></span>${label}</div>`;
  }

  function renderFilters() {
    const owners = new Set();
    for (const t of S.doc.tasks) splitOwners(t.owner).forEach((o) => owners.add(o));
    const sorted = [...owners].sort((a, b) => a.localeCompare(b));
    const sel = $('#filter-owner');
    const cur = S.filters.owner;
    sel.innerHTML = '<option value="">All owners</option>' + sorted.map((o) => `<option${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('');
    $('#owner-list').innerHTML = sorted.map((o) => `<option value="${esc(o)}">`).join('');
    document.title = S.doc.title;
    $('#title').textContent = S.doc.title;
  }

  // ---------- sync status ----------

  function updateSync() {
    const el = $('#sync-status');
    const btn = $('#btn-save');
    const n = S.base ? L.diffCount(S.base, S.doc) : 0;
    btn.disabled = !S.dirty || S.saving;
    btn.textContent = S.saving ? 'Saving…' : n ? `Save to GitHub (${n})` : 'Save to GitHub';
    let text, cls;
    if (S.saving) { text = 'Saving…'; cls = 'busy'; }
    else if (S.dirty) { text = `${n} unsaved change${n === 1 ? '' : 's'}`; cls = 'dirty'; }
    else if (S.source === 'github') { text = 'Up to date with GitHub'; cls = 'ok'; }
    else if (S.source === 'static') { text = 'Read-only copy (GitHub API unreachable)'; cls = 'warn'; }
    else { text = 'Could not load schedule'; cls = 'warn'; }
    el.textContent = text;
    el.className = 'sync ' + cls;
    $('#btn-undo').disabled = !S.undo.length;
    $('#btn-redo').disabled = !S.redo.length;
  }

  let toastTimer;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 8000 : 4000);
  }

  // ---------- mutations / undo ----------

  function changed() {
    S.dirty = !!S.base && L.serialize(S.doc) !== L.serialize(S.base);
    saveDraft();
    render();
  }

  function mutate(fn) {
    const before = JSON.stringify(S.doc);
    fn();
    L.pruneDeps(S.doc.tasks); // safety net, e.g. after re-parenting
    const moved = L.enforceDeps(S.doc.tasks);
    if (JSON.stringify(S.doc) === before) return false;
    if (moved.length) {
      const names = moved.map((id) => S.doc.tasks.find((t) => t.id === id).name);
      toast(`Rescheduled to keep dependencies in order: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}`);
    }
    S.undo.push(before);
    if (S.undo.length > 100) S.undo.shift();
    S.redo = [];
    changed();
    return true;
  }

  function undo() {
    if (!S.undo.length) return;
    S.redo.push(JSON.stringify(S.doc));
    S.doc = JSON.parse(S.undo.pop());
    changed();
  }

  function redo() {
    if (!S.redo.length) return;
    S.undo.push(JSON.stringify(S.doc));
    S.doc = JSON.parse(S.redo.pop());
    changed();
  }

  function saveDraft() {
    if (S.dirty) store.set('draft', JSON.stringify({ doc: S.doc, base: S.base, sha: S.sha, at: Date.now() }));
    else store.set('draft', null);
  }

  function restoreDraft() {
    let draft;
    try { draft = JSON.parse(store.get('draft') || 'null'); } catch { draft = null; }
    if (!draft || !draft.doc) return;
    const doc = L.sanitize(draft.doc);
    if (L.serialize(doc) === L.serialize(S.base)) { store.set('draft', null); return; }
    const when = new Date(draft.at).toLocaleString();
    if (confirm(`You have unsaved schedule changes from ${when} on this device.\n\nRestore them? (Cancel discards them.)`)) {
      S.doc = doc;
      if (draft.base) S.base = L.sanitize(draft.base);
      if (draft.sha) S.sha = draft.sha;
      S.dirty = true;
    } else {
      store.set('draft', null);
    }
  }

  function taskIds() {
    return new Set(S.doc.tasks.map((t) => t.id));
  }

  function defaultDatesFor(parentId) {
    const sibs = parentId ? kidsOf(parentId) : kidsOf('');
    let start = today();
    const lastEnd = sibs.reduce((m, s) => {
      const r = S.info.get(s.id);
      return r && r.end != null && r.end > m ? r.end : m;
    }, -Infinity);
    if (parentId && isFinite(lastEnd)) start = lastEnd + 1;
    else if (parentId) {
      const pr = S.info.get(parentId);
      if (pr && pr.start != null) return { start: L.fromDay(pr.start), end: L.fromDay(pr.end) };
    }
    return { start: L.fromDay(start), end: L.fromDay(start + 6) };
  }

  function addTask(parentId) {
    const id = L.newId(taskIds());
    const dates = defaultDatesFor(parentId);
    mutate(() => {
      S.doc.tasks.push(L.normTask({ id, parent: parentId || null, name: 'New task', ...dates }));
      if (parentId) S.collapsed.delete(parentId);
    });
    persistCollapsed();
    openEditor(id, true);
  }

  function deleteTask(id) {
    const gone = new Set([id, ...descendants(id)]);
    S.doc.tasks = S.doc.tasks.filter((t) => !gone.has(t.id));
    for (const t of S.doc.tasks) t.deps = t.deps.filter((d) => !gone.has(d));
  }

  function duplicateTask(id) {
    const ids = taskIds();
    const map = new Map();
    const subtree = [id, ...descendants(id)];
    for (const old of subtree) { const n = L.newId(ids); ids.add(n); map.set(old, n); }
    const copies = subtree.map((old) => {
      const t = clone(S.tree.byId.get(old));
      t.id = map.get(old);
      if (old === id) t.name += ' (copy)';
      else t.parent = map.get(t.parent);
      t.deps = t.deps.map((d) => map.get(d) || d); // links inside the copy point at the copies
      return t;
    });
    const idx = S.doc.tasks.findIndex((t) => t.id === id);
    S.doc.tasks.splice(idx + 1, 0, ...copies);
    return map.get(id);
  }

  function moveSibling(id, dir) {
    const t = S.tree.byId.get(id);
    const sibs = kidsOf(t.parent || '');
    const i = sibs.indexOf(t);
    const other = sibs[i + dir];
    if (!other) return;
    const a = S.doc.tasks.indexOf(t), b = S.doc.tasks.indexOf(other);
    S.doc.tasks[a] = other;
    S.doc.tasks[b] = t;
  }

  function applyTemplate(parentId, key) {
    const tpl = TEMPLATES[key];
    if (!tpl) return;
    const kids = kidsOf(parentId);
    const pr = S.info.get(parentId);
    let d = today();
    if (kids.length && pr.end != null) d = pr.end + 1;
    else if (pr.start != null) d = pr.start;
    const ids = taskIds();
    const made = [];
    tpl.steps.forEach(([name, dur, after], i) => {
      const id = L.newId(ids);
      ids.add(id);
      const preds = (after || (i ? [i - 1] : [])).map((j) => made[j]);
      const start = preds.length ? Math.max(...preds.map((p) => p.endDay)) + 1 : d;
      S.doc.tasks.push(L.normTask({
        id, parent: parentId, name, start: L.fromDay(start), end: L.fromDay(start + dur - 1), deps: preds.map((p) => p.id),
      }));
      made.push({ id, endDay: start + dur - 1 });
    });
    S.collapsed.delete(parentId);
    persistCollapsed();
  }

  // Make each subtask wait for the one above it (keeps any links already there).
  function chainChildren(parentId) {
    const kids = kidsOf(parentId);
    for (let i = 1; i < kids.length; i++) {
      const prev = kids[i - 1].id;
      if (kids[i].deps.includes(prev)) continue;
      if (L.wouldCycle(L.graph(S.doc.tasks), prev, kids[i].id)) continue;
      kids[i].deps.push(prev);
    }
  }

  function persistCollapsed() {
    store.set('collapsed', JSON.stringify([...S.collapsed]));
  }

  // ---------- task editor ----------

  const dlg = $('#task-dialog');
  const form = $('#task-form');

  function openEditor(id, isNew) {
    const t = S.tree.byId.get(id);
    if (!t) return;
    S.editing = { id, isNew: !!isNew, deps: [...t.deps] };
    const r = S.info.get(id);
    const f = form.elements;
    const banned = new Set([id, ...descendants(id)]);

    let opts = '<option value="">— Top level —</option>';
    const walk = (pid, depth) => {
      for (const k of kidsOf(pid)) {
        if (banned.has(k.id)) continue;
        opts += `<option value="${esc(k.id)}"${k.id === t.parent ? ' selected' : ''}>${'  '.repeat(depth)}${esc(k.name || 'Untitled')}</option>`;
        walk(k.id, depth + 1);
      }
    };
    walk('', 0);
    f.parent.innerHTML = opts;

    f.name.value = t.name;
    f.owner.value = t.owner;
    f.link.value = t.link;
    f.notes.value = t.notes;
    f.milestone.checked = t.milestone;
    f.status.value = r.status;
    f.start.value = r.start != null ? L.fromDay(r.start) : '';
    f.end.value = r.end != null ? L.fromDay(r.end) : '';

    const rolled = r.hasKids;
    f.status.disabled = f.start.disabled = f.end.disabled = f.milestone.disabled = rolled;
    $('#rollup-note').hidden = !rolled;
    $('#rollup-note').textContent = rolled
      ? `Dates and status roll up from ${r.leaves} subtask${r.leaves === 1 ? '' : 's'} (${r.done} done).`
      : '';
    syncMilestoneField();

    renderDepEditor();
    const blocks = S.doc.tasks.filter((x) => x.deps.includes(id)).map((x) => x.name || 'Untitled');
    $('#dep-blocks').textContent = blocks.length ? `Blocks: ${blocks.join(', ')}` : '';
    $('#dep-blocks').hidden = !blocks.length;
    $('#btn-chain').disabled = kidsOf(id).length < 2;

    const sibs = kidsOf(t.parent || '');
    $('#btn-up').disabled = sibs[0] === t;
    $('#btn-down').disabled = sibs[sibs.length - 1] === t;
    $('#dlg-title').textContent = isNew ? 'New task' : 'Edit task';
    $('#dlg-path').textContent = pathOf(t);

    dlg.showModal();
    f.name.focus();
    if (isNew) f.name.select();
  }

  function renderDepEditor() {
    const { id, deps } = S.editing;
    $('#dep-chips').innerHTML = deps.length
      ? deps.map((d) => {
        const p = S.tree.byId.get(d);
        const pr = S.info.get(d);
        const when = pr && pr.end != null ? ` · ends ${fmt(pr.end)}` : '';
        return `<span class="chip" title="${esc(pathOf(p) + ' → ' + p.name)}">${esc(p.name || 'Untitled')}<span class="muted">${when}</span>`
          + `<button type="button" data-dep-remove="${esc(d)}" aria-label="Remove ${esc(p.name)}">×</button></span>`;
      }).join('')
      : '<span class="muted small">Nothing. This task can start any time.</span>';

    // Offer only tasks that wouldn't create a loop given the links picked so far.
    const g = L.graph(S.doc.tasks.map((x) => (x.id === id ? { ...x, deps } : x)));
    let opts = '<option value="">+ Add a task this waits for…</option>';
    const walk = (pid, depth) => {
      for (const k of kidsOf(pid)) {
        const ok = !deps.includes(k.id) && !L.wouldCycle(g, k.id, id);
        if (ok) opts += `<option value="${esc(k.id)}">${'\u00a0\u00a0'.repeat(depth)}${esc(k.name || 'Untitled')}</option>`;
        else if (k.id !== id) opts += `<option disabled>${'\u00a0\u00a0'.repeat(depth)}${esc(k.name || 'Untitled')}</option>`;
        walk(k.id, depth + 1);
      }
    };
    walk('', 0);
    $('#dep-add').innerHTML = opts;
  }

  $('#dep-add').addEventListener('change', (e) => {
    if (e.target.value) S.editing.deps.push(e.target.value);
    renderDepEditor();
  });
  $('#dep-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dep-remove]');
    if (!b) return;
    S.editing.deps = S.editing.deps.filter((d) => d !== b.dataset.depRemove);
    renderDepEditor();
  });

  function pathOf(t) {
    const parts = [];
    for (let p = S.tree.byId.get(t.parent); p; p = S.tree.byId.get(p.parent)) parts.unshift(p.name || 'Untitled');
    return parts.length ? parts.join(' → ') : 'Top level';
  }

  function syncMilestoneField() {
    const f = form.elements;
    $('#end-field').hidden = f.milestone.checked && !f.milestone.disabled;
    $('#start-label').textContent = f.milestone.checked && !f.milestone.disabled ? 'Date' : 'Start';
  }

  function applyForm() {
    const t = S.tree.byId.get(S.editing.id);
    const f = form.elements;
    t.name = f.name.value.trim() || 'Untitled';
    t.owner = f.owner.value.trim();
    t.link = f.link.value.trim();
    t.notes = f.notes.value;
    t.deps = [...S.editing.deps];
    if (!S.info.get(t.id).hasKids) {
      t.status = f.status.value;
      t.milestone = f.milestone.checked;
      let s = f.start.value, e = t.milestone ? f.start.value : f.end.value;
      if (!s) s = e;
      if (!e || e < s) e = s;
      t.start = s;
      t.end = e;
    }
    const np = f.parent.value || null;
    if (np !== t.parent) {
      t.parent = np;
      S.doc.tasks.splice(S.doc.tasks.indexOf(t), 1);
      S.doc.tasks.push(t); // last among its new siblings
    }
  }

  // Edits made in the dialog plus a follow-up action count as one undo step.
  function commitWith(action) {
    const { id } = S.editing;
    let next = null;
    mutate(() => { applyForm(); S.tree = buildTree(); S.info = computeRollups(S.tree); next = action ? action(id) : null; });
    S.editing = null;
    dlg.close();
    if (next) openEditor(next.id, next.isNew);
  }

  function cancelEdit() {
    if (S.editing && S.editing.isNew) { undo(); S.redo.pop(); updateSync(); }
    S.editing = null;
    if (dlg.open) dlg.close();
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); commitWith(null); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); cancelEdit(); });
  form.elements.milestone.addEventListener('change', syncMilestoneField);
  $('#btn-cancel').addEventListener('click', cancelEdit);
  $('#btn-up').addEventListener('click', () => commitWith((id) => { moveSibling(id, -1); return { id }; }));
  $('#btn-down').addEventListener('click', () => commitWith((id) => { moveSibling(id, 1); return { id }; }));
  $('#btn-add-sub').addEventListener('click', () => {
    commitWith((id) => {
      const nid = L.newId(taskIds());
      const dates = defaultDatesFor(id);
      S.doc.tasks.push(L.normTask({ id: nid, parent: id, name: 'New task', ...dates }));
      S.collapsed.delete(id);
      return { id: nid, isNew: false };
    });
    persistCollapsed();
  });
  $('#btn-template').addEventListener('click', () => {
    const key = $('#template-select').value;
    commitWith((id) => { applyTemplate(id, key); return null; });
    toast(`Added ${TEMPLATES[key].label} steps`);
  });
  $('#btn-chain').addEventListener('click', () => {
    commitWith((id) => { chainChildren(id); return { id }; });
  });
  $('#btn-duplicate').addEventListener('click', () => commitWith((id) => ({ id: duplicateTask(id) })));
  $('#btn-delete').addEventListener('click', () => {
    const { id, isNew } = S.editing;
    const n = descendants(id).length;
    const name = S.tree.byId.get(id).name;
    if (!isNew && !confirm(`Delete "${name}"${n ? ` and its ${n} subtask${n === 1 ? '' : 's'}` : ''}?`)) return;
    if (isNew) { cancelEdit(); return; }
    S.editing = null;
    dlg.close();
    mutate(() => deleteTask(id));
    toast(`Deleted "${name}" — Ctrl+Z to undo`);
  });

  $('#template-select').innerHTML = Object.entries(TEMPLATES)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)} (${v.steps.length} steps)</option>`).join('');

  // ---------- gantt interaction ----------

  gantt.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row && e.target.closest('.bar.parent')) { openEditor(row.dataset.id); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn || !row) return;
    const id = row.dataset.id;
    const act = btn.dataset.act;
    if (act === 'toggle') {
      if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
      persistCollapsed();
      render();
    } else if (act === 'edit') {
      openEditor(id);
    } else if (act === 'add-child') {
      addTask(id);
    }
  });

  // Drag a leaf bar to move it, or its edges to change start/end.
  gantt.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-drag]');
    if (!handle || e.button !== 0) return;
    const bar = handle.closest('.bar, .ms');
    const id = bar.closest('.row').dataset.id;
    const r = S.info.get(id);
    const mode = handle.dataset.drag;
    const ppd = ZOOMS[S.zoom].ppd;
    const x0 = e.clientX;
    const left0 = parseFloat(bar.style.left);
    const label = bar.querySelector('.bar-label');
    const label0 = label.textContent;
    let s = r.start, en = r.end, moved = false;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      const delta = Math.round(dx / ppd);
      if (mode === 'move') { s = r.start + delta; en = r.end + delta; }
      else if (mode === 'l') { s = Math.min(r.start + delta, r.end); en = r.end; }
      else { s = r.start; en = Math.max(r.end + delta, r.start); }
      if (bar.classList.contains('ms')) {
        bar.style.left = left0 + (en - r.end) * ppd + 'px';
      } else {
        bar.style.left = left0 + (s - r.start) * ppd + 'px';
        bar.style.width = (en - s + 1) * ppd + 'px';
      }
      label.textContent = s === en ? fmt(s) : `${fmt(s)} – ${fmt(en)} (${en - s + 1}d)`;
    };
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      bar.classList.remove('dragging');
      label.textContent = label0;
      if (!moved) { openEditor(id); return; }
      if (s === r.start && en === r.end) return;
      mutate(() => {
        const t = S.tree.byId.get(id);
        t.start = L.fromDay(s);
        t.end = L.fromDay(en);
      });
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  });

  function visibleTimelineWidth() {
    return Math.max(scroller.clientWidth - leftWidth(), 100);
  }

  function scrollToDay(day, frac) {
    scroller.scrollLeft = (day - S.range.min) * ZOOMS[S.zoom].ppd - visibleTimelineWidth() * frac;
  }

  function setZoom(z) {
    const centre = S.range.min + (scroller.scrollLeft + visibleTimelineWidth() / 2) / ZOOMS[S.zoom].ppd;
    S.zoom = z;
    store.set('zoom', z);
    render();
    scrollToDay(centre, 0.5);
    document.querySelectorAll('[data-zoom]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.zoom === z)));
  }

  // ---------- GitHub ----------

  function getToken() { return store.get('token') || ''; }

  function ghHeaders(token) {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  async function errorText(res) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* not json */ }
    if (res.status === 401) return 'GitHub rejected the token (expired or mistyped). Update it in Settings.';
    if (res.status === 403 && /rate limit/i.test(msg)) return 'GitHub API rate limit hit. Add a token in Settings to raise it.';
    if (res.status === 403 || res.status === 404) return `This token can't access ${CONFIG.owner}/${CONFIG.repo} (needs Contents: read & write).`;
    return `GitHub error ${res.status}${msg ? `: ${msg}` : ''}`;
  }

  async function ghGet(token) {
    const res = await fetch(`${API_URL}?ref=${encodeURIComponent(CONFIG.branch)}&t=${Date.now()}`,
      { headers: ghHeaders(token), cache: 'no-store' });
    if (!res.ok) throw new Error(await errorText(res));
    const j = await res.json();
    return { sha: j.sha, doc: L.sanitize(JSON.parse(b64decode(j.content))) };
  }

  async function loadRemote() {
    let doc, sha = null, source = 'none';
    try {
      ({ doc, sha } = await ghGet(getToken()));
      source = 'github';
    } catch (err) {
      console.warn('GitHub load failed, falling back to the deployed copy:', err);
      try {
        const res = await fetch(`${CONFIG.path}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        doc = L.sanitize(await res.json());
        source = 'static';
      } catch (err2) {
        console.error(err2);
        doc = L.sanitize({});
      }
      toast(`Couldn't reach GitHub: ${err.message}`, 'error');
    }
    S.base = doc;
    S.doc = clone(doc);
    S.sha = sha;
    S.source = source;
    S.dirty = false;
    S.lastRemoteCheck = Date.now();
  }

  async function save() {
    if (!S.dirty || S.saving) return;
    const token = getToken();
    if (!token) { openSettings('Add a GitHub token to save changes for the team.'); return; }
    S.saving = true;
    updateSync();
    try {
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await ghGet(token);
        const { doc, conflicts } = L.merge(S.base, S.doc, remote.doc);
        const n = L.diffCount(remote.doc, doc);
        if (!n) { adopt(doc, remote.sha); toast('Nothing new to save, already up to date'); return; }
        const who = (store.get('name') || '').trim();
        const message = `Update schedule (${n} change${n === 1 ? '' : 's'})${who ? ` by ${who}` : ''}`;
        const res = await fetch(API_URL, {
          method: 'PUT',
          headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, content: b64encode(L.serialize(doc)), sha: remote.sha, branch: CONFIG.branch }),
        });
        if (res.status === 409 || res.status === 422) { lastErr = await errorText(res); continue; } // someone saved in between
        if (!res.ok) throw new Error(await errorText(res));
        const j = await res.json();
        const mergedOthers = L.diffCount(S.doc, doc) > 0;
        adopt(doc, j.content.sha);
        S.lastRemoteCheck = Date.now() + REMOTE_CHECK_MS; // let GitHub's caches catch up
        if (conflicts.length) {
          toast(`Saved. ${conflicts.length} edit${conflicts.length === 1 ? '' : 's'} overlapped with a teammate's; yours were kept.`);
        } else {
          toast(mergedOthers ? "Saved and merged in teammates' changes" : 'Saved to GitHub');
        }
        return;
      }
      throw new Error(lastErr || 'Other saves kept landing at the same time. Try again.');
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'error');
    } finally {
      S.saving = false;
      updateSync();
    }
  }

  function adopt(doc, sha) {
    S.base = clone(doc);
    S.doc = clone(doc);
    S.sha = sha;
    S.source = 'github';
    S.dirty = false;
    saveDraft();
    render();
  }

  // Pick up teammates' saves when the tab regains focus or periodically.
  async function checkRemote() {
    if (S.saving || Date.now() - S.lastRemoteCheck < REMOTE_CHECK_MS || document.hidden || S.source === 'none') return;
    S.lastRemoteCheck = Date.now();
    let remote;
    try { remote = await ghGet(getToken()); } catch { return; }
    if (remote.sha === S.sha || S.saving) return;
    if (!S.dirty) {
      adopt(remote.doc, remote.sha);
      toast("Loaded teammates' latest changes");
    } else if (remote.sha !== S.notifiedSha) {
      S.notifiedSha = remote.sha;
      toast("A teammate saved changes. They'll be merged with yours when you save.");
    }
  }

  // ---------- settings ----------

  const settings = $('#settings-dialog');

  function openSettings(msg) {
    const f = $('#settings-form').elements;
    f.token.value = getToken();
    f.name.value = store.get('name') || '';
    f.title.value = S.doc.title;
    $('#settings-msg').textContent = msg || '';
    $('#settings-msg').hidden = !msg;
    settings.showModal();
  }

  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const hadToken = getToken();
    store.set('token', f.token.value.trim() || null);
    store.set('name', f.name.value.trim() || null);
    const title = f.title.value.trim();
    if (title && title !== S.doc.title) mutate(() => { S.doc.title = title; });
    settings.close();
    if (!hadToken && getToken() && S.source !== 'github' && !S.dirty) init();
  });
  $('#btn-settings-close').addEventListener('click', () => settings.close());
  $('#history-link').href = HISTORY_URL;
  $('#repo-name').textContent = `${CONFIG.owner}/${CONFIG.repo}`;
  $('#token-link').href = 'https://github.com/settings/personal-access-tokens/new';

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([L.serialize(S.doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'schedule.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const doc = L.sanitize(JSON.parse(await file.text()));
      if (!confirm(`Replace the whole schedule with ${doc.tasks.length} tasks from ${file.name}? You can still undo before saving.`)) return;
      mutate(() => { S.doc = doc; });
      settings.close();
      toast('Imported. Review it, then Save to GitHub.');
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error');
    }
  });

  // ---------- toolbar ----------

  $('#btn-add-root').addEventListener('click', () => addTask(null));
  $('#btn-save').addEventListener('click', save);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-today').addEventListener('click', () => scrollToDay(today(), 1 / 3));
  $('#btn-reload').addEventListener('click', async () => {
    if (S.dirty && !confirm('Discard your unsaved changes and load the latest from GitHub?')) return;
    store.set('draft', null);
    await loadRemote();
    S.undo = []; S.redo = [];
    render();
    toast('Loaded latest from GitHub');
  });
  $('#btn-expand').addEventListener('click', () => { S.collapsed.clear(); persistCollapsed(); render(); });
  $('#btn-collapse').addEventListener('click', () => {
    for (const t of S.doc.tasks) if (kidsOf(t.id).length) S.collapsed.add(t.id);
    persistCollapsed();
    render();
  });
  document.querySelectorAll('[data-zoom]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.zoom === S.zoom));
    b.addEventListener('click', () => setZoom(b.dataset.zoom));
  });
  $('#search').addEventListener('input', (e) => { S.filters.q = e.target.value.trim(); render(); });
  $('#filter-owner').addEventListener('change', (e) => { S.filters.owner = e.target.value; render(); });
  $('#filter-status').addEventListener('change', (e) => { S.filters.status = e.target.value; render(); });

  document.addEventListener('keydown', (e) => {
    if (dlg.open || settings.open || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('focus', checkRemote);
  document.addEventListener('visibilitychange', checkRemote);
  setInterval(checkRemote, 3 * REMOTE_CHECK_MS);
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });

  async function init() {
    $('#sync-status').textContent = 'Loading…';
    await loadRemote();
    restoreDraft();
    render();
    scrollToDay(today(), 1 / 3);
  }

  init();
})();
