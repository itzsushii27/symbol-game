// auth.js — accounts + Google sign-in.
//
// An account is created with Google and tied to the Google account's ID:
//   1. The player signs in with Google.
//   2. If that Google ID already has an account, they're logged in.
//   3. If not, they are "pending" — signed in with Google but with no account yet —
//      and must pick a username (POST /api/signup) to create one.
// A username is permanent: it is chosen once at sign-up and there is no way to
// change it. It is what everyone else sees (leaderboard and in-game).

const path = require('path');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const { defaultRating } = require('./rating');
const { createStore } = require('./store');

const TIME_CONTROLS = ['bullet', 'blitz', 'rapid'];

const accounts = new Map();      // googleId -> account
const usernameIndex = new Map(); // lowercased username -> googleId (usernames are unique, case-insensitively)

let store = null;

// --- Usernames ---------------------------------------------------------------------
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
// Letters, numbers and underscore only. Keeping it to plain ASCII also means a
// username can never carry markup or look-alike characters into other players' pages.
const USERNAME_RE = /^[A-Za-z0-9_]+$/;
const RESERVED_USERNAMES = new Set([
  'bot', 'cpu', 'guest', 'admin', 'administrator', 'mod', 'moderator', 'system',
  'support', 'staff', 'you', 'opponent', 'player', 'anonymous', 'null', 'undefined'
]);

function validateUsername(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Please enter a username.' };
  }
  const username = raw.trim();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { ok: false, error: `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters.` };
  }
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: 'Username can only use letters, numbers, and underscores.' };
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    return { ok: false, error: 'That username is reserved. Please pick another.' };
  }
  return { ok: true, username };
}

// --- Account storage ---------------------------------------------------------------
function persist() {
  if (store) store.save(() => Array.from(accounts.values()));
}

// Load accounts from disk (resets the in-memory maps). Safe to call again; tests do.
function initAccounts(dir = process.env.DATA_DIR || path.join(__dirname, 'data')) {
  accounts.clear();
  usernameIndex.clear();
  store = createStore(dir);

  for (const saved of store.load()) {
    if (!saved || typeof saved.id !== 'string' || typeof saved.username !== 'string') continue;
    const key = saved.username.toLowerCase();
    if (usernameIndex.has(key)) continue; // never let a bad file create duplicate usernames

    const ratings = {};
    for (const tc of TIME_CONTROLS) {
      ratings[tc] = { ...defaultRating(), ...((saved.ratings && saved.ratings[tc]) || {}) };
    }
    accounts.set(saved.id, {
      id: saved.id,
      username: saved.username,
      createdAt: saved.createdAt || Date.now(),
      ratings
    });
    usernameIndex.set(key, saved.id);
  }
  return accounts.size;
}

// Write any pending save immediately (called on shutdown).
function flushAccounts() {
  if (store) store.flush();
}

// Create the account for a Google ID with a chosen username.
// Returns { ok: true, account } or { ok: false, status, error }.
function createAccount(googleId, rawUsername) {
  if (accounts.has(googleId)) {
    return { ok: false, status: 409, error: 'You already have an account.' };
  }

  const check = validateUsername(rawUsername);
  if (!check.ok) {
    return { ok: false, status: 400, error: check.error };
  }

  // Check-then-set happens synchronously, so two simultaneous sign-ups can't both win.
  if (usernameIndex.has(check.username.toLowerCase())) {
    return { ok: false, status: 409, error: 'That username is already taken.' };
  }

  const ratings = {};
  for (const tc of TIME_CONTROLS) ratings[tc] = defaultRating();

  const account = {
    id: googleId,
    username: check.username,
    createdAt: Date.now(),
    ratings
  };
  accounts.set(googleId, account);
  usernameIndex.set(check.username.toLowerCase(), googleId);
  persist();
  return { ok: true, account };
}

function isUsernameTaken(raw) {
  return typeof raw === 'string' && usernameIndex.has(raw.trim().toLowerCase());
}

// --- Google sign-in ----------------------------------------------------------------
// Known Google ID -> their account. Unknown Google ID -> a "pending" placeholder
// that carries nothing but the ID; no account exists until they choose a username.
function resolveGoogleUser(googleId) {
  return accounts.get(googleId) || { id: googleId, pending: true };
}

function configurePassport() {
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID || 'dummy-id',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'dummy-secret',
      // Optionally set GOOGLE_CALLBACK_URL to the full https URL registered in Google
      // Cloud Console. `proxy: true` makes the relative default resolve to https when
      // running behind a TLS-terminating host (Render, Railway, ...).
      callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
      proxy: true
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, resolveGoogleUser(profile.id));
    }
  ));

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Anyone whose Google ID has no account (new player, or accounts were wiped by a
  // restart on an ephemeral host) comes back as pending and is asked to sign up.
  passport.deserializeUser((id, done) => {
    done(null, resolveGoogleUser(id));
  });
}

module.exports = {
  configurePassport,
  initAccounts,
  flushAccounts,
  saveAccounts: persist,
  createAccount,
  validateUsername,
  isUsernameTaken,
  resolveGoogleUser,
  accounts,
  TIME_CONTROLS,
  USERNAME_MIN,
  USERNAME_MAX
};
