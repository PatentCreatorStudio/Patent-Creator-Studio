// The steps tab: the list of steps, the panel for the chosen step, and the
// live feed of what the AI is doing. What each step's status is, and whether
// it may run, comes from the app (project.steps); nothing is worked out here.
import { S, $, state, esc, md, toast, guard, ago, engineFamily, engineAvailable, familyName } from './core.js';
import { renderProject, showProject } from './project.js';

const WORDS = {
  todo: 'Not run yet',
  running: 'Working…',
  done: 'Finished',
  'no-go': 'Not worth filing',
  blocked: 'Blocked: read the summary',
  stale: 'Run again',
  'needs-input': 'Needs your answers',
  error: 'Did not finish',
};
const NUM_CLASS = { todo: 'idle', running: 'running', done: 'done', 'no-go': 'nogo', blocked: 'attention', stale: 'attention', 'needs-input': 'attention', error: 'error' };
const PILL_CLASS = { done: 'good', 'no-go': '', blocked: 'warn', stale: 'warn', 'needs-input': 'warn', error: 'bad', running: '' };

export function renderSteps(body) {
  const p = state.project;
  body.innerHTML = `<div class="steps">
    <div class="step-list">
      ${state.phases
        .map((ph) => {
          const s = p.steps[ph.id];
          return `<button class="step ${ph.id === state.phaseId ? 'active' : ''} ${s.locked ? 'locked' : ''}" data-id="${ph.id}">
            <span class="num ${NUM_CLASS[s.status]}">${s.status === 'done' ? '✓' : ph.n}</span>
            <span><div class="s-title">${esc(ph.title)}</div><div class="s-sub">${esc(s.locked && s.status === 'todo' ? s.locked : WORDS[s.status])}</div></span>
          </button>`;
        })
        .join('')}
    </div>
    <div id="phase-panel"></div>
  </div>`;
  body.querySelectorAll('.step').forEach((b) => (b.onclick = () => ((state.phaseId = b.dataset.id), renderSteps(body))));
  renderPhasePanel($('#phase-panel'));
}

// One AI writes the whole draft (step 4 picks it) and the other attacks it.
function engineAllowed(p, ph, id) {
  if (!p.writer) return true;
  if (ph.role === 'review') return engineFamily(id) !== p.writer;
  if (ph.writes === 'draft') return engineFamily(id) === p.writer;
  return true;
}

function pickEngine(p, ph) {
  const s = state.settings;
  const wanted = [state.engineChoice?.[ph.id], ph.role === 'review' ? s.reviewEngine : s.draftEngine, ...Object.keys(s.engines)].filter(Boolean);
  return wanted.find((id) => engineAllowed(p, ph, id) && engineAvailable(id)) || wanted.find((id) => engineAllowed(p, ph, id));
}

function renderPhasePanel(el) {
  const p = state.project;
  const ph = state.phases.find((x) => x.id === state.phaseId);
  const step = p.steps[ph.id];
  const info = p.phases?.[ph.id] || {};
  const last = info.runs?.[info.runs.length - 1];
  const busy = !!p.busy;
  const mine = p.running === ph.id;
  const engines = state.settings.engines;
  const chosen = pickEngine(p, ph);
  const feedKey = `${p.id}:${ph.id}`;
  const qFile = `questions/${ph.id}.md`;
  const hasQuestions = p.files.some((f) => f.path === qFile);
  const needsInput = step.status === 'needs-input';
  const other = p.writer === 'claude' ? 'codex' : 'claude';

  const rule =
    ph.id === 'claims' && !p.writer
      ? 'This choice applies to steps 4 to 7. The other AI reviews the draft in step 8, so no AI checks its own work.'
      : ph.writes === 'draft' && p.writer
        ? `${familyName(p.writer)} writes steps 4 to 7.`
        : ph.role === 'review' && p.writer
          ? `${familyName(p.writer)} wrote the draft. ${familyName(other)} reviews it.`
          : '';
  const optionNote = (id) => (!engineAllowed(p, ph, id) ? (ph.role === 'review' ? ' - wrote the draft' : ' - not the drafting AI') : !engineAvailable(id) ? ' - not set up' : '');

  el.innerHTML = `<div class="card phase-panel">
    <div class="ph-head">
      <div style="flex:1">
        <div class="row"><span class="pill ${PILL_CLASS[step.status] ?? 'idle'}">${WORDS[step.status]}</span><span class="muted small">${esc(ph.time)}</span></div>
        <h2 style="margin-top:8px">${ph.n}. ${esc(ph.title)}</h2>
        <p>${esc(ph.plain)}</p>
        ${rule ? `<p class="small muted">${esc(rule)}</p>` : ''}
      </div>
    </div>
    ${step.status === 'stale' && !step.locked ? `<div class="summary-box attention"><b>Run this step again.</b> ${esc(step.note)}</div>` : ''}
    ${
      step.locked
        ? `<div class="summary-box attention">${esc(step.locked)}${p.readiness.level === 'nogo' ? ' See the decision report for the evidence.' : ''}</div>`
        : `<div class="controls">
      <select id="engine" ${busy ? 'disabled' : ''}>
        ${Object.entries(engines)
          .map(([id, d]) => `<option value="${id}" ${id === chosen ? 'selected' : ''} ${engineAllowed(p, ph, id) && engineAvailable(id) ? '' : 'disabled'}>${esc(d.label)}${optionNote(id)}</option>`)
          .join('')}
      </select>
      ${
        mine
          ? p.busy.stage === 'checks-after'
            ? '<button class="btn" disabled>Finishing checks…</button>'
            : '<button class="btn danger" id="stop">Stop</button>'
          : `<button class="btn primary" id="run" ${busy ? 'disabled' : ''}>${step.status === 'todo' ? 'Run this step' : 'Run again'}</button>`
      }
      ${busy && !mine ? `<span class="muted small">${p.running ? 'Another step is running for this invention.' : "The app's checks are running."}</span>` : ''}
    </div>`
    }
    ${last ? lastRunBox(last) : ''}
    ${
      needsInput
        ? `<div class="card" style="margin-top:14px">
            <h3>Needs your answers</h3>
            <div class="doc" id="questions">${hasQuestions ? '' : '<p class="muted">Read the questions in the summary above.</p>'}</div>
            <textarea id="reply" placeholder="Answer in your own words. One line per question is fine."></textarea>
            <div class="row" style="margin-top:8px"><button class="btn primary" id="send-reply" ${busy ? 'disabled' : ''}>Send answers and continue</button></div>
          </div>`
        : ''
    }
    <div class="outputs">
      ${ph.outputs
        .map((o) => {
          const have = p.files.some((f) => f.path === o);
          return `<button class="file-chip ${have ? '' : 'missing'}" data-file="${esc(o)}" ${have ? '' : 'disabled'} title="${have ? 'Open' : 'Not written yet'}">${esc(o)}</button>`;
        })
        .join('')}
    </div>
    <div class="feed" id="feed"></div>
  </div>`;

  const sel = $('#engine', el);
  if (sel) sel.onchange = () => (state.engineChoice = { ...(state.engineChoice || {}), [ph.id]: sel.value });
  $('#run', el)?.addEventListener('click', () => startRun(ph.id, sel.value));
  $('#stop', el)?.addEventListener('click', () => guard(() => S.stop(p.id)));
  $('#send-reply', el)?.addEventListener('click', () => {
    const reply = $('#reply', el).value.trim();
    if (!reply) return toast('Write your answers first.', true);
    startRun(ph.id, sel?.value, reply);
  });
  if (needsInput && hasQuestions) {
    S.readFile(p.id, qFile).then((t) => {
      const q = $('#questions', el);
      if (q && state.project?.id === p.id && state.phaseId === ph.id) q.innerHTML = md(t);
    });
  }
  el.querySelectorAll('.file-chip:not(.missing)').forEach((b) => (b.onclick = () => ((state.tab = 'files'), (state.file = b.dataset.file), renderProject())));

  const feed = $('#feed', el);
  const events = state.feeds[feedKey];
  if (events) events.forEach((ev) => appendEv(feed, ev));
  else if (last?.log) {
    S.runLog(p.id, last.log).then((evs) => {
      state.feeds[feedKey] ||= evs;
      if (feed.isConnected) state.feeds[feedKey].forEach((ev) => appendEv(feed, ev));
    });
  }
}

function lastRunBox(last) {
  const cls = last.status === 'error' ? 'error' : ['needs-input', 'blocked'].includes(last.status) ? 'attention' : '';
  const label =
    {
      done: 'Finished',
      'done-unconfirmed': 'Files created; completion unconfirmed',
      'needs-input': 'Needs your answers',
      'no-go': 'Not worth filing',
      blocked: 'Blocked: read the summary',
      error: 'Did not finish',
    }[last.status] || last.status;
  const meta = [state.settings.engines[last.engine]?.label, last.ms ? (last.ms < 60000 ? 'under a minute' : `${Math.round(last.ms / 60000)} min`) : null, ago(last.endedAt)].filter(Boolean).join(' · ');
  return `<div class="summary-box ${cls}"><b>${esc(label)}</b>${last.reason ? `: ${esc(last.reason)}` : ''}<div class="muted small">${esc(meta)}</div>${last.summary ? `\n${esc(last.summary)}` : ''}</div>`;
}

const kindLabel = { text: 'AI', tool: 'tool', toolResult: 'result', session: 'started', final: 'finished', error: 'problem', warn: 'note', gate: 'app check', files: 'files', think: 'plan', log: 'log' };

function appendEv(feed, ev) {
  if (!feed) return;
  let v = '';
  if (ev.kind === 'session') v = `Session ${ev.sessionId || ''}${ev.model ? ` · ${ev.model}` : ''}${ev.apiKeySource && ev.apiKeySource !== 'none' ? ' · API key' : ''}`;
  else if (ev.kind === 'tool') v = `${ev.name}  ${ev.input || ''}`;
  else if (ev.kind === 'final') v = ev.ok ? 'AI run finished.' : `AI run failed (${ev.subtype || 'error'}). Read the run details.`;
  else v = ev.text || '';
  if (!v) return;
  const d = document.createElement('div');
  d.className = `ev ${ev.kind}`;
  d.innerHTML = `<div class="k">${esc(kindLabel[ev.kind] || ev.kind)}</div><div class="v">${esc(v)}</div>`;
  const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
  feed.appendChild(d);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

async function startRun(phaseId, engine, reply) {
  const id = state.project.id;
  state.feeds[`${id}:${phaseId}`] = [];
  const r = await guard(() => S.run(id, phaseId, { engine, reply }));
  if (r && state.projectId === id) toast(`Started on ${state.settings.engines[r.engine].label}`);
  showProject(await guard(() => S.project(id)));
}

S.on('run:event', ({ projectId, phaseId, ev }) => {
  const key = `${projectId}:${phaseId}`;
  (state.feeds[key] ||= []).push(ev);
  if (state.view === 'project' && state.projectId === projectId && state.phaseId === phaseId && state.tab === 'steps') appendEv($('#feed'), ev);
});
S.on('run:end', ({ projectId, record }) => {
  if (projectId !== state.projectId || state.view !== 'project') return;
  toast(record.status === 'error' ? 'The step did not finish. Read its summary.' : record.status === 'needs-input' ? 'Needs your answers.' : 'Step finished.', record.status === 'error');
});
