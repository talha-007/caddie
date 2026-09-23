/**
 * The usage dashboard, as one self-contained page.
 *
 * Served by the server rather than built by Vite on purpose: it has to be
 * reachable wherever the server runs, with no second thing to deploy and no
 * CORS between it and the data. Nothing is loaded from a CDN, so it works on a
 * box with no outbound internet.
 *
 * The client script uses string concatenation rather than template literals
 * because the whole page is itself a template literal - nesting them is a
 * escaping trap that bites whoever edits this next.
 */

const STYLE = `
:root {
  --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #e6e9ef;
  --dim: #8b93a5; --accent: #6ea8fe; --warn: #f0b429; --bad: #e5484d; --good: #46a758;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
header {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
  padding: 18px 24px; border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 5;
}
h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .01em; }
.sub { color: var(--dim); font-size: 12px; }
.spacer { flex: 1; }
main { padding: 24px; max-width: 1180px; }
section { margin-bottom: 30px; }
h2 {
  font-size: 12px; text-transform: uppercase; letter-spacing: .09em;
  color: var(--dim); margin: 0 0 10px; font-weight: 600;
}
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.card .label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
.card .value { font-size: 23px; font-weight: 600; margin-top: 6px; font-variant-numeric: tabular-nums; }
.card .note { color: var(--dim); font-size: 11px; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
th { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
tr:last-child td { border-bottom: none; }
tbody tr.clickable { cursor: pointer; }
tbody tr.clickable:hover { background: #1d212a; }
td.num, th.num { text-align: right; }
.bar { height: 6px; background: #22262f; border-radius: 3px; overflow: hidden; min-width: 60px; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.days { display: flex; gap: 6px; align-items: flex-end; height: 110px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.day { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; height: 100%; }
.day > i { display: block; width: 100%; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
.day > span { font-size: 10px; color: var(--dim); white-space: nowrap; }
button, select {
  background: #212633; color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 11px; font: inherit; font-size: 13px; cursor: pointer;
}
button:hover, select:hover { border-color: #38405280; }
.pill { font-size: 11px; padding: 2px 7px; border-radius: 99px; border: 1px solid var(--line); color: var(--dim); }
.pill.bad { color: var(--bad); border-color: #e5484d55; }
.note-box { background: #1a1d24; border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 6px; padding: 11px 14px; color: var(--dim); font-size: 12px; }
.note-box strong { color: var(--text); font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
dialog {
  background: var(--panel); color: var(--text); border: 1px solid var(--line);
  border-radius: 10px; padding: 0; width: min(720px, 92vw); max-height: 84vh;
}
dialog::backdrop { background: #000a; }
.dhead { display: flex; gap: 12px; align-items: baseline; padding: 15px 18px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
.dbody { padding: 16px 18px; overflow: auto; max-height: 64vh; }
.turn { margin-bottom: 13px; }
.turn .who { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
.turn .what { white-space: pre-wrap; margin-top: 3px; }
.turn.assistant .what { color: #bcd4ff; }
.empty { color: var(--dim); padding: 20px 0; }
`;

const SCRIPT = `
var TOKEN = document.body.dataset.token;
var days = 7;
var report = null;

function money(n) {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(5);
  return '$' + n.toFixed(2);
}
function pct(n) { return (n * 100).toFixed(1) + '%'; }
function num(n) { return Math.round(n).toLocaleString('en-GB'); }
function when(ms) { return new Date(ms).toLocaleString('en-GB'); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function api(path) {
  return fetch(path, { headers: { 'x-admin-token': TOKEN } }).then(function (res) {
    if (!res.ok) throw new Error('Request failed with ' + res.status);
    return res.json();
  });
}

function load() {
  document.getElementById('generated').textContent = 'loading...';
  api('/api/admin/usage?days=' + days)
    .then(function (data) { report = data; render(); })
    .catch(function (err) {
      document.getElementById('generated').textContent = String(err.message || err);
    });
}

function render() {
  var t = report.totals;
  document.getElementById('generated').textContent =
    'as at ' + when(report.generatedAt) + ' - last ' + report.windowDays + ' days';

  card('total', money(t.costUsd), num(t.turns) + ' chat turns');
  card('per1k', money(t.costPerThousandConversations), 'per 1,000 conversations');
  card('convos', num(t.conversations), 'distinct sessions');
  card('cache', pct(t.cacheHitRate), 'of input tokens cached');
  card('saved', money(Math.max(t.costWithoutCacheUsd - t.costUsd, 0)), 'saved by prompt caching');
  card('declined', num(t.declined), 'messages turned away');

  renderKinds();
  renderModels();
  renderDays();
  renderSessions();
  renderWarnings();
}

function card(id, value, note) {
  var el = document.getElementById(id);
  if (!el) return;
  el.querySelector('.value').textContent = value;
  el.querySelector('.note').textContent = note;
}

function renderKinds() {
  var rows = report.byKind.map(function (k) {
    var label = { chat: 'Chat loop', guard: 'Screening', transcribe: 'Voice' }[k.kind] || k.kind;
    return '<tr><td>' + esc(label) + '</td>' +
      '<td class="num">' + num(k.calls) + '</td>' +
      '<td class="num">' + money(k.costUsd) + '</td>' +
      '<td style="width:34%"><div class="bar"><i style="width:' + (k.share * 100).toFixed(1) + '%"></i></div></td>' +
      '<td class="num">' + pct(k.share) + '</td></tr>';
  }).join('');
  document.querySelector('#kinds tbody').innerHTML = rows || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>';
}

function renderModels() {
  var rows = report.byModel.map(function (m) {
    return '<tr><td class="mono">' + esc(m.model) + (m.priced ? '' : ' <span class="pill bad">no rate</span>') + '</td>' +
      '<td class="num">' + num(m.calls) + '</td>' +
      '<td class="num">' + num(m.promptTokens) + '</td>' +
      '<td class="num">' + pct(m.cacheHitRate) + '</td>' +
      '<td class="num">' + num(m.completionTokens) + '</td>' +
      '<td class="num">' + money(m.costUsd) + '</td></tr>';
  }).join('');
  document.querySelector('#models tbody').innerHTML = rows || '<tr><td colspan="6" class="empty">Nothing yet.</td></tr>';
}

function renderDays() {
  var box = document.getElementById('days');
  if (!report.byDay.length) { box.innerHTML = '<div class="empty">Nothing yet.</div>'; return; }
  var peak = Math.max.apply(null, report.byDay.map(function (d) { return d.costUsd; })) || 1;
  box.innerHTML = report.byDay.map(function (d) {
    var height = Math.max((d.costUsd / peak) * 100, 2);
    var title = d.day + ' - ' + money(d.costUsd) + ', ' + d.conversations + ' conversations, ' + d.turns + ' turns';
    return '<div class="day" title="' + esc(title) + '">' +
      '<i style="height:' + height.toFixed(1) + '%"></i>' +
      '<span>' + d.day.slice(5) + '</span></div>';
  }).join('');
}

function renderSessions() {
  var rows = report.sessions.map(function (s) {
    return '<tr class="clickable" data-session="' + esc(s.sessionId) + '">' +
      '<td class="mono">' + esc(s.sessionId.slice(0, 8)) + '</td>' +
      '<td class="mono">' + esc(s.client || '-') + '</td>' +
      '<td class="num">' + num(s.turns) + '</td>' +
      '<td class="num">' + num(s.promptTokens + s.completionTokens) + '</td>' +
      '<td class="num">' + (s.voiceSeconds ? Math.round(s.voiceSeconds) + 's' : '-') + '</td>' +
      '<td class="num">' + (s.declined ? '<span class="pill bad">' + s.declined + '</span>' : '-') + '</td>' +
      '<td class="num">' + money(s.costUsd) + '</td>' +
      '<td>' + when(s.lastAt) + '</td></tr>';
  }).join('');
  document.querySelector('#sessions tbody').innerHTML =
    rows || '<tr><td colspan="8" class="empty">No conversations in this window.</td></tr>';
}

function renderWarnings() {
  var box = document.getElementById('warnings');
  var bits = [];
  if (report.unpricedModels.length) {
    bits.push('<strong>' + esc(report.unpricedModels.join(', ')) + '</strong> has no rate in the price table, ' +
      'so its spend reads as zero here. Add it to <span class="mono">src/usage/pricing.ts</span>.');
  }
  bits.push('Costs are worked out from a price table we maintain by hand, not from OpenAI\\'s billing. ' +
    'Treat them as close, not exact.');
  bits.push('Voice minutes are estimated from audio size - the transcribe models do not return a duration.');
  bits.push('Conversations are kept for 7 days, then expire.');
  box.innerHTML = bits.map(function (b) { return '<div class="note-box">' + b + '</div>'; }).join('');
}

document.addEventListener('click', function (event) {
  var row = event.target.closest('tr.clickable');
  if (!row) return;
  openTranscript(row.dataset.session);
});

function openTranscript(sessionId) {
  var dialog = document.getElementById('convo');
  document.getElementById('convo-id').textContent = sessionId;
  document.getElementById('convo-body').innerHTML = '<div class="empty">Loading...</div>';
  dialog.showModal();

  api('/api/admin/usage/' + encodeURIComponent(sessionId)).then(function (data) {
    var head = data.session
      ? '<div class="sub" style="margin-bottom:14px">' + num(data.session.turns) + ' turns - ' +
        money(data.session.costUsd) + ' - ' + num(data.session.promptTokens + data.session.completionTokens) +
        ' tokens</div>'
      : '';
    var lines = data.transcript.map(function (line) {
      return '<div class="turn ' + line.role + '"><div class="who">' + line.role + ' - ' +
        when(line.at) + '</div><div class="what">' + esc(line.text) + '</div></div>';
    }).join('');
    document.getElementById('convo-body').innerHTML =
      head + (lines || '<div class="empty">No messages stored for this session.</div>');
  }).catch(function (err) {
    document.getElementById('convo-body').innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
  });
}

document.getElementById('window').addEventListener('change', function (event) {
  days = Number(event.target.value);
  load();
});
document.getElementById('refresh').addEventListener('click', load);
document.getElementById('convo-close').addEventListener('click', function () {
  document.getElementById('convo').close();
});

load();
`;

export function renderAdminPage(token: string): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Caddie usage</title>
<style>${STYLE}</style>
</head>
<body data-token="${token.replace(/"/g, '&quot;')}">
<header>
  <h1>Caddie usage</h1>
  <span class="sub" id="generated">loading...</span>
  <span class="spacer"></span>
  <select id="window" aria-label="Time window">
    <option value="1">Last 24 hours</option>
    <option value="7" selected>Last 7 days</option>
  </select>
  <button id="refresh">Refresh</button>
</header>

<main>
  <section>
    <h2>Spend</h2>
    <div class="cards">
      <div class="card" id="total"><div class="label">Total cost</div><div class="value">-</div><div class="note"></div></div>
      <div class="card" id="per1k"><div class="label">Per 1,000</div><div class="value">-</div><div class="note"></div></div>
      <div class="card" id="convos"><div class="label">Conversations</div><div class="value">-</div><div class="note"></div></div>
      <div class="card" id="cache"><div class="label">Cache hit rate</div><div class="value">-</div><div class="note"></div></div>
      <div class="card" id="saved"><div class="label">Saved by cache</div><div class="value">-</div><div class="note"></div></div>
      <div class="card" id="declined"><div class="label">Declined</div><div class="value">-</div><div class="note"></div></div>
    </div>
  </section>

  <section>
    <h2>Cost per day (UTC)</h2>
    <div class="days" id="days"></div>
  </section>

  <section>
    <h2>Where the money goes</h2>
    <table id="kinds">
      <thead><tr><th>Call</th><th class="num">Calls</th><th class="num">Cost</th><th></th><th class="num">Share</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section>
    <h2>By model</h2>
    <table id="models">
      <thead><tr><th>Model</th><th class="num">Calls</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th><th class="num">Cost</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section>
    <h2>Who is using it</h2>
    <table id="sessions">
      <thead><tr><th>Session</th><th>Client</th><th class="num">Turns</th><th class="num">Tokens</th><th class="num">Voice</th><th class="num">Declined</th><th class="num">Cost</th><th>Last seen</th></tr></thead>
      <tbody></tbody>
    </table>
    <p class="sub" style="margin-top:8px">A row is one conversation. Select it to read what was said. Client is a salted hash of the address, not the address.</p>
  </section>

  <section>
    <h2>Worth knowing</h2>
    <div id="warnings" style="display:grid; gap:8px"></div>
  </section>
</main>

<dialog id="convo">
  <div class="dhead">
    <strong>Conversation</strong>
    <span class="sub mono" id="convo-id"></span>
    <span class="spacer"></span>
    <button id="convo-close">Close</button>
  </div>
  <div class="dbody" id="convo-body"></div>
</dialog>

<script>${SCRIPT}</script>
</body>
</html>`;
}
