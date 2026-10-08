// Test helpers. No extra dependencies: a tiny Socket.IO client built on `ws`
// (already installed for socket.io itself) and a way to mint logged-in sessions
// without going through Google.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const cookieSignature = require('cookie-signature');

const SESSION_SECRET = 'test-session-secret';

// Boots the real server on a random port with an isolated, empty accounts folder.
// Must be called before anything else requires server.js in this process.
async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-game-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.SESSION_SECRET = SESSION_SECRET;

  const srv = require('../server');
  const auth = require('../auth');
  const port = await srv.start(0);

  return {
    ...srv,
    auth,
    port,
    dataDir,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      srv.io.close();
      auth.flushAccounts();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

// Creates a session for `googleId` in the server's session store and returns the
// Cookie header value a browser would send for it.
async function cookieFor(sessionStore, googleId) {
  const sid = crypto.randomBytes(16).toString('hex');
  const sess = {
    cookie: {
      originalMaxAge: 3600000,
      expires: new Date(Date.now() + 3600000).toISOString(),
      secure: true,
      httpOnly: true,
      path: '/',
      sameSite: 'none'
    },
    passport: { user: googleId }
  };
  await new Promise((resolve, reject) => sessionStore.set(sid, sess, (err) => (err ? reject(err) : resolve())));
  const signed = 's:' + cookieSignature.sign(sid, SESSION_SECRET);
  return `connect.sid=${encodeURIComponent(signed)}`;
}

// Minimal Socket.IO v4 client (Engine.IO v4 over a raw WebSocket).
class TestClient {
  constructor(port, cookie) {
    this.received = []; // [{ name, args }] not yet consumed
    this.waiters = [];
    this.id = null;
    this.closed = false;

    this.ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
      headers: cookie ? { Cookie: cookie } : {}
    });

    this.ready = new Promise((resolve, reject) => {
      this.ws.on('error', reject);
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('message', (data) => {
        const msg = data.toString();
        if (msg.startsWith('0')) {
          this.ws.send('40'); // Engine.IO open -> connect to the default namespace
        } else if (msg === '2') {
          this.ws.send('3'); // ping -> pong
        } else if (msg.startsWith('40')) {
          this.id = JSON.parse(msg.slice(2) || '{}').sid;
          resolve(this);
        } else if (msg.startsWith('44')) {
          reject(new Error(`connect_error: ${msg}`));
        } else if (msg.startsWith('42')) {
          const [name, ...args] = JSON.parse(msg.slice(2));
          this._push(name, args);
        }
      });
    });
  }

  _push(name, args) {
    const idx = this.waiters.findIndex((w) => w.name === name);
    if (idx !== -1) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(args[0]);
    } else {
      this.received.push({ name, args });
    }
  }

  emit(name, payload) {
    this.ws.send('42' + JSON.stringify(payload === undefined ? [name] : [name, payload]));
  }

  // Resolves with the payload of the next `name` event (consuming it).
  waitFor(name, timeoutMs = 3000) {
    const idx = this.received.findIndex((e) => e.name === name);
    if (idx !== -1) {
      const [e] = this.received.splice(idx, 1);
      return Promise.resolve(e.args[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for "${name}" (client ${this.id})`));
      }, timeoutMs);
      const waiter = { name, resolve, timer };
      this.waiters.push(waiter);
    });
  }

  // Asserts that NO `name` event arrives within `ms`.
  async expectNone(name, ms = 400) {
    await new Promise((r) => setTimeout(r, ms));
    const got = this.received.find((e) => e.name === name);
    if (got) throw new Error(`unexpected "${name}" event: ${JSON.stringify(got.args[0])}`);
  }

  close() {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}

async function connect(srv, googleId) {
  const cookie = googleId ? await cookieFor(srv.sessionStore, googleId) : undefined;
  const client = new TestClient(srv.port, cookie);
  await client.ready;
  return client;
}

// Creates a real account for a fake Google ID and returns its session cookie.
async function makeAccount(srv, googleId, username) {
  const res = srv.auth.createAccount(googleId, username);
  if (!res.ok) throw new Error(`could not create ${username}: ${res.error}`);
  return res.account;
}

// Plays `symbols` in order for a matched game. `clients` is [clientA, clientB] in
// any order; `matchFound` is the event both received. Waits for each move to land
// before sending the next, so there is no racing.
async function playGame(clients, matchFound, symbols) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const seats = matchFound.players.map((p) => byId.get(p.id));
  for (let i = 0; i < symbols.length; i++) {
    const mover = seats[i % 2];
    mover.emit('makeMove', { roomId: matchFound.roomId, symbol: symbols[i] });
    // Both clients get `moveMade`; consume it from each so queues stay clean.
    await Promise.all(clients.map((c) => c.waitFor('moveMade')));
  }
}

module.exports = { startServer, cookieFor, connect, makeAccount, playGame, TestClient };
