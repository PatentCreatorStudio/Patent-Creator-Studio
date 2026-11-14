// The three reference tabs beside the steps: the files, the app's own check
// results, and the rulebook search.
import { S, $, state, esc, md, toast, guard, ago } from './core.js';
import { showProject } from './project.js';

export function renderFiles(body) {
  const p = state.project;
  const files = p.files;
  if (!state.file && files.length) state.file = files.find((f) => f.path.endsWith('.md'))?.path || files[0].path;
  body.innerHTML = `<div class="files">
    <div class="file-tree">${files.map((f) => `<button class="${f.path === state.file ? 'active' : ''}" data-f="${esc(f.path)}" title="${esc(f.path)}">${esc(f.path)}</button>`).join('') || '<span class="muted">No files yet.</span>'}</div>
    <div class="viewer card"><div id="viewer-body" class="muted">Select a file.</div></div>
  </div>`;
  body.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => ((state.file = b.dataset.f), renderFiles(body))));
  if (!state.file) return;
  const vb = $('#viewer-body');
  const head = `<div class="row" style="margin-bottom:12px"><b class="small" style="font-family:var(--mono)">${esc(state.file)}</b><span class="spacer"></span><button class="btn sm" id="reveal">Open in its app</button></div>`;
  const ext = state.file.split('.').pop().toLowerCase();
  if (['svg', 'png', 'jpg', 'jpeg', 'gif'].includes(ext)) {
    S.fileData(p.id, state.file).then((u) => {
      if (!vb.isConnected) return;
      vb.className = '';
      vb.innerHTML = head + `<img src="${esc(u)}" style="max-width:100%;background:#fff;border-radius:6px" alt="${esc(state.file)}">`;
      $('#reveal').onclick = () => S.openFile(p.id, state.file).catch(() => S.openFolder(p.id, state.file));
    });
    return;
  }
  if (['pdf', 'docx', 'zip'].includes(ext)) {
    vb.className = '';
    vb.innerHTML = head + '<p class="muted">This file opens in its own app.</p>';
    $('#reveal').onclick = () => guard(() => S.openFile(p.id, state.file));
    return;
  }
  S.readFile(p.id, state.file).then((t) => {
    if (!vb.isConnected) return;
    vb.className = '';
    vb.innerHTML = head + (ext === 'md' ? `<div class="doc">${md(t)}</div>` : `<div class="raw">${esc(ext === 'json' ? pretty(t) : t)}</div>`);
    $('#reveal').onclick = () => guard(() => S.openFile(p.id, state.file));
  });
}
function pretty(t) {
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}

// ---- checks ---------------------------------------------------------------

export function renderChecks(body) {
  const p = state.project;
  const g = p.gates?.draft;
  const pkg = p.gates?.package;
  const s = g?.summary;
  const issuesOf = (r) => (r?.issues || []).slice(0, 60);
  body.innerHTML = `<div class="stack">
    <p class="lede">Results from the last automated checks. The claim reference check looks for terms used before they are introduced. After editing files, run the checks again.</p>
    <div class="row"><button class="btn" id="rerun" ${p.busy || !p.steps.claims.ok ? 'disabled' : ''}>Run draft checks</button><button class="btn" id="rerun-pkg" ${p.busy || !p.files.some((f) => f.path.startsWith('08-package/')) ? 'disabled' : ''}>Check package</button><button class="btn" id="srch">Check patent search</button></div>
    ${
      g
        ? `<div class="check-grid">
        ${metric(s.claimCount ?? '–', 'claims read')}
        ${metric(s.claimsCritical ?? '–', 'critical claim problems')}
        ${metric(s.specCritical ?? '–', 'critical description problems')}
        ${metric(s.formalitiesCritical ?? '–', 'critical format problems')}
        ${metric(s.antecedentRan ? 'Yes' : 'No', 'claim references checked')}
        ${metric(ago(g.ranAt), 'last run')}
      </div>
      ${s.skipped?.length ? `<div class="summary-box attention"><b>Checks that did not run:</b>\n${s.skipped.map((k) => `• ${esc(k.check)}: ${esc(k.reason)}`).join('\n')}</div>` : ''}
      ${issueCard('Claims', g.checks.claims)}
      ${issueCard('Description', g.checks.specification)}
      ${issueCard('Format', g.checks.formalities)}`
        : '<div class="card muted">Draft checks run in step 6. You can also run them here once claims exist.</div>'
    }
    ${
      pkg
        ? `<div class="card"><h3>Package check</h3><p>${esc(pkg.result?.summary || '')}</p><p class="muted small">${ago(pkg.ranAt)}</p>${issueList(pkg.result)}</div>`
        : ''
    }
    <div id="search-box"></div>
  </div>`;
  function metric(v, l) {
    return `<div class="metric"><div class="m-val">${esc(v)}</div><div class="m-lbl">${esc(l)}</div></div>`;
  }
  function issueCard(title, r) {
    if (!r) return '';
    if (r.error) return `<div class="card"><h3>${title}</h3><p class="muted">Check failed: ${esc(r.error)}. Run the check again.</p></div>`;
    return `<div class="card"><h3>${title}</h3><p>${esc(r.summary || '')}</p>${issueList(r)}</div>`;
  }
  function issueList(r) {
    const items = issuesOf(r);
    if (!items.length) return '';
    return `<ul class="issues">${items
      .map((i) => `<li><span class="sev ${esc(i.severity)}">${esc(i.severity)}</span>${i.claim_number != null ? `Claim ${esc(i.claim_number)}: ` : ''}${esc(i.description || i.message || i.issue || JSON.stringify(i))}${i.confidence ? ` <span class="muted small">(${esc(i.confidence)} confidence)</span>` : ''}</li>`)
      .join('')}</ul>${r.issues.length > 60 ? `<p class="muted small">…and ${r.issues.length - 60} more in 06-verify/gates.json</p>` : ''}`;
  }
  $('#rerun').onclick = async () => {
    toast('Running the checks…');
    showProject(await guard(() => S.draftGates(p.id)));
  };
  $('#rerun-pkg').onclick = async () => {
    toast('Checking the package…');
    showProject(await guard(() => S.packageGate(p.id)));
  };
  $('#srch').onclick = async () => {
    $('#search-box').innerHTML = '<div class="card muted">Checking…</div>';
    const st = await guard(() => S.searchStatus());
    if (st) $('#search-box').innerHTML = `<div class="card"><h3>Patent search</h3><p>${st.ready ? 'On.' : 'Not set up. Add a search key in Settings.'}</p><div class="raw small">${esc(JSON.stringify({ google: st.google, bigquery: st.bigquery }, null, 2))}</div></div>`;
  };
}

// ---- law lookup -------------------------------------------------------------

export function renderLaw(body) {
  const L = state.law;
  body.innerHTML = `<div class="stack">
    <p class="lede">Search patent rules on your computer. Results are excerpts from laws, regulations and the patent examiner’s manual, with sources.</p>
    <div class="row"><input type="text" id="law-q" value="${esc(L.q)}" placeholder="How long can the abstract be?" style="flex:1"><button class="btn primary" id="law-go" ${L.busy ? 'disabled' : ''}>${L.busy ? 'Searching…' : 'Search'}</button></div>
    <div class="card" id="law-res">${L.results ? lawResults(L.results) : '<span class="muted">Try: "Do my claims have to be numbered?" or "What is a provisional application?"</span>'}</div>
  </div>`;
  const run = async () => {
    L.q = $('#law-q').value.trim();
    if (!L.q) return;
    L.busy = true;
    renderLaw(body);
    L.results = (await guard(() => S.lawSearch(L.q))) || [];
    L.busy = false;
    renderLaw(body);
  };
  $('#law-go').onclick = run;
  $('#law-q').onkeydown = (e) => e.key === 'Enter' && run();
}
function lawResults(rs) {
  const list = Array.isArray(rs) ? rs : [rs];
  if (!list.length) return '<span class="muted">No matches. Try different words.</span>';
  return list
    .map((r) => {
      const src = [r.source, r.section || r.mpep_section, r.file || r.pdf, r.page != null ? `p. ${r.page}` : null].filter(Boolean).join(' · ');
      return `<div class="law-result"><div class="src">${esc(src || 'Source')}</div><p>${esc((r.text || r.content || JSON.stringify(r)).slice(0, 1400))}</p></div>`;
    })
    .join('');
}
