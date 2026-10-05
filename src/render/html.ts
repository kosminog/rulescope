import type { Report } from '../model.js';

/**
 * Self-contained HTML report. The report JSON is embedded and rendered by a
 * small inline script, so the file has no runtime dependencies and opens
 * offline. All file content is inserted as text, never as markup.
 */
export function renderHtml(report: Report): string {
  // Every "<" becomes a JSON unicode escape so the payload can never close the
  // script element or open an HTML comment, whatever a rule file contains.
  const json = JSON.stringify(report).replace(/</g, '\\u003c');
  const title = `rulescope · ${escapeHtml(report.cwd)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${CSS}
</style>
</head>
<body>
<header class="top">
  <div class="brand">rulescope</div>
  <div class="meta" id="meta"></div>
  <input id="search" type="search" placeholder="Filter by path, name or text…" aria-label="Filter entries">
</header>
<nav class="tabs" id="tabs" role="tablist"></nav>
<main class="layout">
  <section class="tree" id="tree" aria-live="polite"></section>
  <aside class="detail" id="detail"><div class="empty">Select an entry to see why it is or is not loaded, its frontmatter and its content.</div></aside>
</main>
<footer class="foot" id="foot"></footer>
<script id="data" type="application/json">${json}</script>
<script>
${JS}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
:root {
  --bg: #fafaf9; --panel: #ffffff; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb;
  --active: #15803d; --active-bg: #dcfce7;
  --conditional: #a16207; --conditional-bg: #fef9c3;
  --on-demand: #0e7490; --on-demand-bg: #cffafe;
  --manual: #1d4ed8; --manual-bg: #dbeafe;
  --trust-gated: #7e22ce; --trust-gated-bg: #f3e8ff;
  --truncated: #b91c1c; --truncated-bg: #fee2e2;
  --shadowed: #57534e; --shadowed-bg: #e7e5e4;
  --inactive: #57534e; --inactive-bg: #e7e5e4;
  --unknown: #a16207; --unknown-bg: #fef3c7;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0c0a09; --panel: #1c1917; --text: #fafaf9; --muted: #a8a29e; --line: #292524; --accent: #60a5fa;
    --active: #86efac; --active-bg: #14532d;
    --conditional: #fde047; --conditional-bg: #713f12;
    --on-demand: #67e8f9; --on-demand-bg: #164e63;
    --manual: #93c5fd; --manual-bg: #1e3a8a;
    --trust-gated: #d8b4fe; --trust-gated-bg: #581c87;
    --truncated: #fca5a5; --truncated-bg: #7f1d1d;
    --shadowed: #d6d3d1; --shadowed-bg: #44403c;
    --inactive: #d6d3d1; --inactive-bg: #44403c;
    --unknown: #fde68a; --unknown-bg: #78350f;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; }
.brand { font-weight: 700; letter-spacing: 0.02em; }
.meta { color: var(--muted); font-family: var(--mono); font-size: 12px; flex: 1 1 320px; overflow-wrap: anywhere; }
#search { flex: 1 1 240px; max-width: 420px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
.tabs { display: flex; gap: 4px; padding: 10px 16px 0; border-bottom: 1px solid var(--line); overflow-x: auto; background: var(--panel); }
.tab { border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; padding: 8px 14px; background: none; color: var(--muted); cursor: pointer; font: inherit; white-space: nowrap; }
.tab[aria-selected="true"] { background: var(--bg); color: var(--text); border-color: var(--line); font-weight: 600; }
.tab .count { color: var(--muted); font-size: 12px; margin-left: 6px; }
.layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); min-height: calc(100vh - 120px); }
.tree { padding: 16px; border-right: 1px solid var(--line); overflow: auto; }
.detail { padding: 16px; overflow: auto; position: sticky; top: 100px; max-height: calc(100vh - 100px); }
@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
  .tree { border-right: none; border-bottom: 1px solid var(--line); }
  .detail { position: static; max-height: none; }
}
.summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
.notes { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.notes p { margin: 4px 0; }
.notes .blind { color: var(--muted); }
details.scope { margin: 0 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
details.scope > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; list-style: none; display: flex; gap: 8px; align-items: baseline; }
details.scope > summary::-webkit-details-marker { display: none; }
details.scope > summary::before { content: "▸"; color: var(--muted); font-size: 12px; }
details.scope[open] > summary::before { content: "▾"; }
details.scope > summary .dir { color: var(--muted); font-weight: 400; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.entries { padding: 0 8px 8px; }
.entry { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; padding: 7px 8px; border-radius: 6px; cursor: pointer; align-items: start; }
.entry:hover, .entry[aria-selected="true"] { background: var(--bg); }
.entry[aria-selected="true"] { outline: 1px solid var(--accent); }
.entry .path { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.entry .name { font-weight: 600; margin-right: 6px; }
.entry .why { grid-column: 2; color: var(--muted); font-size: 12.5px; }
.entry .tags { grid-column: 2; display: flex; gap: 4px; flex-wrap: wrap; }
.children { margin-left: 18px; border-left: 1px dashed var(--line); padding-left: 6px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.badge.kind { background: var(--bg); color: var(--muted); border: 1px solid var(--line); font-weight: 500; }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
.s-active { background: var(--active-bg); color: var(--active); }
.s-conditional { background: var(--conditional-bg); color: var(--conditional); }
.s-on-demand { background: var(--on-demand-bg); color: var(--on-demand); }
.s-manual { background: var(--manual-bg); color: var(--manual); }
.s-trust-gated { background: var(--trust-gated-bg); color: var(--trust-gated); }
.s-truncated { background: var(--truncated-bg); color: var(--truncated); }
.s-shadowed { background: var(--shadowed-bg); color: var(--shadowed); }
.s-inactive { background: var(--inactive-bg); color: var(--inactive); }
.s-unknown { background: var(--unknown-bg); color: var(--unknown); }
.detail h2 { margin: 0 0 6px; font-size: 15px; font-family: var(--mono); overflow-wrap: anywhere; }
.detail .row { margin: 6px 0; }
.detail .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.detail pre { margin: 6px 0 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font: 12px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 60vh; overflow: auto; }
.detail a { color: var(--accent); }
.empty { color: var(--muted); }
.overlap { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.overlap th, .overlap td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.overlap td.path { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.foot { padding: 12px 16px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
.hidden { display: none !important; }
`;

const JS = `
(function () {
  var report = JSON.parse(document.getElementById('data').textContent);
  var LABELS = { active: 'active', conditional: 'conditional', 'on-demand': 'on demand', manual: 'manual', inactive: 'inactive', shadowed: 'shadowed', truncated: 'truncated', 'trust-gated': 'trust gated', unknown: 'unverified' };
  var ORDER = ['active', 'conditional', 'on-demand', 'manual', 'trust-gated', 'truncated', 'shadowed', 'inactive', 'unknown'];
  var state = { tab: report.tools.length ? report.tools[0].tool : 'overlap', query: '', selected: null };
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  };
  var badge = function (status) { return el('span', { class: 'badge s-' + status, text: LABELS[status] || status }); };

  function allEntries(tool) {
    var out = [];
    var visit = function (entries) { entries.forEach(function (e) { out.push(e); if (e.children) visit(e.children); }); };
    tool.scopes.forEach(function (s) { visit(s.entries); });
    return out;
  }
  function matches(e, q) {
    if (!q) return true;
    var hay = [e.displayPath, e.path, e.name || '', e.description || '', e.reason || '', e.content || ''].join('\\n').toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function subtreeMatches(e, q) {
    if (matches(e, q)) return true;
    return (e.children || []).some(function (c) { return subtreeMatches(c, q); });
  }

  function renderMeta() {
    var parts = [report.cwd];
    if (report.gitRoot) parts.push('git root ' + report.gitRoot);
    if (report.targetFile) parts.push('target ' + report.targetFile);
    $('meta').textContent = parts.join('  ·  ');
    $('foot').textContent = 'Generated ' + new Date(report.generatedAt).toLocaleString() + ' · discovery rules as of ' + report.rulesVersion + ' · home ' + report.home;
  }

  function renderTabs() {
    var tabs = $('tabs');
    tabs.textContent = '';
    report.tools.forEach(function (t) {
      var n = allEntries(t).filter(function (e) { return e.status === 'active'; }).length;
      tabs.appendChild(el('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === t.tool), onclick: function () { state.tab = t.tool; render(); } }, [t.label, el('span', { class: 'count', text: n + ' active' })]));
    });
    tabs.appendChild(el('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === 'overlap'), onclick: function () { state.tab = 'overlap'; render(); } }, ['Overlap', el('span', { class: 'count', text: String(report.overlap.length) })]));
  }

  function entryNode(e, q) {
    var visible = subtreeMatches(e, q);
    var node = el('div', { class: 'entry' + (visible ? '' : ' hidden'), role: 'button', tabindex: '0', 'aria-selected': String(state.selected === e.id), onclick: function () { select(e); }, onkeydown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(e); } } });
    node.appendChild(badge(e.status));
    var line = el('div', { class: 'path' });
    if (e.name && (e.kind === 'skill' || e.kind === 'agent' || e.kind === 'command')) line.appendChild(el('span', { class: 'name', text: e.name }));
    line.appendChild(el('span', { class: 'badge kind', text: e.kind }));
    line.appendChild(document.createTextNode(' ' + e.displayPath + (e.bytes !== undefined ? '  ' + fmtBytes(e.bytes) : '')));
    node.appendChild(line);
    node.appendChild(el('div', { class: 'why', text: e.reason }));
    if (e.tags && e.tags.length) node.appendChild(el('div', { class: 'tags' }, e.tags.map(function (t) { return el('span', { class: 'tag', text: '#' + t }); })));
    var wrap = el('div', {}, [node]);
    if (e.children && e.children.length) wrap.appendChild(el('div', { class: 'children' }, e.children.map(function (c) { return entryNode(c, q); })));
    return wrap;
  }

  function renderTool(tool) {
    var tree = $('tree');
    var q = state.query;
    var counts = {};
    allEntries(tool).forEach(function (e) { counts[e.status] = (counts[e.status] || 0) + 1; });
    tree.appendChild(el('div', { class: 'summary' }, ORDER.filter(function (s) { return counts[s]; }).map(function (s) { return el('span', { class: 'badge s-' + s, text: counts[s] + ' ' + LABELS[s] }); })));
    if (tool.notes.length || tool.blindSpots.length) {
      tree.appendChild(el('div', { class: 'notes' }, tool.notes.map(function (n) { return el('p', { text: '! ' + n }); }).concat(tool.blindSpots.map(function (b) { return el('p', { class: 'blind', text: '? ' + b }); }))));
    }
    tool.scopes.forEach(function (scope) {
      var any = scope.entries.some(function (e) { return subtreeMatches(e, q); });
      var details = el('details', { class: 'scope' + (any || !q ? '' : ' hidden'), open: '' }, [
        el('summary', {}, [scope.label, el('span', { class: 'dir', text: scope.displayDir })]),
        el('div', { class: 'entries' }, scope.entries.length ? scope.entries.map(function (e) { return entryNode(e, q); }) : [el('div', { class: 'empty', text: 'nothing found' })]),
      ]);
      tree.appendChild(details);
    });
  }

  function renderOverlap() {
    var tree = $('tree');
    tree.appendChild(el('p', { class: 'empty', text: 'Files that more than one tool reads. A single directory can shape what several agents see.' }));
    if (!report.overlap.length) { tree.appendChild(el('p', { class: 'empty', text: 'No overlapping files found.' })); return; }
    var table = el('table', { class: 'overlap' }, [el('thead', {}, [el('tr', {}, [el('th', { text: 'File' }), el('th', { text: 'Tools' })])])]);
    var body = el('tbody');
    report.overlap.forEach(function (row) {
      if (state.query && row.displayPath.toLowerCase().indexOf(state.query) === -1) return;
      body.appendChild(el('tr', {}, [el('td', { class: 'path', text: row.displayPath }), el('td', {}, row.tools.map(function (t) { return el('span', { style: 'margin-right:8px' }, [t.tool + ' ', badge(t.status)]); }))]));
    });
    table.appendChild(body);
    tree.appendChild(table);
  }

  function select(e) {
    state.selected = e.id;
    var d = $('detail');
    d.textContent = '';
    d.appendChild(el('h2', { text: e.displayPath }));
    d.appendChild(el('div', { class: 'row' }, [badge(e.status), ' ', el('span', { class: 'badge kind', text: e.kind }), ' ', el('span', { class: 'badge kind', text: e.tool })]));
    d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Why' }), el('div', { text: e.reason })]));
    if (e.name) d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Name' }), el('div', { text: e.name })]));
    if (e.description) d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Description' }), el('div', { text: e.description })]));
    if (e.globs && e.globs.length) d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Globs' }), el('div', { text: e.globs.join(', ') })]));
    d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Path' }), el('div', { style: 'font-family:var(--mono);font-size:12px;overflow-wrap:anywhere', text: e.path + (e.bytes !== undefined ? '  (' + fmtBytes(e.bytes) + ')' : '') })]));
    if (e.docUrl) d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Rule source' }), el('a', { href: e.docUrl, target: '_blank', rel: 'noopener', text: e.docUrl })]));
    if (e.frontmatter) d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Frontmatter' }), el('pre', { text: JSON.stringify(e.frontmatter, null, 2) })]));
    if (e.content !== undefined) d.appendChild(el('div', { class: 'row' }, [el('div', { class: 'label', text: 'Content' }), el('pre', { text: e.content || '(empty)' })]));
    document.querySelectorAll('.entry').forEach(function (n) { n.setAttribute('aria-selected', 'false'); });
    var nodes = document.querySelectorAll('.entry');
    for (var i = 0; i < nodes.length; i++) { /* selection highlight re-applied on next render */ }
    render(true);
  }

  function render(keepDetail) {
    var tree = $('tree');
    tree.textContent = '';
    renderTabs();
    if (state.tab === 'overlap') renderOverlap();
    else {
      var tool = report.tools.filter(function (t) { return t.tool === state.tab; })[0];
      if (tool) renderTool(tool);
    }
    if (!keepDetail && state.selected === null) { /* leave hint */ }
  }

  function fmtBytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }

  $('search').addEventListener('input', function (ev) { state.query = ev.target.value.trim().toLowerCase(); render(true); });
  renderMeta();
  render();
})();
`;
