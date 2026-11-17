const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...args) =>
  ipcRenderer.invoke(ch, ...args).then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.value;
  });

contextBridge.exposeInMainWorld('studio', {
  env: (force) => call('env:get', force),
  settings: () => call('settings:get'),
  saveSettings: (patch) => call('settings:set', patch),
  setKey: (name, value) => call('settings:setKey', name, value),
  phases: () => call('phases:list'),
  projects: () => call('projects:list'),
  createProject: (intake) => call('projects:create', intake),
  project: (id) => call('projects:get', id),
  updateIntake: (id, intake) => call('projects:updateIntake', id, intake),
  setDates: (id, dates) => call('projects:setDates', id, dates),
  readFile: (id, rel) => call('projects:readFile', id, rel),
  fileData: (id, rel) => call('projects:fileData', id, rel),
  openFile: (id, rel) => call('projects:openFile', id, rel),
  openFolder: (id, rel) => call('projects:openFolder', id, rel),
  runLog: (id, rel) => call('projects:runLog', id, rel),
  run: (id, phaseId, opts) => call('run:start', id, phaseId, opts),
  stop: (id) => call('run:stop', id),
  fixRound: (id) => call('run:fixRound', id),
  overrule: (id) => call('decision:overrule', id),
  draftGates: (id) => call('gates:draft', id),
  packageGate: (id) => call('gates:package', id),
  searchStatus: () => call('gates:search'),
  lawSearch: (q) => call('law:search', q),
  install: () => call('setup:install'),
  installTool: (name) => call('setup:installTool', name),
  login: (name) => call('setup:login', name),
  loginCode: (name, code) => call('setup:loginCode', name, code),
  openExternal: (url) => call('shell:openExternal', url),
  pickMaterial: () => call('dialog:pickMaterial'),
  pickWorkspace: () => call('dialog:pickWorkspace'),
  on: (channel, fn) => {
    const allowed = ['run:event', 'run:end', 'project:changed', 'setup:line', 'setup:login'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
