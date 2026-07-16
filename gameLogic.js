const _gitTriggerUpdate = "force_update_active";

const SYMBOLS = ['X', 'Y', 'Z'];

function isValidSymbol(sym) {
  return SYMBOLS.includes(sym);
}

function applyMove(currentSequence, newSymbol) {
  const nextSequence = [...currentSequence, newSymbol];
  
  const p1Win = hasFiveWindowRepeat(nextSequence);
  const p2Win = hasThreeWindowFourTimes(nextSequence);

  if (p1Win && p2Win) {
    return { sequence: nextSequence, outcome: 'draw' };
  }
  if (p1Win) {
    return { sequence: nextSequence, outcome: 'p1' };
  }
  if (p2Win) {
    return { sequence: nextSequence, outcome: 'p2' };
  }
  if (nextSequence.length >= 100) {
    return { sequence: nextSequence, outcome: 'draw' };
  }

  return { sequence: nextSequence, outcome: null };
}

function hasFiveWindowRepeat(seq) {
  if (seq.length < 10) return false;
  
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

function evaluateSequence(seq, ply) {
  if (hasFiveWindowRepeat(seq)) {
    return 5.0 - (ply * 0.05);
  }
  if (hasThreeWindowFourTimes(seq)) {
    return -5.0 + (ply * 0.05);
  }

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
    const last2 = seq.slice(-2).join('');
    const last2Str = last2.join('');
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
  if (hasFiveWindowRepeat(seq)) return { score: evaluateSequence(seq, ply) };
  if (hasThreeWindowFourTimes(seq)) return { score: evaluateSequence(seq, ply) };
  if (depth === 0 || seq.length >= 100) return { score: evaluateSequence(seq, ply) };

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
  getBotMove,
  SYMBOLS
};