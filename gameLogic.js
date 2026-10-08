const SYMBOLS = ['X', 'Y', 'Z'];

// If nobody has won after this many plies (letters in the sequence), the game is a draw.
const MAX_PLIES = 50;

// Terminal score for a win. Heuristic scores are clamped well below this,
// so a real win can never be outranked by a "good-looking" non-terminal position.
const WIN_SCORE = 5;
const HEURISTIC_CLAMP = 4.9;
// Small per-ply nudge so faster wins / slower losses are preferred.
// Must stay small: WIN_SCORE - MAX_PLIES * PLY_PENALTY (= 4.0) has to stay above the
// heuristic's real maximum (3.5), so a heuristic position never outranks a real win.
const PLY_PENALTY = 0.02;

function isValidSymbol(sym) {
  return SYMBOLS.includes(sym);
}

// Single source of truth for game state.
// Returns 'p1', 'p2', 'draw', or null (game continues).
//  - P1 wins if any 5-letter window appears twice (overlaps allowed).
//  - P2 wins if any 3-letter window appears 4 times (overlaps allowed).
//  - Both at once is a draw (checked FIRST so it is never mistaken for a win).
//  - Reaching MAX_PLIES with no winner is a draw.
function getOutcome(seq) {
  const p1Win = hasFiveWindowRepeat(seq);
  const p2Win = hasThreeWindowFourTimes(seq);

  if (p1Win && p2Win) return 'draw';
  if (p1Win) return 'p1';
  if (p2Win) return 'p2';
  if (seq.length >= MAX_PLIES) return 'draw';
  return null;
}

function applyMove(currentSequence, newSymbol) {
  const nextSequence = [...currentSequence, newSymbol];
  return { sequence: nextSequence, outcome: getOutcome(nextSequence) };
}

// A 5-window repeat is checked for the newest window against all earlier ones.
// Because applyMove runs after every move, this catches every repeat the moment it happens.
// The earliest possible repeat is at length 6 (XXXXXX: windows [0:5] and [1:6] are both "XXXXX").
function hasFiveWindowRepeat(seq) {
  if (seq.length < 5) return false;

  const newestWindow = seq.slice(-5).join('');
  // Search up to the start index of the newest window so it doesn't match itself
  const searchLimit = seq.length - 5;

  for (let i = 0; i < searchLimit; i++) {
    const historicalWindow = seq.slice(i, i + 5).join('');
    if (historicalWindow === newestWindow) {
      return true;
    }
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

// Counts occurrences of `sub` in `str`, INCLUDING overlapping ones
// (matches the game rule: XXXXXX contains XXX four times).
function countOverlapping(str, sub) {
  let count = 0;
  let pos = str.indexOf(sub);
  while (pos !== -1) {
    count++;
    pos = str.indexOf(sub, pos + 1);
  }
  return count;
}

// Score from P1's point of view: positive is good for P1, negative is good for P2.
function terminalScore(outcome, ply) {
  if (outcome === 'p1') return WIN_SCORE - ply * PLY_PENALTY;   // faster wins are better
  if (outcome === 'p2') return -(WIN_SCORE - ply * PLY_PENALTY);
  return 0; // draw
}

function heuristicScore(seq) {
  let p1Score = 0;
  let p2Score = 0;
  const len = seq.length;

  if (len === 0) return 0;

  const full = seq.join('');
  const prior = seq.slice(0, -1).join('');

  // P1 Heuristics
  // The 4-, 3- and 2-letter suffix matches do NOT stack: only the longest
  // suffix that has appeared before is scored (3, else 2, else 1).
  if (len >= 4 && prior.includes(seq.slice(-4).join(''))) {
    p1Score += 3;
  } else if (len >= 3 && prior.includes(seq.slice(-3).join(''))) {
    p1Score += 2;
  } else if (len >= 2 && prior.includes(seq.slice(-2).join(''))) {
    p1Score += 1;
  }
  if (len >= 2) {
    const last2Str = seq.slice(-2).join('');
    const matchesOf2 = countOverlapping(full, last2Str);
    p1Score += Math.min(matchesOf2 * 0.05, 0.2);
  }

  let p1ProximityBonus = 0;
  SYMBOLS.forEach(sym => {
    if (hasFiveWindowRepeat([...seq, sym])) p1ProximityBonus += 0.1;
  });
  p1Score += Math.min(p1ProximityBonus, 0.3);

  // P2 Heuristics
  if (len >= 3) {
    const last3Str = seq.slice(-3).join('');
    // Overlapping count, so XXX in XXXXXX counts correctly
    const occurrences = countOverlapping(prior, last3Str);
    if (occurrences === 1) p2Score += 1;
    else if (occurrences === 2) p2Score += 2;
    else if (occurrences >= 3) p2Score += 3;
  }

  if (len >= 2) {
    const last2Str = seq.slice(-2).join('');
    const matchesOf2 = countOverlapping(full, last2Str);
    p2Score += Math.min(matchesOf2 * 0.05, 0.2);
  }

  let p2ProximityBonus = 0;
  SYMBOLS.forEach(sym => {
    if (hasThreeWindowFourTimes([...seq, sym])) p2ProximityBonus += 0.1;
  });
  p2Score += Math.min(p2ProximityBonus, 0.3);

  const raw = p1Score - p2Score;
  return Math.max(-HEURISTIC_CLAMP, Math.min(HEURISTIC_CLAMP, raw));
}

// Kept for backwards compatibility with any caller of the old function.
function evaluateSequence(seq) {
  const outcome = getOutcome(seq);
  if (outcome) return terminalScore(outcome, seq.length);
  return heuristicScore(seq);
}

function minimax(seq, depth, alpha, beta, isMaximizing) {
  const outcome = getOutcome(seq);
  if (outcome) return { score: terminalScore(outcome, seq.length) };
  if (depth === 0) return { score: heuristicScore(seq) };

  let bestMove = null;

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const sym of SYMBOLS) {
      const nextSeq = [...seq, sym];
      const evaluation = minimax(nextSeq, depth - 1, alpha, beta, false).score;
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
      const evaluation = minimax(nextSeq, depth - 1, alpha, beta, true).score;
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

// isBotP1 must reflect the bot's actual seat (P1 maximizes, P2 minimizes).
// server.js triggerBotMove() should pass activeRoom.botIsP1.
function getBotMove(sequence, skillLevel, isBotP1) {
  const depth = SKILL_MAP[skillLevel] ?? 3;
  if (depth === 0) {
    return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  }
  const result = minimax(sequence, depth, -Infinity, Infinity, isBotP1);
  return result.move || SYMBOLS[0];
}

module.exports = {
  isValidSymbol,
  applyMove,
  getBotMove,
  getOutcome,
  hasFiveWindowRepeat,
  hasThreeWindowFourTimes,
  evaluateSequence,
  SYMBOLS,
  MAX_PLIES
};
