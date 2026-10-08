const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const passport = require('passport');

const { applyMove, isValidSymbol, getBotMove, normalizeSkillLevel } = require('./gameLogic');
const { isRatedGame, applyRatedResult } = require('./rating');
const {
  configurePassport,
  initAccounts,
  flushAccounts,
  saveAccounts,
  createAccount,
  accounts,
  TIME_CONTROLS
} = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json()); // support json request bodies

const TIME_CONTROL_CONFIG = {
  bullet: { baseMs: 60 * 1000, incrementMs: 1 * 1000, label: '1|1' },
  blitz: { baseMs: 2 * 60 * 1000, incrementMs: 2 * 1000, label: '2|2' },
  rapid: { baseMs: 3 * 60 * 1000, incrementMs: 3 * 1000, label: '3|3' }
};

const MODES = ['ranked', 'casual'];

// Socket payloads come straight from the network, so treat them as untrusted.
// Destructuring null (or a non-object) throws, and an exception inside a socket
// handler is uncaught and kills the whole server process for every player.
function payloadOf(raw) {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// Strict check: a plain truthiness test on TIME_CONTROL_CONFIG[value] also passes for
// names like "constructor" or "__proto__", which then crash the queue lookups.
function isTimeControl(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TIME_CONTROL_CONFIG, value);
}

// A game only counts as played once both players have made a move. If someone
// disconnects or runs out of time before that, the game is aborted: no winner,
// and nobody's rating changes.
const MIN_MOVES_FOR_RESULT = 2;

app.set('trust proxy', 1);

// Without a SESSION_SECRET anyone who has read this repo could forge a login
// cookie, so fall back to a random per-run secret rather than a public constant.
// (Sessions already live in memory, so restarts sign everyone out regardless.)
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[server] SESSION_SECRET is not set; using a random one for this run. Set it in your environment.');
}

const sessionStore = new session.MemoryStore();

const sessionMiddleware = session({
  secret: sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: true,
    sameSite: 'none'
  }
});

initAccounts();
configurePassport();

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

app.use(express.static(path.join(__dirname, 'public')));

// --- Auth routes ---
// Google sign-in doubles as account creation: a returning Google account logs in;
// a new one is asked to choose a username (see /api/signup below).
// `select_account` makes Google show the account chooser, so a new player picks
// which Google account the permanent username will be tied to.
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile'], prompt: 'select_account' })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (req.user && !req.user.pending) {
    res.json({
      loggedIn: true,
      username: req.user.username,
      ratings: req.user.ratings
    });
  } else if (req.user && req.user.pending) {
    // Signed in with Google, but no game account yet.
    res.json({ loggedIn: false, needsUsername: true });
  } else {
    res.json({ loggedIn: false });
  }
});

// Create the account for the Google user who is currently signed in. The username
// is permanent: there is deliberately no endpoint to change it.
app.post('/api/signup', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in with Google first.' });
  }
  if (!req.user.pending) {
    return res.status(409).json({ error: 'You already have an account.' });
  }

  const result = createAccount(req.user.id, req.body && req.body.username);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json({ success: true, username: result.account.username });
});

// Endpoint to fetch leaderboard
app.get('/api/leaderboard/:timeControl', (req, res) => {
  const { timeControl } = req.params;
  if (!TIME_CONTROLS.includes(timeControl)) {
    return res.status(400).json({ error: 'Invalid time control' });
  }

  // Only players who have actually played a rated game in this time control.
  const list = Array.from(accounts.values())
    .filter(acc => acc.ratings[timeControl].games > 0)
    .map(acc => ({
      username: acc.username,
      rating: Math.round(acc.ratings[timeControl].rating)
    }));

  list.sort((a, b) => b.rating - a.rating);
  res.json(list.slice(0, 10)); // return top 10
});

// --- Game state ---
const connections = new Map(); // socket.id -> { accountId, roomId }
const rooms = new Map();       // roomId -> room object

// Queues are keyed per time control AND mode, so ranked and casual players
// never get cross-matched into a room whose settlement behavior neither of them expects.
const queues = {};
for (const tc of TIME_CONTROLS) {
  queues[tc] = { ranked: [], casual: [] };
}

function makeRoomId() {
  return Math.random().toString(36).slice(2, 9);
}

function accountForSocket(socketId) {
  const conn = connections.get(socketId);
  if (!conn) return null;
  return accounts.get(conn.accountId) || null;
}

// Closest-rated waiting player, never the searcher's own account (no self-play,
// even across two tabs/devices). Returns the index into `queue`, or -1.
function findClosestOpponent(queue, rating, ownAccountId) {
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].accountId === ownAccountId) continue;
    const diff = Math.abs(queue[i].rating - rating);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// A socket should only ever be waiting in ONE queue. Otherwise a player searching
// in two places (two modes/time controls, or clicking Find twice) could be matched
// into two games at once, with the second match overwriting their room state.
function removeFromAllQueues(socketId) {
  for (const tc of TIME_CONTROLS) {
    for (const m of MODES) {
      const queue = queues[tc][m];
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].socketId === socketId) queue.splice(i, 1);
      }
    }
  }
}

function clearRoomTimer(room) {
  if (room.flagTimeout) {
    clearTimeout(room.flagTimeout);
    room.flagTimeout = null;
  }
}

function scheduleFlagCheck(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.outcome || room.isBotMatch) return;

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
  const acc1 = socketId1 === 'bot' ? null : accountForSocket(socketId1);
  const acc2 = socketId2 === 'bot' ? null : accountForSocket(socketId2);
  const tc = room.timeControl;

  // Leaving or flagging before the game really started isn't a loss, it's an abort.
  if ((outcome === 'timeout' || outcome === 'forfeit') && room.sequence.length < MIN_MOVES_FOR_RESULT) {
    outcome = 'aborted';
  }

  // 'draw' and 'aborted' have no winner.
  let winnerId = null;
  if (outcome === 'timeout' || outcome === 'forfeit') {
    winnerId = explicitWinnerSocketId;
  } else if (outcome === 'p1') {
    winnerId = socketId1;
  } else if (outcome === 'p2') {
    winnerId = socketId2;
  }

  const isBotMatch = !!room.isBotMatch || socketId1 === 'bot' || socketId2 === 'bot';
  const isCasual = room.mode === 'casual';
  // Self-play: same Google account controlling both seats (e.g. two tabs/two devices).
  const isSelfPlay = !!(acc1 && acc2 && acc1.id === acc2.id);

  // rating.js is the single place that decides whether a game may move ratings.
  const rated = isRatedGame({ mode: room.mode, isBotMatch, acc1, acc2, outcome });

  let ratings = {};
  if (rated) {
    const winnerSeat = winnerId === null ? null : (winnerId === socketId1 ? 0 : 1);
    const { rating1, rating2 } = applyRatedResult(acc1, acc2, tc, winnerSeat);
    ratings = {
      [socketId1]: rating1.rating,
      [socketId2]: rating2.rating
    };
    saveAccounts();
  }

  io.to(roomId).emit('gameOver', {
    outcome,
    winnerId,
    timeControl: tc,
    mode: room.mode,
    ratings,
    isBotMatch,
    isCasual,
    isSelfPlay
  });

  // Cleanup player connection states
  if (socketId1 !== 'bot') {
    const conn1 = connections.get(socketId1);
    if (conn1) conn1.roomId = null;
  }
  if (socketId2 !== 'bot') {
    const conn2 = connections.get(socketId2);
    if (conn2) conn2.roomId = null;
  }

  clearRoomTimer(room);
  rooms.delete(roomId);
}

function triggerBotMove(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.outcome) return;

  setTimeout(() => {
    const activeRoom = rooms.get(roomId);
    if (!activeRoom || activeRoom.outcome) return;

    // The bot must search for the goal of the seat it was actually assigned.
    const botMoveSym = getBotMove(activeRoom.sequence, activeRoom.botSkill, activeRoom.botIsP1);
    const botRes = applyMove(activeRoom.sequence, botMoveSym);

    activeRoom.sequence = botRes.sequence;
    activeRoom.turn += 1;
    activeRoom.turnStartedAt = Date.now();

    io.to(roomId).emit('moveMade', {
      symbol: botMoveSym,
      sequence: activeRoom.sequence,
      nextTurnPlayerId: activeRoom.players[activeRoom.turn % 2],
      clocks: activeRoom.clocks
    });

    if (botRes.outcome) {
      activeRoom.outcome = botRes.outcome;
      settleGame(activeRoom, roomId, botRes.outcome);
    } else {
      const nextPlayer = activeRoom.players[activeRoom.turn % 2];
      if (nextPlayer === 'bot') {
        triggerBotMove(roomId);
      }
    }
  }, 500); // 500ms humanized delay
}

io.on('connection', (socket) => {
  const user = socket.request.user;

  if (!user) {
    socket.emit('authRequired');
    return;
  }
  if (user.pending) {
    // Signed in with Google but hasn't created an account (chosen a username) yet.
    socket.emit('signupRequired');
    return;
  }

  connections.set(socket.id, { accountId: user.id, roomId: null });

  // Bot matchmaking event handler
  socket.on('findBotMatch', (raw) => {
    const { timeControl, skillLevel } = payloadOf(raw);
    if (!isTimeControl(timeControl)) return;
    const conn = connections.get(socket.id);
    if (!conn || conn.roomId) return;

    const account = accountForSocket(socket.id);
    if (!account) return;

    // Starting a bot game cancels any search in progress.
    removeFromAllQueues(socket.id);

    const roomId = makeRoomId();
    const skill = normalizeSkillLevel(skillLevel);

    // Randomize whether human is Player 1 (first) or Player 2 (second)
    const order = Math.random() < 0.5 ? [socket.id, 'bot'] : ['bot', socket.id];
    const config = TIME_CONTROL_CONFIG[timeControl];
    const botIsP1 = order[0] === 'bot';

    rooms.set(roomId, {
      sequence: [],
      turn: 0,
      players: order,
      outcome: null,
      timeControl,
      mode: 'casual', // bot matches are always unrated practice
      clocks: { [socket.id]: config.baseMs, 'bot': config.baseMs },
      turnStartedAt: Date.now(),
      flagTimeout: null,
      isBotMatch: true,
      botIsP1,
      botSkill: skill
    });

    conn.roomId = roomId;
    socket.join(roomId);

    socket.emit('matchFound', {
      roomId,
      timeControl,
      timeControlLabel: config.label,
      baseMs: config.baseMs,
      incrementMs: config.incrementMs,
      players: [
        { id: socket.id, name: account.username, rating: Math.round(account.ratings[timeControl].rating) },
        { id: 'bot', name: `Bot Level ${skill}`, rating: 'CPU' }
      ],
      clocks: { [socket.id]: config.baseMs, 'bot': config.baseMs },
      isBotMatch: true,
      nextTurnPlayerId: order[0]
    });

    if (botIsP1) {
      triggerBotMove(roomId);
    }
  });

  socket.on('findMatch', (raw) => {
    const { timeControl, mode } = payloadOf(raw);
    if (!isTimeControl(timeControl)) return;
    const matchMode = MODES.includes(mode) ? mode : 'ranked';

    const conn = connections.get(socket.id);
    if (!conn || conn.roomId) return;

    const account = accountForSocket(socket.id);
    if (!account) return;

    // One search at a time: a new search replaces any earlier one from this socket.
    removeFromAllQueues(socket.id);

    const myRating = account.ratings[timeControl].rating;
    const queue = queues[timeControl][matchMode];

    // Find the closest-rated opponent who is genuinely still available. A queue entry
    // can be stale (their socket is gone, or they're somehow already in a game); drop
    // those and keep looking instead of giving up.
    let opponentEntry = null;
    let opponentSocket = null;
    let opponentConn = null;
    while (true) {
      const idx = findClosestOpponent(queue, myRating, account.id);
      if (idx === -1) break;
      const candidate = queue.splice(idx, 1)[0];
      const candidateSocket = io.sockets.sockets.get(candidate.socketId);
      const candidateConn = connections.get(candidate.socketId);
      if (candidateSocket && candidateConn && !candidateConn.roomId) {
        opponentEntry = candidate;
        opponentSocket = candidateSocket;
        opponentConn = candidateConn;
        break;
      }
    }

    if (opponentEntry) {
      const opponentId = opponentEntry.socketId;
      removeFromAllQueues(opponentId);

      const roomId = makeRoomId();
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
        mode: matchMode,
        clocks,
        turnStartedAt: Date.now(),
        flagTimeout: null,
        isBotMatch: false
      });

      conn.roomId = roomId;
      opponentConn.roomId = roomId;

      socket.join(roomId);
      opponentSocket.join(roomId);

      const p1Acc = accountForSocket(order[0]);
      const p2Acc = accountForSocket(order[1]);

      io.to(roomId).emit('matchFound', {
        roomId,
        timeControl,
        timeControlLabel: config.label,
        baseMs: config.baseMs,
        incrementMs: config.incrementMs,
        mode: matchMode,
        players: [
          { id: order[0], name: p1Acc ? p1Acc.username : 'Player 1', rating: p1Acc ? Math.round(p1Acc.ratings[timeControl].rating) : 1500 },
          { id: order[1], name: p2Acc ? p2Acc.username : 'Player 2', rating: p2Acc ? Math.round(p2Acc.ratings[timeControl].rating) : 1500 }
        ],
        clocks,
        isBotMatch: false
      });

      scheduleFlagCheck(roomId);
    } else {
      queue.push({ socketId: socket.id, accountId: account.id, rating: myRating, queuedAt: Date.now() });
      socket.emit('queued');
    }
  });

  // Cancel always removes this player from every queue, whatever time control or
  // mode the client says it is on. (Trusting the client's current selection left
  // "ghost" queue entries behind if they changed the buttons while searching.)
  socket.on('cancelFind', () => {
    removeFromAllQueues(socket.id);
  });

  socket.on('makeMove', (raw) => {
    const { roomId, symbol } = payloadOf(raw);
    const room = rooms.get(roomId);
    if (!room || room.outcome) return;
    if (!isValidSymbol(symbol)) return;

    const currentPlayerId = room.players[room.turn % 2];
    if (currentPlayerId !== socket.id) return; // Not the user's turn

    if (!room.isBotMatch) {
      clearRoomTimer(room);
      const elapsed = Date.now() - room.turnStartedAt;
      const config = TIME_CONTROL_CONFIG[room.timeControl];
      room.clocks[socket.id] = Math.max(room.clocks[socket.id] - elapsed, 0);

      if (room.clocks[socket.id] <= 0) {
        handleFlag(roomId, socket.id);
        return;
      }
      room.clocks[socket.id] += config.incrementMs;
    }

    const { sequence, outcome } = applyMove(room.sequence, symbol);
    room.sequence = sequence;
    room.turn += 1;
    room.turnStartedAt = Date.now();

    io.to(roomId).emit('moveMade', {
      symbol,
      sequence: room.sequence,
      nextTurnPlayerId: room.players[room.turn % 2],
      clocks: room.clocks
    });

    if (outcome) {
      room.outcome = outcome;
      settleGame(room, roomId, outcome);
      return;
    }

    if (room.isBotMatch) {
      const nextPlayer = room.players[room.turn % 2];
      if (nextPlayer === 'bot') {
        triggerBotMove(roomId);
      }
    } else {
      scheduleFlagCheck(roomId);
    }
  });

  socket.on('disconnect', () => {
    removeFromAllQueues(socket.id);

    const conn = connections.get(socket.id);
    if (conn && conn.roomId) {
      const room = rooms.get(conn.roomId);
      if (room && !room.outcome) {
        room.outcome = 'forfeit';
        const [socketId1, socketId2] = room.players;
        const winnerSocketId = socket.id === socketId1 ? socketId2 : socketId1;
        settleGame(room, conn.roomId, 'forfeit', winnerSocketId);
      }
    }
    connections.delete(socket.id);
  });
});

function start(port = process.env.PORT || 3000) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actualPort = server.address().port;
      console.log(`Server running on port ${actualPort}`);
      resolve(actualPort);
    });
  });
}

// Save any pending account changes before the host stops the process.
function shutdown() {
  flushAccounts();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  start();
}

module.exports = { app, server, io, start, sessionStore, rooms, queues, connections };
