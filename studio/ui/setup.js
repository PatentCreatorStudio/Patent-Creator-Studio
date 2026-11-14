// Setup: what is installed on this computer and what is still needed.
import { S, $, main, state, esc, toast, guard } from './core.js';
import { renderSidebar } from './app.js';

// One AI tool: install it, sign in, or say it is ready. Each button runs the
// maker's own installer or sign-in; nothing needs a terminal.
function aiItem(name, title, t, otherReady, how, pitch) {
  const busy = state.toolBusy === name;
  const ok = t.installed && t.loggedIn;
  const icon = ok ? '✅' : otherReady ? '◻️' : '⚠️';
  const text = !t.installed
    ? `Not installed. ${pitch}`
    : t.loggedIn
      ? `Installed (${esc(t.version || '')}) and signed in${how}.`
      : `Installed but not signed in. ${pitch}`;
  const btn = ok ? '' : `<button class="btn primary" data-tool="${name}" data-act="${t.installed ? 'login' : 'install'}" ${busy || state.toolBusy ? 'disabled' : ''}>${busy ? 'Working…' : t.installed ? 'Sign in' : 'Install'}</button>`;
  return `<div class="check-item"><div class="ci-icon">${icon}</div><div><b>${title}</b><p>${text}</p></div><div>${btn}</div></div>`;
}

async function toolAction(name, act) {
  state.toolBusy = name;
  state.setupLog = [act === 'install' ? `Installing ${name === 'claude' ? 'Claude Code' : 'Codex'}…` : 'Opening the sign-in page in your browser…'];
  renderSetup();
  const r = await guard(() => (act === 'install' ? S.installTool(name) : S.login(name)));
  state.toolBusy = null;
  state.loginCode = null;
  if (r) ((state.env = r), toast(act === 'install' ? 'Installed. Now sign in.' : 'Signed in.'));
  renderSetup();
  renderSidebar();
}

export function renderSetup() {
  const e = state.env;
  const k = state.settings?.keys || {};
  const item = (ok, title, text, action = '') =>
    `<div class="check-item"><div class="ci-icon">${ok === true ? '✅' : ok === 'opt' ? '◻️' : '⚠️'}</div><div><b>${title}</b><p>${text}</p></div><div>${action}</div></div>`;
  main.innerHTML = `<div class="page" style="max-width:860px">
    <div class="page-head"><div><h1>Setup</h1><p class="lede">Install the patent tools and one AI to start. Set up both Claude Code and Codex for the second AI review.</p></div><button class="btn" id="recheck">Check again</button></div>
    ${
      !e
        ? '<div class="card muted">Checking installed tools…</div>'
        : `<div class="card">
      ${item(
        e.patentCreator.ready,
        'Patent tools',
        e.patentCreator.ready
          ? `Ready (${esc(e.patentCreator.chunks || '?')} searchable rulebook passages). <span class="muted small">${esc(e.patentCreator.path)}</span>`
          : e.patentCreator.installed
            ? 'Installed. Select Install to prepare the rulebook search.'
            : 'Install downloads the patent tools, Python and the rulebook. Allow 5 to 45 minutes.',
        e.patentCreator.ready ? '' : `<button class="btn primary" id="install" ${state.installing ? 'disabled' : ''}>${state.installing ? 'Installing…' : 'Install'}</button>`
      )}
      ${aiItem('claude', 'Claude Code', e.claude, e.codex.loggedIn, e.claude.authMethod === 'claude.ai' ? ' with your Claude subscription' : '', 'Use your Claude subscription, or add an Anthropic API key in Settings.')}
      ${aiItem('codex', 'Codex', e.codex, e.claude.loggedIn, '', 'Use your ChatGPT subscription, or add an OpenAI API key in Settings.')}
      ${state.loginCode ? `<div class="check-item"><div class="ci-icon">🔑</div><div><b>Finish signing in to Claude</b><p>Sign in in your browser, then paste the code shown there.</p><div class="row"><input id="login-code" placeholder="Paste the code here" style="flex:1"><button class="btn primary" id="login-send">Finish sign-in</button></div></div><div></div></div>` : ''}
      ${item(k.anthropic || k.openai ? true : 'opt', 'API keys (optional)', `Anthropic key: ${k.anthropic ? 'saved' : 'none'} · OpenAI key: ${k.openai ? 'saved' : 'none'}. For pay-per-use billing, add a key in Settings.`)}
      ${item(e.graphviz.installed ? true : 'opt', 'Graphviz (optional, for drawings)', e.graphviz.installed ? 'Installed. Arranges flowcharts and block diagrams.' : 'Optional tool for arranging flowcharts. The AI can also draw figures directly.')}
      <div id="search-item"></div>
    </div>`
    }
    ${state.setupLog.length ? `<div class="log" id="setup-log">${esc(state.setupLog.slice(-400).join('\n'))}</div>` : ''}
  </div>`;
  $('#recheck').onclick = async () => {
    main.querySelector('.card').innerHTML = '<span class="muted">Checking installed tools…</span>';
    state.env = await guard(() => S.env(true));
    state.settings = await S.settings();
    renderSetup();
    renderSidebar();
  };
  main.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => toolAction(b.dataset.tool, b.dataset.act)));
  $('#login-send')?.addEventListener('click', async () => {
    const code = $('#login-code').value.trim();
    if (!code) return;
    await guard(() => S.loginCode(state.loginCode, code));
  });
  $('#install')?.addEventListener('click', async () => {
    state.installing = true;
    state.setupLog = ['Starting…'];
    renderSetup();
    const r = await guard(() => S.install());
    state.installing = false;
    if (r) ((state.env = r), toast('The patent tools are installed.'));
    renderSetup();
  });
  if (e?.patentCreator.ready) {
    const box = $('#search-item');
    box.innerHTML = item('opt', 'Patent search', 'Checking…');
    S.searchStatus()
      .then((st) => {
        box.innerHTML = item(
          st.ready ? true : false,
          'Patent search',
          st.ready
            ? `On${st.google?.ready ? ` (Google Patents, ${esc(st.google.searches_left ?? '?')} searches left this month on ${esc(st.google.plan || '')})` : ' (BigQuery)'}.`
            : 'Off. To assess whether filing is worth pursuing, add a <a href="https://serpapi.com/users/sign_up">SerpApi search key</a> in Settings.'
        );
      })
      .catch((err) => (box.innerHTML = item(false, 'Patent search', esc(err.message))));
  }
}
S.on('setup:line', (l) => {
  state.setupLog.push(l);
  const el = $('#setup-log');
  if (el) {
    el.textContent = state.setupLog.slice(-400).join('\n');
    el.scrollTop = el.scrollHeight;
  } else if (state.view === 'setup') renderSetup();
});
S.on('setup:login', ({ name, needsCode }) => {
  state.loginCode = needsCode ? name : null;
  if (state.view === 'setup') renderSetup();
});
