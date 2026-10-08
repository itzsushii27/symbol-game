const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyMove,
  getOutcome,
  evaluateSequence,
  getBotMove,
  normalizeSkillLevel,
  hasFiveWindowRepeat,
  hasThreeWindowFourTimes,
  SYMBOLS,
  MAX_LENGTH
} = require('../gameLogic');

// Play a string of moves one at a time; report the first outcome and where it hit.
function play(moves) {
  let seq = [];
  for (const ch of moves) {
    const r = applyMove(seq, ch);
    seq = r.sequence;
    if (r.outcome) return { outcome: r.outcome, length: seq.length };
  }
  return { outcome: null, length: seq.length };
}

// Deliberately naive, independent reimplementation of the rules (O(n^2), no
// shortcuts) to check the real code against.
function oracle(arr) {
  let p1 = false;
  for (let i = 0; i + 5 <= arr.length; i++) {
    for (let j = i + 1; j + 5 <= arr.length; j++) {
      if (arr.slice(i, i + 5).join('') === arr.slice(j, j + 5).join('')) p1 = true;
    }
  }
  let p2 = false;
  const counts = {};
  for (let i = 0; i + 3 <= arr.length; i++) {
    const w = arr.slice(i, i + 3).join('');
    counts[w] = (counts[w] || 0) + 1;
    if (counts[w] >= 4) p2 = true;
  }
  if (p1 && p2) return 'draw';
  if (p1) return 'p1';
  if (p2) return 'p2';
  return null;
}

test('six of the same symbol in a row is a draw (both conditions fire together)', () => {
  for (const s of SYMBOLS) {
    assert.deepEqual(play(s.repeat(6)), { outcome: 'draw', length: 6 });
  }
});

test('five of the same symbol is not over yet', () => {
  for (const s of SYMBOLS) {
    assert.deepEqual(play(s.repeat(5)), { outcome: null, length: 5 });
  }
});

test('a run of six reached after another symbol is also a draw', () => {
  assert.deepEqual(play('YXXXXXX'), { outcome: 'draw', length: 7 });
  assert.deepEqual(play('XZZZZZZ'), { outcome: 'draw', length: 7 });
});

test('overlapping 5-windows count: XYXYXYX is a P1 win at length 7 (not a draw)', () => {
  assert.deepEqual(play('XYXYXYX'), { outcome: 'p1', length: 7 });
});

test('a non-overlapping repeated 5-window is a P1 win', () => {
  // XXYZZ ... XXYZZ with nothing else hitting first
  assert.deepEqual(play('XXYZZYXXYZZ'), { outcome: 'p1', length: 11 });
});

test('P2 wins when a 3-window occurs a 4th time with no 5-window repeat', () => {
  // Breadth-first search for the shortest game that ends in a P2 win.
  let frontier = [[]];
  let found = null;
  for (let depth = 0; depth < 14 && !found; depth++) {
    const next = [];
    for (const seq of frontier) {
      for (const sym of SYMBOLS) {
        const r = applyMove(seq, sym);
        if (r.outcome === 'p2') { found = r.sequence; break; }
        if (!r.outcome) next.push(r.sequence);
      }
      if (found) break;
    }
    frontier = next;
  }
  assert.ok(found, 'expected to find a P2 win');
  assert.equal(hasThreeWindowFourTimes(found), true);
  assert.equal(hasFiveWindowRepeat(found), false);
  assert.equal(play(found.join('')).outcome, 'p2');
});

test('the rules match the brute-force oracle for EVERY game up to length 10', () => {
  let games = 0;
  (function walk(seq) {
    for (const sym of SYMBOLS) {
      const r = applyMove(seq, sym);
      assert.equal(r.outcome, oracle(r.sequence), `mismatch on ${r.sequence.join('')}`);
      games++;
      if (!r.outcome && r.sequence.length < 10) walk(r.sequence);
    }
  })([]);
  assert.ok(games > 10000);
});

test('random complete games: always end at the first moment a condition holds, within 84 moves', () => {
  let longest = 0;
  const tally = { p1: 0, p2: 0, draw: 0 };
  for (let g = 0; g < 5000; g++) {
    let seq = [];
    let outcome = null;
    while (!outcome) {
      const r = applyMove(seq, SYMBOLS[Math.floor(Math.random() * 3)]);
      seq = r.sequence;
      outcome = r.outcome;
      assert.equal(outcome, oracle(seq));
    }
    tally[outcome]++;
    longest = Math.max(longest, seq.length);
  }
  // 27 possible 3-windows x 3 uses each = 81, so a 4th use is forced by 82 windows (length 84).
  assert.ok(longest <= 84, `a game ran ${longest} moves`);
  assert.ok(longest < MAX_LENGTH);
  assert.ok(tally.p1 > 0 && tally.p2 > 0);
});

test('getOutcome is correct for any sequence, not just ones built move by move', () => {
  // An early 5-window repeat followed by unrelated symbols is still detected.
  const seq = 'XXYZZYXXYZZZY'.split('');
  assert.equal(hasFiveWindowRepeat(seq), true);
});

test('bot evaluation: a simultaneous trigger is a draw (0), not a P1 win', () => {
  assert.equal(evaluateSequence('XXXXXX'.split(''), 1), 0);
  assert.equal(evaluateSequence('YXXXXXX'.split(''), 3), 0);
});

test('bot evaluation: P1 wins score positive, P2 wins negative, faster is more extreme', () => {
  const p1 = 'XYXYXYX'.split('');
  assert.ok(evaluateSequence(p1, 2) > 4);
  assert.ok(evaluateSequence(p1, 2) > evaluateSequence(p1, 10));

  let p2seq = null;
  (function find(seq) {
    for (const sym of SYMBOLS) {
      if (p2seq) return;
      const r = applyMove(seq, sym);
      if (r.outcome === 'p2') { p2seq = r.sequence; return; }
      if (!r.outcome && r.sequence.length < 12) find(r.sequence);
    }
  })([]);
  assert.ok(evaluateSequence(p2seq, 2) < -4);
  assert.ok(evaluateSequence(p2seq, 2) < evaluateSequence(p2seq, 10));
});

test('bot always returns a legal symbol at every skill level, as either seat', () => {
  for (let level = 0; level <= 4; level++) {
    for (const isP1 of [true, false]) {
      const seq = (isP1 ? 'XYZXYZ' : 'XYZXY').split('');
      assert.ok(SYMBOLS.includes(getBotMove(seq, level, isP1)), `level ${level}`);
    }
  }
});

test('skill level 0 stays 0 (it used to silently become 3); junk falls back to 3', () => {
  assert.equal(normalizeSkillLevel(0), 0);
  assert.equal(normalizeSkillLevel('0'), 0);
  assert.equal(normalizeSkillLevel(7), 7);
  assert.equal(normalizeSkillLevel(99), 3);
  assert.equal(normalizeSkillLevel(-1), 3);
  assert.equal(normalizeSkillLevel('abc'), 3);
  assert.equal(normalizeSkillLevel(undefined), 3);
});
