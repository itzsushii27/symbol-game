// End-to-end tests against the real server: real HTTP, real Socket.IO traffic, real
// sessions (minted directly, since we can't go through Google here).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startServer, cookieFor, connect, makeAccount, playGame } = require('./helpers');
const { updateRating, defaultRating } = require('../rating');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.stop(); });

async function closeAll(...clients) {
  await Promise.all(clients.map((c) => c.close()));
  await sleep(60); // let the server process the disconnects
}

// Two logged-in players already matched into a game in the given mode/time control.
async function matchedPair(googleA, nameA, googleB, nameB, { timeControl = 'bullet', mode = 'ranked' } = {}) {
  const accA = await makeAccount(srv, googleA, nameA);
  const accB = await makeAccount(srv, googleB, nameB);
  const a = await connect(srv, googleA);
  const b = await connect(srv, googleB);

  a.emit('findMatch', { timeControl, mode });
  await a.waitFor('queued');
  b.emit('findMatch', { timeControl, mode });
  const [matchA, matchB] = await Promise.all([a.waitFor('matchFound'), b.waitFor('matchFound')]);
  assert.equal(matchA.roomId, matchB.roomId);
  return { a, b, accA, accB, match: matchA };
}

// --- Sign-up with Google --------------------------------------------------------------
test('new Google user must create an account (pick a username) before playing', async () => {
  const cookie = await cookieFor(srv.sessionStore, 'g-newbie');

  // Signed in with Google, no account yet.
  let me = await (await fetch(`${srv.base}/api/me`, { headers: { cookie } })).json();
  assert.deepEqual(me, { loggedIn: false, needsUsername: true });

  // They can't play yet: the socket tells them to sign up and ignores matchmaking.
  const pendingSocket = await connect(srv, 'g-newbie');
  await pendingSocket.waitFor('signupRequired');
  pendingSocket.emit('findMatch', { timeControl: 'bullet', mode: 'ranked' });
  await pendingSocket.expectNone('queued');
  await closeAll(pendingSocket);

  const post = (body) => fetch(`${srv.base}/api/signup`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  assert.equal((await post({ username: 'x' })).status, 400);
  assert.equal((await post({ username: '<img src=x onerror=alert(1)>' })).status, 400);
  assert.equal((await post({ username: 'bot' })).status, 400);
  assert.equal((await post({})).status, 400);

  const ok = await post({ username: 'NewbieNick' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true, username: 'NewbieNick' });

  me = await (await fetch(`${srv.base}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.loggedIn, true);
  assert.equal(me.username, 'NewbieNick');
  assert.equal(me.ratings.blitz.rating, 1500);
  assert.equal('id' in me, false, 'the Google ID is not sent to the browser');

  // The username is permanent and the account is one-per-Google-account.
  const second = await post({ username: 'Different' });
  assert.equal(second.status, 409);
  const nick = await fetch(`${srv.base}/api/nickname`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'Different' })
  });
  assert.equal(nick.status, 404, 'there is no way to change a username');
  me = await (await fetch(`${srv.base}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.username, 'NewbieNick');
});

test('usernames are unique across Google accounts (ignoring case)', async () => {
  const cookie = await cookieFor(srv.sessionStore, 'g-copycat');
  const res = await fetch(`${srv.base}/api/signup`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'newbienick' }) // taken by the previous test, different case
  });
  assert.equal(res.status, 409);
  const me = await (await fetch(`${srv.base}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.needsUsername, true, 'still has no account');
});

test('signing up requires being signed in with Google first', async () => {
  const res = await fetch(`${srv.base}/api/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Ghost' })
  });
  assert.equal(res.status, 401);

  const signedOutSocket = await connect(srv, null);
  await signedOutSocket.waitFor('authRequired');
  await closeAll(signedOutSocket);
});

// --- Draws and results ------------------------------------------------------------------
test('XXXXXX in a ranked game is a draw: both players told so, ratings stay 1500, RD shrinks', async () => {
  const { a, b, accA, accB, match } = await matchedPair('g-d1', 'DrawOne', 'g-d2', 'DrawTwo');

  await playGame([a, b], match, ['X', 'X', 'X', 'X', 'X', 'X']);
  const [overA, overB] = await Promise.all([a.waitFor('gameOver'), b.waitFor('gameOver')]);

  for (const over of [overA, overB]) {
    assert.equal(over.outcome, 'draw');
    assert.equal(over.winnerId, null);
    assert.equal(over.mode, 'ranked');
    assert.equal(over.isBotMatch, false);
    assert.equal(over.isCasual, false);
    assert.equal(over.isSelfPlay, false);
    assert.equal(over.ratings[a.id], 1500);
    assert.equal(over.ratings[b.id], 1500);
  }
  for (const acc of [accA, accB]) {
    assert.equal(acc.ratings.bullet.rating, 1500);
    assert.ok(acc.ratings.bullet.rd < 350, 'a rated game makes the rating more certain');
    assert.equal(acc.ratings.bullet.games, 1, 'a draw still counts as a rated game');
  }
  await closeAll(a, b);
});

test('a decisive ranked game (overlapping 5-window) rewards the winner and costs the loser', async () => {
  const { a, b, accA, accB, match } = await matchedPair('g-w1', 'WinnerOne', 'g-w2', 'WinnerTwo');
  const p1Id = match.players[0].id;
  const [p1Acc, p2Acc] = p1Id === a.id ? [accA, accB] : [accB, accA];

  await playGame([a, b], match, 'XYXYXYX'.split(''));
  const [overA, overB] = await Promise.all([a.waitFor('gameOver'), b.waitFor('gameOver')]);

  assert.equal(overA.outcome, 'p1');
  assert.equal(overA.winnerId, p1Id);
  assert.deepEqual(overA, overB);

  const fresh = defaultRating();
  const expectedWinner = updateRating(fresh, fresh, 1).rating;
  const expectedLoser = updateRating(fresh, fresh, 0).rating;
  assert.equal(p1Acc.ratings.bullet.rating, expectedWinner);
  assert.equal(p2Acc.ratings.bullet.rating, expectedLoser);
  assert.ok(expectedWinner > 1500 && expectedLoser < 1500);
  assert.equal(overA.ratings[p1Id], expectedWinner);
  await closeAll(a, b);
});

test('casual games never touch ratings', async () => {
  const { a, b, accA, accB, match } = await matchedPair('g-c1', 'CasualOne', 'g-c2', 'CasualTwo', { mode: 'casual' });
  const before = JSON.stringify([accA.ratings, accB.ratings]);

  await playGame([a, b], match, 'XYXYXYX'.split(''));
  const over = await a.waitFor('gameOver');
  await b.waitFor('gameOver');

  assert.equal(over.outcome, 'p1');
  assert.equal(over.isCasual, true);
  assert.deepEqual(over.ratings, {});
  assert.equal(JSON.stringify([accA.ratings, accB.ratings]), before);
  await closeAll(a, b);
});

test('ranked and casual searches never match each other', async () => {
  await makeAccount(srv, 'g-m1', 'ModeOne');
  await makeAccount(srv, 'g-m2', 'ModeTwo');
  const a = await connect(srv, 'g-m1');
  const b = await connect(srv, 'g-m2');

  a.emit('findMatch', { timeControl: 'blitz', mode: 'ranked' });
  await a.waitFor('queued');
  b.emit('findMatch', { timeControl: 'blitz', mode: 'casual' });
  await b.waitFor('queued');
  await a.expectNone('matchFound');
  await b.expectNone('matchFound');
  await closeAll(a, b);
});

test('playing a bot never touches ratings (level 0 bot, played to the end)', { timeout: 90000 }, async () => {
  const acc = await makeAccount(srv, 'g-bot1', 'BotFighter');
  const before = JSON.stringify(acc.ratings);
  const me = await connect(srv, 'g-bot1');

  me.emit('findBotMatch', { timeControl: 'bullet', skillLevel: 0 });
  const match = await me.waitFor('matchFound');
  assert.equal(match.isBotMatch, true);
  assert.equal(match.players[1].name, 'Bot Level 0', 'level 0 is honoured (it used to become level 3)');

  // Play X whenever it's our turn until the game ends.
  let over = null;
  me.waitFor('gameOver', 85000).then((o) => { over = o; });
  const myId = me.id;
  let nextTurn = match.nextTurnPlayerId;
  while (!over) {
    if (nextTurn === myId) {
      me.emit('makeMove', { roomId: match.roomId, symbol: 'X' });
    }
    const moved = await Promise.race([me.waitFor('moveMade', 5000), sleep(5000).then(() => null)]);
    if (!moved) break;
    nextTurn = moved.nextTurnPlayerId;
    await sleep(5);
  }
  await sleep(100);
  assert.ok(over, 'the game should have finished');
  assert.equal(over.isBotMatch, true);
  assert.deepEqual(over.ratings, {});
  assert.equal(JSON.stringify(acc.ratings), before);
  await closeAll(me);
});

test('the same Google account on two tabs is never matched against itself', async () => {
  const acc = await makeAccount(srv, 'g-self', 'SelfPlayer');
  const before = JSON.stringify(acc.ratings);
  const tab1 = await connect(srv, 'g-self');
  const tab2 = await connect(srv, 'g-self');

  tab1.emit('findMatch', { timeControl: 'rapid', mode: 'ranked' });
  await tab1.waitFor('queued');
  tab2.emit('findMatch', { timeControl: 'rapid', mode: 'ranked' });
  await tab2.waitFor('queued');
  await tab1.expectNone('matchFound');
  await tab2.expectNone('matchFound');
  assert.equal(JSON.stringify(acc.ratings), before);
  await closeAll(tab1, tab2);
});

// --- Matchmaking bugs --------------------------------------------------------------------
test('a new search replaces the old one: no double-booking into two games', async () => {
  await makeAccount(srv, 'g-q1', 'QueueOne');
  await makeAccount(srv, 'g-q2', 'QueueTwo');
  await makeAccount(srv, 'g-q3', 'QueueThree');
  const a = await connect(srv, 'g-q1');
  const b = await connect(srv, 'g-q2');
  const c = await connect(srv, 'g-q3');

  // A searches blitz, then changes their mind and searches bullet.
  a.emit('findMatch', { timeControl: 'blitz', mode: 'ranked' });
  await a.waitFor('queued');
  a.emit('findMatch', { timeControl: 'bullet', mode: 'ranked' });
  await a.waitFor('queued');

  // B looks in blitz: A is no longer there, so B must NOT be matched with A.
  b.emit('findMatch', { timeControl: 'blitz', mode: 'ranked' });
  await b.waitFor('queued');
  await a.expectNone('matchFound');
  await b.expectNone('matchFound');

  // C looks in bullet and gets A, exactly once.
  c.emit('findMatch', { timeControl: 'bullet', mode: 'ranked' });
  const [mA, mC] = await Promise.all([a.waitFor('matchFound'), c.waitFor('matchFound')]);
  assert.equal(mA.roomId, mC.roomId);
  await a.expectNone('matchFound');
  await closeAll(a, b, c);
});

test('clicking Find twice does not leave a ghost entry behind', async () => {
  await makeAccount(srv, 'g-t1', 'TwiceOne');
  await makeAccount(srv, 'g-t2', 'TwiceTwo');
  await makeAccount(srv, 'g-t3', 'TwiceThree');
  const a = await connect(srv, 'g-t1');
  const b = await connect(srv, 'g-t2');
  const c = await connect(srv, 'g-t3');

  a.emit('findMatch', { timeControl: 'rapid', mode: 'ranked' });
  a.emit('findMatch', { timeControl: 'rapid', mode: 'ranked' });
  await a.waitFor('queued');
  await a.waitFor('queued');

  b.emit('findMatch', { timeControl: 'rapid', mode: 'ranked' });
  const [mA] = await Promise.all([a.waitFor('matchFound'), b.waitFor('matchFound')]);

  // A is now in a game. C must NOT be matched with A's leftover queue entry.
  c.emit('findMatch', { timeControl: 'rapid', mode: 'ranked' });
  await c.waitFor('queued');
  await c.expectNone('matchFound');
  assert.ok(mA.roomId);
  await closeAll(a, b, c);
});

test('Cancel always cancels, even if the time control / mode changed while searching', async () => {
  await makeAccount(srv, 'g-x1', 'CancelOne');
  await makeAccount(srv, 'g-x2', 'CancelTwo');
  const a = await connect(srv, 'g-x1');
  const b = await connect(srv, 'g-x2');

  a.emit('findMatch', { timeControl: 'bullet', mode: 'ranked' });
  await a.waitFor('queued');
  // The old client sent whatever buttons were selected at that moment, which could differ.
  a.emit('cancelFind', { timeControl: 'rapid', mode: 'casual' });
  await sleep(50);

  b.emit('findMatch', { timeControl: 'bullet', mode: 'ranked' });
  await b.waitFor('queued');
  await a.expectNone('matchFound');
  await b.expectNone('matchFound');
  await closeAll(a, b);
});

// --- Aborts, forfeits, and not hurting ratings --------------------------------------------
test('leaving before both players have moved aborts the game: no rating change for anyone', async () => {
  const { a, b, accA, accB } = await matchedPair('g-ab1', 'AbortOne', 'g-ab2', 'AbortTwo');
  const before = JSON.stringify([accA.ratings, accB.ratings]);

  await b.close();
  const over = await a.waitFor('gameOver');

  assert.equal(over.outcome, 'aborted');
  assert.equal(over.winnerId, null);
  assert.deepEqual(over.ratings, {});
  assert.equal(JSON.stringify([accA.ratings, accB.ratings]), before);

  // The player who stayed is free to search again.
  a.emit('findMatch', { timeControl: 'bullet', mode: 'ranked' });
  await a.waitFor('queued');
  await closeAll(a);
});

test('disconnecting mid-game (after both have moved) is a forfeit loss and IS rated', async () => {
  const { a, b, accA, accB, match } = await matchedPair('g-ff1', 'ForfeitOne', 'g-ff2', 'ForfeitTwo');
  await playGame([a, b], match, ['X', 'Y']);

  await b.close();
  const over = await a.waitFor('gameOver');

  assert.equal(over.outcome, 'forfeit');
  assert.equal(over.winnerId, a.id);
  assert.ok(accA.ratings.bullet.rating > 1500);
  assert.ok(accB.ratings.bullet.rating < 1500);
  assert.equal(accA.ratings.bullet.games, 1);
  assert.equal(accB.ratings.bullet.games, 1);
  await closeAll(a);
});

// --- Robustness ----------------------------------------------------------------------------
test('malformed or empty socket events cannot crash the server', async () => {
  await makeAccount(srv, 'g-fuzz', 'Fuzzer');
  const f = await connect(srv, 'g-fuzz');

  // Any exception thrown inside a socket handler is an uncaught exception, which
  // would kill the real server process. Record them so the test can fail on them.
  const crashes = [];
  const onCrash = (err) => crashes.push(err.message);
  process.on('uncaughtException', onCrash);
  try {
    f.emit('makeMove');
    f.emit('makeMove', null);
    f.emit('makeMove', 'nope');
    f.emit('makeMove', 42);
    f.emit('makeMove', [1, 2]);
    f.emit('makeMove', { roomId: 12345, symbol: { evil: true } });
    f.emit('findMatch');
    f.emit('findMatch', null);
    f.emit('findMatch', 'nope');
    f.emit('findMatch', { timeControl: '__proto__', mode: 5 });
    f.emit('findMatch', { timeControl: 'constructor', mode: 'ranked' });
    f.emit('findMatch', { timeControl: 'toString', mode: 'casual' });
    f.emit('findMatch', { timeControl: ['bullet'], mode: 'ranked' });
    f.emit('findBotMatch');
    f.emit('findBotMatch', null);
    f.emit('findBotMatch', { timeControl: 'hasOwnProperty' });
    f.emit('findBotMatch', { timeControl: 'bullet', skillLevel: { x: 1 } });
    f.emit('cancelFind');
    await sleep(200);
  } finally {
    process.removeListener('uncaughtException', onCrash);
  }
  assert.deepEqual(crashes, [], 'a malformed event threw inside the server');

  // Still alive and responsive over HTTP and sockets.
  const me = await (await fetch(`${srv.base}/api/me`)).json();
  assert.equal(me.loggedIn, false);
  const lastBot = await f.waitFor('matchFound').catch(() => null); // that last bot request was valid
  assert.ok(lastBot, 'the one valid request still worked');
  await closeAll(f);
});

// --- Leaderboard & persistence ---------------------------------------------------------------
test('leaderboard lists only players with rated games, by username, best first', async () => {
  const board = await (await fetch(`${srv.base}/api/leaderboard/bullet`)).json();

  assert.ok(board.length >= 2);
  for (const row of board) {
    assert.deepEqual(Object.keys(row).sort(), ['rating', 'username']);
  }
  const ratings = board.map((r) => r.rating);
  assert.deepEqual(ratings, [...ratings].sort((x, y) => y - x));

  // Accounts that never played a rated game (e.g. the sign-up-only ones) are absent.
  const names = board.map((r) => r.username);
  assert.ok(!names.includes('NewbieNick'));
  assert.ok(!names.includes('SelfPlayer'));
  assert.ok(!names.includes('CasualOne'));

  const bad = await fetch(`${srv.base}/api/leaderboard/notatimecontrol`);
  assert.equal(bad.status, 400);
});

test('accounts and ratings are written to disk after games', async () => {
  srv.auth.flushAccounts();
  const saved = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'accounts.json'), 'utf8'));

  const byName = Object.fromEntries(saved.accounts.map((a) => [a.username, a]));
  assert.ok(byName.NewbieNick, 'accounts created via sign-up are saved');
  assert.equal(byName.NewbieNick.ratings.bullet.games, 0);
  assert.equal(byName.WinnerOne.ratings.bullet.games + byName.WinnerTwo.ratings.bullet.games, 2);
  assert.equal(byName.DrawOne.ratings.bullet.rating, 1500);
  assert.ok(!JSON.stringify(saved).includes('nickname'));
});
