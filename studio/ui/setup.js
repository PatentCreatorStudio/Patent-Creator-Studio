// Setup: what is installed on this computer and what is still needed.
import { S, $, main, state, esc, toast, guard, aiAvailable, updateNotice } from './core.js';
import { renderSidebar } from './app.js';

// One AI tool: install it, sign in, or say it is ready. Each button runs the
// maker's own installer or sign-in; nothing needs a terminal.
function aiItem(name, title, t, keySaved, otherReady, how, pitch) {
  const busy = state.toolBusy === name;
  const ok = t.installed && (t.loggedIn || keySaved);
  const icon = ok ? '✅' : otherReady ? '◻️' : '⚠️';
  const text = !t.installed
    ? `Not installed. ${pitch}`
    : t.loggedIn
      ? `Installed (${esc(t.version || '')}) and signed in${how}.`
      : keySaved
        ? `Installed (${esc(t.version || '')}). Runs on your saved API key.`
        : `Installed. Sign in to use it. ${pitch}`;
  const btn = ok ? '' : `<button class="btn primary" data-tool="${name}" data-act="${t.installed ? 'login' : 'install'}" ${busy || state.toolBusy ? 'disabled' : ''}>${busy ? 'Working…' : t.installed ? 'Sign in' : 'Install'}</button>`;
  const cancel = busy && state.toolAction === 'login' ? `<button class="btn" data-cancel-login="${name}" ${state.loginCancelling ? 'disabled' : ''}>Cancel</button>` : '';
  return `<div class="check-item"><div class="ci-icon">${icon}</div><div><b>${title}</b><p>${text}</p></div><div class="row">${btn}${cancel}</div></div>`;
}

async function toolAction(name, act) {
  state.toolBusy = name;
  state.toolAction = act;
  state.loginCancelling = false;
  state.setupLog = [act === 'install' ? `Installing ${name === 'claude' ? 'Claude Code' : 'Codex'}…` : 'Opening the sign-in page in your browser…'];
  renderSetup();
  const r = await guard(() => (act === 'install' ? S.installTool(name) : S.login(name)));
  state.toolBusy = null;
  state.toolAction = null;
  state.loginCancelling = false;
  state.loginCode = null;
  if (r?.cancelled) {
    state.setupLog.push('Sign-in cancelled.');
    toast('Sign-in cancelled.');
  } else if (r) ((state.env = r), toast(act === 'install' ? (aiAvailable(name, r) ? 'Installed and ready.' : 'Installed. Now sign in.') : 'Signed in.'));
  renderSetup();
  renderSidebar();
}

// The patent tools: install, update an older copy, or say they are ready.
function toolsItem(t, item) {
  const busy = state.installing;
  const button = (label, busyLabel) =>
    `<button class="btn primary" id="install" ${busy ? 'disabled' : ''}>${busy ? busyLabel : label}</button>`;
  if (t.outdated) {
    return t.canUpdate
      ? item(
          false,
          'Patent tools',
          `Out of date: ${t.version ? `version ${esc(t.version)} is installed` : 'the installed version cannot be read'} and this app needs ${esc(t.neededVersion)}. Update installs the new version and keeps the rulebook. It takes a few minutes, longer when it must replace an old Python and download graphics card support again.`,
          button('Update', 'Updating…')
        )
      : item(
          false,
          'Patent tools',
          `A development copy at version ${esc(t.version || 'unknown')} is linked here; this app needs ${esc(t.neededVersion)}. Update the source folder, then select Check again. <span class="muted small">${esc(t.path)}</span>`
        );
  }
  if (t.ready) {
    return item(
      true,
      'Patent tools',
      `Ready, version ${esc(t.version || '?')} (${esc(t.chunks || '?')} searchable rulebook passages). <span class="muted small">${esc(t.path)}</span>`
    );
  }
  return item(
    false,
    'Patent tools',
    t.installed ? 'Installed. Select Install to prepare the rulebook search.' : 'Install downloads the patent tools, Python and the rulebook. Allow 5 to 45 minutes.',
    button('Install', 'Installing…')
  );
}

export function renderSetup() {
  const e = state.env;
  const k = state.settings?.keys || {};
  const item = (ok, title, text, action = '') =>
    `<div class="check-item"><div class="ci-icon">${ok === true ? '✅' : ok === 'opt' ? '◻️' : '⚠️'}</div><div><b>${title}</b><p>${text}</p></div><div>${action}</div></div>`;
  main.innerHTML = `<div class="page" style="max-width:860px">
    <div class="page-head"><div><h1>Setup</h1><p class="lede">Install the patent tools and one AI to start. Set up both Claude Code and Codex for the second AI review.</p></div><button class="btn" id="recheck">Check again</button></div>
    ${state.update?.error ? `<p class="small">${esc(state.update.error)}</p>` : ''}
    ${state.update?.newer ? `<p class="small">${updateNotice()}</p>` : ''}
    ${
      !e
        ? '<div class="card muted">Checking installed tools…</div>'
        : `<div class="card">
      ${toolsItem(e.patentCreator, item)}
      ${aiItem('claude', 'Claude Code', e.claude, k.anthropic, aiAvailable('codex'), e.claude.authMethod === 'claude.ai' ? ' with your Claude subscription' : '', 'Needs a Claude Pro plan or higher, or an Anthropic API key in Settings.')}
      ${aiItem('codex', 'Codex', e.codex, k.openai, aiAvailable('claude'), '', 'Needs a ChatGPT plan that includes Codex, or an OpenAI API key in Settings.')}
      ${state.loginCode ? `<div class="check-item"><div class="ci-icon">🔑</div><div><b>Finish signing in to Claude</b><p>Sign in in your browser, then paste the code shown there.</p><div class="row"><input id="login-code" placeholder="Paste the code here" style="flex:1"><button class="btn primary" id="login-send" ${state.loginCancelling ? 'disabled' : ''}>Finish sign-in</button><button class="btn" data-cancel-login="${state.loginCode}" ${state.loginCancelling ? 'disabled' : ''}>Cancel</button></div></div><div></div></div>` : ''}
      ${item(k.anthropic || k.openai ? true : 'opt', 'API keys (optional)', `Anthropic key: ${k.anthropic ? 'saved' : 'none'} · OpenAI key: ${k.openai ? 'saved' : 'none'}. For pay-per-use billing, add a key in Settings.`)}
      ${item(e.graphviz.installed ? true : 'opt', 'Graphviz (optional, for drawings)', e.graphviz.installed ? 'Installed. Arranges flowcharts and block diagrams.' : 'Optional tool for arranging flowcharts. The AI can also draw figures directly.')}
      <div id="search-item"></div>
    </div>`
    }
    ${state.setupLog.length ? `<div class="log" id="setup-log">${esc(state.setupLog.slice(-400).join('\n'))}</div>` : ''}
  </div>`;
  $('#recheck').onclick = async () => {
    main.querySelector('.card').innerHTML = '<span class="muted">Checking installed tools…</span>';
    [state.env, state.update] = await Promise.all([guard(() => S.env(true)), S.checkUpdates(true)]);
    state.settings = await S.settings();
    renderSetup();
    renderSidebar();
  };
  main.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => toolAction(b.dataset.tool, b.dataset.act)));
  main.querySelectorAll('[data-cancel-login]').forEach((b) => (b.onclick = async () => {
    state.loginCancelling = true;
    renderSetup();
    await guard(() => S.cancelLogin(b.dataset.cancelLogin));
  }));
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
    if (r) ((state.env = r), toast(r.patentCreator?.outdated ? 'The patent tools are still out of date. Read the setup log.' : 'The patent tools are ready.'));
    renderSetup();
  });
  if (e?.patentCreator.ready && !e.patentCreator.outdated) {
    const box = $('#search-item');
    box.innerHTML = item('opt', 'Patent search', 'Checking…');
    S.searchStatus()
      .then((st) => {
        const sources = (st.sources || []).map((name) => name === 'Google Patents' ? `Google Patents (${st.google.searches_left ?? '?'} searches left)` : name).join(', ');
        box.innerHTML = item(
          st.ready ? true : false,
          'Patent search',
          (sources ? `On: ${esc(sources)}. ` : '') + (st.ready ? '' : `Patent search is off (${esc(st.reasons.join('; '))}). Add a Google Patents (SerpApi) key or free EPO keys in Settings to search patents.`)
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
