const test = require('node:test');
const assert = require('node:assert/strict');

const {
  updateRating,
  defaultRating,
  isRatedGame,
  scoresFor,
  applyRatedResult
} = require('../rating');

// --- An independent Glicko-2 reference, written step by step from Glickman's paper
// (http://www.glicko.net/glicko/glicko2.pdf), supporting several opponents so it can
// reproduce the paper's own worked example. -----------------------------------------
function reference(player, results, tau = 0.5) {
  const S = 173.7178;
  const mu = (player.rating - 1500) / S;
  const phi = player.rd / S;
  const sigma = player.vol;

  const g = (p) => 1 / Math.sqrt(1 + (3 * p * p) / (Math.PI * Math.PI));
  const E = (m, mj, pj) => 1 / (1 + Math.exp(-g(pj) * (m - mj)));

  const opp = results.map((r) => ({ mu: (r.rating - 1500) / S, phi: r.rd / S, s: r.score }));

  // Step 3
  let vInv = 0;
  for (const o of opp) {
    const e = E(mu, o.mu, o.phi);
    vInv += g(o.phi) ** 2 * e * (1 - e);
  }
  const v = 1 / vInv;

  // Step 4
  let sum = 0;
  for (const o of opp) sum += g(o.phi) * (o.s - E(mu, o.mu, o.phi));
  const delta = v * sum;

  // Step 5 (Illinois algorithm)
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > 1e-9) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  // Steps 6-8
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * sum;
  return { rating: newMu * S + 1500, rd: newPhi * S, vol: newSigma };
}

test('reference implementation reproduces the worked example in the Glicko-2 paper', () => {
  const out = reference(
    { rating: 1500, rd: 200, vol: 0.06 },
    [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 }
    ]
  );
  // Published result: r' = 1464.06, RD' = 151.52, sigma' = 0.05999
  assert.ok(Math.abs(out.rating - 1464.06) < 0.01, `rating ${out.rating}`);
  assert.ok(Math.abs(out.rd - 151.52) < 0.01, `rd ${out.rd}`);
  assert.ok(Math.abs(out.vol - 0.05999) < 0.00001, `vol ${out.vol}`);
});

test('updateRating matches the reference across a grid of ratings, RDs and results', () => {
  const ratings = [800, 1200, 1500, 1650, 2100];
  const rds = [60, 120, 200, 350];
  const scores = [0, 0.5, 1];
  let cases = 0;
  let worstRating = 0;
  let worstRd = 0;

  for (const r1 of ratings) for (const rd1 of rds) for (const r2 of ratings) for (const rd2 of rds) for (const s of scores) {
    const mine = updateRating({ rating: r1, rd: rd1, vol: 0.06 }, { rating: r2, rd: rd2 }, s);
    const ref = reference({ rating: r1, rd: rd1, vol: 0.06 }, [{ rating: r2, rd: rd2, score: s }]);

    for (const k of ['rating', 'rd', 'vol']) {
      assert.ok(Number.isFinite(mine[k]), `${k} not finite for ${r1}/${rd1} vs ${r2}/${rd2} score ${s}`);
    }
    assert.ok(Math.abs(mine.rating - ref.rating) <= 0.5 + 1e-9, `rating off: ${mine.rating} vs ${ref.rating}`);
    assert.ok(Math.abs(mine.rd - ref.rd) <= 0.01, `rd off: ${mine.rd} vs ${ref.rd}`);
    assert.ok(Math.abs(mine.vol - ref.vol) < 1e-6, `vol off: ${mine.vol} vs ${ref.vol}`);
    worstRating = Math.max(worstRating, Math.abs(mine.rating - ref.rating));
    worstRd = Math.max(worstRd, Math.abs(mine.rd - ref.rd));
    cases++;
  }
  assert.equal(cases, 5 * 4 * 5 * 4 * 3);
  console.log(`  checked ${cases} cases; worst rating diff ${worstRating.toFixed(3)} (rounding), worst RD diff ${worstRd.toFixed(4)}`);
});

test('sanity: results move ratings the right way', () => {
  const a = { rating: 1500, rd: 200, vol: 0.06 };
  const win = updateRating(a, a, 1);
  const loss = updateRating(a, a, 0);
  const draw = updateRating(a, a, 0.5);

  assert.ok(win.rating > 1500);
  assert.ok(loss.rating < 1500);
  assert.equal(draw.rating, 1500, 'a draw between equals changes no rating');
  assert.ok(draw.rd < 200 && win.rd < 200 && loss.rd < 200, 'playing a game makes you more certain');
  assert.ok(Math.abs((win.rating - 1500) + (loss.rating - 1500)) <= 1, 'equal win/loss swing');

  const strong = { rating: 1800, rd: 100, vol: 0.06 };
  const weak = { rating: 1200, rd: 100, vol: 0.06 };
  const upset = updateRating(weak, strong, 1).rating - 1200;
  const expected = updateRating(strong, weak, 1).rating - 1800;
  assert.ok(upset > expected * 5, 'beating a much stronger player is worth far more');
});

test('a draw lifts the lower-rated player and costs the higher-rated one', () => {
  const strong = { rating: 1800, rd: 100, vol: 0.06 };
  const weak = { rating: 1500, rd: 100, vol: 0.06 };
  assert.ok(updateRating(weak, strong, 0.5).rating > 1500);
  assert.ok(updateRating(strong, weak, 0.5).rating < 1800);
});

// --- Which games may move ratings ------------------------------------------------------
const alice = { id: 'g-alice' };
const bob = { id: 'g-bob' };

test('isRatedGame: only ranked, human-vs-human, distinct-account, actually-played games count', () => {
  const base = { mode: 'ranked', isBotMatch: false, acc1: alice, acc2: bob, outcome: 'p1' };
  assert.equal(isRatedGame(base), true);
  assert.equal(isRatedGame({ ...base, outcome: 'draw' }), true);
  assert.equal(isRatedGame({ ...base, outcome: 'timeout' }), true);
  assert.equal(isRatedGame({ ...base, outcome: 'forfeit' }), true);

  assert.equal(isRatedGame({ ...base, mode: 'casual' }), false, 'casual');
  assert.equal(isRatedGame({ ...base, isBotMatch: true }), false, 'bot');
  assert.equal(isRatedGame({ ...base, acc2: null }), false, 'missing player');
  assert.equal(isRatedGame({ ...base, acc2: alice }), false, 'playing yourself');
  assert.equal(isRatedGame({ ...base, outcome: 'aborted' }), false, 'aborted');
});

test('scoresFor: win/loss/draw', () => {
  assert.deepEqual(scoresFor(0), [1, 0]);
  assert.deepEqual(scoresFor(1), [0, 1]);
  assert.deepEqual(scoresFor(null), [0.5, 0.5]);
});

function freshAccount(id, rating = 1500, rd = 350) {
  return {
    id,
    ratings: {
      bullet: { ...defaultRating(), rating, rd },
      blitz: defaultRating(),
      rapid: defaultRating()
    }
  };
}

test('applyRatedResult: both players are updated from PRE-game ratings, and only that time control changes', () => {
  const a = freshAccount('a', 1700, 80);
  const b = freshAccount('b', 1400, 150);
  const beforeA = { ...a.ratings.bullet };
  const beforeB = { ...b.ratings.bullet };

  const expectedA = updateRating(beforeA, beforeB, 1);
  const expectedB = updateRating(beforeB, beforeA, 0);

  const { rating1, rating2 } = applyRatedResult(a, b, 'bullet', 0);

  assert.equal(rating1.rating, expectedA.rating);
  assert.equal(rating2.rating, expectedB.rating);
  assert.equal(a.ratings.bullet.rating, expectedA.rating);
  assert.equal(b.ratings.bullet.rating, expectedB.rating);
  assert.equal(a.ratings.bullet.games, 1);
  assert.equal(b.ratings.bullet.games, 1);

  // other time controls are untouched
  assert.deepEqual(a.ratings.blitz, defaultRating());
  assert.deepEqual(b.ratings.rapid, defaultRating());
});

test('applyRatedResult: a draw between two new players leaves both ratings at 1500 but counts the game', () => {
  const a = freshAccount('a');
  const b = freshAccount('b');
  applyRatedResult(a, b, 'bullet', null);
  assert.equal(a.ratings.bullet.rating, 1500);
  assert.equal(b.ratings.bullet.rating, 1500);
  assert.ok(a.ratings.bullet.rd < 350);
  assert.equal(a.ratings.bullet.games, 1);
});

test('applyRatedResult: seat order does not matter (swapping players gives mirrored results)', () => {
  const a1 = freshAccount('a', 1650, 120);
  const b1 = freshAccount('b', 1480, 200);
  const a2 = freshAccount('a', 1650, 120);
  const b2 = freshAccount('b', 1480, 200);

  applyRatedResult(a1, b1, 'bullet', 0); // a is seat 1 and wins
  applyRatedResult(b2, a2, 'bullet', 1); // a is seat 2 and wins

  assert.equal(a1.ratings.bullet.rating, a2.ratings.bullet.rating);
  assert.equal(b1.ratings.bullet.rating, b2.ratings.bullet.rating);
});
