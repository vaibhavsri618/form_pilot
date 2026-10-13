// Profiles live in chrome.storage.local; attachments (files to upload) live in
// IndexedDB so they can be large. Both are shared by the side panel and the
// service worker.
import { load } from './lib/js-yaml.mjs';

// ------------------------------------------------------------- profiles

export async function getProfiles() {
  const { profiles } = await chrome.storage.local.get('profiles');
  return profiles || [];
}

export async function saveProfiles(list) {
  await chrome.storage.local.set({ profiles: list });
}

export function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** name/match pulled from a profile's YAML, tolerating half-typed text. */
export function profileMeta(text) {
  try {
    const d = load(text) || {};
    return { name: d.name ? String(d.name) : 'Untitled', match: d.match ? String(d.match) : '' };
  } catch {
    const m = /^name:\s*["']?(.+?)["']?\s*$/m.exec(text);
    return { name: m ? m[1] : 'Untitled', match: '' };
  }
}

export function urlMatches(pattern, url) {
  if (!pattern || !url) return false;
  if (!pattern.includes('*')) return url.includes(pattern);
  const re = new RegExp(pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
  return re.test(url);
}

export async function findMatchingProfile(url) {
  return (await getProfiles()).find((p) => urlMatches(profileMeta(p.text).match, url)) || null;
}

// ---------------------------------------------------------- attachments

const DB = 'form-pilot';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

/** [{name, size, type}] without loading the bytes. */
export async function listFiles() {
  const all = await withStore('readonly', (s) => s.getAll());
  return (all || []).map(({ name, type, blob }) => ({ name, type, size: blob.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function putFile(file) {
  return withStore('readwrite', (s) => s.put({ name: file.name, type: file.type, blob: file }));
}

export function getFile(name) {
  return withStore('readonly', (s) => s.get(name));
}

export function deleteFile(name) {
  return withStore('readwrite', (s) => s.delete(name));
}
