import { describe, it, expect, vi } from 'vitest';
import { GameEngine } from '../src/game.js';

describe('GameEngine', () => {
  it('requires the exact number of ready players before starting', () => {
    const game = new GameEngine();
    const room = game.createRoom({ mode: 'trio_free', player: { id: 'a', name: 'A' } });
    game.setReady(room.code, 'a', true);
    expect(() => game.startRoom(room.code)).toThrow(/ready players/);
  });

  it('advances only the correctly answering player in free mode', () => {
    const game = new GameEngine();
    const room = game.createRoom({ mode: 'duo_free', player: { id: 'a', name: 'A' } });
    game.joinRoom(room.code, { id: 'b', name: 'B' });
    game.setReady(room.code, 'a', true);
    game.setReady(room.code, 'b', true);
    const state = game.getRoom(room.code);
    const qa = state.players.find(p => p.id === 'a').currentQuestion;
    const qb = state.players.find(p => p.id === 'b').currentQuestion;
    game.submitAnswer({ code: room.code, playerId: 'a', questionId: qa.id, value: 'wrong' });
    expect(game.getRoom(room.code).players.find(p => p.id === 'b').currentQuestion.id).toBe(qb.id);
    const correct = game.rooms.get(room.code).players.get('a').currentQuestion.answer;
    game.submitAnswer({ code: room.code, playerId: 'a', questionId: qa.id, value: correct });
    expect(game.getRoom(room.code).players.find(p => p.id === 'a').currentQuestion.id).not.toBe(qa.id);
    clearTimeout(game.rooms.get(room.code).timer);
  });

  it('awards at most one point for a shared race question', () => {
    const game = new GameEngine();
    const room = game.createRoom({ mode: 'duo_race', player: { id: 'a', name: 'A' } });
    game.joinRoom(room.code, { id: 'b', name: 'B' });
    game.setReady(room.code, 'a', true);
    game.setReady(room.code, 'b', true);
    const q = game.rooms.get(room.code).question;
    const answer = q.answer;
    game.submitAnswer({ code: room.code, playerId: 'a', questionId: q.id, value: answer });
    const after = game.getRoom(room.code);
    expect(after.players.find(p => p.id === 'a').score).toBe(1);
    expect(after.question.id).not.toBe(q.id);
    clearTimeout(game.rooms.get(room.code).timer);
  });
});
