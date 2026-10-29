
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { supabase } from './supabase.js';
import {
  Activity,
  ArrowRight,
  Award,
  Check,
  Clock3,
  Copy,
  Gamepad2,
  LogOut,
  Mail,
  Radio,
  ShieldCheck,
  Swords,
  Users,
  X,
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

const MODES = [
  {
    id: 'duo_free',
    title: 'Duo Free Answer',
    players: '2 players',
    desc: 'Your own question stream. Solve at your pace.',
    icon: '∞',
  },
  {
    id: 'duo_race',
    title: 'Duo First Correct',
    players: '2 players',
    desc: 'Race to answer each shared question first.',
    icon: '⚡',
  },
  {
    id: 'trio_free',
    title: 'Trio Free Answer',
    players: '3 players',
    desc: 'Three independent streams, one 60-second round.',
    icon: 'Ⅲ',
  },
  {
    id: 'trio_race',
    title: 'Trio First Correct',
    players: '3 players',
    desc: 'Three players compete on the same question.',
    icon: '🏁',
  },
];

function getGuestId() {
  let id = sessionStorage.getItem('arena_guest_id');

  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('arena_guest_id', id);
  }

  return id;
}

export default function App() {
  const socketRef = useRef(null);
  const inputRef = useRef(null);
  const typingTimer = useRef(null);
  const attemptId = useRef(null);

  const [session, setSession] = useState(null);
  const [authEmail, setAuthEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [authMessage, setAuthMessage] = useState('');

  const [page, setPage] = useState('home');
  const [mode, setMode] = useState('duo_free');
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const [state, setState] = useState(null);
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [remaining, setRemaining] = useState(60000);
  const [results, setResults] = useState(null);

  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [matchmakingStatus, setMatchmakingStatus] = useState('');

  const [leaderboard, setLeaderboard] = useState([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState('');

  const player = session?.user
    ? {
        id: session.user.id,
        name:
          session.user.user_metadata?.display_name ||
          session.user.email?.split('@')[0] ||
          'Player',
      }
    : {
        id: getGuestId(),
        name: `Guest ${getGuestId().slice(0, 4)}`,
      };

  const loadLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    setLeaderboardError('');

    try {
      const response = await fetch(`${API}/api/leaderboard/weekly`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Unable to load leaderboard.');
      }

      setLeaderboard(data.leaderboard || []);
    } catch (error) {
      setLeaderboardError(
        error.message || 'Unable to load leaderboard.'
      );
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  // Restore the Supabase authentication session.
  useEffect(() => {
    if (!supabase) return undefined;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!error) {
        setSession(data.session);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  // Connect the game socket and register event listeners.
  useEffect(() => {
    const socket = io(API, {
      autoConnect: true,
      auth: session?.access_token
        ? { token: session.access_token }
        : { guestId: player.id, name: player.name },
    });

    socketRef.current = socket;

    const onLobby = (newState) => {
      setState(newState);
      setRoomCode(newState.code);
      setPage('lobby');
    };

    const onStarted = (newState) => {
      setState(newState);
      setPage('game');
      setAnswer('');
      setFeedback(null);
      attemptId.current = crypto.randomUUID();

      setTimeout(() => inputRef.current?.focus(), 20);
    };

    const onUpdate = (newState) => {
      setState(newState);
      setRemaining(newState.remainingMs ?? 60000);
    };

    const onFeedback = (result) => {
      if (result.playerId !== player.id) return;

      setFeedback(
        result.correct
          ? { kind: 'good', text: 'Correct! Nice work.' }
          : { kind: 'bad', text: 'Not quite — try again.' }
      );
    };

    const onFinished = (result) => {
      setResults(result);
      setPage('results');
      setState(null);
      setAnswer('');
    };

    const onMatchFound = ({ state: matchedState }) => {
      setState(matchedState);
      setRoomCode(matchedState.code);
      setMatchmakingStatus('');
      setPage('lobby');
      setToast('Players found! Starting your match…');
    };

    const onMatchmakingError = ({ message }) => {
      setMatchmakingStatus('');
      setPage('modes');
      setToast(message || 'Matchmaking failed. Please try again.');
    };

    socket.on('lobby:update', onLobby);
    socket.on('game:started', onStarted);
    socket.on('game:update', onUpdate);
    socket.on('answer:feedback', onFeedback);
    socket.on('game:finished', onFinished);
    socket.on('matchmaking:found', onMatchFound);
    socket.on('matchmaking:error', onMatchmakingError);

    return () => {
      socket.off('lobby:update', onLobby);
      socket.off('game:started', onStarted);
      socket.off('game:update', onUpdate);
      socket.off('answer:feedback', onFeedback);
      socket.off('game:finished', onFinished);
      socket.off('matchmaking:found', onMatchFound);
      socket.off('matchmaking:error', onMatchmakingError);
      socket.disconnect();

      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [session?.access_token, player.id, player.name]);

  // Update the countdown timer.
  useEffect(() => {
    if (page !== 'game' || !state?.endsAt) return undefined;

    const tick = () => {
      setRemaining(Math.max(0, state.endsAt - Date.now()));
    };

    tick();

    const timerId = setInterval(tick, 100);

    return () => clearInterval(timerId);
  }, [page, state?.endsAt]);

  // Choose the question appropriate to the current game mode.
  const currentQuestion = useCallback(() => {
    if (!state) return null;

    if (state.mode?.endsWith('_race')) {
      return state.question;
    }

    return state.players?.find(
      (p) => p.id === player.id
    )?.currentQuestion;
  }, [state, player.id]);

  // Focus the answer input when the question changes.
  useEffect(() => {
    if (page !== 'game') return undefined;

    setAnswer('');
    setFeedback(null);
    attemptId.current = crypto.randomUUID();

    const timerId = setTimeout(() => {
      inputRef.current?.focus();
    }, 30);

    return () => clearTimeout(timerId);
  }, [
    page,
    state?.question?.id,
    state?.players?.find((p) => p.id === player.id)?.currentQuestion?.id,
    player.id,
  ]);

  // Send an event to the backend and wait for its acknowledgement.
  const connectAction = (event, payload) =>
    new Promise((resolve) => {
      const socket = socketRef.current;

      if (!socket?.connected) {
        resolve({
          ok: false,
          error: 'Connecting to server. Try again in a moment.',
        });
        return;
      }

      socket.emit(event, payload, resolve);
    });

  const createRoom = async () => {
    setBusy(true);

    try {
      const result = await connectAction('room:create', { mode });

      if (!result?.ok) {
        setToast(result?.error || 'Could not create room.');
        return;
      }

      setState(result.state);
      setRoomCode(result.state.code);
      setPage('lobby');
    } finally {
      setBusy(false);
    }
  };

  const startMatchmaking = async () => {
    if (!session?.access_token) {
      setToast('Sign in before entering ranked matchmaking.');
      setPage('auth');
      return;
    }

    setBusy(true);
    setMatchmakingStatus('Searching for compatible players…');

    try {
      const result = await connectAction('matchmaking:join', { mode });

      if (!result?.ok) {
        setMatchmakingStatus('');
        setToast(result?.error || 'Could not find a match.');
        return;
      }

      if (result.status === 'waiting') {
        setMatchmakingStatus(
          `Searching for players within ${
            result.maxRatingGap ?? 50
          } rating points…`
        );
      } else if (result.status === 'matched') {
        setMatchmakingStatus('');
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelMatchmaking = async () => {
    const result = await connectAction('matchmaking:cancel', {});

    if (!result?.ok) {
      setToast(result?.error || 'Could not cancel matchmaking.');
      return;
    }

    setMatchmakingStatus('');
    setToast('Matchmaking cancelled.');
  };

  const joinRoom = async () => {
    setBusy(true);

    try {
      const result = await connectAction('room:join', {
        code: joinCode.trim().toUpperCase(),
      });

      if (!result?.ok) {
        setToast(result?.error || 'Could not join room.');
        return;
      }

      setState(result.state);
      setRoomCode(result.state.code);
      setPage('lobby');
    } finally {
      setBusy(false);
    }
  };

  const toggleReady = async () => {
    const me = state?.players?.find((p) => p.id === player.id);

    const result = await connectAction('room:ready', {
      code: roomCode,
      ready: !me?.ready,
    });

    if (!result?.ok) {
      setToast(result?.error || 'Could not change ready status.');
    } else {
      setState(result.state);
    }
  };

  const submitAnswer = useCallback(
    async (value) => {
      const question = currentQuestion();
      const trimmedValue = value.trim();

      if (
        !question ||
        !trimmedValue ||
        !/^-?\d{1,9}$/.test(trimmedValue) ||
        !socketRef.current?.connected
      ) {
        return;
      }

      const submittedId = crypto.randomUUID();

      const result = await connectAction('answer:submit', {
        code: roomCode,
        questionId: question.id,
        value: trimmedValue,
        attemptId: submittedId,
      });

      if (result?.accepted && result.correct) {
        setAnswer('');
        attemptId.current = crypto.randomUUID();
        setFeedback({
          kind: 'good',
          text: 'Correct! Next question…',
        });

        setTimeout(() => inputRef.current?.focus(), 20);
      } else if (result?.reason === 'invalid_answer') {
        setFeedback({
          kind: 'bad',
          text: 'Enter a whole number.',
        });
      }
    },
    [currentQuestion, roomCode]
  );

  const onAnswerChange = (value) => {
    setAnswer(value);
    setFeedback(null);

    clearTimeout(typingTimer.current);

    if (/^-?\d{1,9}$/.test(value.trim())) {
      typingTimer.current = setTimeout(() => {
        submitAnswer(value);
      }, 450);
    }
  };

  const signInGoogle = async () => {
    if (!supabase) {
      setAuthMessage(
        'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable authentication.'
      );
      return;
    }

    setBusy(true);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setAuthMessage(error.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const sendOtp = async () => {
    if (!supabase) {
      setAuthMessage(
        'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable email OTP.'
      );
      return;
    }

    setBusy(true);

    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: authEmail.trim(),
        options: { shouldCreateUser: true },
      });

      if (error) {
        setAuthMessage(error.message);
      } else {
        setOtpSent(true);
        setAuthMessage('Check your inbox for the verification code.');
      }
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    if (!supabase) return;

    setBusy(true);

    try {
      const { error } = await supabase.auth.verifyOtp({
        email: authEmail.trim(),
        token: otp.trim(),
        type: 'email',
      });

      setAuthMessage(
        error ? error.message : 'Signed in successfully.'
      );
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await supabase?.auth.signOut();
    setPage('home');
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setToast('Room code copied.');
    } catch {
      setToast('Unable to copy the room code.');
    }
  };

  const me = state?.players?.find((p) => p.id === player.id);
  const q = currentQuestion();
  const seconds = Math.ceil(remaining / 1000);
  const mmss = `00:${String(Math.max(0, seconds)).padStart(2, '0')}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => setPage('home')}
          aria-label="SOLVER home"
        >
          <span className="brand-mark">
            <Gamepad2 size={20} />
          </span>
          <span>
            SOLV<span className="brand-accent">ER</span>
          </span>
        </button>

        <nav>
          <button className="nav-link" onClick={() => setPage('home')}>
            Play
          </button>

          <button
            className="nav-link"
            onClick={() => {
              setPage('leaderboard');
              loadLeaderboard();
            }}
          >
            <Award size={15} /> Leaderboard
          </button>

          <button className="nav-link" onClick={() => setPage('profile')}>
            My stats
          </button>
        </nav>

        <div className="top-actions">
          {session ? (
            <>
              <span className="user-pill">
                <span className="online-dot" />
                {player.name}
              </span>

              <button
                className="icon-btn"
                onClick={logout}
                title="Sign out"
              >
                <LogOut size={17} />
              </button>
            </>
          ) : (
            <button
              className="button button-ghost button-small"
              onClick={() => setPage('auth')}
            >
              Sign in <ArrowRight size={15} />
            </button>
          )}
        </div>
      </header>

      {/* HOME */}
      {page === 'home' && (
        <main className="main-content">
          <section className="hero">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="pulse-dot" /> LIVE MULTIPLAYER MATH
              </div>

              <h1>
                Think fast.
                <br />
                <span>Play smarter.</span>
              </h1>

              <p>
                One minute. Real opponents. Pure mental math.
                Challenge friends and see how your focus stacks up.
              </p>

              <div className="hero-actions">
                <button
                  className="button button-primary"
                  onClick={() => setPage('modes')}
                >
                  Start a match <ArrowRight size={17} />
                </button>

                <button
                  className="button button-ghost"
                  onClick={() => setPage('join')}
                >
                  Join with code
                </button>
              </div>

              <div className="trust-row">
                <span><ShieldCheck size={15} /> Server-scored</span>
                <span><Radio size={15} /> Real-time</span>
                <span><Clock3 size={15} /> 60-second rounds</span>
              </div>
            </div>

            <div className="hero-art">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />

              <div className="math-card card-back">
                <span className="tiny-label">STREAK</span>
                <strong>+7</strong>
                <small>on fire</small>
              </div>

              <div className="math-card card-front">
                <span className="tiny-label">QUICK THINKING</span>

                <div className="equation">
                  18 <i>×</i> 7 <b>=</b> <em>126</em>
                </div>

                <div className="card-line" />

                <div className="card-footer">
                  <span className="mini-avatar">K</span>
                  <span>You're warming up</span>
                  <span className="check-circle">
                    <Check size={13} />
                  </span>
                </div>
              </div>

              <div className="floating-chip chip-top">
                <span className="chip-icon">⚡</span>
                <span>
                  <b>Fastest wins</b>
                  <small>Every millisecond counts</small>
                </span>
              </div>

              <div className="floating-chip chip-bottom">
                <span className="avatar-stack">
                  <i>A</i><i>R</i><i>J</i>
                </span>
                <span>
                  <b>Play together</b>
                  <small>2 or 3 players</small>
                </span>
              </div>
            </div>
          </section>

          <section className="section-head">
            <div>
              <div className="eyebrow">CHOOSE YOUR CHALLENGE</div>
              <h2>Four ways to compete</h2>
            </div>

            <button
              className="text-link"
              onClick={() => setPage('modes')}
            >
              All game modes <ArrowRight size={15} />
            </button>
          </section>

          <section className="mode-grid">
            {MODES.map((m, i) => (
              <button
                key={m.id}
                className="mode-card"
                onClick={() => {
                  setMode(m.id);
                  setPage('modes');
                }}
              >
                <div className={`mode-icon mode-${i}`}>{m.icon}</div>

                <div className="mode-card-title">
                  {m.title} <ArrowRight size={15} />
                </div>

                <p>{m.desc}</p>

                <div className="mode-card-foot">
                  <span>{m.players}</span>
                  <span className="mode-tag">
                    {m.id.endsWith('free') ? 'FREE FLOW' : 'RACE MODE'}
                  </span>
                </div>
              </button>
            ))}
          </section>
        </main>
      )}

      {/* MATCH SETUP */}
      {page === 'modes' && (
        <main className="page-wrap">
          <button
            className="back-link"
            onClick={() => setPage('home')}
          >
            ← Back
          </button>

          <div className="page-heading">
            <div className="eyebrow">MATCH SETUP</div>
            <h1>Choose your game</h1>
            <p>
              Pick a game format, then find opponents or create a private room.
            </p>
          </div>

          <div className="mode-list">
            {MODES.map((m, i) => (
              <button
                key={m.id}
                className={`mode-row ${mode === m.id ? 'selected' : ''}`}
                onClick={() => setMode(m.id)}
              >
                <span className={`mode-icon mode-${i}`}>{m.icon}</span>

                <span className="mode-row-copy">
                  <b>{m.title}</b>
                  <small>{m.desc}</small>
                </span>

                <span className="mode-row-players">{m.players}</span>

                <span className="select-indicator">
                  {mode === m.id ? <Check size={15} /> : null}
                </span>
              </button>
            ))}
          </div>

          <div className="setup-card">
            <div className="section-title-row">
              <h3>Ranked matchmaking</h3>
              <span>+10 / −8 points</span>
            </div>

            <p className="hint-text">
              Find opponents in the same game mode, with ratings
              no more than 50 points apart. Difficulty is automatic.
            </p>

            <button
              className="button button-primary full-width"
              onClick={startMatchmaking}
              disabled={busy || Boolean(matchmakingStatus)}
            >
              {matchmakingStatus || 'Find a ranked match'}
              <Swords size={16} />
            </button>

            {Boolean(matchmakingStatus) && (
              <button
                className="button button-ghost full-width secondary-action"
                onClick={cancelMatchmaking}
                disabled={busy}
              >
                Cancel search
              </button>
            )}

            <div className="or-divider">
              <span>OR CREATE A PRIVATE ROOM</span>
            </div>

            <button
              className="button button-primary full-width"
              onClick={createRoom}
              disabled={busy}
            >
              {busy ? 'Creating room…' : 'Create private room'}
              <ArrowRight size={16} />
            </button>

            <div className="or-divider">
              <span>OR JOIN AN EXISTING ROOM</span>
            </div>

            <div className="join-inline">
              <input
                aria-label="Room code"
                placeholder="Enter 6-character code"
                maxLength={6}
                value={joinCode}
                onChange={(event) =>
                  setJoinCode(event.target.value.toUpperCase())
                }
              />

              <button
                className="button button-ghost"
                onClick={joinRoom}
                disabled={busy || joinCode.trim().length !== 6}
              >
                Join room
              </button>
            </div>
          </div>
        </main>
      )}

      {/* JOIN ROOM */}
      {page === 'join' && (
        <main className="page-wrap narrow">
          <button
            className="back-link"
            onClick={() => setPage('home')}
          >
            ← Back
          </button>

          <div className="page-heading">
            <div className="eyebrow">JOIN THE GAME</div>
            <h1>Enter room code</h1>
            <p>Ask your friend for the six-character room code.</p>
          </div>

          <div className="setup-card">
            <label className="field-label" htmlFor="join-room-code">
              ROOM CODE
            </label>

            <input
              id="join-room-code"
              className="big-code-input"
              autoFocus
              maxLength={6}
              value={joinCode}
              onChange={(event) =>
                setJoinCode(event.target.value.toUpperCase())
              }
              placeholder="ABC123"
            />

            <button
              className="button button-primary full-width"
              disabled={joinCode.trim().length !== 6 || busy}
              onClick={joinRoom}
            >
              Join room <ArrowRight size={16} />
            </button>
          </div>
        </main>
      )}

      {/* LOBBY */}
      {page === 'lobby' && state && (
        <main className="page-wrap narrow">
          <button
            className="back-link"
            onClick={() => {
              socketRef.current?.emit('room:leave', { code: roomCode });
              setState(null);
              setPage('home');
            }}
          >
            ← Leave lobby
          </button>

          <div className="page-heading">
            <div className="eyebrow">
              <span className="pulse-dot" /> WAITING ROOM
            </div>
            <h1>Room ready to roll.</h1>
          </div>

          <div className="room-code-panel">
            <div>
              <small>SHARE THIS ROOM CODE</small>
              <strong>{roomCode}</strong>
            </div>

            <button
              className="icon-btn"
              onClick={copyCode}
              aria-label="Copy room code"
            >
              <Copy size={18} />
            </button>
          </div>

          <div className="setup-card">
            <div className="section-title-row">
              <h3>Players</h3>
              <span>
                {state.players.length} / {state.requiredPlayers} joined
              </span>
            </div>

            {state.players.map((p) => (
              <div className="player-row" key={p.id}>
                <div className="player-avatar">
                  {p.name.slice(0, 1).toUpperCase()}
                </div>

                <div className="player-name">
                  <b>
                    {p.name}{p.id === player.id ? ' (you)' : ''}
                  </b>
                  <small>
                    {p.id === state.players[0]?.id ? 'Room host' : 'Player'}
                  </small>
                </div>

                <span className={`ready-status ${p.ready ? 'ready' : ''}`}>
                  {p.ready ? 'Ready' : 'Not ready'}
                </span>
              </div>
            ))}

            {Array.from({
              length: Math.max(
                0,
                state.requiredPlayers - state.players.length
              ),
            }).map((_, i) => (
              <div className="player-row waiting" key={i}>
                <div className="player-avatar ghost">
                  <Users size={16} />
                </div>

                <div className="player-name">
                  <b>Waiting for player…</b>
                  <small>Share the code to invite</small>
                </div>

                <span className="waiting-pill">Open slot</span>
              </div>
            ))}

            <button
              className="button button-primary full-width"
              onClick={toggleReady}
            >
              {me?.ready ? 'Cancel ready status' : 'I’m ready'}
              <ArrowRight size={16} />
            </button>

            <p className="hint-text">
              The round begins automatically when every required player is ready.
            </p>
          </div>
        </main>
      )}

      {/* LIVE GAME */}
      {page === 'game' && state && (
        <main className="game-wrap">
          <div className="game-topline">
            <div className="live-label">
              <span className="pulse-dot" /> LIVE MATCH
            </div>

            <div className={`timer-pill ${seconds <= 10 ? 'urgent' : ''}`}>
              <Clock3 size={16} />
              <span>{mmss}</span>
            </div>

            <button
              className="icon-btn"
              onClick={() => {
                socketRef.current?.emit('room:leave', { code: roomCode });
                setState(null);
                setPage('home');
              }}
              title="Leave match"
            >
              <X size={18} />
            </button>
          </div>

          <div className="game-layout">
            <aside className="score-panel">
              <div className="panel-label">SCOREBOARD</div>

              {state.players.map((p, i) => (
                <div
                  key={p.id}
                  className={`score-player ${
                    p.id === player.id ? 'current-player' : ''
                  }`}
                >
                  <div className={`score-avatar score-${i}`}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>

                  <div className="score-player-info">
                    <b>
                      {p.name}{p.id === player.id ? ' (you)' : ''}
                    </b>
                    <small>
                      {p.correct} correct · {p.accuracy}% accuracy
                    </small>
                  </div>

                  <strong>{p.score}</strong>
                </div>
              ))}

              <div className="round-note">
                <Clock3 size={15} />
                <span>
                  One minute
                  <br />
                  to show your skills.
                </span>
              </div>
            </aside>

            <section className="question-panel">
              <div className="question-meta">
                <span>{state.modeLabel}</span>
              </div>

              <div className="question-area">
                <div className="question-label">SOLVE THIS</div>

                <div className="question-expression">
                  {q?.text || '—'} <span>=</span>
                </div>

                <div className="answer-wrap">
                  <input
                    ref={inputRef}
                    className="answer-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                    aria-label="Type your answer"
                    placeholder="Type answer…"
                    value={answer}
                    onChange={(event) =>
                      onAnswerChange(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (
                        ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                          event.key
                        )
                      ) {
                        return;
                      }

                      if (event.key === 'Enter') {
                        event.preventDefault();
                        clearTimeout(typingTimer.current);
                        submitAnswer(answer);
                      }

                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setAnswer('');
                      }
                    }}
                  />

                  <span className="input-hint">↵</span>
                </div>

                <div
                  className={`feedback ${feedback?.kind || ''}`}
                  aria-live="polite"
                >
                  {feedback?.text ||
                    'Type your answer — it checks automatically.'}
                </div>
              </div>

              <div className="question-footer">
                <span>
                  <Activity size={15} /> {me?.correct || 0} solved
                </span>
                <span>Question stream updates automatically</span>
              </div>
            </section>
          </div>
        </main>
      )}

      {/* RESULTS */}
      {page === 'results' && results && (
        <main className="page-wrap narrow">
          <div className="results-hero">
            <div className="results-trophy">
              <Award size={34} />
            </div>
            <div className="eyebrow">ROUND COMPLETE</div>
            <h1>Time's up.</h1>
            <p>Every second counted. Here's how the round went.</p>
          </div>

          <div className="setup-card">
            <div className="results-list">
              {results.players.map((p) => (
                <div
                  className={`result-player ${
                    p.rank === 1 ? 'winner' : ''
                  }`}
                  key={p.id}
                >
                  <span className="rank-number">
                    {p.rank === 1 ? '🏆' : `#${p.rank}`}
                  </span>

                  <div className="player-name">
                    <b>
                      {p.name}{p.id === player.id ? ' (you)' : ''}
                    </b>
                    <small>
                      {p.correct} correct · {p.attempts} attempts ·{' '}
                      {p.accuracy}% accuracy
                    </small>
                  </div>

                  <strong>
                    {p.score} <small>pts</small>
                  </strong>
                </div>
              ))}
            </div>

            <h3 className="analysis-heading">Your round analysis</h3>

            {results.players
              .filter((p) => p.id === player.id)
              .map((p) => (
                <div className="stat-grid" key={p.id}>
                  <div className="stat-box">
                    <small>ACCURACY</small>
                    <b>{p.accuracy}%</b>
                  </div>

                  <div className="stat-box">
                    <small>AVG RESPONSE</small>
                    <b>
                      {p.averageResponseMs == null
                        ? '—'
                        : `${(p.averageResponseMs / 1000).toFixed(1)}s`}
                    </b>
                  </div>

                  <div className="stat-box">
                    <small>BEST STREAK</small>
                    <b>{p.bestStreak}</b>
                  </div>
                </div>
              ))}

            <button
              className="button button-primary full-width"
              onClick={() => {
                setResults(null);
                setPage('modes');
              }}
            >
              Play another match <ArrowRight size={16} />
            </button>

            <button
              className="button button-ghost full-width secondary-action"
              onClick={() => setPage('home')}
            >
              Back to home
            </button>
          </div>
        </main>
      )}

      {/* AUTHENTICATION */}
      {page === 'auth' && (
        <main className="page-wrap narrow">
          <button
            className="back-link"
            onClick={() => setPage('home')}
          >
            ← Back
          </button>

          <div className="auth-card">
            <div className="auth-mark">
              <Gamepad2 size={26} />
            </div>

            <div className="eyebrow">WELCOME TO THE ARENA</div>
            <h1>Ready to play?</h1>

            <p>
              Sign in to keep your identity across sessions and build your
              player history.
            </p>

            <button
              className="button button-google full-width"
              onClick={signInGoogle}
              disabled={busy}
            >
              <span className="google-g">G</span>
              Continue with Google
            </button>

            <div className="or-divider">
              <span>OR CONTINUE WITH EMAIL</span>
            </div>

            <label className="field-label" htmlFor="email">
              EMAIL ADDRESS
            </label>

            <div className="auth-input-row">
              <Mail size={17} />
              <input
                id="email"
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            {otpSent && (
              <>
                <label className="field-label" htmlFor="otp">
                  VERIFICATION CODE
                </label>

                <input
                  id="otp"
                  className="otp-input"
                  inputMode="numeric"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                  placeholder="Enter code from email"
                  autoComplete="one-time-code"
                />
              </>
            )}

            <button
              className="button button-primary full-width"
              onClick={otpSent ? verifyOtp : sendOtp}
              disabled={busy || !authEmail.includes('@')}
            >
              {busy
                ? 'Please wait…'
                : otpSent
                  ? 'Verify code'
                  : 'Send email code'}
              <ArrowRight size={16} />
            </button>

            {authMessage && (
              <p className="auth-message" role="status">
                {authMessage}
              </p>
            )}

            <p className="fine-print">
              <ShieldCheck size={14} />
              Your account is secured by Supabase Auth. We never ask for your
              Google password.
            </p>
          </div>
        </main>
      )}

      {/* WEEKLY LEADERBOARD */}
      {page === 'leaderboard' && (
        <main className="page-wrap narrow">
          <button
            className="back-link"
            onClick={() => setPage('home')}
          >
            ← Back
          </button>

          <div className="page-heading">
            <div className="eyebrow">COMPETITIVE RANKINGS</div>
            <h1>Weekly leaderboard</h1>
            <p>
              Ranked by net rating points earned this week.
              Overall rating is tracked separately.
            </p>
          </div>

          <div className="setup-card">
            <div className="section-title-row">
              <h3>Top players</h3>

              <button
                className="button button-ghost button-small"
                onClick={loadLeaderboard}
                disabled={leaderboardLoading}
              >
                {leaderboardLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>

            {leaderboardLoading && leaderboard.length === 0 && (
              <p className="hint-text">Loading weekly rankings…</p>
            )}

            {leaderboardError && (
              <p className="auth-message" role="alert">
                {leaderboardError}
              </p>
            )}

            {!leaderboardLoading &&
              !leaderboardError &&
              leaderboard.length === 0 && (
                <p className="hint-text">
                  No ranked results recorded this week yet.
                  Play a ranked match to get on the board!
                </p>
              )}

            <div className="results-list">
              {leaderboard.map((p) => (
                <div className="result-player" key={p.playerId}>
                  <span className="rank-number">#{p.rank}</span>

                  <div className="player-name">
                    <b>{p.username}</b>
                    <small>Overall rating: {p.rating}</small>
                  </div>

                  <strong>
                    {p.weeklyPoints > 0 ? '+' : ''}
                    {p.weeklyPoints}
                    <small> pts</small>
                  </strong>
                </div>
              ))}
            </div>
          </div>
        </main>
      )}

      {/* PLAYER PROFILE */}
      {page === 'profile' && (
        <main className="page-wrap narrow">
          <button
            className="back-link"
            onClick={() => setPage('home')}
          >
            ← Back
          </button>

          <div className="page-heading">
            <div className="eyebrow">PLAYER PROFILE</div>
            <h1>Your stats</h1>
            <p>
              {session ? 'Signed-in account' : 'Guest session'} · {player.name}
            </p>
          </div>

          <div className="setup-card">
            <div className="profile-identity">
              <div className="profile-avatar">
                {player.name.slice(0, 1).toUpperCase()}
              </div>

              <div>
                <h3>{player.name}</h3>
                <p>
                  {session?.user?.email ||
                    'Guest play · sign in to save your identity'}
                </p>
              </div>
            </div>

            {!session && (
              <button
                className="button button-primary full-width"
                onClick={() => setPage('auth')}
              >
                Sign in to build your profile <ArrowRight size={16} />
              </button>
            )}

            <p className="hint-text">
              Persistent statistics and match history require a configured
              Supabase project and authenticated profile. The current game
              session still shows match results.
            </p>
          </div>
        </main>
      )}

      <footer className="footer">
        <div className="footer-brand">
          <span className="brand-mark small">
            <Gamepad2 size={15} />
          </span>
          <span className="brand-name">
            SOLV<span className="brand-accent">ER</span>
          </span>
        </div>

        <span>Built for curious minds.</span>
        <span className="footer-status">
          <i /> Live game service
        </span>
      </footer>

      {toast && (
        <div className="toast" role="status">
          {toast}
          <button
            onClick={() => setToast('')}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
