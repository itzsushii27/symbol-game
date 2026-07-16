console.log("DIAGNOSTIC - GOOGLE_CLIENT_ID is:", process.env.GOOGLE_CLIENT_ID ? "FOUND" : "NOT FOUND (UNDEFINED)");
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const passport = require('passport');

const { applyMove, isValidSymbol } = require('./gameLogic');
const { updateRating } = require('./rating');
const { configurePassport, accounts, TIME_CONTROLS } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Time control definitions (Fischer clock: base + increment, in ms) ---
const TIME_CONTROL_CONFIG = {
  bullet: { baseMs: 60 * 1000, incrementMs: 1 * 1000, label: '1|1' },
  blitz: { baseMs: 2 * 60 * 1000, incrementMs: 2 * 1000, label: '2|2' },
  rapid: { baseMs: 3 * 60 * 1000, incrementMs: 3 * 1000, label: '3|3' }
};

// 1. Tell Express to trust Render's HTTPS proxy (Crucial for secure cookies)
app.set('trust proxy', 1);

// 2. Define the session middleware ONCE with secure settings for production
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: true,                     // Must be true on Render
    sameSite: 'none'                  // Must be 'none' for cross-site cookie verification
  }
});

configurePassport();

// 3. Apply the middlewares to Express and Socket.io in the correct order
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

app.use(express.static(path.join(__dirname, 'public')));

// --- Auth routes ---
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (req.user) {
    res.json({ loggedIn: true, id: req.user.id, name: req.user.name, ratings: req.user.ratings });
  } else {
    res.json({ loggedIn: false });
  }
});

// --- Game state ---
const connections = new Map(); // socket.id -> { accountId, roomId }
const rooms = new Map();       // roomId -> room object (see below)

// One waiting queue per time control, for SBMM.
// Each entry: { socketId, rating, queuedAt }
const queues = {};
for (const tc of TIME_CONTROLS) queues[tc] = [];

function makeRoomId() {
  return Math.random().toString(36).slice(2, 9);
}

function accountForSocket(socketId) {
  const conn = connections.get(socketId);
  if (!conn) return null;
  return accounts.get(conn.accountId) || null;
}

// SBMM: find the queued player with the closest rating to `rating`.
function findClosestOpponent(queue, rating) {
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const diff = Math.abs(queue[i].rating - rating);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function clearRoomTimer(room) {
  if (room.flagTimeout) {
    clearTimeout(room.flagTimeout);
    room.flagTimeout = null;
  }
}

// Schedule a flag-loss check for whoever's clock is currently running.
function scheduleFlagCheck(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.outcome) return;

  clearRoomTimer(room);

  const activeSocketId = room.players[room.turn % 2];
  const remaining = room.clocks[activeSocketId];

  room.flagTimeout = setTimeout(() => {
    handleFlag(roomId, activeSocketId);
  }, Math.max(remaining, 0));
}

function handleFlag(roomId, flaggedSocketId) {
  const room = rooms.get(roomId);
  if (!room || room.outcome) return;

  room.outcome = 'timeout';
  clearRoomTimer(room);

  const [socketId1, socketId2] = room.players;
  const winnerSocketId = flaggedSocketId === socketId1 ? socketId2 : socketId1;

  settleGame(room, roomId, 'timeout', winnerSocketId);
}

function settleGame(room, roomId, outcome, explicitWinnerSocketId) {
  const [socketId1, socketId2] = room.players;
  const acc1 = accountForSocket(socketId1);
  const acc2 = accountForSocket(socketId2);
  const tc = room.timeControl;

  let winnerId = null;
  if (outcome === 'timeout' || outcome === 'forfeit') {
    winnerId = explicitWinnerSocketId;
  } else if (outcome === 'p1') {
    winnerId = socketId1;
  } else if (outcome === 'p2') {
    winnerId = socketId2;
  } // outcome === 'draw' -> winnerId stays null

  if (acc1 && acc2) {
    let score1;
    if (outcome === 'draw') {
      score1 = 0.5;
    } else {
      score1 = winnerId === socketId1 ? 1 : 0;
    }
    const score2 = 1 - score1;

    const r1 = acc1.ratings[tc];
    const r2 = acc2.ratings[tc];
    const newR1 = updateRating(r1, r2, score1);
    const newR2 = updateRating(r2, r1, score2);
    acc1.ratings[tc] = newR1;
    acc2.ratings[tc] = newR2;

    io.to(roomId).emit('gameOver', {
      outcome,
      winnerId,
      timeControl: tc,
      ratings: { [socketId1]: newR1.rating, [socketId2]: newR2.rating }
    });
  } else {
    io.to(roomId).emit('gameOver', { outcome, winnerId, timeControl: tc, ratings: {} });
  }

  const conn1 = connections.get(socketId1);
  const conn2 = connections.get(socketId2);
  if (conn1) conn1.roomId = null;
  if (conn2) conn2.roomId = null;
}

io.on('connection', (socket) => {
  const user = socket.request.user;

  if (!user) {
    socket.emit('authRequired');
    return;
  }

  connections.set(socket.id, { accountId: user.id, roomId: null });

  socket.on('findMatch', (timeControl) => {
    if (!TIME_CONTROL_CONFIG[timeControl]) return;

    const conn = connections.get(socket.id);
    if (!conn || conn.roomId) return;

    const account = accountForSocket(socket.id);
    if (!account) return;

    const myRating = account.ratings[timeControl].rating;
    const queue = queues[timeControl];

    const opponentIdx = findClosestOpponent(queue, myRating);

    if (opponentIdx !== -1) {
      const opponentEntry = queue.splice(opponentIdx, 1)[0];
      const opponentId = opponentEntry.socketId;
      const opponentSocket = io.sockets.sockets.get(opponentId);
      const opponentConn = connections.get(opponentId);

      if (!opponentSocket || !opponentConn) {
        // stale entry, just queue this player instead
        queue.push({ socketId: socket.id, rating: myRating, queuedAt: Date.now() });
        socket.emit('queued');
        return;
      }

      const roomId = makeRoomId();
      // Random P1/P2 assignment — order[0] is always P1, order[1] is always P2.
      const order = Math.random() < 0.5 ? [socket.id, opponentId] : [opponentId, socket.id];

      const config = TIME_CONTROL_CONFIG[timeControl];
      const clocks = {
        [order[0]]: config.baseMs,
        [order[1]]: config.baseMs
      };

      rooms.set(roomId, {
        sequence: [],
        turn: 0,
        players: order,
        outcome: null,
        timeControl,
        clocks,
        turnStartedAt: Date.now(),
        flagTimeout: null
      });

      conn.roomId = roomId;
      opponentConn.roomId = roomId;

      socket.join(roomId);
      opponentSocket.join(roomId);

      io.to(roomId).emit('matchFound', {
        roomId,
        timeControl,
        timeControlLabel: config.label,
        baseMs: config.baseMs,
        incrementMs: config.incrementMs,
        players: order.map((id) => {
          const acc = accountForSocket(id);
          return {
            id,
            name: acc ? acc.name : 'Player',
            rating: acc ? acc.ratings[timeControl].rating : 1500
          };
        }),
        clocks
      });

      scheduleFlagCheck(roomId);
    } else {
      queue.push({ socketId: socket.id, rating: myRating, queuedAt: Date.now() });
      socket.emit('queued');
    }
  });

  socket.on('cancelFind', (timeControl) => {
    if (!TIME_CONTROL_CONFIG[timeControl]) return;
    const queue = queues[timeControl];