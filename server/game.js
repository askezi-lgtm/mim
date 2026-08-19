'use strict';

/**
 * Socket.IO adapter around the pure rules in shared/engine.js.
 *
 * The engine owns all the rules; a Room only keeps the state object alive,
 * ticks it on a short interval so deadlines and bot moves land on time, and
 * pushes a personalised snapshot to every connected socket.
 */

const engine = require('../shared/engine');

const TICK_MS = 400;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

class Room {
  constructor(code, io) {
    this.io = io;
    this.state = engine.createRoom(code, Date.now());
    this.sockets = new Map(); // playerId -> socket id
    this.loop = setInterval(() => this.tick(), TICK_MS);
    if (this.loop.unref) this.loop.unref();
  }

  get code() {
    return this.state.code;
  }

  get phase() {
    return this.state.phase;
  }

  get settings() {
    return this.state.settings;
  }

  get hostId() {
    return this.state.hostId;
  }

  get lastActivity() {
    return this.state.lastActivity;
  }

  /** Map view over the engine's players; the player objects are live refs. */
  get players() {
    return new Map(Object.entries(this.state.players));
  }

  get playerList() {
    return engine.playerList(this.state);
  }

  get humanPlayers() {
    return engine.humans(this.state);
  }

  get activePlayers() {
    return engine.activePlayers(this.state, Date.now());
  }

  isEmpty() {
    return this.humanPlayers.length === 0;
  }

  isHost(playerId) {
    return this.state.hostId === playerId;
  }

  /**
   * Run a state change, bring the clock-driven parts up to date and push the
   * result to every socket if anything actually moved.
   */
  apply(change) {
    const before = this.state.version;
    const result = change();
    engine.tick(this.state, Date.now());
    if (this.state.version !== before) this.broadcast();
    return result;
  }

  /* ---------------------------------------------------------------- seats */

  addPlayer({ name, avatar, socketId, isBot = false }) {
    return this.apply(() => {
      const result = engine.addPlayer(this.state, {
        name,
        avatar,
        isBot,
        mode: 'socket',
        now: Date.now()
      });
      if (result.player && socketId) this.sockets.set(result.player.id, socketId);
      return result;
    });
  }

  removePlayer(playerId) {
    this.sockets.delete(playerId);
    this.apply(() => engine.removePlayer(this.state, playerId, Date.now()));
  }

  updatePlayer(playerId, patch) {
    this.apply(() => engine.updatePlayer(this.state, playerId, patch, Date.now()));
  }

  attachSocket(playerId, socketId) {
    if (!this.state.players[playerId]) return false;
    this.sockets.set(playerId, socketId);
    this.apply(() => engine.setConnected(this.state, playerId, true, Date.now()));
    return true;
  }

  detachSocket(playerId) {
    this.sockets.delete(playerId);
    this.apply(() => engine.setConnected(this.state, playerId, false, Date.now()));
  }

  /* ---------------------------------------------------------------- moves */

  updateSettings(patch) {
    this.apply(() => engine.updateSettings(this.state, patch, Date.now()));
  }

  start() {
    return this.apply(() => engine.startGame(this.state, Date.now()));
  }

  saveDraft(playerId, payload) {
    return engine.saveDraft(this.state, playerId, payload, Date.now());
  }

  submitMeme(playerId, payload) {
    return this.apply(() => engine.submitMeme(this.state, playerId, payload, Date.now()));
  }

  castVote(playerId, rating) {
    return this.apply(() => engine.castVote(this.state, playerId, rating, Date.now()));
  }

  skipPhase() {
    this.apply(() => engine.skipPhase(this.state, Date.now()));
  }

  backToLobby() {
    this.apply(() => engine.backToLobby(this.state, Date.now()));
  }

  /* --------------------------------------------------------------- output */

  /** Interval-driven: deadlines and bot moves land without anyone acting. */
  tick() {
    this.apply(() => {});
  }

  snapshotFor(playerId) {
    return engine.snapshotFor(this.state, playerId, Date.now());
  }

  broadcast() {
    for (const player of this.playerList) {
      const socketId = this.sockets.get(player.id);
      if (socketId && player.connected) {
        this.io.to(socketId).emit('state', this.snapshotFor(player.id));
      }
    }
  }

  destroy() {
    clearInterval(this.loop);
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
      const code = engine.randomCode();
      if (!this.rooms.has(code)) return code;
    }
    return `R${Date.now().toString(36).toUpperCase().slice(-3)}`;
  }

  create() {
    const room = new Room(this.generateCode(), this.io);
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) {
    if (typeof code !== 'string') return null;
    return this.rooms.get(code.trim().toUpperCase()) || null;
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
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
  MIN_PLAYERS: engine.MIN_PLAYERS,
  MAX_PLAYERS: engine.MAX_PLAYERS,
  MAX_NAME: engine.MAX_NAME,
  MAX_TEXT: engine.MAX_TEXT,
  DEFAULT_SETTINGS: engine.DEFAULT_SETTINGS,
  BOT_NAMES: engine.BOT_NAMES,
  BOT_AVATARS: engine.BOT_AVATARS
};
