import { generateQuestion, publicQuestion } from './questions.js';

export const MODES = {
  duo_free: { label: 'Duo Free Answer', players: 2, kind: 'free' },
  duo_race: { label: 'Duo First Correct', players: 2, kind: 'race' },
  trio_free: { label: 'Trio Free Answer', players: 3, kind: 'free' },
  trio_race: { label: 'Trio First Correct', players: 3, kind: 'race' }
};

const now = () => Date.now();
const accuracy = p => p.attempts ? Math.round((p.correct / p.attempts) * 100) : 0;

export class GameEngine {
  constructor({ onEvent = () => {}, persistMatch = async () => {} } = {}) {
    this.rooms = new Map();
    this.onEvent = onEvent;
    this.persistMatch = persistMatch;
  }

createRoom({ mode, difficulty = 'easy', player, ranked = false }) {    if (!MODES[mode]) throw new Error('Invalid game mode');
    const code = this.#roomCode();
    const room = {
  code,
  mode,
  difficulty,
  ranked: Boolean(ranked),
  status: 'lobby',
  createdAt: now(),
  startedAt: null,
  endsAt: null,
      players: new Map(), used: new Set(), question: null, questionSequence: 0, timer: null,
      questionLog: [], scoringEvents: [], matchSaved: false
    };
    this.rooms.set(code, room);
    this.joinRoom(code, player);
    return this.snapshot(room);
  }

  joinRoom(code, player) {
    const room = this.#room(code);
    if (room.status !== 'lobby') throw new Error('Match already started');
    if (room.players.has(player.id)) return this.snapshot(room);
    if (room.players.size >= MODES[room.mode].players) throw new Error('Room is full');
    room.players.set(player.id, this.#newPlayer(player));
    this.#emit(room, 'lobby:update', this.snapshot(room));
    return this.snapshot(room);
  }

  leaveRoom(code, playerId) {
    const room = this.#room(code);
    if (room.status === 'lobby') room.players.delete(playerId);
    else {
      const p = room.players.get(playerId);
      if (p) p.connected = false;
    }
    this.#emit(room, 'lobby:update', this.snapshot(room));
  }

  setReady(code, playerId, ready) {
    const room = this.#room(code);
    if (room.status !== 'lobby') throw new Error('Lobby is closed');
    const p = room.players.get(playerId);
    if (!p) throw new Error('Not a room member');
    p.ready = Boolean(ready);
    this.#emit(room, 'lobby:update', this.snapshot(room));
    if (room.players.size === MODES[room.mode].players && [...room.players.values()].every(x => x.ready)) this.startRoom(code);
    return this.snapshot(room);
  }

  startRoom(code) {
    const room = this.#room(code);
    if (room.status !== 'lobby') throw new Error('Match already started');
    if (room.players.size !== MODES[room.mode].players || ![...room.players.values()].every(p => p.ready)) {
      throw new Error(`Exactly ${MODES[room.mode].players} ready players are required`);
    }
    room.status = 'active';
    room.startedAt = now();
    room.endsAt = room.startedAt + 60_000;
    for (const p of room.players.values()) {
      p.currentQuestion = this.#nextQuestion(room);
      p.questionStartedAt = room.startedAt;
    }
    if (MODES[room.mode].kind === 'race') room.question = this.#nextQuestion(room);
    room.timer = setTimeout(() => this.finishRoom(code), Math.max(0, room.endsAt - now()));
    room.timer.unref?.();
    this.#emit(room, 'game:started', this.snapshot(room));
    return this.snapshot(room);
  }

  submitAnswer({ code, playerId, questionId, value, attemptId }) {
    const room = this.#room(code);
    if (room.status !== 'active' || now() >= room.endsAt) {
      if (room.status === 'active') this.finishRoom(code);
      return { accepted: false, reason: 'round_ended' };
    }
    const p = room.players.get(playerId);
    if (!p) return { accepted: false, reason: 'not_a_member' };
    if (typeof value !== 'string' || !/^-?\d{1,9}$/.test(value.trim())) return { accepted: false, reason: 'invalid_answer' };
    if (attemptId && p.attemptIds.has(attemptId)) return { accepted: false, reason: 'duplicate_attempt' };
    if (attemptId) p.attemptIds.add(attemptId);
    const isRace = MODES[room.mode].kind === 'race';
    const q = isRace ? room.question : p.currentQuestion;
    if (!q || q.id !== questionId) return { accepted: false, reason: 'stale_question' };

    p.attempts++;
    const correct = value.trim() === q.answer;
    const responseMs = Math.max(0, now() - p.questionStartedAt);
    const attempt = { playerId, questionId, value: value.trim(), correct, responseMs, at: now() };
    room.questionLog.push(attempt);
    this.#emit(room, 'answer:feedback', { playerId, questionId, correct, responseMs });

    if (correct) {
      p.correct++;
      p.score++;
      p.totalResponseMs += responseMs;
      p.currentStreak++;
      p.bestStreak = Math.max(p.bestStreak, p.currentStreak);
      room.scoringEvents.push({ playerId, questionId, points: 1, at: now() });
      if (isRace) {
        // JavaScript event-loop execution serializes this critical section: only the first accepted correct answer scores.
        room.question = this.#nextQuestion(room);
        for (const player of room.players.values()) player.questionStartedAt = now();
      } else {
        p.currentQuestion = this.#nextQuestion(room);
        p.questionStartedAt = now();
      }
      this.#emit(room, 'game:update', this.snapshot(room));
    } else {
      p.currentStreak = 0;
    }
    return { accepted: true, correct, score: p.score };
  }

  finishRoom(code) {
    const room = this.rooms.get(code);
    if (!room || room.status !== 'active') return room ? this.snapshot(room) : null;
    room.status = 'finished';
    clearTimeout(room.timer);
    room.finishedAt = now();
    const ranked = [...room.players.values()].sort((a, b) =>
      b.correct - a.correct || b.bestStreak - a.bestStreak ||
      (a.totalResponseMs / Math.max(a.correct, 1)) - (b.totalResponseMs / Math.max(b.correct, 1)) ||
      a.id.localeCompare(b.id)
    );
    const top = ranked[0];
    const second = ranked[1];
    const tied = ranked.length > 1 && top.correct === second.correct &&
      top.bestStreak === second.bestStreak &&
      (top.totalResponseMs / Math.max(top.correct, 1)) === (second.totalResponseMs / Math.max(second.correct, 1));
    const result = {
      code: room.code, mode: room.mode, durationMs: Math.min(60_000, room.finishedAt - room.startedAt),
      players: ranked.map((p, index) => ({
        id: p.id, name: p.name, score: p.score, correct: p.correct, attempts: p.attempts,
        accuracy: accuracy(p), averageResponseMs: p.correct ? Math.round(p.totalResponseMs / p.correct) : null,
        bestStreak: p.bestStreak, rank: index + 1, outcome: tied && p.correct === top.correct ? 'draw' : index === 0 ? 'win' : 'loss'
      })),
      attempts: room.questionLog.map(a => ({ ...a, at: undefined })),
      questions: room.questionLog.map(a => ({ questionId: a.questionId, playerId: a.playerId, value: a.value, correct: a.correct, responseMs: a.responseMs }))
    };
    this.#emit(room, 'game:finished', result);
    if (!room.matchSaved) {
      room.matchSaved = true;
      Promise.resolve(this.persistMatch(room, result)).catch(err => console.error('Match persistence failed:', err.message));
    }
    return result;
  }

  getRoom(code) { return this.snapshot(this.#room(code)); }

  snapshot(room) {
    const race = MODES[room.mode]?.kind === 'race';
    return {
code: room.code,
mode: room.mode,
modeLabel: MODES[room.mode]?.label,
difficulty: room.difficulty,
ranked: Boolean(room.ranked),status: room.status, requiredPlayers: MODES[room.mode]?.players,
      startedAt: room.startedAt, endsAt: room.endsAt, remainingMs: room.status === 'active' ? Math.max(0, room.endsAt - now()) : null,
      question: race && room.question ? publicQuestion(room.question) : null,
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, avatar: p.avatar, ready: p.ready, connected: p.connected,
        score: p.score, correct: p.correct, attempts: p.attempts, accuracy: accuracy(p),
        currentQuestion: !race && p.currentQuestion ? publicQuestion(p.currentQuestion) : undefined
      }))
    };
  }

  #newPlayer(player) {
    return { id: String(player.id), name: String(player.name || 'Player').slice(0, 32), avatar: player.avatar || null,
      ready: false, connected: true, score: 0, correct: 0, attempts: 0, totalResponseMs: 0,
      currentStreak: 0, bestStreak: 0, currentQuestion: null, questionStartedAt: now(), attemptIds: new Set() };
  }
  #nextQuestion(room) {
    const q = generateQuestion(room.difficulty, room.used);
    q.sequence = ++room.questionSequence;
    return q;
  }
  #room(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new Error('Room not found');
    return room;
  }
  #roomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let tries = 0; tries < 100; tries++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Unable to allocate room code');
  }
  #emit(room, event, data) { this.onEvent(room.code, event, data); }
}
