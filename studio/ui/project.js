// One invention's page: the readiness banner, the deadline clocks and the tabs.
import { S, $, main, state, esc, guard, fmtDate, addMonths, daysUntil } from './core.js';
import { renderSidebar } from './app.js';
import { intakeModal } from './intake.js';
import { renderSteps } from './steps.js';
import { renderFiles, renderChecks, renderLaw } from './tabs.js';

// Every answer that comes back from the app names its invention. It is shown
// only if that invention is still the one on screen, so a slow reply for one
// invention can never replace another's page.
export function showProject(np, { keepFeedScroll = false } = {}) {
  if (!np || np.id !== state.projectId) return false;
  state.project = np;
  if (state.view !== 'project') return true;
  const scroll = keepFeedScroll ? $('#feed')?.scrollTop : null;
  renderProject();
  if (scroll != null && $('#feed')) $('#feed').scrollTop = scroll;
  return true;
}

// The files can change outside the app (Finder, an editor). Whenever the
// person comes back to the window or changes tabs, the page is rebuilt from
// the files as they are now, so a green mark never outlives what it vouched for.
export async function refreshProject() {
  const id = state.projectId;
  if (state.view !== 'project' || !id || document.querySelector('#reply')?.value || document.querySelector('.modal')) return;
  const np = await S.project(id).catch(() => null);
  if (np && JSON.stringify([np.steps, np.readiness, np.files, np.busy, np.fixing]) !== JSON.stringify([state.project?.steps, state.project?.readiness, state.project?.files, state.project?.busy, state.project?.fixing])) showProject(np, { keepFeedScroll: true });
}
window.addEventListener('focus', refreshProject);

export function renderProject() {
  const p = state.project;
  const r = p.readiness;
  const icon = { review: '✓', nogo: '■', blocked: '!', working: '…', early: '·' }[r.level] || '·';
  main.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1>${esc(p.title)}</h1>
        <p class="muted small">Folder: <a href="#" id="open-folder">${esc(p.folder)}</a></p>
      </div>
      <div class="row"><button class="btn" id="edit-intake">Edit your answers</button></div>
    </div>
    <div class="banner ${r.level}">
      <div class="b-icon">${icon}</div>
      <div>
        <div class="b-label">${esc(r.label)}</div>
        <div>${esc(r.detail)}</div>
        ${r.missing?.length ? `<ul>${r.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        ${p.fixing ? `<div class="row"><span class="muted">${esc(p.fixing)}</span><button class="btn" id="fix-stop">Stop</button></div>` : r.fixRound && !p.busy ? '<div class="row"><button class="btn primary" id="fix-round">Fix and review again</button><span class="muted small">Runs steps 6, 7 and 8 again until the review passes, up to 3 rounds. About 25 minutes a round.</span></div>' : ''}
      </div>
    </div>
    ${clocks(p)}
    <div class="tabs" role="tablist">
      ${[
        ['steps', 'Steps'],
        ['files', 'Files'],
        ['checks', 'Checks'],
        ['law', 'Search patent rules'],
      ]
        .map(([id, l]) => `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${l}</button>`)
        .join('')}
    </div>
    <div id="tab-body"></div>
  </div>`;
  $('#open-folder').onclick = (e) => {
    e.preventDefault();
    S.openFolder(p.id);
  };
  $('#edit-intake').onclick = () => intakeModal(p);
  const fixBtn = $('#fix-round');
  if (fixBtn) fixBtn.onclick = () => guard(() => S.fixRound(p.id)).then(refreshProject);
  const fixStop = $('#fix-stop');
  if (fixStop) fixStop.onclick = () => guard(() => S.stop(p.id)).then(refreshProject);
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => ((state.tab = t.dataset.tab), renderProject(), refreshProject())));
  document.querySelectorAll('[data-date]').forEach((inp) => {
    inp.onchange = async () => {
      const np = await guard(() => S.setDates(p.id, { [inp.dataset.date]: inp.value || null }));
      showProject(np);
    };
  });
  const body = $('#tab-body');
  if (state.tab === 'steps') renderSteps(body);
  else if (state.tab === 'files') renderFiles(body);
  else if (state.tab === 'checks') renderChecks(body);
  else renderLaw(body);
}

function clocks(p) {
  const d = p.dates || {};
  const items = [];
  if (d.firstDisclosure) {
    const end = addMonths(d.firstDisclosure, 12);
    const left = daysUntil(end);
    items.push(`<div class="c ${left < 60 ? 'urgent' : ''}">One year after your first public disclosure: <b>${fmtDate(end)}</b> (${left >= 0 ? `${left} days left` : 'passed'}). Most other countries allow no grace period. Confirm your deadline with a registered patent practitioner.</div>`);
  }
  if (d.provisionalFiled) {
    const end = addMonths(d.provisionalFiled, 12);
    const left = daysUntil(end);
    items.push(`<div class="c ${left < 90 ? 'urgent' : ''}">12-month deadline to claim the provisional filing date: <b>${fmtDate(end)}</b> (${left >= 0 ? `${left} days left` : 'passed'}). If this date has passed, contact a registered patent practitioner now.</div>`);
  }
  return `<div class="clock">
    ${items.join('')}
    <div class="c">First public disclosure: <input type="date" data-date="firstDisclosure" value="${esc(d.firstDisclosure || '')}"></div>
    <div class="c">Provisional filed on: <input type="date" data-date="provisionalFiled" value="${esc(d.provisionalFiled || '')}"></div>
  </div>`;
}
