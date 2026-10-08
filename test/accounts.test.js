const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auth = require('../auth');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-game-accounts-'));
}

test('validateUsername: accepts normal names, trims whitespace', () => {
  assert.deepEqual(auth.validateUsername('  Sushi_27 '), { ok: true, username: 'Sushi_27' });
  assert.equal(auth.validateUsername('abc').ok, true);
  assert.equal(auth.validateUsername('a'.repeat(20)).ok, true);
});

test('validateUsername: rejects bad lengths, characters, markup, and reserved names', () => {
  for (const bad of [
    undefined, null, 42, {}, '', '   ', 'ab', 'a'.repeat(21),
    'has space', 'dash-ed', 'émile', '<img src=x>', '<script>', 'a.b', 'name!',
    'bot', 'BOT', 'Admin', 'guest', 'System'
  ]) {
    assert.equal(auth.validateUsername(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('createAccount: one account per Google ID, usernames unique ignoring case', () => {
  auth.initAccounts(tmpDir());

  const first = auth.createAccount('google-1', 'Sushi');
  assert.equal(first.ok, true);
  assert.equal(first.account.username, 'Sushi');
  assert.equal(first.account.ratings.blitz.rating, 1500);
  assert.equal(first.account.ratings.blitz.games, 0);

  const dupe = auth.createAccount('google-2', 'sUsHi');
  assert.equal(dupe.ok, false);
  assert.equal(dupe.status, 409);

  const again = auth.createAccount('google-1', 'SomethingElse');
  assert.equal(again.ok, false);
  assert.equal(again.status, 409, 'usernames are permanent: a Google account cannot make a second one');
  assert.equal(auth.accounts.get('google-1').username, 'Sushi');

  const bad = auth.createAccount('google-3', 'x');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);

  assert.equal(auth.isUsernameTaken('SUSHI'), true);
  assert.equal(auth.isUsernameTaken('nobody'), false);
});

test('resolveGoogleUser: known Google ID gets their account, unknown is pending', () => {
  auth.initAccounts(tmpDir());
  auth.createAccount('google-known', 'Known');

  assert.equal(auth.resolveGoogleUser('google-known').username, 'Known');
  assert.deepEqual(auth.resolveGoogleUser('google-new'), { id: 'google-new', pending: true });
});

test('accounts (usernames + ratings) survive a restart', () => {
  const dir = tmpDir();
  auth.initAccounts(dir);
  auth.createAccount('google-1', 'Persisted');
  auth.accounts.get('google-1').ratings.blitz = { rating: 1612, rd: 180.5, vol: 0.0601, games: 3 };
  auth.saveAccounts();
  auth.flushAccounts();

  // "Restart": load from the same folder into fresh state.
  const count = auth.initAccounts(dir);
  assert.equal(count, 1);
  const loaded = auth.accounts.get('google-1');
  assert.equal(loaded.username, 'Persisted');
  assert.deepEqual(loaded.ratings.blitz, { rating: 1612, rd: 180.5, vol: 0.0601, games: 3 });
  assert.equal(loaded.ratings.bullet.rating, 1500);
  assert.equal(auth.isUsernameTaken('persisted'), true, 'username index is rebuilt');
});

test('loading is defensive: bad rows skipped, duplicate usernames dropped, missing ratings filled in', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [
      { id: 'a', username: 'Same', ratings: { bullet: { rating: 1700, rd: 100, vol: 0.06 } } },
      { id: 'b', username: 'same' },     // duplicate username (case-insensitive) -> dropped
      { id: 'c' },                       // no username -> skipped
      null,
      { username: 'NoId' }               // no id -> skipped
    ]
  }));
  assert.equal(auth.initAccounts(dir), 1);
  const a = auth.accounts.get('a');
  assert.equal(a.ratings.bullet.rating, 1700);
  assert.equal(a.ratings.bullet.games, 0, 'older records without a games count get 0');
  assert.equal(a.ratings.rapid.rating, 1500, 'missing time controls are filled in');
});

test('a corrupt accounts file is set aside rather than overwritten', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{ this is not json');
  assert.equal(auth.initAccounts(dir), 0);

  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('accounts.json.corrupt-')), `files: ${files}`);
  assert.ok(!files.includes('accounts.json'));

  // and the app keeps working: new accounts save normally
  auth.createAccount('google-1', 'Fresh');
  auth.flushAccounts();
  assert.ok(fs.existsSync(path.join(dir, 'accounts.json')));
});

test('an unwritable data folder never crashes the app (it just stays in memory)', () => {
  // A *file* where the folder should be makes mkdir fail, like a read-only host.
  const blocker = path.join(tmpDir(), 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  auth.initAccounts(path.join(blocker, 'data'));

  const res = auth.createAccount('google-1', 'InMemory');
  assert.equal(res.ok, true);
  assert.doesNotThrow(() => auth.flushAccounts());
  assert.equal(auth.accounts.get('google-1').username, 'InMemory');
});
