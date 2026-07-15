const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { applyMove, isValidSymbol } = require('./gameLogic');
const { updateRating, defaultRating } = require('./rating');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory stores (fine for a small free-tier deployment; swap for a DB later)
const players = new Map();   // socket.id -> { name, rating, rd, vol, roomId }
const waitingQueue = [];     // socket.ids waiting for a match
const rooms = new Map();     // roomId -> { sequence, turn, players: [id1, id2], outcome }

function makeRoomId() {
  return Math.random().toString(36).slice(2, 9);
}

function getPlayerRating(socketId) {
  const p = players.get(socketId);
  return p ? { rating: p.rating, rd: p.rd, vol: p.vol } : defaultRating();
}

io.on('connection', (socket) => {
  players.set(socket.id, { name: `Player-${socket.id.slice(0, 4)}`, ...defaultRating(), roomId: null });

  socket.on('setName', (name) => {
    const p = players.get(socket.id);
    if (p && typeof name === 'string' && name.trim().length > 0) {
      p.name = name.trim().slice(0, 20);
    }
  });

  socket.on('findMatch', () => {
    const p = players.get(socket.id);
    if (!p || p.roomId) return;

    if (waitingQueue.length > 0 && waitingQueue[0] !== socket.id) {
      const opponentId = waitingQueue.shift();
      const opponentSocket = io.sockets.sockets.get(opponentId);
      if (!opponentSocket) {
        // stale entry, retry
        waitingQueue.push(socket.id);
        return;
      }

      const roomId = makeRoomId();
      const order = Math.random() < 0.5 ? [socket.id, opponentId] : [opponentId, socket.id];
      rooms.set(roomId, { sequence: [], turn: 0, players: order, outcome: null });

      p.roomId = roomId;
      players.get(opponentId).roomId = roomId;

      socket.join(roomId);
      opponentSocket.join(roomId);

      io.to(roomId).emit('matchFound', {
        roomId,
        players: order.map((id) => ({ id, name: players.get(id).name, rating: players.get(id).rating })),
        yourTurnIndex: null // clients derive their own index
      });
    } else {
      waitingQueue.push(socket.id);
      socket.emit('queued');
    }
  });

  socket.on('cancelFind', () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
  });

  socket.on('makeMove', ({ roomId, symbol }) => {
    const room = rooms.get(roomId);
    if (!room || room.outcome) return;
    if (!isValidSymbol(symbol)) return;

    const currentPlayerId = room.players[room.turn % 2];
    if (currentPlayerId !== socket.id) return; // not your turn

    const { sequence, outcome } = applyMove(room.sequence, symbol);
    room.sequence = sequence;
    room.turn += 1;

    io.to(roomId).emit('moveMade', {
      symbol,
      sequence: room.sequence,
      nextTurnPlayerId: room.players[room.turn % 2]
    });

    if (outcome) {
      room.outcome = outcome;
      const [id1, id2] = room.players;
      const r1 = getPlayerRating(id1);
      const r2 = getPlayerRating(id2);

      let score1;
      if (outcome === 'draw') score1 = 0.5;
      else if (outcome === 'p1') score1 = room.players[0] === id1 ? 1 : 0;
      else score1 = room.players[0] === id1 ? 0 : 1;
      // outcome 'p1' means the player acting as P1 (players[0]) won,
      // outcome 'p2' means the player acting as P2 (players[1]) won.
      if (outcome === 'p1') score1 = 1;
      if (outcome === 'p2') score1 = 0;
      if (outcome === 'draw') score1 = 0.5;
      const score2 = 1 - score1;

      const newR1 = updateRating(r1, r2, score1);
      const newR2 = updateRating(r2, r1, score2);

      const p1 = players.get(id1);
      const p2 = players.get(id2);
      if (p1) Object.assign(p1, newR1);
      if (p2) Object.assign(p2, newR2);

      io.to(roomId).emit('gameOver', {
        outcome,
        ratings: {
          [id1]: newR1.rating,
          [id2]: newR2.rating
        }
      });

      if (p1) p1.roomId = null;
      if (p2) p2.roomId = null;
    }
  });

  socket.on('disconnect', () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const p = players.get(socket.id);
    if (p && p.roomId) {
      const room = rooms.get(p.roomId);
      if (room && !room.outcome) {
        io.to(p.roomId).emit('opponentDisconnected');
      }
    }
    players.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
