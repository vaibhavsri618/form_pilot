import { autoFill, buildTemplate, profileFromFill, runProfile } from './runner.js';
import * as store from './storage.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Earlier versions seeded a demo profile; drop it if it's still there untouched.
chrome.runtime.onInstalled.addListener(async () => {
  const profiles = await store.getProfiles();
  const kept = profiles.filter((p) => !(store.profileMeta(p.text).name === 'Example: demo application'
    && /match: "demo-form\.html"/.test(p.text)));
  if (kept.length !== profiles.length) await store.saveProfiles(kept);
});

async function badge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 4000);
}

// Shortcut: fill the current tab with its matching profile, or with dummy data.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-matched') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) return;
  await badge(tab.id, '…', '#2563eb');
  const log = (l) => console.log('[Form Pilot]', l);
  try {
    const profile = await store.findMatchingProfile(tab.url);
    const ok = profile
      ? await runProfile(tab.id, profile.text, { log })
      : (await autoFill(tab.id, { log })).ok;
    await badge(tab.id, ok ? '✓' : '✗', ok ? '#15803d' : '#b91c1c');
  } catch (e) {
    console.error('[Form Pilot]', e);
    await badge(tab.id, '✗', '#b91c1c');
  }
});

// Handy from the service worker console, e.g. formPilot.autoFill(tabId)
globalThis.formPilot = { autoFill, runProfile, buildTemplate, profileFromFill, store };
