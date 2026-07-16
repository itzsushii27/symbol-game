console.log("DIAGNOSTIC - GOOGLE_CLIENT_ID is:", process.env.GOOGLE_CLIENT_ID ? "FOUND" : "NOT FOUND (UNDEFINED)");
const _gitTriggerUpdate = "force_update_active";

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const passport = require('passport');

const { applyMove, isValidSymbol, getBotMove } = require('./gameLogic');
const { updateRating } = require('./rating');
const { configurePassport, accounts, TIME_CONTROLS } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json()); // support json request bodies

const TIME_CONTROL_CONFIG = {
  bullet: { baseMs: 60 * 1000, incrementMs: 1 * 1000, label: '1|1' },
  blitz: { baseMs: 2 * 60 * 1000, incrementMs: 2 * 1000, label: '2|2' },
  rapid: { baseMs: 3 * 60 * 1000, incrementMs: 3 * 1000, label: '3|3' }
};

app.set('trust proxy', 1);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: true,
    sameSite: 'none'
  }
});

configurePassport();

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
    res.json({ 
      loggedIn: true, 
      id: req.user.id, 
      name: req.user.name, 
      nickname: req.user.nickname || req.user.name,
      ratings: req.user.ratings 
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// Post endpoint to update nickname
app.post('/api/nickname', (req, res) => {
  if (!req.user) return res.status(411).json({ error: 'Unauthorized' });
  const { nickname } = req.body;
  if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid nickname' });
  }
  
  // Find the account and update the nickname
  const userAcc = accounts.get(req.user.id);
  if (userAcc) {
    userAcc.nickname = nickname.trim().substring(0, 20); // enforce limit
    req.user.nickname = userAcc.nickname;
    return res.json({ success: true, nickname: userAcc.nickname });
  }
  return res.status(500).json({ error: 'Account not found' });
});

// Endpoint to fetch leaderboard
app.get('/api/leaderboard/:timeControl', (req, res) => {
  const { timeControl } = req.params;
  if (!TIME_CONTROLS.includes(timeControl)) {
    return res.status(400).json({ error: 'Invalid time control' });
  }

  // Map accounts to list sorted by rating
  const list = Array.from(accounts.values()).map(acc => ({
    nickname: acc.nickname || acc.name,
    rating: Math.round(acc.ratings[timeControl].rating)
  }));

  list.sort((a, b) => b.rating - a.rating);
  res.json(list.slice(0, 10)); // return top 10
});

// --- Game state ---
const connections = new Map(); // socket.id -> { accountId, roomId }
const rooms = new Map();       // roomId -> room object

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
  const acc1 = accountForSocket(socketId1);
  const acc2 = room.isBotMatch ? null : accountForSocket(socketId2);
  const tc = room.timeControl;

  let winnerId = null;
  if (outcome === 'timeout' || outcome === 'forfeit') {
    winnerId = explicitWinnerSocketId;
  } else if (outcome === 'p1') {
    winnerId = socketId1;
  } else if (outcome === 'p2') {
    winnerId = socketId2;
  }

  if (acc1 && acc2 && !room.isBotMatch) {
    let score1 = outcome === 'draw' ? 0.5 : (winnerId === socketId1 ? 1 : 0);
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
      ratings: { 
        [socketId1]: newR1.rating, 
        [socketId2]: newR2.rating 
      }
    });
  } else {
    io.to(roomId).emit('gameOver', { 
      outcome, 
      winnerId, 
      timeControl: tc, 
      ratings: {}, 
      isBotMatch: room.isBotMatch 
    });
  }

  const conn1 = connections.get(socketId1);
  if (conn1) conn1.roomId = null;

  if (!room.isBotMatch) {
    const conn2 = connections.get(socketId2);
    if (conn2) conn2.roomId = null;
  }
}

io.on('connection', (socket) => {
  const user = socket.request.user;

  if (!user) {
    socket.emit('authRequired');
    return;
  }

  connections.set(socket.id, { accountId: user.id, roomId: null });

  // Bot matchmaking event handler
  socket.on('findBotMatch', ({ timeControl, skillLevel }) => {
    if (!TIME_CONTROL_CONFIG[timeControl]) return;
    const conn = connections.get(socket.id);
    if (!conn || conn.roomId) return;

    const account = accountForSocket(socket.id);
    if (!account) return;

    const roomId = makeRoomId();
    // Human is always P1 (order[0]), Bot is always P2 (order[1])
    const order = [socket.id, 'bot'];
    const config = TIME_CONTROL_CONFIG[timeControl];
    
    rooms.set(roomId, {
      sequence: [],
      turn: 0,
      players: order,
      outcome: null,
      timeControl,
      clocks: { [socket.id]: config.baseMs, 'bot': config.baseMs },
      turnStartedAt: Date.now(),
      flagTimeout: null,
      isBotMatch: true,
      botSkill: parseInt(skillLevel) || 3
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
        { id: socket.id, name: account.nickname || account.name, rating: Math.round(account.ratings[timeControl].rating) },
        { id: 'bot', name: `Bot Level ${skillLevel}`, rating: 'CPU' }
      ],
      clocks: { [socket.id]: config.baseMs, 'bot': config.baseMs },
      isBotMatch: true
    });
  });

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
        queue.push({ socketId: socket.id, rating: myRating, queuedAt: Date.now() });
        socket.emit('queued');
        return;
      }

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
        players: [
          { id: order[0], name: p1Acc ? p1Acc.nickname || p1Acc.name : 'Player 1', rating: p1Acc ? Math.round(p1Acc.ratings[timeControl].rating) : 1500 },
          { id: order[1], name: p2Acc ? p2Acc.nickname || p2Acc.name : 'Player 2', rating: p2Acc ? Math.round(p2Acc.ratings[timeControl].rating) : 1500 }
        ],
        clocks,
        isBotMatch: false
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
    const idx = queue.findIndex((e) => e.socketId === socket.id);
    if (idx !== -1) queue.splice(idx, 1);
  });

  socket.on('makeMove', ({ roomId, symbol }) => {
    const room = rooms.get(roomId);
    if (!room || room.outcome) return;
    if (!isValidSymbol(symbol)) return;

    const currentPlayerId = room.players[room.turn % 2];
    if (currentPlayerId !== socket.id) return; 

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
      // It is now the bot's turn
      setTimeout(() => {
        const botMoveSym = getBotMove(room.sequence, room.botSkill, false);
        const botRes = applyMove(room.sequence, botMoveSym);
        room.sequence = botRes.sequence;
        room.turn += 1;
        room.turnStartedAt = Date.now();

        io.to(roomId).emit('moveMade', {
          symbol: botMoveSym,
          sequence: room.sequence,
          nextTurnPlayerId: room.players[room.turn % 2],
          clocks: room.clocks
        });

        if (botRes.outcome) {
          room.outcome = botRes.outcome;
          settleGame(room, roomId, botRes.outcome);
        }
      }, 500); // add half second delay so the bot feels human
    } else {
      scheduleFlagCheck(roomId);
    }
  });

  socket.on('disconnect', () => {
    for (const tc of TIME_CONTROLS) {
      const queue = queues[tc];
      const idx = queue.findIndex((e) => e.socketId === socket.id);
      if (idx !== -1) queue.splice(idx, 1);
    }

    const conn = connections.get(socket.id);
    if (conn && conn.roomId) {
      const room = rooms.get(conn.roomId);
      if (room && !room.outcome) {
        if (!room.isBotMatch) {
          clearRoomTimer(room);
          room.outcome = 'forfeit';

          const [socketId1, socketId2] = room.players;
          const winnerSocketId = socket.id === socketId1 ? socketId2 : socketId1;

          settleGame(room, conn.roomId, 'forfeit', winnerSocketId);
        } else {
          // If bot match, player forfeit
          room.outcome = 'forfeit';
          settleGame(room, conn.roomId, 'forfeit', 'bot');
        }
      }
    }
    connections.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
