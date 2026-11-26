import { marked } from '../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../node_modules/dompurify/dist/purify.es.mjs';

export const S = window.studio;
export const $ = (sel, root = document) => root.querySelector(sel);
export const main = $('#main');

export const state = {
  view: 'welcome',
  projectId: null,
  project: null,
  tab: 'steps',
  phaseId: null,
  phases: [],
  settings: null,
  env: null,
  feeds: {}, // `${projectId}:${phaseId}` -> events
  file: null,
  setupLog: [],
  installing: false,
  law: { q: '', results: null, busy: false },
};

// ---- helpers ---------------------------------------------------------------

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function md(text) {
  return DOMPurify.sanitize(marked.parse(String(text || ''), { gfm: true }));
}
export function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), bad ? 6000 : 2600);
}
export async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
    return undefined;
  }
}
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
export function fmtDate(d) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
export function addMonths(iso, m) {
  const d = new Date(iso + 'T12:00:00');
  d.setMonth(d.getMonth() + m);
  return d;
}
export function daysUntil(d) {
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}
export const levelClass = { review: 'good', nogo: '', blocked: 'warn', working: 'idle', early: 'idle' };


// Like guard, but answers the question "did it work?" so a caller can never
// announce success after a failure.
export async function attempt(fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

export function engineFamily(engine) {
  return engine?.startsWith('claude') ? 'claude' : 'codex';
}
export const familyName = (fam) => (fam === 'claude' ? 'Claude' : 'Codex');

export function engineAvailable(id, e = state.env, k = state.settings?.keys || {}) {
  if (!e) return true;
  if (id === 'claude-sub') return e.claude.installed && e.claude.loggedIn;
  if (id === 'claude-key') return e.claude.installed && k.anthropic;
  if (id === 'codex-sub') return e.codex.installed && e.codex.loggedIn;
  if (id === 'codex-key') return e.codex.installed && k.openai;
  return false;
}

export function aiAvailable(name, e = state.env, k = state.settings?.keys || {}) {
  return !!e && (engineAvailable(`${name}-sub`, e, k) || engineAvailable(`${name}-key`, e, k));
}

export function updateNotice() {
  const update = state.update;
  if (!update?.newer) return '';
  const progress = state.updateProgress;
  const busy = progress && progress.stage !== 'error';
  const label = progress?.stage === 'installing' ? 'Installing…'
    : busy ? `Downloading… ${progress.percent ?? 0}%` : 'Update and restart';
  return `Version ${esc(progress?.version || update.version)} is available.
    <button class="btn sm" data-install-update ${busy ? 'disabled' : ''}>${label}</button>
    ${progress?.reason ? `<span role="status">${esc(progress.reason)} <a href="${esc(update.url)}">Download it</a></span>` : ''}`;
}

function refreshUpdateNotices() {
  document.querySelectorAll('#update-notice, [data-update-notice]').forEach((notice) => {
    notice.innerHTML = updateNotice();
  });
}

S.onUpdateProgress((progress) => {
  state.updateProgress = progress;
  refreshUpdateNotices();
});

document.addEventListener('click', async (e) => {
  if (!e.target.closest?.('[data-install-update]')) return;
  if (state.updateProgress && state.updateProgress.stage !== 'error') return;
  state.updateProgress = { stage: 'downloading', percent: 0 };
  refreshUpdateNotices();
  try {
    const result = await S.installUpdate();
    if (!result.installed) state.updateProgress = { stage: 'error', reason: result.reason };
  } catch (err) {
    state.updateProgress = { stage: 'error', reason: err.message || 'The update could not be started.' };
  }
  refreshUpdateNotices();
});

// Web links open in the person's browser; nothing else navigates.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || a.id === 'open-folder' || a.dataset.ext) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (/^https?:\/\//i.test(href)) S.openExternal(href);
});
