'use strict';

/**
 * Pure game rules for Make It Mem.
 *
 * The engine owns a plain JSON state object and never touches the network,
 * timers or storage. Two very different backends drive it:
 *
 *  - server/game.js  — a long-lived Socket.IO process that calls `tick()`
 *                      on a timer and pushes snapshots to sockets.
 *  - netlify/functions/api.mjs — stateless functions that load the state from
 *                      Netlify Blobs, call `tick()` on every request and save.
 *
 * Everything time-based therefore lives in `tick(state, now)`: deadlines,
 * phase transitions, bot moves and presence expiry. Calling it twice with the
 * same clock is a no-op, so concurrent callers converge on the same state.
 */

const { dealTemplates, shuffle } = require('./templates');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const MAX_NAME = 16;
const MAX_TEXT = 90;
const POINTS_PER_STAR = 20;
const ROUND_WINNER_BONUS = 50;
const PRESENCE_TTL_MS = 20000; // polling clients are "here" if seen this recently
const LOBBY_GRACE_MS = 60000; // a phone that backgrounds keeps its lobby seat this long
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  rounds: 3,
  writeSeconds: 75,
  voteSeconds: 18,
  revealSeconds: 6,
  scoreSeconds: 10
};

const SETTING_BOUNDS = {
  rounds: [1, 10],
  writeSeconds: [20, 180],
  voteSeconds: [8, 60],
  revealSeconds: [3, 20],
  scoreSeconds: [4, 30]
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const BOT_NAMES = ['MemeBot', 'LOLtron', 'Captionator', 'Dank9000', 'Pixelbot'];
const BOT_AVATARS = ['🤖', '👾', '🛸', '🦾', '🧿'];
const BOT_LINES = [
  ['ME EXPLAINING', 'WHY IT WORKS ON MY MACHINE'],
  ['NOBODY:', 'MY BRAIN AT 3AM'],
  ['WHEN THE WIFI DROPS', 'FOR EXACTLY ONE SECOND'],
  ['MY PLAN FOR TODAY', 'MY PLAN AFTER ONE COFFEE'],
  ['TEACHER: THE TEST IS EASY', 'THE TEST:'],
  ['ME PRETENDING TO LISTEN', 'ME THINKING ABOUT SNACKS'],
  ['ONE MORE EPISODE', 'THE SUN:'],
  ['MY CODE', 'THE PRODUCTION SERVER'],
  ['SAVING FOR THE FUTURE', 'SEEING A SALE'],
  ['5 MINUTE NAP', 'THREE HOURS LATER']
];

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function sanitizeText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Stable 32-bit hash — bot behaviour must not depend on Math.random. */
function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

function randomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/* -------------------------------------------------------------- lifecycle */

function createRoom(code, now) {
  return {
    code,
    version: 1,
    phase: 'lobby',
    round: 0,
    hostId: null,
    settings: { ...DEFAULT_SETTINGS },
    order: [],
    players: {},
    submissions: [],
    roundResults: [],
    winners: [],
    usedTemplates: [],
    voteIndex: -1,
    deadline: null,
    phaseStartedAt: now,
    createdAt: now,
    lastActivity: now
  };
}

const playerList = (state) => state.order.map((id) => state.players[id]).filter(Boolean);
const humans = (state) => playerList(state).filter((p) => !p.isBot);

/** Players the game waits for: bots, live sockets and recently-seen pollers. */
function isActive(state, player, now) {
  if (!player) return false;
  if (player.isBot) return true;
  if (!player.connected) return false;
  if (player.mode === 'poll') return now - (player.lastSeen || 0) <= PRESENCE_TTL_MS;
  return true;
}

const activePlayers = (state, now) => playerList(state).filter((p) => isActive(state, p, now));

function bump(state, now) {
  state.version += 1;
  state.lastActivity = now;
}

function promoteHost(state, now) {
  const candidate =
    playerList(state).find((p) => !p.isBot && isActive(state, p, now)) || humans(state)[0] || null;
  state.hostId = candidate ? candidate.id : null;
}

function addPlayer(state, { name, avatar, isBot = false, mode = 'socket', now }) {
  if (Object.keys(state.players).length >= MAX_PLAYERS) return { error: 'ROOM_FULL' };
  if (state.phase !== 'lobby' && isBot) return { error: 'GAME_IN_PROGRESS' };

  const player = {
    id: makeId(),
    name: sanitizeText(name, MAX_NAME) || (isBot ? 'Bot' : 'Player'),
    avatar: typeof avatar === 'string' && avatar ? avatar.slice(0, 4) : '🙂',
    score: 0,
    roundScore: 0,
    connected: true,
    isBot,
    mode: isBot ? 'bot' : mode,
    lastSeen: now,
    disconnectedAt: null
  };
  state.players[player.id] = player;
  state.order.push(player.id);
  if (!state.hostId || !state.players[state.hostId]) promoteHost(state, now);
  ensureSubmission(state, player.id);
  bump(state, now);
  return { player };
}

function removePlayer(state, playerId, now) {
  if (!state.players[playerId]) return;
  delete state.players[playerId];
  state.order = state.order.filter((id) => id !== playerId);
  state.submissions = state.submissions.filter((s) => s.authorId !== playerId);
  if (state.hostId === playerId) promoteHost(state, now);
  bump(state, now);
}

function updatePlayer(state, playerId, { name, avatar }, now) {
  const player = state.players[playerId];
  if (!player) return;
  const clean = sanitizeText(name, MAX_NAME);
  if (clean) player.name = clean;
  if (typeof avatar === 'string' && avatar) player.avatar = avatar.slice(0, 4);
  bump(state, now);
}

/** Mark a player present. Polling clients call this on every request. */
function touch(state, playerId, now, mode) {
  const player = state.players[playerId];
  if (!player) return false;
  const wasConnected = player.connected;
  player.lastSeen = now;
  player.connected = true;
  player.disconnectedAt = null;
  if (mode) player.mode = mode;
  if (!state.hostId || !state.players[state.hostId]) promoteHost(state, now);
  if (!wasConnected) {
    ensureSubmission(state, playerId);
    bump(state, now);
    return true;
  }
  state.lastActivity = now;
  return false;
}

function setConnected(state, playerId, connected, now) {
  const player = state.players[playerId];
  if (!player) return;
  player.connected = connected;
  player.lastSeen = now;
  player.disconnectedAt = connected ? null : now;
  if (connected) ensureSubmission(state, playerId);
  // The host badge does not move on a blip - it follows the seat, and the seat
  // is only reclaimed once the grace period expires (see applyPresence).
  // Seats are never dropped on the spot: phones lose the network when they
  // lock or switch apps, and the player must be able to come back. Lobby seats
  // are reclaimed by the tick after LOBBY_GRACE_MS; mid-game seats are kept so
  // the score and the template survive.
  bump(state, now);
}

function updateSettings(state, patch = {}, now) {
  for (const [key, bounds] of Object.entries(SETTING_BOUNDS)) {
    const value = Number(patch[key]);
    if (Number.isFinite(value)) state.settings[key] = clamp(Math.round(value), bounds[0], bounds[1]);
  }
  bump(state, now);
}

/* ------------------------------------------------------------- game phases */

function usedSet(state) {
  return new Set(state.usedTemplates);
}

function rememberTemplates(state, used) {
  state.usedTemplates = [...used];
}

/** Deal a template to someone who joined (or came back) mid-writing. */
function ensureSubmission(state, playerId) {
  if (state.phase !== 'writing') return;
  if (state.submissions.some((s) => s.authorId === playerId)) return;
  const used = usedSet(state);
  const [template] = dealTemplates(1, used);
  rememberTemplates(state, used);
  state.submissions.push(newSubmission(playerId, template));
}

function newSubmission(authorId, template) {
  return {
    id: makeId(),
    authorId,
    template,
    top: '',
    bottom: '',
    submitted: false,
    votes: {},
    points: 0,
    average: 0,
    roundWinner: false
  };
}

function startGame(state, now) {
  if (state.phase !== 'lobby' && state.phase !== 'final') return { error: 'ALREADY_STARTED' };
  if (activePlayers(state, now).length < MIN_PLAYERS) return { error: 'NEED_MORE_PLAYERS' };
  playerList(state).forEach((p) => {
    p.score = 0;
    p.roundScore = 0;
  });
  state.round = 0;
  state.usedTemplates = [];
  state.winners = [];
  beginWriting(state, now);
  return {};
}

function setPhase(state, phase, seconds, now) {
  state.phase = phase;
  state.phaseStartedAt = now;
  state.deadline = seconds === null ? null : now + seconds * 1000;
  bump(state, now);
}

function beginWriting(state, now) {
  state.round += 1;
  state.roundResults = [];
  state.voteIndex = -1;
  const players = activePlayers(state, now);
  const used = usedSet(state);
  const templates = dealTemplates(players.length, used);
  rememberTemplates(state, used);
  state.submissions = players.map((player, i) => newSubmission(player.id, templates[i % templates.length]));
  setPhase(state, 'writing', state.settings.writeSeconds, now);
}

function endWriting(state, now) {
  // Any caption with text counts, submitted or not: clients autosave drafts.
  state.submissions = shuffle(state.submissions.filter((s) => s.top || s.bottom));
  state.voteIndex = -1;
  if (state.submissions.length === 0) {
    showScores(state, now);
    return;
  }
  nextVote(state, now);
}

function nextVote(state, now) {
  state.voteIndex += 1;
  if (state.voteIndex >= state.submissions.length) {
    finishRound(state, now);
    return;
  }
  setPhase(state, 'voting', state.settings.voteSeconds, now);
}

const currentSubmission = (state) => state.submissions[state.voteIndex] || null;

function eligibleVoters(state, submission, now) {
  return activePlayers(state, now).filter((p) => p.id !== submission.authorId);
}

function beginReveal(state, now) {
  const submission = currentSubmission(state);
  if (!submission) {
    finishRound(state, now);
    return;
  }
  const ratings = Object.values(submission.votes);
  const total = ratings.reduce((a, b) => a + b, 0);
  submission.points = total * POINTS_PER_STAR;
  submission.average = ratings.length ? total / ratings.length : 0;
  const author = state.players[submission.authorId];
  if (author) {
    author.score += submission.points;
    author.roundScore += submission.points;
  }
  setPhase(state, 'reveal', state.settings.revealSeconds, now);
}

function finishRound(state, now) {
  const best = Math.max(0, ...state.submissions.map((s) => s.points));
  if (best > 0 && state.submissions.length > 1) {
    state.submissions
      .filter((s) => s.points === best)
      .forEach((s) => {
        const author = state.players[s.authorId];
        if (!author) return;
        author.score += ROUND_WINNER_BONUS;
        author.roundScore += ROUND_WINNER_BONUS;
        s.roundWinner = true;
      });
  }
  state.roundResults = state.submissions.map((s) => ({
    id: s.id,
    template: s.template,
    top: s.top,
    bottom: s.bottom,
    points: s.points,
    average: s.average,
    roundWinner: s.roundWinner,
    author: publicPlayer(state, state.players[s.authorId])
  }));
  showScores(state, now);
}

function showScores(state, now) {
  if (state.round >= state.settings.rounds) {
    const board = leaderboard(state);
    const top = board[0];
    state.winners = top ? board.filter((p) => p.score === top.score) : [];
    setPhase(state, 'final', null, now);
  } else {
    setPhase(state, 'scores', state.settings.scoreSeconds, now);
  }
}

function nextRound(state, now) {
  playerList(state).forEach((p) => (p.roundScore = 0));
  beginWriting(state, now);
}

function skipPhase(state, now) {
  if (state.phase === 'writing') endWriting(state, now);
  else if (state.phase === 'voting') beginReveal(state, now);
  else if (state.phase === 'reveal') nextVote(state, now);
  else if (state.phase === 'scores') nextRound(state, now);
}

function backToLobby(state, now) {
  state.phase = 'lobby';
  state.round = 0;
  state.submissions = [];
  state.roundResults = [];
  state.winners = [];
  state.voteIndex = -1;
  state.deadline = null;
  state.phaseStartedAt = now;
  playerList(state).forEach((p) => {
    p.score = 0;
    p.roundScore = 0;
  });
  playerList(state)
    .filter((p) => !p.isBot && !isActive(state, p, now))
    .forEach((p) => removePlayer(state, p.id, now));
  bump(state, now);
}

/* ---------------------------------------------------------------- actions */

function saveDraft(state, playerId, { top, bottom }, now) {
  if (state.phase !== 'writing') return { error: 'WRONG_PHASE' };
  const submission = state.submissions.find((s) => s.authorId === playerId);
  if (!submission) return { error: 'NO_SUBMISSION' };
  submission.top = sanitizeText(top, MAX_TEXT);
  submission.bottom = sanitizeText(bottom, MAX_TEXT);
  state.lastActivity = now;
  return {};
}

function submitMeme(state, playerId, { top, bottom }, now) {
  if (state.phase !== 'writing') return { error: 'WRONG_PHASE' };
  const submission = state.submissions.find((s) => s.authorId === playerId);
  if (!submission) return { error: 'NO_SUBMISSION' };
  submission.top = sanitizeText(top, MAX_TEXT);
  submission.bottom = sanitizeText(bottom, MAX_TEXT);
  submission.submitted = Boolean(submission.top || submission.bottom);
  bump(state, now);
  maybeAdvanceOnInput(state, now);
  return {};
}

function castVote(state, playerId, rating, now) {
  if (state.phase !== 'voting') return { error: 'WRONG_PHASE' };
  const submission = currentSubmission(state);
  if (!submission) return { error: 'NO_SUBMISSION' };
  if (submission.authorId === playerId) return { error: 'CANNOT_VOTE_OWN' };
  submission.votes[playerId] = clamp(Math.round(Number(rating) || 0), 1, 5);
  bump(state, now);
  maybeAdvanceOnInput(state, now);
  return {};
}

/** Move on as soon as everyone who can act has acted. */
function maybeAdvanceOnInput(state, now) {
  if (state.phase === 'writing') {
    const waiting = activePlayers(state, now).some((p) => {
      const submission = state.submissions.find((s) => s.authorId === p.id);
      return submission && !submission.submitted;
    });
    if (!waiting) {
      endWriting(state, now);
      return true;
    }
  } else if (state.phase === 'voting') {
    const submission = currentSubmission(state);
    if (submission) {
      const voters = eligibleVoters(state, submission, now);
      if (voters.length > 0 && voters.every((p) => submission.votes[p.id] !== undefined)) {
        beginReveal(state, now);
        return true;
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------- tick */

function botWriteDueAt(state, bot) {
  const window = Math.min(15000, state.settings.writeSeconds * 400);
  return state.phaseStartedAt + 4000 + (hash(`${bot.id}:w${state.round}`) % window);
}

function botVoteDueAt(state, bot, submission) {
  const window = Math.min(8000, state.settings.voteSeconds * 400);
  return state.phaseStartedAt + 2500 + (hash(`${bot.id}:v${submission.id}`) % window);
}

/** Bot moves are derived from hashes so every caller computes the same thing. */
function applyBots(state, now) {
  let changed = false;
  const bots = playerList(state).filter((p) => p.isBot);
  if (bots.length === 0) return false;

  if (state.phase === 'writing') {
    for (const bot of bots) {
      const submission = state.submissions.find((s) => s.authorId === bot.id);
      if (!submission || submission.submitted) continue;
      if (now < botWriteDueAt(state, bot)) continue;
      const [top, bottom] = BOT_LINES[hash(`${bot.id}:line${state.round}`) % BOT_LINES.length];
      submitMeme(state, bot.id, { top, bottom }, now);
      changed = true;
      if (state.phase !== 'writing') break; // that submission ended the phase
    }
  } else if (state.phase === 'voting') {
    const submission = currentSubmission(state);
    if (!submission) return changed;
    for (const bot of bots) {
      if (bot.id === submission.authorId) continue;
      if (submission.votes[bot.id] !== undefined) continue;
      if (now < botVoteDueAt(state, bot, submission)) continue;
      castVote(state, bot.id, 2 + (hash(`${bot.id}:r${submission.id}`) % 4), now);
      changed = true;
      if (state.phase !== 'voting') break;
    }
  }
  return changed;
}

/** Mark absent players away, and eventually free their lobby seat. */
function applyPresence(state, now) {
  let changed = false;
  for (const player of playerList(state)) {
    if (player.isBot) continue;
    if (player.connected && player.mode === 'poll' && now - (player.lastSeen || 0) > PRESENCE_TTL_MS) {
      setConnected(state, player.id, false, now);
      changed = true;
    }
    if (
      !player.connected &&
      state.phase === 'lobby' &&
      now - (player.disconnectedAt || player.lastSeen || 0) > LOBBY_GRACE_MS
    ) {
      removePlayer(state, player.id, now);
      changed = true;
    }
  }
  return changed;
}

function advanceDeadline(state, now) {
  if (!state.deadline || now < state.deadline) return false;
  if (state.phase === 'writing') endWriting(state, now);
  else if (state.phase === 'voting') beginReveal(state, now);
  else if (state.phase === 'reveal') nextVote(state, now);
  else if (state.phase === 'scores') nextRound(state, now);
  else state.deadline = null;
  return true;
}

/**
 * Bring the room up to date with the clock. Idempotent: calling it again with
 * the same `now` changes nothing, which is what makes concurrent serverless
 * invocations safe.
 */
function tick(state, now) {
  let changed = false;
  for (let guard = 0; guard < 64; guard++) {
    let stepped = applyPresence(state, now);
    if (applyBots(state, now)) stepped = true;
    if (maybeAdvanceOnInput(state, now)) stepped = true;
    else if (advanceDeadline(state, now)) stepped = true;
    if (!stepped) break;
    changed = true;
  }
  return changed;
}

const isExpired = (state, now) => now - state.lastActivity > ROOM_TTL_MS;

/* -------------------------------------------------------------- snapshots */

function publicPlayer(state, player) {
  if (!player) return null;
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    score: player.score,
    roundScore: player.roundScore || 0,
    connected: player.connected,
    isBot: player.isBot,
    isHost: player.id === state.hostId
  };
}

function leaderboard(state) {
  return playerList(state)
    .map((p) => publicPlayer(state, p))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Everything one player is allowed to see, ready to render. */
function snapshotFor(state, playerId, now) {
  const snapshot = {
    code: state.code,
    version: state.version,
    phase: state.phase,
    round: state.round,
    settings: { ...state.settings },
    hostId: state.hostId,
    youId: playerId,
    isHost: playerId === state.hostId,
    players: playerList(state).map((p) => publicPlayer(state, p)),
    leaderboard: leaderboard(state),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    maxTextLength: MAX_TEXT,
    deadline: state.deadline,
    serverNow: now
  };

  if (state.phase === 'writing') {
    const mine = state.submissions.find((s) => s.authorId === playerId) || null;
    snapshot.writing = {
      template: mine ? mine.template : null,
      top: mine ? mine.top : '',
      bottom: mine ? mine.bottom : '',
      submitted: mine ? mine.submitted : false,
      done: state.submissions.filter((s) => s.submitted).length,
      total: state.submissions.length
    };
  }

  if (state.phase === 'voting' || state.phase === 'reveal') {
    const submission = currentSubmission(state);
    if (submission) {
      const voters = eligibleVoters(state, submission, now);
      snapshot.meme = {
        index: state.voteIndex + 1,
        total: state.submissions.length,
        template: submission.template,
        top: submission.top,
        bottom: submission.bottom,
        isMine: submission.authorId === playerId,
        yourRating: submission.votes[playerId] || null,
        voted: voters.filter((p) => submission.votes[p.id] !== undefined).length,
        voters: voters.length
      };
      if (state.phase === 'reveal') {
        snapshot.meme.author = publicPlayer(state, state.players[submission.authorId]);
        snapshot.meme.points = submission.points;
        snapshot.meme.average = submission.average;
        snapshot.meme.ratings = Object.values(submission.votes).sort((a, b) => b - a);
      }
    }
  }

  if (state.phase === 'scores' || state.phase === 'final') {
    snapshot.roundResults = state.roundResults;
    snapshot.winners = state.phase === 'final' ? state.winners : [];
  }

  return snapshot;
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_NAME,
  MAX_TEXT,
  DEFAULT_SETTINGS,
  PRESENCE_TTL_MS,
  LOBBY_GRACE_MS,
  BOT_NAMES,
  BOT_AVATARS,
  createRoom,
  randomCode,
  addPlayer,
  removePlayer,
  updatePlayer,
  updateSettings,
  touch,
  setConnected,
  startGame,
  saveDraft,
  submitMeme,
  castVote,
  skipPhase,
  backToLobby,
  tick,
  isExpired,
  isActive,
  activePlayers,
  playerList,
  humans,
  leaderboard,
  snapshotFor,
  publicPlayer
};
