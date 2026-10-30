
import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import { GameEngine, MODES } from './game.js';

// --------------------------------------------------
// WEEK START CALCULATION (INDIAN STANDARD TIME)
// --------------------------------------------------

function getWeekStartIST() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );

  // Midnight IST represented as a UTC timestamp.
  const todayIST = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    -5,
    -30
  );

  // Calculate weekday using the actual IST calendar date.
  const weekday = new Date(
    Date.UTC(values.year, values.month - 1, values.day)
  ).getUTCDay();

  const daysSinceMonday = (weekday + 6) % 7;

  return new Date(
    todayIST - daysSinceMonday * 24 * 60 * 60 * 1000
  ).toISOString();
}

// --------------------------------------------------
// EXPRESS SERVER
// --------------------------------------------------

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://solverway.vercel.app',
  'https://mathcalc-git-fix-security-audit-keerthi05104.vercel.app',
  'https://mathcalc-cpn2cswsw-keerthi05104.vercel.app',

  ...(process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json({ limit: '32kb' }));

// --------------------------------------------------
// SUPABASE CONFIGURATION
// --------------------------------------------------

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

// --------------------------------------------------
// SOCKET.IO CONFIGURATION
// --------------------------------------------------

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// --------------------------------------------------
// BASIC API ROUTES
// --------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'arithmetic-arena',
    time: new Date().toISOString()
  });
});

app.get('/api/modes', (_req, res) => {
  res.json(
    Object.entries(MODES).map(([id, mode]) => ({
      id,
      ...mode
    }))
  );
});

// --------------------------------------------------
// WEEKLY LEADERBOARD
// --------------------------------------------------

app.get('/api/leaderboard/weekly', async (_req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        error: 'Leaderboard service is unavailable.'
      });
    }

    const weekStart = getWeekStartIST();

    const { data: events, error: eventsError } = await supabase
      .from('rating_events')
      .select('player_id, rating_change')
      .gte('created_at', weekStart);

    if (eventsError) throw eventsError;

    const totals = new Map();

    for (const event of events || []) {
      const id = event.player_id;

      totals.set(
        id,
        (totals.get(id) || 0) + event.rating_change
      );
    }

    const playerIds = [...totals.keys()];

    if (playerIds.length === 0) {
      return res.json({
        weekStart,
        timezone: 'Asia/Kolkata',
        leaderboard: []
      });
    }

    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, username, avatar_url, rating')
      .in('id', playerIds);

    if (profilesError) throw profilesError;

    const leaderboard = (profiles || [])
      .map(profile => ({
        playerId: profile.id,
        username: profile.username || 'Player',
        avatarUrl: profile.avatar_url,
        rating: profile.rating,
        weeklyPoints: totals.get(profile.id) || 0
      }))
      .sort((a, b) =>
        b.weeklyPoints - a.weeklyPoints ||
        b.rating - a.rating ||
        a.username.localeCompare(b.username)
      )
      .map((player, index) => ({
        rank: index + 1,
        ...player
      }));

    return res.json({
      weekStart,
      timezone: 'Asia/Kolkata',
      leaderboard
    });

  } catch (error) {
    console.error(
      'Weekly leaderboard failed:',
      error.message
    );

    return res.status(500).json({
      error: 'Unable to load the weekly leaderboard.'
    });
  }
});

// --------------------------------------------------
// CURRENT USER API
// --------------------------------------------------

app.get('/api/me', async (req, res) => {
  try {
    const token = (req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '');

    if (
      !token ||
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_ANON_KEY
    ) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data, error } = await client.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({
        error: 'Invalid session'
      });
    }

    return res.json({
      id: data.user.id,
      email: data.user.email
    });

  } catch (error) {
    console.error('User authentication failed:', error.message);

    return res.status(500).json({
      error: 'Unable to verify user.'
    });
  }
});

// --------------------------------------------------
// GAME ENGINE
// --------------------------------------------------

const engine = new GameEngine({

  onEvent: (room, event, data) => {
    io.to(room).emit(event, data);
  },

  persistMatch: async (room, result) => {

    if (!supabase) {
      console.warn(
        'Match not saved: Supabase service-role client is not configured.'
      );
      return;
    }

    const players = result.players;

    // Validate UUIDs before inserting into the database.
    const isUuid = value =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

    if (
      !players.length ||
      !players.every(player => isUuid(player.id))
    ) {
      console.warn(
        `Match ${room.code} not saved: one or more player IDs are not UUIDs.`
      );
      return;
    }

    const isRanked = Boolean(room.ranked);

    // Ranked matches require existing player profiles.
    if (isRanked) {
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .in('id', players.map(player => player.id));

      if (profileError) throw profileError;

      const profileIds = new Set(
        (profiles || []).map(profile => profile.id)
      );

      if (players.some(player => !profileIds.has(player.id))) {
        throw new Error(
          'Cannot rate this match: a participant profile is missing.'
        );
      }
    }

    const winner = players.find(
      player => player.outcome === 'win'
    );

    // Save match.
    const { data: savedMatch, error: matchError } = await supabase
      .from('matches')
      .insert({
        mode: room.mode,
        status: 'finished',
        player_ids: players.map(player => player.id),
        winner_id: winner?.id ?? null,

        started_at: room.startedAt
          ? new Date(room.startedAt).toISOString()
          : null,

        ended_at: new Date(room.finishedAt).toISOString(),
        rated: isRanked
      })
      .select('id')
      .single();

    if (matchError) throw matchError;

    // Private matches are saved without rating changes.
    if (!isRanked) return;

    const changes = players.map(player => ({
      player_id: player.id,

      rating_change:
        player.outcome === 'win' ? 10 :
        player.outcome === 'loss' ? -8 : 0
    }));

    const { error: ratingError } = await supabase.rpc(
      'apply_ranked_match_ratings',
      {
        p_match_id: savedMatch.id,
        p_changes: changes
      }
    );

    if (ratingError) {
      console.error(
        `Match ${room.code} was saved, but rating updates failed:`,
        ratingError.message
      );

      throw ratingError;
    }

    console.log(
      `Saved match ${room.code}; ranked ratings applied.`
    );
  }
});

// --------------------------------------------------
// SOCKET AUTHENTICATION
// --------------------------------------------------

async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;

    // Authenticated player.
    if (token) {

      if (
        !process.env.SUPABASE_URL ||
        !process.env.SUPABASE_ANON_KEY
      ) {
        return next(
          new Error('Authentication service is not configured.')
        );
      }

      const client = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
      );

      const { data, error } = await client.auth.getUser(token);

      if (error || !data.user) {
        return next(new Error('Unauthorized'));
      }

      const user = data.user;

      const name =
        user.user_metadata?.display_name ||
        user.user_metadata?.full_name ||
        user.email?.split('@')[0] ||
        'Player';

      const avatar =
        user.user_metadata?.avatar_url || null;

      // Initialize profile if it does not exist.
      if (supabase) {
        const { error: profileError } = await supabase
          .from('profiles')
          .upsert(
            { id: user.id },
            {
              onConflict: 'id',
              ignoreDuplicates: true
            }
          );

        if (profileError) {
          console.error(
            'Profile initialization failed:',
            profileError.message
          );

          return next(
            new Error('Unable to initialize player profile.')
          );
        }
      }

      socket.data.player = {
        id: user.id,
        name: String(name).slice(0, 32),
        avatar,
        authenticated: true
      };

      return next();
    }

    // Guest player.
    if (process.env.ALLOW_GUESTS === 'false') {
      return next(new Error('Sign in required'));
    }

    const guestId = String(
      socket.handshake.auth?.guestId || socket.id
    );

    socket.data.player = {
      id: guestId,
      name: String(
        socket.handshake.auth?.name || 'Guest'
      ).slice(0, 32),
      avatar: null,
      authenticated: false
    };

    return next();

  } catch (error) {
    console.error(
      'Socket authentication failed:',
      error.message
    );

    return next(new Error('Authentication failed.'));
  }
}

io.use(authenticateSocket);

// --------------------------------------------------
// MATCHMAKING QUEUES
// --------------------------------------------------

const matchmakingQueues = new Map();
const queuedPlayers = new Map();

// Remove a player from the matchmaking queue.
function removeFromMatchmaking(playerId) {
  const id = String(playerId);
  const entry = queuedPlayers.get(id);

  if (!entry) return false;

  queuedPlayers.delete(id);

  const queue = matchmakingQueues.get(entry.key);

  if (queue) {
    const remaining = queue.filter(
      item => item.player.id !== id
    );

    if (remaining.length) {
      matchmakingQueues.set(entry.key, remaining);
    } else {
      matchmakingQueues.delete(entry.key);
    }
  }

  return true;
}

// Find an existing active room for a player.
function findActiveRoom(playerId) {
  return [...engine.rooms.values()].find(room =>
    room.players.has(String(playerId)) &&
    (
      room.status === 'lobby' ||
      room.status === 'active'
    )
  );
}

// --------------------------------------------------
// RANDOM MATCHMAKING
// --------------------------------------------------

function joinMatchmaking(socket, payload = {}) {
  const {
    mode,
    difficulty = 'easy'
  } = payload || {};

  const player = socket.data.player;

  if (!player) {
    throw new Error('Player authentication required.');
  }

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

  const playerId = String(player.id);
  const key = `${mode}:${difficulty}`;

  const existing = queuedPlayers.get(playerId);

  if (existing && existing.socketId !== socket.id) {
    throw new Error(
      'This player is already searching in another connection.'
    );
  }

  if (existing && existing.key === key) {
    return {
      ok: true,
      status: 'waiting'
    };
  }

  if (existing) {
    removeFromMatchmaking(playerId);
  }

  if (findActiveRoom(playerId)) {
    throw new Error(
      'Leave your current room before searching for a match.'
    );
  }

  // Get the queue for the selected mode and difficulty.
  const queue = matchmakingQueues.get(key) || [];

  // Remove disconnected or outdated queue entries.
  const validQueue = [];

  for (const item of queue) {
    const opponentId = String(item.player.id);
    const opponentSocket = io.sockets.sockets.get(item.socketId);
    const opponentEntry = queuedPlayers.get(opponentId);

    const isValid =
      opponentSocket &&
      opponentEntry &&
      opponentEntry.socketId === item.socketId &&
      opponentEntry.key === key &&
      opponentId !== playerId &&
      !findActiveRoom(opponentId);

    if (isValid) {
      validQueue.push(item);
    } else if (
      opponentEntry &&
      opponentEntry.socketId === item.socketId
    ) {
      queuedPlayers.delete(opponentId);

      if (opponentSocket) {
        opponentSocket.data.matchmakingKey = null;
      }
    }
  }

  if (validQueue.length) {
    matchmakingQueues.set(key, validQueue);
  } else {
    matchmakingQueues.delete(key);
  }

  // No opponent available: add player to queue.
  if (validQueue.length === 0) {
    matchmakingQueues.set(key, [
      {
        socketId: socket.id,
        player,
        key
      }
    ]);

    queuedPlayers.set(playerId, {
      socketId: socket.id,
      key
    });

    socket.data.matchmakingKey = key;

    return {
      ok: true,
      status: 'waiting'
    };
  }

  // Match with the first available opponent.
  const opponent = validQueue.shift();

  if (validQueue.length) {
    matchmakingQueues.set(key, validQueue);
  } else {
    matchmakingQueues.delete(key);
  }

  const opponentSocket = io.sockets.sockets.get(
    opponent.socketId
  );

  // Defensive check before creating the room.
  if (!opponentSocket) {
    queuedPlayers.delete(String(opponent.player.id));

    return joinMatchmaking(socket, payload);
  }

  queuedPlayers.delete(String(opponent.player.id));

  socket.data.matchmakingKey = null;
  opponentSocket.data.matchmakingKey = null;

  // Create a ranked game room.
  const roomState = engine.createRoom({
    mode,
    difficulty,
    player: opponent.player,
    ranked: true
  });

  const code = roomState.code;

  engine.joinRoom(code, player);

  const sockets = [
    opponentSocket,
    socket
  ];

  // Join both players to the Socket.IO room.
  for (const member of sockets) {
    member.join(code);
    member.data.matchmakingRoom = code;

    member.emit('matchmaking:found', {
      code,
      state: engine.getRoom(code)
    });
  }

  // Mark both players ready.
  for (const member of sockets) {
    engine.setReady(
      code,
      member.data.player.id,
      true
    );
  }

  return {
    ok: true,
    status: 'matched',
    code
  };
}

// --------------------------------------------------
// SOCKET CONNECTION AND EVENTS
// --------------------------------------------------

io.on('connection', (socket) => {

  console.log(
    `Player connected: ${socket.id}`
  );

  // ----------------------------------------------
  // MATCHMAKING JOIN
  // ----------------------------------------------

  socket.on(
    'matchmaking:join',
    (payload, ack = () => {}) => {
      try {
        const result = joinMatchmaking(
          socket,
          payload
        );

        ack(result);

      } catch (error) {
        ack({
          ok: false,
          error:
            error.message ||
            'Unable to join matchmaking.'
        });
      }
    }
  );

  // ----------------------------------------------
  // CREATE ROOM
  // ----------------------------------------------

  socket.on(
    'room:create',
    (payload = {}, ack = () => {}) => {
      try {
        removeFromMatchmaking(socket.data.player.id);

        const {
          mode,
          difficulty
        } = payload || {};

        const state = engine.createRoom({
          mode,
          difficulty,
          player: socket.data.player
        });

        socket.join(state.code);

        ack({
          ok: true,
          state
        });

      } catch (error) {
        ack({
          ok: false,
          error: error.message
        });
      }
    }
  );

  // ----------------------------------------------
  // JOIN ROOM
  // ----------------------------------------------

  socket.on(
    'room:join',
    (payload = {}, ack = () => {}) => {
      try {
        removeFromMatchmaking(socket.data.player.id);

        const { code } = payload || {};

        const state = engine.joinRoom(
          code,
          socket.data.player
        );

        socket.join(state.code);

        ack({
          ok: true,
          state
        });

      } catch (error) {
        ack({
          ok: false,
          error: error.message
        });
      }
    }
  );

  // ----------------------------------------------
  // PLAYER READY
  // ----------------------------------------------

  socket.on(
    'room:ready',
    (payload = {}, ack = () => {}) => {
      try {
        const {
          code,
          ready
        } = payload || {};

        const state = engine.setReady(
          code,
          socket.data.player.id,
          ready
        );

        ack({
          ok: true,
          state
        });

      } catch (error) {
        ack({
          ok: false,
          error: error.message
        });
      }
    }
  );

  // ----------------------------------------------
  // ROOM STATE
  // ----------------------------------------------

  socket.on(
    'room:state',
    (payload = {}, ack = () => {}) => {
      try {
        const { code } = payload || {};

        ack({
          ok: true,
          state: engine.getRoom(code)
        });

      } catch (error) {
        ack({
          ok: false,
          error: error.message
        });
      }
    }
  );

  // ----------------------------------------------
  // SUBMIT ANSWER
  // ----------------------------------------------

  socket.on(
    'answer:submit',
    (payload, ack = () => {}) => {
      try {
        if (
          !payload ||
          typeof payload.code !== 'string'
        ) {
          return ack({
            accepted: false,
            reason: 'invalid_payload'
          });
        }

        const result = engine.submitAnswer({
          ...payload,
          playerId: socket.data.player.id
        });

        ack(result);

      } catch (error) {
        ack({
          accepted: false,
          reason: error.message
        });
      }
    }
  );

  // ----------------------------------------------
  // LEAVE ROOM
  // ----------------------------------------------

  socket.on(
    'room:leave',
    (payload = {}) => {
      try {
        const { code } = payload || {};

        engine.leaveRoom(
          code,
          socket.data.player.id
        );

        socket.leave(code);
        socket.data.matchmakingRoom = null;

      } catch (error) {
        console.error(
          'Room leave failed:',
          error.message
        );
      }
    }
  );

  // ----------------------------------------------
  // DISCONNECT
  // ----------------------------------------------

  socket.on('disconnect', () => {

    const playerId = String(
      socket.data.player.id
    );

    console.log(
      `Player disconnected: ${socket.id}`
    );

    // Remove disconnected player from matchmaking.
    const entry = queuedPlayers.get(playerId);

    if (
      entry &&
      entry.socketId === socket.id
    ) {
      removeFromMatchmaking(playerId);
    }

    // Notify the game engine about room disconnection.
    for (const [code, room] of engine.rooms) {
      if (room.players.has(playerId)) {
        try {
          engine.leaveRoom(code, playerId);
        } catch (error) {
          console.error(
            'Room disconnect handling failed:',
            error.message
          );
        }
      }
    }
  });

});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const port = Number(process.env.PORT || 4000);

server.listen(port, () => {
  console.log(
    `SOLVER API listening on ${port}`
  );
});
