const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { defaultRating } = require('./rating');

const TIME_CONTROLS = ['bullet', 'blitz', 'rapid'];

// In-memory account store, keyed by Google profile id.
// Swap this Map for a real database later if you want accounts to
// survive server restarts (Render free tier restarts periodically).
const accounts = new Map(); // googleId -> { id, name, email, ratings: { bullet, blitz, rapid } }

function freshRatings() {
  const ratings = {};
  for (const tc of TIME_CONTROLS) {
    ratings[tc] = defaultRating();
  }
  return ratings;
}

function getOrCreateAccount(profile) {
  const existing = accounts.get(profile.id);
  if (existing) return existing;

  const account = {
    id: profile.id,
    name: profile.displayName || 'Player',
    email: (profile.emails && profile.emails[0] && profile.emails[0].value) || null,
    ratings: freshRatings()
  };
  accounts.set(profile.id, account);
  return account;
}

function configurePassport() {
  const callbackBase = process.env.OAUTH_CALLBACK_BASE || 'http://localhost:3000';

  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${callbackBase}/auth/google/callback`
    },
    (accessToken, refreshToken, profile, done) => {
      const account = getOrCreateAccount(profile);
      return done(null, account);
    }
  ));

  passport.serializeUser((account, done) => {
    done(null, account.id);
  });

  passport.deserializeUser((id, done) => {
    const account = accounts.get(id) || null;
    done(null, account);
  });
}

module.exports = { configurePassport, accounts, getOrCreateAccount, TIME_CONTROLS };
