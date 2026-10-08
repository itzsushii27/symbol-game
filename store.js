// store.js — tiny JSON-file persistence for accounts (usernames + ratings).
//
// This is deliberately small and isolated so it can be swapped for a real database
// (Postgres/Supabase) later without touching anything else: auth.js only needs
// load() and save(). Writes are debounced and atomic (write to a temp file, then
// rename), so a crash mid-write can't leave a half-written accounts file.
//
// NOTE: this only survives restarts where the folder itself survives. On hosts with
// an ephemeral disk (e.g. Render's free tier) the file is wiped on every deploy,
// restart and spin-down, so use a persistent disk or a database there.

const fs = require('fs');
const path = require('path');

const SAVE_DELAY_MS = 500;

function createStore(dir) {
  const file = path.join(dir, 'accounts.json');
  let timer = null;
  let pendingSnapshot = null;
  let disabled = false; // flipped if the folder isn't writable (e.g. read-only hosting)

  // Returns an array of plain account objects ([] if there is no file yet).
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] could not read ${file}: ${err.message}`);
      }
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.accounts) ? parsed.accounts : [];
    } catch (err) {
      // Never overwrite a file we couldn't parse: set it aside so nothing is lost.
      const aside = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch (_) { /* best effort */ }
      console.warn(`[store] ${file} was not valid JSON; moved to ${aside} and starting empty`);
      return [];
    }
  }

  function writeNow(accounts) {
    if (disabled) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts }, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      disabled = true;
      console.warn(`[store] persistence disabled (${err.message}); accounts will only live in memory`);
    }
  }

  // Schedule a save. `snapshot` is a function returning the array to write; it is
  // called when the save actually happens so it always captures the latest state.
  function save(snapshot) {
    pendingSnapshot = snapshot;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const fn = pendingSnapshot;
      pendingSnapshot = null;
      if (fn) writeNow(fn());
    }, SAVE_DELAY_MS);
    if (timer.unref) timer.unref(); // a pending save must never keep the process alive
  }

  // Write any pending save right now (used on shutdown and in tests).
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const fn = pendingSnapshot;
    pendingSnapshot = null;
    if (fn) writeNow(fn());
  }

  return { load, save, flush, file };
}

module.exports = { createStore };
