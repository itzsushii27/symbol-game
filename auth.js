// auth.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const accounts = new Map(); // database mock
const TIME_CONTROLS = ['bullet', 'blitz', 'rapid'];

function createUser(profile) {
  const newUser = {
    id: profile.id,
    name: profile.displayName,
    nickname: profile.displayName, // default nickname is their real display name
    ratings: {
      bullet: { rating: 1500, rd: 350, vol: 0.06 },
      blitz: { rating: 1500, rd: 350, vol: 0.06 },
      rapid: { rating: 1500, rd: 350, vol: 0.06 }
    }
  };
  accounts.set(profile.id, newUser);
  return newUser;
}

function configurePassport() {
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID || 'dummy-id',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'dummy-secret',
      callbackURL: '/auth/google/callback'
    },
    (accessToken, refreshToken, profile, done) => {
      let user = accounts.get(profile.id);
      if (!user) {
        user = createUser(profile);
      }
      return done(null, user);
    }
  ));

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser((id, done) => {
    const user = accounts.get(id);
    done(null, user || null);
  });
}

module.exports = {
  configurePassport,
  accounts,
  TIME_CONTROLS
};
