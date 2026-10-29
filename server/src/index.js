import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import { GameEngine, MODES } from './game.js';


const app = express();
const server = http.createServer(app);
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: origin.split(',').map(s => s.trim()), credentials: true }));
app.use(express.json({ limit: '32kb' }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const io = new Server(server, { cors: { origin: origin.split(',').map(s => s.trim()), credentials: true } });

app.get('/health', (_req, res) => res.json({ ok: true, service: 'arithmetic-arena', time: new Date().toISOString() }));
app.get('/api/modes', (_req, res) => res.json(Object.entries(MODES).map(([id, mode]) => ({ id, ...mode }))));
app.get('/api/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return res.status(401).json({ error: 'Authentication required' });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid session' });
  res.json({ id: data.user.id, email: data.user.email });
});

const engine = new GameEngine({
  onEvent: (room, event, data) => io.to(room).emit(event, data),
  persistMatch: async (room, result) => {
    if (!supabase) return;
    const { data, error } = await supabase.from('matches').insert({
      room_code: room.code, mode: room.mode, difficulty: room.difficulty,
      started_at: new Date(room.startedAt).toISOString(), finished_at: new Date(room.finishedAt).toISOString(),
      duration_ms: result.durationMs, result: { players: result.players, questions: result.questions }
    }).select('id').single();
    if (error) throw error;
    const participants = result.players.map(p => ({ match_id: data.id, player_id: p.id, score: p.score, correct: p.correct, attempts: p.attempts, accuracy: p.accuracy, rank: p.rank }));
    const { error: participantError } = await supabase.from('match_participants').insert(participants);
    if (participantError) throw participantError;
  }
});

async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  if (token && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return next(new Error('Unauthorized'));
    socket.data.player = { id: data.user.id, name: data.user.user_metadata?.display_name || data.user.email?.split('@')[0] || 'Player', avatar: data.user.user_metadata?.avatar_url || null };
    return next();
  }
  if (process.env.ALLOW_GUESTS === 'false') return next(new Error('Sign in required'));
  const guestId = String(socket.handshake.auth?.guestId || socket.id);
  socket.data.player = { id: guestId, name: String(socket.handshake.auth?.name || 'Guest').slice(0, 32), avatar: null };
  next();
}
io.use(authenticateSocket);
// Random matchmaking queues, separated by mode and difficulty.
const matchmakingQueues = new Map();
const queuedPlayers = new Map();

function removeFromMatchmaking(playerId) {
  const entry = queuedPlayers.get(String(playerId));
  if (!entry) return false;

  queuedPlayers.delete(String(playerId));

  const queue = matchmakingQueues.get(entry.key);
  if (queue) {
    const remaining = queue.filter(
      item => item.player.id !== String(playerId)
    );

    if (remaining.length) {
      matchmakingQueues.set(entry.key, remaining);
    } else {
      matchmakingQueues.delete(entry.key);
    }
  }

  return true;
}

function findActiveRoom(playerId) {
  return [...engine.rooms.values()].find(room =>
    room.players.has(String(playerId)) &&
    (room.status === 'lobby' || room.status === 'active')
  );
}

function joinMatchmaking(socket, payload = {}) {
  const { mode, difficulty = 'easy' } = payload;
  const player = socket.data.player;

  if (!MODES[mode]) {
    throw new Error('Select a valid game mode.');
  }

  if (
    typeof difficulty !== 'string' ||
    difficulty.length < 1 ||
    difficulty.length > 32
  ) {
    throw new Error('Select a valid difficulty.');
  }

  const existing = queuedPlayers.get(String(player.id));

  if (existing && existing.socketId !== socket.id) {
    throw new Error('This player is already searching in another connection.');
  }

  if (existing && existing.key === `${mode}:${difficulty}`) {
    return { ok: true, status: 'waiting' };
  }

  if (existing) removeFromMatchmaking(player.id);

  if (findActiveRoom(player.id)) {
    throw new Error('Leave your current room before searching for a match.');
  }

  const key = `${mode}:${difficulty}`;
  const queue = matchmakingQueues.get(key) || [];

  // Remove stale entries and never pair the same player ID with itself.
  const candidateIndex = queue.findIndex(item =>
    item.player.id !== player.id &&
    io.sockets.sockets.has(item.socketId)
  );

  if (candidateIndex === -1) {
    queue.push({
      socketId: socket.id,
      player,
      key
    });

    matchmakingQueues.set(key, queue);
    queuedPlayers.set(String(player.id), {
      socketId: socket.id,
      key
    });

    socket.data.matchmakingKey = key;

    return { ok: true, status: 'waiting' };
  }

  const [opponent] = queue.splice(candidateIndex, 1);

  if (queue.length) {
    matchmakingQueues.set(key, queue);
  } else {
    matchmakingQueues.delete(key);
  }

  queuedPlayers.delete(String(opponent.player.id));
  socket.data.matchmakingKey = null;
  opponent.socketId && (
    io.sockets.sockets.get(opponent.socketId).data.matchmakingKey = null
  );

  // Reuse the existing engine and room lifecycle.
  const opponentSocket = io.sockets.sockets.get(opponent.socketId);

  if (!opponentSocket || opponent.player.id === player.id) {
    return joinMatchmaking(socket, payload);
  }

  const roomState = engine.createRoom({
    mode,
    difficulty,
    player: opponent.player
  });

  const code = roomState.code;
  engine.joinRoom(code, player);

  const sockets = [opponentSocket, socket];

  for (const member of sockets) {
    member.join(code);
    member.data.matchmakingRoom = code;

    member.emit('matchmaking:found', {
      code,
      state: engine.getRoom(code)
    });
  }

  // The existing engine starts only after all required players are ready.
  for (const member of sockets) {
    engine.setReady(code, member.data.player.id, true);
  }

  return { ok: true, status: 'matched', code };
}

io.on('connection', socket => {
    socket.on('matchmaking:join', (payload, ack = () => {}) => {
    try {
      ack(joinMatchmaking(socket, payload));
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  socket.on('matchmaking:cancel', (_payload, ack = () => {}) => {
    const entry = queuedPlayers.get(String(socket.data.player.id));

    if (entry && entry.socketId === socket.id) {
      removeFromMatchmaking(socket.data.player.id);
      socket.data.matchmakingKey = null;
    }

    ack({ ok: true, cancelled: true });
  });
  socket.on('room:create', ({ mode, difficulty }, ack = () => {}) => {
    try {
      const state = engine.createRoom({ mode, difficulty, player: socket.data.player });
      socket.join(state.code);
      ack({ ok: true, state });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('room:join', ({ code }, ack = () => {}) => {
    try {
      const state = engine.joinRoom(code, socket.data.player);
      socket.join(state.code);
      ack({ ok: true, state });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('room:ready', ({ code, ready }, ack = () => {}) => {
    try { const state = engine.setReady(code, socket.data.player.id, ready); ack({ ok: true, state }); }
    catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('room:state', ({ code }, ack = () => {}) => {
    try { ack({ ok: true, state: engine.getRoom(code) }); } catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('answer:submit', (payload, ack = () => {}) => {
    try {
      if (!payload || typeof payload.code !== 'string') return ack({ accepted: false, reason: 'invalid_payload' });
      ack(engine.submitAnswer({ ...payload, playerId: socket.data.player.id }));
    } catch (e) { ack({ accepted: false, reason: e.message }); }
  });
  socket.on('room:leave', ({ code }) => {
    try { engine.leaveRoom(code, socket.data.player.id); socket.leave(code); } catch {}
  });
  socket.on('disconnect', () => {
    // Keep active players in the room for reconnection; they are marked disconnected.
         const entry = queuedPlayers.get(String(socket.data.player.id));

    if (entry && entry.socketId === socket.id) {
      removeFromMatchmaking(socket.data.player.id);
    }
    for (const [code, room] of engine.rooms) if (room.players.has(socket.data.player.id)) {
      try { engine.leaveRoom(code, socket.data.player.id); } catch {}
    }
  });
});

const port = Number(process.env.PORT || 4000);
server.listen(port, () => console.log(`SOLVER API listening on ${port}`));
