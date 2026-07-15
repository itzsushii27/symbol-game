// Minimal Glicko-2 implementation (no external deps).
// Ratings stored in "Glicko-2 scale" internally, exposed on the normal 1500-ish scale.

const TAU = 0.5; // system volatility constraint, standard default
const SCALE = 173.7178;

function toGlicko2Scale(rating, rd) {
  return {
    mu: (rating - 1500) / SCALE,
    phi: rd / SCALE
  };
}

function fromGlicko2Scale(mu, phi) {
  return {
    rating: mu * SCALE + 1500,
    rd: phi * SCALE
  };
}

function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function E(mu, muj, phij) {
  return 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
}

// player: { rating, rd, vol }  opponent: { rating, rd }  score: 1 win, 0.5 draw, 0 loss
function updateRating(player, opponent, score) {
  const p = toGlicko2Scale(player.rating, player.rd);
  const o = toGlicko2Scale(opponent.rating, opponent.rd);
  let vol = player.vol || 0.06;

  const gPhi = g(o.phi);
  const E_val = E(p.mu, o.mu, o.phi);
  const v = 1 / (gPhi * gPhi * E_val * (1 - E_val));
  const delta = v * gPhi * (score - E_val);

  // Iterative volatility update (simplified Illinois algorithm)
  const a = Math.log(vol * vol);
  let A = a;
  let B;
  const deltaSq = delta * delta;
  const phiSq = p.phi * p.phi;

  const f = (x) => {
    const ex = Math.exp(x);
    const num = ex * (deltaSq - phiSq - v - ex);
    const den = 2 * Math.pow(phiSq + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > 0.000001 && iterations < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    iterations++;
  }

  const newVol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phiSq + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = p.mu + newPhi * newPhi * gPhi * (score - E_val);

  const result = fromGlicko2Scale(newMu, newPhi);
  return {
    rating: Math.round(result.rating),
    rd: Math.round(result.rd * 100) / 100,
    vol: newVol
  };
}

function defaultRating() {
  return { rating: 1500, rd: 350, vol: 0.06 };
}

module.exports = { updateRating, defaultRating };
