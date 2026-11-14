// The frame around every screen: the sidebar, moving between screens, and
// starting up. Each screen lives in its own file.
import { S, $, main, state, esc, guard, ago, levelClass } from './core.js';
import { renderProject, showProject } from './project.js';
import { intakeModal } from './intake.js';
import { renderSetup } from './setup.js';
import { renderSettings } from './settings.js';
import { renderHelp } from './help.js';
import './steps.js';

export async function renderSidebar() {
  const list = await guard(() => S.projects());
  const nav = $('#project-list');
  if (!list?.length) {
    nav.innerHTML = '<div class="empty-side">No inventions yet.</div>';
  } else {
    nav.innerHTML = list
      .map(
        (p) => `<button class="proj ${p.id === state.projectId && state.view === 'project' ? 'active' : ''}" data-id="${p.id}">
        <span class="proj-title">${esc(p.title)}</span>
        <span class="row"><span class="pill ${levelClass[p.readiness.level] ?? 'idle'}">${p.running ? 'Working…' : esc(p.readiness.label)}</span><span class="muted small">${ago(p.updatedAt)}</span></span>
      </button>`
      )
      .join('');
  }
  nav.querySelectorAll('.proj').forEach((b) => (b.onclick = () => openProject(b.dataset.id)));
  document.querySelectorAll('.navlink').forEach((b) => b.classList.toggle('active', state.view === b.dataset.view));
  const e = state.env;
  if (e) $('#setup-dot').className = 'dot ' + (toolsReady(e) ? 'good' : 'warn');
}

const toolsReady = (e) => e.patentCreator.ready && ((e.claude.installed && e.claude.loggedIn) || (e.codex.installed && e.codex.loggedIn));

document.querySelectorAll('.navlink').forEach((b) => (b.onclick = () => go(b.dataset.view)));
$('#new-btn').onclick = () => intakeModal();

export function go(view) {
  state.view = view;
  if (view !== 'project') state.projectId = null;
  render();
}

export async function openProject(id) {
  state.view = 'project';
  state.projectId = id;
  state.file = null;
  state.project = null;
  const p = await guard(() => S.project(id));
  if (!p || state.projectId !== id) return;
  state.project = p;
  state.phaseId = p.next; // the first step whose result is not standing
  render();
}

export function render() {
  renderSidebar();
  if (state.view === 'project') return state.project ? renderProject() : (main.innerHTML = '<div class="page muted">Opening…</div>');
  if (state.view === 'setup') return renderSetup();
  if (state.view === 'settings') return renderSettings();
  if (state.view === 'help') return renderHelp();
  renderWelcome();
}

function renderWelcome() {
  const e = state.env;
  const ready = e && toolsReady(e);
  main.innerHTML = `<div class="welcome">
    <h1>Develop your patent draft</h1>
    <p class="lede">Use Claude Code or Codex to research your idea and prepare a draft for professional review. If the idea isn't worth filing, it tells you so plainly.</p>
    <ol class="howto">
      <li><div><b>Describe your idea.</b> Add notes, drawings or code.</div></li>
      <li><div><b>Search for similar inventions</b> in patents, papers, products and public code.</div></li>
      <li><div><b>Assess whether filing is worth pursuing.</b> If so, draft the claims, description and drawings.</div></li>
      <li><div><b>Check the draft.</b> Run automated checks and a second AI review.</div></li>
      <li><div><b>Prepare files for professional review.</b> Include the findings and open questions.</div></li>
    </ol>
    <div class="row">
      ${ready ? '<button class="btn primary" id="w-new">New invention</button>' : '<button class="btn primary" id="w-setup">Set up (about an hour, mostly waiting)</button>'}
      <button class="btn" id="w-help">Costs and legal help</button>
    </div>
  </div>`;
  $('#w-new')?.addEventListener('click', () => intakeModal());
  $('#w-setup')?.addEventListener('click', () => go('setup'));
  $('#w-help').onclick = () => go('help');
}

S.on('project:changed', (p) => {
  showProject(p, { keepFeedScroll: true });
  renderSidebar();
});

(async function boot() {
  state.phases = await S.phases();
  state.settings = await S.settings();
  render();
  state.env = await guard(() => S.env());
  render();
  const list = await guard(() => S.projects());
  if (list?.length && state.view === 'welcome') openProject(list[0].id);
})();
