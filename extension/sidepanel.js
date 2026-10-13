import { autoFill, buildTemplate, parseProfile, profileFromFill, runProfile } from './runner.js';
import * as store from './storage.js';

const $ = (id) => document.getElementById(id);
const el = {
  tabUrl: $('tabUrl'), autoBtn: $('autoBtn'), optSteps: $('optSteps'), optOverwrite: $('optOverwrite'),
  matchHint: $('matchHint'), matchName: $('matchName'), useMatch: $('useMatch'),
  afterFill: $('afterFill'), afterFillText: $('afterFillText'), saveAsProfile: $('saveAsProfile'),
  log: $('log'), clearLog: $('clearLog'), profilesBox: $('profilesBox'), noProfiles: $('noProfiles'),
  editorWrap: $('editorWrap'), sel: $('profileSel'), scaffoldBtn: $('scaffoldBtn'), moreBtn: $('moreBtn'),
  menu: $('moreMenu'), newBtn: $('newBtn'), dupBtn: $('dupBtn'), importBtn: $('importBtn'),
  importInput: $('importInput'), exportBtn: $('exportBtn'), delBtn: $('delBtn'), editor: $('editor'),
  parseErr: $('parseErr'), fillBtn: $('fillBtn'), fieldsOnly: $('fieldsOnly'), fileList: $('fileList'),
  fileCount: $('fileCount'), fileInput: $('fileInput'), shortcut: $('shortcut'),
};

let profiles = [];
let currentId = null;
let running = null; // {ctrl, button, label} while a fill is in progress
let matchId = null;
let lastFill = null; // {pages, url, title} from the latest dummy fill

// --------------------------------------------------------------- helpers

function log(line) {
  const span = document.createElement('span');
  if (line.startsWith('✓')) span.className = 'ok';
  if (line.startsWith('✗')) span.className = 'bad';
  span.textContent = `${line}\n`;
  el.log.append(span);
  el.log.scrollTop = el.log.scrollHeight;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function fillableTab() {
  const tab = await activeTab();
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) {
    log('✗ Open a web page (http/https) in this window first.');
    return null;
  }
  return tab;
}

/** Runs fn with a Stop-able button; ignores clicks while another fill runs. */
async function withRun(button, fn) {
  if (running) {
    if (running.button === button) running.ctrl.abort();
    return;
  }
  const label = button.textContent;
  running = { ctrl: new AbortController(), button };
  button.textContent = 'Stop';
  try {
    await fn(running.ctrl.signal);
  } catch (e) {
    log(`✗ ${e.message}`);
  } finally {
    button.textContent = label;
    running = null;
  }
}

const current = () => profiles.find((p) => p.id === currentId);

function renderProfiles() {
  el.sel.replaceChildren(...profiles.map((p) => new Option(store.profileMeta(p.text).name, p.id)));
  el.sel.value = currentId;
  const none = profiles.length === 0;
  el.noProfiles.hidden = !none;
  el.editorWrap.hidden = none;
  el.sel.disabled = none;
  el.dupBtn.disabled = el.exportBtn.disabled = el.delBtn.disabled = none;
}

function select(id) {
  currentId = id;
  chrome.storage.local.set({ selectedId: id });
  el.sel.value = id;
  el.editor.value = current()?.text || '';
  validate();
  refreshMatch();
}

function validate() {
  try {
    if (el.editor.value.trim()) parseProfile(el.editor.value);
    el.parseErr.hidden = true;
    return true;
  } catch (e) {
    el.parseErr.textContent = e.message.split('\n')[0];
    el.parseErr.hidden = false;
    return false;
  }
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const p = current();
    if (!p) return;
    p.text = el.editor.value;
    await store.saveProfiles(profiles);
    const opt = [...el.sel.options].find((o) => o.value === p.id);
    if (opt) opt.text = store.profileMeta(p.text).name;
    refreshMatch();
  }, 350);
}

async function addProfile(text) {
  const p = { id: store.newId(), text };
  profiles.push(p);
  await store.saveProfiles(profiles);
  renderProfiles();
  select(p.id);
  el.profilesBox.open = true;
}

async function refreshMatch() {
  const tab = await activeTab();
  el.tabUrl.textContent = tab?.url ? tab.url.replace(/^https?:\/\//, '') : '';
  el.tabUrl.title = tab?.url || '';
  const hit = profiles.find((p) => store.urlMatches(store.profileMeta(p.text).match, tab?.url));
  matchId = hit ? hit.id : null;
  el.matchHint.hidden = !matchId;
  if (matchId) el.matchName.textContent = store.profileMeta(hit.text).name;
}

async function fillWithProfile(text, signal) {
  const tab = await fillableTab();
  if (!tab) return;
  log(`▶ profile: ${store.profileMeta(text).name}`);
  const ok = await runProfile(tab.id, text, { log, fieldsOnly: el.fieldsOnly.checked, signal });
  log(ok ? '✓ Done' : '✗ Finished with errors');
}

// ----------------------------------------------------------- attachments

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function renderFiles() {
  const files = await store.listFiles();
  el.fileCount.textContent = files.length ? `(${files.length})` : '';
  el.fileList.replaceChildren(...files.map((f) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    name.title = f.name;
    const size = document.createElement('span');
    size.className = 'muted small';
    size.textContent = fmtSize(f.size);
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = `Remove ${f.name}`;
    del.addEventListener('click', async () => { await store.deleteFile(f.name); renderFiles(); });
    li.append(name, size, del);
    return li;
  }));
}

// ---------------------------------------------------------------- events

el.autoBtn.addEventListener('click', () => withRun(el.autoBtn, async (signal) => {
  const tab = await fillableTab();
  if (!tab) return;
  el.afterFill.hidden = true;
  log(`▶ dummy data${el.optSteps.checked ? ', all steps' : ''}`);
  const { ok, pages } = await autoFill(tab.id, {
    log, overwrite: el.optOverwrite.checked, steps: el.optSteps.checked, signal,
  });
  const total = pages.reduce((n, p) => n + p.fields.length, 0);
  log(ok ? '✓ Done' : '✗ Finished with some problems (see above)');
  if (total) {
    lastFill = { pages, url: tab.url, title: tab.title };
    el.afterFillText.textContent = `Filled ${total} field${total > 1 ? 's' : ''}${pages.length > 1 ? ` over ${pages.length} steps` : ''}.`;
    el.afterFill.hidden = false;
  }
}));

for (const box of [el.optSteps, el.optOverwrite]) {
  box.addEventListener('change', () => chrome.storage.local.set({
    opts: { steps: el.optSteps.checked, overwrite: el.optOverwrite.checked },
  }));
}

el.saveAsProfile.addEventListener('click', async () => {
  if (!lastFill) return;
  await addProfile(profileFromFill(lastFill.pages, lastFill.url, lastFill.title));
  el.afterFill.hidden = true;
  log('Saved as a profile. Edit any value below and use "Fill with this profile" to repeat it.');
});

el.useMatch.addEventListener('click', () => {
  const p = profiles.find((x) => x.id === matchId);
  if (p) withRun(el.autoBtn, (signal) => fillWithProfile(p.text, signal));
});

el.sel.addEventListener('change', () => select(el.sel.value));
el.editor.addEventListener('input', () => { validate(); scheduleSave(); });
el.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
});

const closeMenu = () => { el.menu.hidden = true; el.moreBtn.setAttribute('aria-expanded', 'false'); };
el.moreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  el.menu.hidden = !el.menu.hidden;
  el.moreBtn.setAttribute('aria-expanded', String(!el.menu.hidden));
});
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

el.newBtn.addEventListener('click', () => addProfile('name: "New profile"\nmatch: ""\n\nfields:\n  "Field label": "value"\n'));
el.scaffoldBtn.addEventListener('click', async () => {
  const tab = await fillableTab();
  if (!tab) return;
  try {
    await addProfile(await buildTemplate(tab.id));
    log(`New profile from ${tab.url}`);
  } catch (e) {
    log(`✗ Can't read this page: ${e.message}`);
  }
});
el.dupBtn.addEventListener('click', () => current() && addProfile(current().text.replace(/^name:\s*"?(.*?)"?\s*$/m, 'name: "$1 (copy)"')));
el.importBtn.addEventListener('click', () => el.importInput.click());
el.importInput.addEventListener('change', async () => {
  for (const f of el.importInput.files) {
    let text = await f.text();
    if (/\.json$/i.test(f.name)) text = JSON.stringify(JSON.parse(text), null, 2); // JSON is valid YAML
    if (!/^name:/m.test(text) && !/\.json$/i.test(f.name)) text = `name: ${JSON.stringify(f.name.replace(/\.\w+$/, ''))}\n${text}`;
    await addProfile(text);
  }
  el.importInput.value = '';
});
el.exportBtn.addEventListener('click', () => {
  const p = current();
  if (!p) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([p.text], { type: 'text/yaml' }));
  a.download = `${store.profileMeta(p.text).name.replace(/[^\w.-]+/g, '_')}.yaml`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
let delArmed = null;
el.delBtn.addEventListener('click', async (e) => {
  const p = current();
  if (!p) return;
  if (!delArmed) { // first click arms, second click (within 4s) deletes
    e.stopPropagation();
    el.delBtn.textContent = `Click again to delete "${store.profileMeta(p.text).name}"`;
    delArmed = setTimeout(() => { delArmed = null; el.delBtn.textContent = 'Delete'; }, 4000);
    return;
  }
  clearTimeout(delArmed);
  delArmed = null;
  el.delBtn.textContent = 'Delete';
  profiles = profiles.filter((x) => x.id !== p.id);
  await store.saveProfiles(profiles);
  currentId = profiles[0]?.id || null;
  renderProfiles();
  select(currentId);
});

el.fillBtn.addEventListener('click', () => withRun(el.fillBtn, async (signal) => {
  if (!validate()) return;
  clearTimeout(saveTimer);
  const p = current();
  if (p) { p.text = el.editor.value; await store.saveProfiles(profiles); }
  await fillWithProfile(el.editor.value, signal);
}));

el.fileInput.addEventListener('change', async () => {
  for (const f of el.fileInput.files) await store.putFile(f);
  el.fileInput.value = '';
  renderFiles();
});

el.clearLog.addEventListener('click', (e) => { e.preventDefault(); el.log.replaceChildren(); });

chrome.tabs.onActivated.addListener(refreshMatch);
chrome.tabs.onUpdated.addListener((_, info) => info.url && refreshMatch());

// ------------------------------------------------------------------ init

(async () => {
  profiles = await store.getProfiles();
  const { selectedId, opts } = await chrome.storage.local.get(['selectedId', 'opts']);
  el.optSteps.checked = !!opts?.steps;
  el.optOverwrite.checked = !!opts?.overwrite;
  currentId = profiles.some((p) => p.id === selectedId) ? selectedId : profiles[0]?.id || null;
  renderProfiles();
  select(currentId);
  renderFiles();
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'fill-matched');
  el.shortcut.textContent = cmd?.shortcut || 'not set';
})();
