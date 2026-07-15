// Core game rules — shared source of truth for the server.
// Symbols: X, Y, Z placed one at a time into a shared sequence.
// P1 wins: any 5-length window repeats another 5-length window exactly.
// P2 wins: any 3-length window has occurred 4 separate times.
// Draw: a single move triggers both conditions at once.

const SYMBOLS = ['X', 'Y', 'Z'];

function countWindows(sequence, windowSize) {
  const counts = new Map();
  for (let i = 0; i + windowSize <= sequence.length; i++) {
    const key = sequence.slice(i, i + windowSize).join('');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// Returns { p1Win: bool, p2Win: bool } after the move that produced `sequence`.
function checkWinConditions(sequence) {
  let p1Win = false;
  let p2Win = false;

  if (sequence.length >= 6) {
    const fiveCounts = countWindows(sequence, 5);
    for (const count of fiveCounts.values()) {
      if (count >= 2) {
        p1Win = true;
        break;
      }
    }
  }

  if (sequence.length >= 3) {
    const threeCounts = countWindows(sequence, 3);
    for (const count of threeCounts.values()) {
      if (count >= 4) {
        p2Win = true;
        break;
      }
    }
  }

  return { p1Win, p2Win };
}

function isValidSymbol(sym) {
  return SYMBOLS.includes(sym);
}

// Simple minimax-friendly evaluator hook (not required for online play,
// but kept here in case you want a "play vs bot" mode later).
function applyMove(sequence, symbol) {
  if (!isValidSymbol(symbol)) {
    throw new Error(`Invalid symbol: ${symbol}`);
  }
  const next = [...sequence, symbol];
  const result = checkWinConditions(next);
  let outcome = null; // null = game continues
  if (result.p1Win && result.p2Win) {
    outcome = 'draw';
  } else if (result.p1Win) {
    outcome = 'p1';
  } else if (result.p2Win) {
    outcome = 'p2';
  }
  return { sequence: next, outcome };
}

module.exports = {
  SYMBOLS,
  checkWinConditions,
  isValidSymbol,
  applyMove
};
