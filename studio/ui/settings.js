// Settings: which AI writes, which attacks, keys, and where inventions live.
import { S, $, main, state, esc, toast, guard, attempt, engineFamily, engineAvailable } from './core.js';
import { renderSidebar } from './app.js';

export function renderSettings() {
  const s = state.settings;
  const engines = s.engines;
  const opt = (field) =>
    `<div class="engines">${Object.entries(engines)
      .map(([id, d]) => `<button class="engine-opt ${s[field] === id ? 'sel' : ''}" data-field="${field}" data-id="${id}" ${engineAvailable(id) ? '' : 'title="Not set up yet"'}><div class="eo-t">${esc(d.label)}</div><div class="eo-s">${engineAvailable(id) ? 'Ready' : 'Not set up yet'}</div></button>`)
      .join('')}</div>`;
  main.innerHTML = `<div class="page" style="max-width:860px">
    <h1>Settings</h1>
    <div class="stack" style="margin-top:16px">
      <div class="card stack">
        <h2>Drafting AI</h2>
        <p class="muted" style="margin:0">Use your Claude Code or Codex sign-in. Runs count toward your subscription limits. API use is billed separately.</p>
        ${opt('draftEngine')}
        <h2 style="margin-top:10px">Second AI reviewer</h2>
        <p class="muted" style="margin:0">Choose Codex for a Claude draft, or Claude for a Codex draft. The AI chosen in step 4 writes steps 4 to 7.</p>
        ${opt('reviewEngine')}
        <div class="grid2">
          <label class="field">Claude model (optional)<span class="hint">Blank uses your Claude Code default.</span><input type="text" id="s-cm" value="${esc(s.claudeModel)}" placeholder="opus"></label>
          <label class="field">Codex model (optional)<span class="hint">Blank uses your Codex default.</span><input type="text" id="s-xm" value="${esc(s.codexModel)}" placeholder=""></label>
        </div>
        <label class="field">Codex thinking effort<select id="s-xe">${['medium', 'high', 'xhigh'].map((o) => `<option ${s.codexEffort === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      </div>
      <div class="card stack">
        <h2>API keys</h2>
        <p class="muted" style="margin:0">An API key connects to your paid AI account. Keys are encrypted using your computer's keychain${s.keys.encryptionAvailable ? '' : ' (unavailable here; use a subscription)'}.</p>
        <label class="field">Anthropic API key ${s.keys.anthropic ? '<span class="pill good">saved</span>' : ''}<input type="password" id="k-anth" placeholder="${s.keys.anthropic ? 'Saved. Paste a new one to replace it.' : 'sk-ant-…'}"></label>
        <label class="field">OpenAI API key ${s.keys.openai ? '<span class="pill good">saved</span>' : ''}<input type="password" id="k-oai" placeholder="${s.keys.openai ? 'Saved. Paste a new one to replace it.' : 'sk-…'}"></label>
        <div class="row"><button class="btn" id="save-keys">Save keys</button>${s.keys.anthropic ? '<button class="btn ghost sm" data-clear="anthropic">Remove Anthropic key</button>' : ''}${s.keys.openai ? '<button class="btn ghost sm" data-clear="openai">Remove OpenAI key</button>' : ''}</div>
      </div>
      <div class="card stack">
        <h2>Patent search</h2>
        <h3>Google Patents</h3>
        <p class="muted" style="margin:0">Search patent text worldwide with a SerpApi key. Check the search allowance when you sign up. <a href="#" data-ext="https://serpapi.com/users/sign_up">Get a SerpApi key</a>.</p>
        <label class="field">SerpApi key ${s.keys.serpapi ? '<span class="pill good">saved</span>' : ''}<input type="password" id="k-serp" placeholder="Paste to set or replace"></label>
        ${s.keys.serpapi ? '<div><button class="btn ghost sm" data-clear="serpapi">Remove SerpApi key</button></div>' : ''}
        <h3>European Patent Office</h3>
        <p class="muted" style="margin:0">Search patent titles, abstracts and classifications worldwide. Registration is free. <a href="#" data-ext="https://developers.epo.org/">Get an EPO key and secret</a>.</p>
        <label class="field">EPO key ${s.keys.epoKey ? '<span class="pill good">saved</span>' : ''}<input type="password" id="k-epo" placeholder="Paste to set or replace"></label>
        <label class="field">EPO secret ${s.keys.epoSecret ? '<span class="pill good">saved</span>' : ''}<input type="password" id="k-epo-secret" placeholder="Paste to set or replace"></label>
        <div class="row">${s.keys.epoKey ? '<button class="btn ghost sm" data-clear="epoKey">Remove EPO key</button>' : ''}${s.keys.epoSecret ? '<button class="btn ghost sm" data-clear="epoSecret">Remove EPO secret</button>' : ''}</div>
        <h3>USPTO</h3>
        <p class="muted" style="margin:0">Search US patent application details, such as applicants and filing dates. Access is free and requires identity verification at sign-up. <a href="#" data-ext="https://data.uspto.gov/myodp">Get a USPTO key</a>.</p>
        <label class="field">USPTO key ${s.keys.uspto ? '<span class="pill good">saved</span>' : ''}<input type="password" id="k-uspto" placeholder="Paste to set or replace"></label>
        ${s.keys.uspto ? '<div><button class="btn ghost sm" data-clear="uspto">Remove USPTO key</button></div>' : ''}
        <h3>Google BigQuery</h3>
        <p class="muted" style="margin:0">Search patent text worldwide through a Google Cloud billing project. <a href="#" data-ext="https://console.cloud.google.com/projectcreate">Create a project</a>.</p>
        <p class="muted" style="margin:0">Needs a Google Cloud sign-in on this computer. Run <code>gcloud auth application-default login</code> in a terminal. Each keyword search scans about 341 GiB. The free allowance covers about three searches a month; further searches are billed to your project.</p>
        <label class="field">Google Cloud project ID ${s.googleCloudProject ? '<span class="pill good">saved</span>' : ''}<input type="text" id="s-gcp" value="${esc(s.googleCloudProject || '')}" placeholder="your-project-id"></label>
        <div class="row"><button class="btn" id="save-search">Save search settings</button>${s.googleCloudProject ? '<button class="btn ghost sm" id="clear-project">Remove project ID</button>' : ''}</div>
      </div>
      <div class="card stack">
        <h2>Where inventions are kept</h2>
        <div class="row"><code style="flex:1">${esc(s.workspace)}</code><button class="btn" id="pick-ws">Change</button></div>
      </div>
      <div class="row"><button class="btn primary" id="save-s">Save settings</button></div>
    </div>
  </div>`;
  main.querySelectorAll('.engine-opt').forEach(
    (b) =>
      (b.onclick = () => {
        s[b.dataset.field] = b.dataset.id;
        renderSettings();
      })
  );
  $('#save-s').onclick = async () => {
    const patch = { draftEngine: s.draftEngine, reviewEngine: s.reviewEngine, claudeModel: $('#s-cm').value.trim(), codexModel: $('#s-xm').value.trim(), codexEffort: $('#s-xe').value, googleCloudProject: $('#s-gcp').value.trim() };
    if (engineFamily(patch.draftEngine) === engineFamily(patch.reviewEngine)) toast('The writer and reviewer use the same AI. Choose the other AI for the review.', true);
    const saved = await attempt(() => S.saveSettings(patch));
    state.settings = await S.settings();
    if (saved) toast('Saved.');
  };
  $('#save-keys').onclick = async () => {
    const a = $('#k-anth').value.trim();
    const o = $('#k-oai').value.trim();
    if (!a && !o) return toast('Paste a key first.', true);
    const okA = !a || (await attempt(() => S.setKey('anthropic', a)));
    const okO = !o || (await attempt(() => S.setKey('openai', o)));
    state.settings = await S.settings();
    renderSettings();
    if (okA && okO) toast(a && o ? 'Both keys saved.' : 'Key saved.');
  };
  main.querySelectorAll('[data-clear]').forEach(
    (b) =>
      (b.onclick = async () => {
        await attempt(() => S.setKey(b.dataset.clear, ''));
        state.settings = await S.settings();
        renderSettings();
      })
  );
  $('#save-search').onclick = async () => {
    for (const [name, selector] of Object.entries({ serpapi: '#k-serp', epoKey: '#k-epo', epoSecret: '#k-epo-secret', uspto: '#k-uspto' })) {
      const value = $(selector).value.trim();
      if (value && !(await attempt(() => S.setKey(name, value)))) return;
    }
    if (await attempt(() => S.saveSettings({ googleCloudProject: $('#s-gcp').value.trim() }))) {
      state.settings = await S.settings();
      toast('Search settings saved.');
      renderSettings();
    }
  };
  $('#clear-project')?.addEventListener('click', async () => {
    if (!(await attempt(() => S.saveSettings({ googleCloudProject: '' })))) return;
    state.settings = await S.settings();
    renderSettings();
  });
  $('#pick-ws').onclick = async () => {
    const d = await guard(() => S.pickWorkspace());
    if (d) {
      if (!(await attempt(() => S.saveSettings({ workspace: d })))) return;
      state.settings = await S.settings();
      renderSettings();
      renderSidebar();
    }
  };
  main.querySelectorAll('[data-ext]').forEach((a) => (a.onclick = (e) => (e.preventDefault(), S.openExternal(a.dataset.ext))));
}
