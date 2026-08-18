'use strict';

const { dealTemplates, shuffle } = require('./templates');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 - easy to read out loud
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const MAX_NAME = 16;
const MAX_TEXT = 90;
const POINTS_PER_STAR = 20;
const ROUND_WINNER_BONUS = 50;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

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
const now = () => Date.now();

function sanitizeText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeId() {
  return Math.random().toString(36).slice(2, 10) + now().toString(36);
}

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = new Map(); // playerId -> player
    this.order = []; // stable seating order
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'lobby';
    this.round = 0;
    this.hostId = null;
    this.deadline = null;
    this.timer = null;
    this.botTimers = new Set();
    this.usedTemplates = new Set();
    this.submissions = [];
    this.voteIndex = -1;
    this.roundResults = [];
    this.lastActivity = now();
    this.winners = [];
  }

  /* ---------------------------------------------------------------- players */

  get playerList() {
    return this.order.map((id) => this.players.get(id)).filter(Boolean);
  }

  get humanPlayers() {
    return this.playerList.filter((p) => !p.isBot);
  }

  get activePlayers() {
    return this.playerList.filter((p) => p.isBot || p.connected);
  }

  addPlayer({ name, avatar, socketId, isBot = false }) {
    if (this.players.size >= MAX_PLAYERS) return { error: 'ROOM_FULL' };
    if (this.phase !== 'lobby' && isBot) return { error: 'GAME_IN_PROGRESS' };

    const player = {
      id: makeId(),
      name: sanitizeText(name, MAX_NAME) || (isBot ? 'Bot' : 'Player'),
      avatar: typeof avatar === 'string' && avatar ? avatar.slice(0, 4) : '🙂',
      score: 0,
      roundScore: 0,
      connected: true,
      isBot,
      socketId: socketId || null
    };
    this.players.set(player.id, player);
    this.order.push(player.id);
    if (!this.hostId || !this.players.has(this.hostId)) this.promoteHost();
    // Latecomers join a round already in progress instead of watching it out.
    this.ensureSubmission(player.id);
    this.lastActivity = now();
    return { player };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.order = this.order.filter((id) => id !== playerId);
    this.submissions = this.submissions.filter((s) => s.authorId !== playerId);
    if (this.hostId === playerId) this.promoteHost();
    this.lastActivity = now();
  }

  promoteHost() {
    const candidate =
      this.playerList.find((p) => !p.isBot && p.connected) || this.humanPlayers[0] || null;
    this.hostId = candidate ? candidate.id : null;
  }

  attachSocket(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player) return false;
    player.socketId = socketId;
    player.connected = true;
    this.ensureSubmission(playerId);
    if (!this.hostId || !this.players.get(this.hostId)?.connected) this.promoteHost();
    this.lastActivity = now();
    return true;
  }

  detachSocket(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    if (this.hostId === playerId) this.promoteHost();
    this.lastActivity = now();
    // Players who drop out of the lobby leave for good; mid-game they keep
    // their seat (and score) so they can rejoin with the same link.
    if (this.phase === 'lobby') this.removePlayer(playerId);
    else this.maybeAdvanceOnInput();
  }

  isEmpty() {
    return this.humanPlayers.length === 0;
  }

  /** Hand a template to a player who arrived (or came back) mid-writing. */
  ensureSubmission(playerId) {
    if (this.phase !== 'writing') return;
    if (this.submissions.some((s) => s.authorId === playerId)) return;
    const [template] = dealTemplates(1, this.usedTemplates);
    this.submissions.push({
      id: makeId(),
      authorId: playerId,
      template,
      top: '',
      bottom: '',
      submitted: false,
      votes: new Map(),
      points: 0
    });
  }

  /* ------------------------------------------------------------- game flow */

  updateSettings(patch = {}) {
    for (const [key, bounds] of Object.entries(SETTING_BOUNDS)) {
      if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) {
        this.settings[key] = clamp(Math.round(patch[key]), bounds[0], bounds[1]);
      }
    }
    this.lastActivity = now();
  }

  start() {
    if (this.phase !== 'lobby' && this.phase !== 'final') return { error: 'ALREADY_STARTED' };
    if (this.activePlayers.length < MIN_PLAYERS) return { error: 'NEED_MORE_PLAYERS' };
    this.playerList.forEach((p) => {
      p.score = 0;
      p.roundScore = 0;
    });
    this.round = 0;
    this.usedTemplates.clear();
    this.winners = [];
    this.beginWriting();
    return {};
  }

  beginWriting() {
    this.round += 1;
    this.phase = 'writing';
    this.roundResults = [];
    this.voteIndex = -1;
    const players = this.activePlayers;
    const templates = dealTemplates(players.length, this.usedTemplates);
    this.submissions = players.map((player, i) => ({
      id: makeId(),
      authorId: player.id,
      template: templates[i % templates.length],
      top: '',
      bottom: '',
      submitted: false,
      votes: new Map(), // voterId -> rating 1..5
      points: 0
    }));
    this.setPhaseTimer(this.settings.writeSeconds, () => this.endWriting());
    this.scheduleBotCaptions();
    this.broadcast();
  }

  endWriting() {
    // Anything with text counts, even if the player never hit "submit" - the
    // client autosaves drafts so a slow typer never loses their caption.
    const kept = this.submissions.filter((s) => s.top || s.bottom);
    this.submissions = shuffle(kept);
    if (this.submissions.length === 0) {
      this.showScores();
      return;
    }
    this.voteIndex = -1;
    this.nextVote();
  }

  nextVote() {
    this.voteIndex += 1;
    if (this.voteIndex >= this.submissions.length) {
      this.finishRound();
      return;
    }
    this.phase = 'voting';
    this.setPhaseTimer(this.settings.voteSeconds, () => this.beginReveal());
    this.scheduleBotVotes();
    this.broadcast();
  }

  currentSubmission() {
    return this.submissions[this.voteIndex] || null;
  }

  eligibleVoters(submission) {
    return this.activePlayers.filter((p) => p.id !== submission.authorId);
  }

  beginReveal() {
    const submission = this.currentSubmission();
    if (!submission) {
      this.finishRound();
      return;
    }
    const ratings = [...submission.votes.values()];
    const total = ratings.reduce((a, b) => a + b, 0);
    submission.points = total * POINTS_PER_STAR;
    submission.average = ratings.length ? total / ratings.length : 0;
    const author = this.players.get(submission.authorId);
    if (author) {
      author.score += submission.points;
      author.roundScore = (author.roundScore || 0) + submission.points;
    }
    this.phase = 'reveal';
    this.setPhaseTimer(this.settings.revealSeconds, () => this.nextVote());
    this.broadcast();
  }

  finishRound() {
    // Bonus for the highest rated meme of the round (ties share it).
    const best = Math.max(...this.submissions.map((s) => s.points), 0);
    if (best > 0 && this.submissions.length > 1) {
      this.submissions
        .filter((s) => s.points === best)
        .forEach((s) => {
          const author = this.players.get(s.authorId);
          if (author) {
            author.score += ROUND_WINNER_BONUS;
            author.roundScore += ROUND_WINNER_BONUS;
            s.roundWinner = true;
          }
        });
    }
    this.roundResults = this.submissions.map((s) => ({
      id: s.id,
      template: s.template,
      top: s.top,
      bottom: s.bottom,
      points: s.points,
      average: s.average || 0,
      roundWinner: Boolean(s.roundWinner),
      author: this.publicPlayer(this.players.get(s.authorId))
    }));
    this.showScores();
  }

  showScores() {
    const isLast = this.round >= this.settings.rounds;
    this.phase = isLast ? 'final' : 'scores';
    if (isLast) {
      const top = this.leaderboard()[0];
      this.winners = top ? this.leaderboard().filter((p) => p.score === top.score) : [];
      this.clearTimer();
      this.deadline = null;
    } else {
      this.setPhaseTimer(this.settings.scoreSeconds, () => {
        this.playerList.forEach((p) => (p.roundScore = 0));
        this.beginWriting();
      });
    }
    this.broadcast();
  }

  skipPhase() {
    if (this.phase === 'writing') this.endWriting();
    else if (this.phase === 'voting') this.beginReveal();
    else if (this.phase === 'reveal') this.nextVote();
    else if (this.phase === 'scores') {
      this.playerList.forEach((p) => (p.roundScore = 0));
      this.beginWriting();
    }
  }

  backToLobby() {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = 0;
    this.submissions = [];
    this.roundResults = [];
    this.voteIndex = -1;
    this.deadline = null;
    this.playerList.forEach((p) => {
      p.score = 0;
      p.roundScore = 0;
    });
    // Nobody is left holding a seat from a game that already ended.
    this.playerList.filter((p) => !p.connected && !p.isBot).forEach((p) => this.removePlayer(p.id));
    this.broadcast();
  }

  /* --------------------------------------------------------------- actions */

  submitMeme(playerId, { top, bottom }) {
    if (this.phase !== 'writing') return { error: 'WRONG_PHASE' };
    const submission = this.submissions.find((s) => s.authorId === playerId);
    if (!submission) return { error: 'NO_SUBMISSION' };
    submission.top = sanitizeText(top, MAX_TEXT);
    submission.bottom = sanitizeText(bottom, MAX_TEXT);
    submission.submitted = Boolean(submission.top || submission.bottom);
    this.lastActivity = now();
    if (!this.maybeAdvanceOnInput()) this.broadcast();
    return {};
  }

  /** Autosaved text; unlike submitMeme it never flips the "done" flag. */
  saveDraft(playerId, { top, bottom }) {
    if (this.phase !== 'writing') return { error: 'WRONG_PHASE' };
    const submission = this.submissions.find((s) => s.authorId === playerId);
    if (!submission) return { error: 'NO_SUBMISSION' };
    submission.top = sanitizeText(top, MAX_TEXT);
    submission.bottom = sanitizeText(bottom, MAX_TEXT);
    this.lastActivity = now();
    return {};
  }

  castVote(playerId, rating) {
    if (this.phase !== 'voting') return { error: 'WRONG_PHASE' };
    const submission = this.currentSubmission();
    if (!submission) return { error: 'NO_SUBMISSION' };
    if (submission.authorId === playerId) return { error: 'CANNOT_VOTE_OWN' };
    const value = clamp(Math.round(Number(rating) || 0), 1, 5);
    submission.votes.set(playerId, value);
    this.lastActivity = now();
    if (!this.maybeAdvanceOnInput()) this.broadcast();
    return {};
  }

  /** Advance early once everyone who can act has acted. Returns true if the phase changed. */
  maybeAdvanceOnInput() {
    if (this.phase === 'writing') {
      const pending = this.activePlayers.filter((p) => {
        const s = this.submissions.find((x) => x.authorId === p.id);
        return s && !s.submitted;
      });
      if (pending.length === 0) {
        this.endWriting();
        return true;
      }
    } else if (this.phase === 'voting') {
      const submission = this.currentSubmission();
      if (submission) {
        const voters = this.eligibleVoters(submission);
        if (voters.length > 0 && voters.every((p) => submission.votes.has(p.id))) {
          this.beginReveal();
          return true;
        }
      }
    }
    return false;
  }

  /* ----------------------------------------------------------------- timers */

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.botTimers.forEach((t) => clearTimeout(t));
    this.botTimers.clear();
  }

  setPhaseTimer(seconds, fn) {
    this.clearTimer();
    this.deadline = now() + seconds * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fn();
      } catch (err) {
        console.error(`[room ${this.code}] phase timer failed:`, err);
      }
    }, seconds * 1000);
  }

  botTimeout(fn, ms) {
    const t = setTimeout(() => {
      this.botTimers.delete(t);
      try {
        fn();
      } catch (err) {
        console.error(`[room ${this.code}] bot action failed:`, err);
      }
    }, ms);
    this.botTimers.add(t);
  }

  scheduleBotCaptions() {
    this.playerList
      .filter((p) => p.isBot)
      .forEach((bot) => {
        const delay = 4000 + Math.random() * Math.min(15000, this.settings.writeSeconds * 400);
        this.botTimeout(() => {
          if (this.phase !== 'writing') return;
          const [top, bottom] = BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)];
          this.submitMeme(bot.id, { top, bottom });
        }, delay);
      });
  }

  scheduleBotVotes() {
    const submission = this.currentSubmission();
    if (!submission) return;
    this.playerList
      .filter((p) => p.isBot && p.id !== submission.authorId)
      .forEach((bot) => {
        const delay = 2500 + Math.random() * Math.min(8000, this.settings.voteSeconds * 400);
        this.botTimeout(() => {
          if (this.phase !== 'voting' || this.currentSubmission() !== submission) return;
          this.castVote(bot.id, 2 + Math.floor(Math.random() * 4));
        }, delay);
      });
  }

  /* -------------------------------------------------------------- snapshots */

  publicPlayer(player) {
    if (!player) return null;
    return {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      score: player.score,
      roundScore: player.roundScore || 0,
      connected: player.connected,
      isBot: player.isBot,
      isHost: player.id === this.hostId
    };
  }

  leaderboard() {
    return this.playerList
      .map((p) => this.publicPlayer(p))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  /** Full, personalised view of the room for one player. */
  snapshotFor(playerId) {
    const state = {
      code: this.code,
      phase: this.phase,
      round: this.round,
      settings: { ...this.settings },
      hostId: this.hostId,
      youId: playerId,
      isHost: playerId === this.hostId,
      players: this.playerList.map((p) => this.publicPlayer(p)),
      leaderboard: this.leaderboard(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      maxTextLength: MAX_TEXT,
      deadline: this.deadline,
      serverNow: now()
    };

    if (this.phase === 'writing') {
      const mine = this.submissions.find((s) => s.authorId === playerId) || null;
      state.writing = {
        template: mine ? mine.template : null,
        top: mine ? mine.top : '',
        bottom: mine ? mine.bottom : '',
        submitted: mine ? mine.submitted : false,
        done: this.submissions.filter((s) => s.submitted).length,
        total: this.submissions.length
      };
    }

    if (this.phase === 'voting' || this.phase === 'reveal') {
      const submission = this.currentSubmission();
      if (submission) {
        const voters = this.eligibleVoters(submission);
        const ratings = [...submission.votes.values()];
        state.meme = {
          index: this.voteIndex + 1,
          total: this.submissions.length,
          template: submission.template,
          top: submission.top,
          bottom: submission.bottom,
          isMine: submission.authorId === playerId,
          yourRating: submission.votes.get(playerId) || null,
          voted: voters.filter((p) => submission.votes.has(p.id)).length,
          voters: voters.length
        };
        if (this.phase === 'reveal') {
          state.meme.author = this.publicPlayer(this.players.get(submission.authorId));
          state.meme.points = submission.points;
          state.meme.average = submission.average || 0;
          state.meme.ratings = ratings.sort((a, b) => b - a);
        }
      }
    }

    if (this.phase === 'scores' || this.phase === 'final') {
      state.roundResults = this.roundResults;
      state.winners = this.phase === 'final' ? this.winners : [];
    }

    return state;
  }

  broadcast() {
    this.lastActivity = now();
    for (const player of this.playerList) {
      if (player.socketId && player.connected) {
        this.io.to(player.socketId).emit('state', this.snapshotFor(player.id));
      }
    }
  }

  destroy() {
    this.clearTimer();
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  generateCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return `R${now().toString(36).toUpperCase().slice(-4)}`;
  }

  create() {
    const code = this.generateCode();
    const room = new Room(code, this.io);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    if (typeof code !== 'string') return null;
    return this.rooms.get(code.trim().toUpperCase()) || null;
  }

  sweep() {
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && now() - room.lastActivity > EMPTY_ROOM_TTL_MS) {
        room.destroy();
        this.rooms.delete(code);
      }
    }
  }

  stats() {
    return {
      rooms: this.rooms.size,
      players: [...this.rooms.values()].reduce((n, r) => n + r.humanPlayers.length, 0)
    };
  }
}

module.exports = {
  Room,
  RoomManager,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_NAME,
  MAX_TEXT,
  DEFAULT_SETTINGS,
  BOT_NAMES,
  BOT_AVATARS
};
