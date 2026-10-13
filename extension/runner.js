// Runs a profile against a tab: parses the YAML, injects content.js into every
// frame and drives it step by step.
import { load } from './lib/js-yaml.mjs';
import { fileMatchesAccept, makeDummyFile, toBase64 } from './dummyfiles.js';
import { getFile, listFiles } from './storage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ templates

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function strftime(d, fmt) {
  const map = {
    Y: d.getFullYear(), y: pad(d.getFullYear() % 100), m: pad(d.getMonth() + 1), d: pad(d.getDate()),
    H: pad(d.getHours()), M: pad(d.getMinutes()), S: pad(d.getSeconds()), b: MONTHS[d.getMonth()],
  };
  return fmt.replace(/%([YymdHMSb%])/g, (_, k) => (k === '%' ? '%' : map[k]));
}

function randomDigits(n) {
  let s = String(1 + Math.floor(Math.random() * 9));
  while (s.length < n) s += Math.floor(Math.random() * 10);
  return s;
}

/** {{today}}, {{today:%d/%m/%Y}}, {{today+30}}, {{now}}, {{rand:10}}, {{uuid:8}} */
export function expand(v) {
  if (typeof v === 'string') {
    return v.replace(/\{\{\s*(\w+)([+-]\d+)?(?::([^}]*))?\s*\}\}/g, (m, name, offset, arg) => {
      const d = new Date();
      if (offset) d.setDate(d.getDate() + Number(offset));
      if (name === 'today') return strftime(d, arg || '%Y-%m-%d');
      if (name === 'now') return strftime(d, arg || '%Y-%m-%d %H:%M');
      if (name === 'rand') return randomDigits(Number(arg) || 6);
      if (name === 'uuid') return crypto.randomUUID().replace(/-/g, '').slice(0, Number(arg) || 32);
      return m;
    });
  }
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}

export function parseProfile(text) {
  const data = load(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('A profile must be a mapping with fields: and/or steps:');
  }
  return data;
}

// ---------------------------------------------------------- tab helpers

async function inject(tabId) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    const ids = res.map((r) => r.frameId).sort((a, b) => a - b);
    return ids.length ? ids : [0];
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return [0];
  }
}

/** Call a content-script method frame by frame (top frame first) until one finds its target. */
async function call(tabId, frames, method, args) {
  for (const frameId of frames) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (m, a) => (window.__formPilot ? window.__formPilot[m](...a) : { found: false }),
        args: [method, args],
      });
      if (res?.result?.found) return res.result;
    } catch {
      // frame went away or is not scriptable
    }
  }
  return { found: false };
}

async function waitTabReady(tabId, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(200);
  }
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(300);
  await waitTabReady(tabId);
}

async function anyFrameHasText(tabId, text) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (t) => !!document.body && document.body.innerText.includes(t),
      args: [text],
    });
    return res.some((r) => r.result);
  } catch {
    return false;
  }
}

/** Make alert/confirm/prompt answer themselves, and record what they said. */
async function autoAcceptDialogs(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        if (window.__fpDialogs) return;
        window.__fpDialogs = true;
        const note = (type, msg) => {
          const root = document.documentElement;
          const list = JSON.parse(root.dataset.fpDialogs || '[]');
          list.push(`${type} "${msg}" → accepted`);
          root.dataset.fpDialogs = JSON.stringify(list);
        };
        window.alert = (m) => note('alert', m);
        window.confirm = (m) => (note('confirm', m), true);
        window.prompt = (m, d) => (note('prompt', m), d ?? '');
      },
    });
  } catch {
    // restricted page
  }
}

async function takeDialogNotes(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const v = document.documentElement.dataset.fpDialogs;
        delete document.documentElement.dataset.fpDialogs;
        return v ? JSON.parse(v) : [];
      },
    });
    return res.flatMap((r) => r.result || []);
  } catch {
    return [];
  }
}

async function libraryFile(name) {
  const rec = await getFile(name);
  return { name: rec.name, type: rec.type, b64: toBase64(new Uint8Array(await rec.blob.arrayBuffer())) };
}

/**
 * Files for a profile value: attachment names from the library, or "dummy" /
 * "dummy.pdf" for a generated file. Returns null when the value isn't a file.
 */
async function resolveFiles(value, library, label) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || !list.every((v) => typeof v === 'string')) return null;
  const names = list.map((v) => v.replace(/^file:/, '').trim());
  const isDummy = (n) => /^dummy(\.\w+)?$/i.test(n);
  const explicit = list.some((v) => v.startsWith('file:'));
  if (!names.every((n) => library.has(n) || isDummy(n))) {
    if (explicit) throw new Error(`Not in attachments: ${names.filter((n) => !library.has(n)).join(', ')}`);
    return null;
  }
  return Promise.all(names.map((n) => (library.has(n) ? libraryFile(n)
    : makeDummyFile('', label, (n.split('.')[1] || 'pdf').toLowerCase()))));
}

// ---------------------------------------------------------------- run

/**
 * @param {number} tabId
 * @param {string} text  profile YAML/JSON
 * @param {{log?: (line: string) => void, fieldsOnly?: boolean, signal?: AbortSignal}} opts
 * @returns {Promise<boolean>} true when every step succeeded
 */
export async function runProfile(tabId, text, { log = console.log, fieldsOnly = false, signal } = {}) {
  const p = parseProfile(text);
  const strict = !!p.strict;
  let acceptDialogs = p.dialog === 'accept';
  let ok = true;

  if (!fieldsOnly && p.url) {
    await navigate(tabId, String(expand(p.url)));
    log(`→ opened ${p.url}`);
  }

  const steps = [];
  if (p.fields) steps.push({ fill: p.fields });
  if (!fieldsOnly) steps.push(...(p.steps || []));

  const library = new Set((await listFiles()).map((f) => f.name));

  for (const [i, step] of steps.entries()) {
    if (signal?.aborted) {
      log('■ stopped');
      return false;
    }
    if (!step || typeof step !== 'object' || Object.keys(step).length !== 1) {
      throw new Error(`Step ${i + 1} must be a single "kind: value" entry, got ${JSON.stringify(step)}`);
    }
    const [kind, raw] = Object.entries(step)[0];
    const arg = expand(raw);
    let frames = await inject(tabId);
    if (acceptDialogs) await autoAcceptDialogs(tabId);

    if (kind === 'fill' || kind === 'upload') {
      if (!arg || typeof arg !== 'object') throw new Error(`"${kind}" takes a mapping of field → value`);
      let skipped = 0;
      for (const [key, value] of Object.entries(arg)) {
        if (signal?.aborted) break;
        if (value === '' || value === null) { // left blank in a generated profile
          skipped += 1;
          continue;
        }
        let res;
        try {
          const files = await resolveFiles(value, library, key);
          res = await call(tabId, frames, 'fill', [key, files ? true : value, files]);
          if (!res.found) {
            // The page may have re-rendered (or navigated) since the last injection.
            frames = await inject(tabId);
            res = await call(tabId, frames, 'fill', [key, files ? true : value, files]);
          }
        } catch (e) {
          res = { found: true, ok: false, msg: e.message };
        }
        const good = res.found && res.ok;
        log(`${good ? '✓' : '✗'} ${key}: ${res.found ? res.msg : 'no field found'}`);
        ok &&= good;
        if (!good && strict) return false;
      }
      if (skipped) log(`– ${skipped} blank field${skipped > 1 ? 's' : ''} left as is`);
      continue;
    }

    try {
      if (kind === 'click' || kind === 'press') {
        const res = await call(tabId, frames, kind, [String(arg)]);
        if (!res.found) throw new Error(`nothing clickable named "${arg}"`);
        await sleep(400);
        await waitTabReady(tabId);
        const notes = await takeDialogNotes(tabId);
        log(`→ ${res.msg}${notes.length ? ` (dialog: ${notes.join('; ')})` : ''}`);
      } else if (kind === 'wait_for') {
        const end = Date.now() + 15000;
        while (!(await anyFrameHasText(tabId, String(arg)))) {
          if (Date.now() > end || signal?.aborted) throw new Error(`"${arg}" did not appear within 15s`);
          await sleep(250);
        }
        log(`→ saw "${arg}"`);
      } else if (kind === 'wait') {
        await sleep(Number(arg) * 1000);
      } else if (kind === 'goto') {
        await navigate(tabId, String(arg));
        log(`→ opened ${arg}`);
      } else if (kind === 'dialog') {
        acceptDialogs = arg === 'accept';
        log(`→ dialogs will be ${acceptDialogs ? 'auto-accepted' : 'shown to you'}`);
      } else if (kind === 'screenshot') {
        const tab = await chrome.tabs.get(tabId);
        const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const filename = `form-pilot/${String(arg).replace(/[^\w.-]+/g, '_')}`;
        await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
        log(`→ screenshot saved to Downloads/${filename}`);
      } else {
        throw new Error(`unknown step "${kind}"`);
      }
    } catch (e) {
      log(`✗ step ${i + 1} (${kind}): ${e.message}`);
      return false;
    }
  }
  return ok;
}

// ------------------------------------------------------------ scaffold

const q = (s) => JSON.stringify(s);

/** Build a starter profile from the form currently open in the tab. */
export async function buildTemplate(tabId) {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] })
    .catch(() => chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }));
  const frames = res.map((r) => r.frameId).sort((a, b) => a - b);
  const pages = [];
  for (const frameId of frames) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: () => window.__formPilot.describe(),
      });
      if (r?.result) pages.push(r.result);
    } catch {
      // not scriptable
    }
  }
  const top = pages[0] || { title: 'Untitled', url: '' };
  const u = top.url ? new URL(top.url) : null;
  const out = [
    `name: ${q(top.title || 'Untitled form')}`,
    `match: ${q(u ? u.origin + u.pathname : '')}   # auto-pick this profile on matching URLs`,
    `url: ${q(top.url)}   # remove to fill whatever page is open`,
    '# dialog: accept      # auto-OK confirm()/alert() popups',
    '',
    'fields:',
  ];
  const seen = new Set();
  const radios = new Map();
  let heading = null;
  const entries = [];
  for (const page of pages) {
    for (const it of page.items) {
      if (it.role === 'heading') { heading = it.name; continue; }
      let key;
      if (it.role === 'radio') {
        const g = it.group || it.attrName;
        if (g && radios.has(g)) { radios.get(g).choices.push(it.radioLabel); continue; }
        key = g || it.radioLabel;
      } else {
        key = it.name;
      }
      if (!key || seen.has(key)) {
        key = it.id ? `css:#${CSS.escape(it.id)}` : it.attrName ? `css:[name="${it.attrName}"]` : '';
      }
      if (key) seen.add(key);
      const e = { key, ...it, heading, choices: [it.radioLabel] };
      heading = null;
      entries.push(e);
      if (it.role === 'radio' && (it.group || it.attrName)) radios.set(it.group || it.attrName, e);
    }
  }
  for (const e of entries) {
    if (e.heading) out.push('', `  # --- ${e.heading} ---`);
    const value = ['checkbox', 'switch'].includes(e.role) ? 'false' : '""';
    const hint = [e.role];
    if (e.required) hint.push('required');
    if (e.role === 'file') hint.push('name of a file in Attachments');
    if (e.options.length) hint.push(`options: ${e.options.slice(0, 15).join(' | ')}`);
    if (e.role === 'radio') hint.push(`choices: ${e.choices.join(' | ')}`);
    out.push(e.key
      ? `  ${q(e.key)}: ${value}   # ${hint.join(', ')}`
      : `  # "css:<selector>": ${value}   # ${hint.join(', ')} with no label — add a CSS selector`);
  }
  if (!entries.length) out.push('  # no form fields found on this page');
  out.push('', '# steps:', '#   - click: "Next"', '#   - wait_for: "Step 2"', '#   - fill: { "PIN Code": "560001" }', '');
  return out.join('\n');
}

// ------------------------------------------------------------ dummy fill

async function inFrame(tabId, frameId, method, args) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (m, a) => (window.__formPilot ? window.__formPilot[m](...a) : null),
      args: [method, args],
    });
    return res?.result || null;
  } catch {
    return null;
  }
}

const short = (s, n = 60) => {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A file for an upload field: one of the user's attachments if its type fits, else a generated dummy. */
async function fileFor(req, libraryList) {
  const own = libraryList.find((f) => fileMatchesAccept(f.name, f.type, req.accept));
  if (own) return { ...(await libraryFile(own.name)), own: true };
  return makeDummyFile(req.accept, req.label);
}

/**
 * Fill every empty field in the tab with dummy data. With steps: true, keeps
 * clicking Next / Continue / Save and continue (never Submit) and fills each step.
 * @returns {Promise<{ok: boolean, pages: {fields: {key: string, value: any}[], next?: string}[]}>}
 */
export async function autoFill(tabId, { log = console.log, overwrite = false, steps = false, signal } = {}) {
  const libraryList = await listFiles();
  const pages = [];
  let ok = true;
  for (let step = 0; step < (steps ? 40 : 1); step += 1) {
    if (signal?.aborted) { log('■ stopped'); break; }
    const frames = await inject(tabId);
    const fields = [];
    for (const frameId of frames) {
      const res = await inFrame(tabId, frameId, 'autofill', [{ overwrite }]);
      if (!res) continue;
      for (const f of res.filled) {
        fields.push(f);
        log(`✓ ${short(f.key, 48)} ← ${short(f.value, 40)}`);
      }
      for (const req of res.files) {
        try {
          const file = await fileFor(req, libraryList);
          const set = await inFrame(tabId, frameId, 'setFiles', [req.k, [file]]);
          if (!set?.ok) throw new Error('upload field disappeared');
          fields.push({ key: req.label, value: file.own ? file.name : `dummy.${file.name.split('.').pop()}` });
          log(`✓ ${short(req.label, 48)} ← 📎 ${file.name}${file.own ? ' (yours)' : ''}`);
        } catch (e) {
          ok = false;
          log(`✗ ${short(req.label, 48)}: ${e.message}`);
        }
      }
      for (const e of res.errors) { ok = false; log(`✗ ${short(e, 90)}`); }
    }
    pages.push({ fields });
    log(`— ${fields.length ? `filled ${fields.length} field${fields.length > 1 ? 's' : ''}` : 'nothing empty to fill'}${steps ? ` on step ${step + 1}` : ''}`);
    if (!steps) break;

    const before = await inFrame(tabId, frames[0], 'pageState', []);
    const next = await call(tabId, frames, 'clickNext', []);
    if (!next.found) { log('■ No Next / Continue button here — stopping.'); break; }
    pages[pages.length - 1].next = next.msg;
    log(`→ clicked "${next.msg}"`);
    let moved = false;
    for (let t = 0; t < 20 && !moved; t += 1) {
      await sleep(300);
      await waitTabReady(tabId);
      const now = await inFrame(tabId, frames[0], 'pageState', []) || await inFrame(tabId, 0, 'pageState', []);
      moved = !now || !before || now.sig !== before.sig;
      if (!moved && t === 19 && now?.errors?.length) log(`  errors on page: ${now.errors.map((e) => short(e, 60)).join(' · ')}`);
    }
    if (!moved) {
      ok = false;
      log('✗ Still on the same step — the form probably rejected something. Fix it and run again.');
      break;
    }
  }
  return { ok, pages };
}

/** Turn what autoFill entered into an editable profile (one fill per step). */
export function profileFromFill(pages, url, title) {
  const u = url ? new URL(url) : null;
  const block = (fields, indent) => {
    const seen = new Set();
    return fields.filter((f) => f.key && !seen.has(f.key) && seen.add(f.key))
      .map((f) => `${indent}${JSON.stringify(f.key)}: ${typeof f.value === 'boolean' ? f.value : JSON.stringify(String(f.value))}`);
  };
  const out = [
    `name: ${JSON.stringify(title || 'Saved fill')}`,
    `match: ${JSON.stringify(u ? u.origin + u.pathname : '')}`,
    '',
    'fields:',
    ...block(pages[0]?.fields || [], '  '),
  ];
  if (pages.length > 1) {
    out.push('', 'steps:');
    pages.slice(1).forEach((p, i) => {
      out.push(`  - click: ${JSON.stringify(pages[i].next || 'Next')}`);
      if (p.fields.length) out.push('  - fill:', ...block(p.fields, '      '));
    });
  }
  return `${out.join('\n')}\n`;
}
