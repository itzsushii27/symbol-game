const SYMBOLS = ['X', 'Y', 'Z'];

function isValidSymbol(sym) {
  return SYMBOLS.includes(sym);
}

// Hard cap. By pigeonhole it can never actually be reached: there are only 27
// distinct 3-symbol windows, and P2 wins as soon as any one of them occurs a 4th
// time, so every game is over by length 84 at the latest. Kept as a safety net.
const MAX_LENGTH = 100;

// The single source of truth for "is this sequence finished, and how?".
// Overlapping windows count. P1 and P2 conditions can fire on the same move
// (e.g. XXXXXX: the 5-window XXXXX appears at 0 and 1, AND the 3-window XXX
// appears 4 times) and that is a draw.
// Returns 'p1' | 'p2' | 'draw' | null.
function getOutcome(seq) {
  const p1Win = hasFiveWindowRepeat(seq);
  const p2Win = hasThreeWindowFourTimes(seq);

  if (p1Win && p2Win) return 'draw';
  if (p1Win) return 'p1';
  if (p2Win) return 'p2';
  if (seq.length >= MAX_LENGTH) return 'draw';
  return null;
}

function applyMove(currentSequence, newSymbol) {
  const nextSequence = [...currentSequence, newSymbol];
  return { sequence: nextSequence, outcome: getOutcome(nextSequence) };
}

// True if ANY 5-symbol window occurs more than once (windows may overlap).
// Overlapping repeats can happen as early as length 6 (XXXXXX: windows [0:5] and
// [1:6] are both XXXXX) and length 7 for the alternating case
// (XYXYXYX: [0:5] and [2:7] are both XYXYX).
// This checks every window rather than only the newest one, so it is correct for
// any sequence handed to it, not just ones built one move at a time.
function hasFiveWindowRepeat(seq) {
  if (seq.length < 6) return false;

  const seen = new Set();
  for (let i = 0; i + 5 <= seq.length; i++) {
    const w = seq[i] + seq[i + 1] + seq[i + 2] + seq[i + 3] + seq[i + 4];
    if (seen.has(w)) return true;
    seen.add(w);
  }
  return false;
}

function hasThreeWindowFourTimes(seq) {
  if (seq.length < 3) return false;
  const counts = {};
  for (let i = 0; i <= seq.length - 3; i++) {
    const window = seq.slice(i, i + 3).join('');
    counts[window] = (counts[window] || 0) + 1;
    if (counts[window] >= 4) return true;
  }
  return false;
}

function evaluateSequence(seq, ply) {
  // FIX: terminal positions are decided by getOutcome(), so a simultaneous
  // P1+P2 trigger scores as a draw (0). Before, a 5-window repeat was checked
  // first and returned +5 even when the same move also gave P2 its win, so the
  // bot believed it had WON positions like XXXXXX that are actually draws.
  const terminal = getOutcome(seq);
  if (terminal === 'draw') return 0;
  if (terminal === 'p1') return 5.0 - (ply * 0.05);
  if (terminal === 'p2') return -5.0 + (ply * 0.05);

  let p1Score = 0;
  let p2Score = 0;
  const len = seq.length;

  if (len === 0) return 0;

  // P1 Heuristics
  if (len >= 4) {
    const last4 = seq.slice(-4).join('');
    if (seq.slice(0, -1).join('').includes(last4)) p1Score += 3;
  }
  if (len >= 3) {
    const last3 = seq.slice(-3).join('');
    if (seq.slice(0, -1).join('').includes(last3)) p1Score += 2;
  }
  if (len >= 2) {
    const last2Str = seq.slice(-2).join('');
    if (seq.slice(0, -1).join('').includes(last2Str)) p1Score += 1;

    const matchesOf2 = (seq.join('').match(new RegExp(last2Str, 'g')) || []).length;
    p1Score += Math.min(matchesOf2 * 0.05, 0.2);
  }

  let p1ProximityBonus = 0;
  SYMBOLS.forEach(sym => {
    const testSeq = [...seq, sym];
    if (hasFiveWindowRepeat(testSeq)) p1ProximityBonus += 0.1;
  });
  p1Score += Math.min(p1ProximityBonus, 0.3);

  // P2 Heuristics
  if (len >= 3) {
    const last3Str = seq.slice(-3).join('');
    const priorSeqStr = seq.slice(0, -1).join('');
    const occurrences = (priorSeqStr.match(new RegExp(last3Str, 'g')) || []).length;
    if (occurrences === 1) p2Score += 1;
    else if (occurrences === 2) p2Score += 2;
    else if (occurrences >= 3) p2Score += 3;
  }

  if (len >= 2) {
    const last2Str = seq.slice(-2).join('');
    const matchesOf2 = (seq.join('').match(new RegExp(last2Str, 'g')) || []).length;
    p2Score += Math.min(matchesOf2 * 0.05, 0.2);
  }

  let p2ProximityBonus = 0;
  SYMBOLS.forEach(sym => {
    const testSeq = [...seq, sym];
    if (hasThreeWindowFourTimes(testSeq)) p2ProximityBonus += 0.1;
  });
  p2Score += Math.min(p2ProximityBonus, 0.3);

  return p1Score - p2Score;
}

function minimax(seq, depth, alpha, beta, isMaximizing, ply = 0) {
  if (getOutcome(seq) !== null || depth === 0) {
    return { score: evaluateSequence(seq, ply) };
  }

  let bestMove = null;

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const sym of SYMBOLS) {
      const nextSeq = [...seq, sym];
      const evaluation = minimax(nextSeq, depth - 1, alpha, beta, false, ply + 1).score;
      if (evaluation > maxEval) {
        maxEval = evaluation;
        bestMove = sym;
      }
      alpha = Math.max(alpha, evaluation);
      if (beta <= alpha) break;
    }
    return { score: maxEval, move: bestMove };
  } else {
    let minEval = Infinity;
    for (const sym of SYMBOLS) {
      const nextSeq = [...seq, sym];
      const evaluation = minimax(nextSeq, depth - 1, alpha, beta, true, ply + 1).score;
      if (evaluation < minEval) {
        minEval = evaluation;
        bestMove = sym;
      }
      beta = Math.min(beta, evaluation);
      if (beta <= alpha) break;
    }
    return { score: minEval, move: bestMove };
  }
}

const SKILL_MAP = { 0: 0, 1: 1, 2: 3, 3: 5, 4: 7, 5: 9, 6: 11, 7: 13 };
const DEFAULT_SKILL = 3;

// FIX: the server used `parseInt(skillLevel) || 3`, and since 0 is falsy, picking
// Level 0 (the random bot) silently gave you Level 3. Anything that isn't a valid
// level falls back to the default instead.
function normalizeSkillLevel(raw) {
  const n = Number.parseInt(raw, 10);
  return Object.prototype.hasOwnProperty.call(SKILL_MAP, n) ? n : DEFAULT_SKILL;
}

// FIX: isBotP1 must reflect the bot's actual seat, not be hardcoded to false by the caller.
// See server.js triggerBotMove() — it now reads activeRoom.botIsP1 instead of passing `false`.
function getBotMove(sequence, skillLevel, isBotP1) {
  const depth = SKILL_MAP[skillLevel] ?? 3;
  if (depth === 0) {
    return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  }
  const result = minimax(sequence, depth, -Infinity, Infinity, isBotP1, 0);
  return result.move || SYMBOLS[0];
}

module.exports = {
  isValidSymbol,
  applyMove,
  getOutcome,
  getBotMove,
  normalizeSkillLevel,
  evaluateSequence,
  hasFiveWindowRepeat,
  hasThreeWindowFourTimes,
  SYMBOLS,
  MAX_LENGTH
};
