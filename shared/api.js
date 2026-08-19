'use strict';

/**
 * Stateless HTTP backend for the game — the shape the Netlify deployment needs.
 *
 * There is no long-lived process here: every request loads the room from a
 * storage adapter, brings it up to date with `engine.tick()` and writes it back
 * with a compare-and-swap. Clients poll `GET /api/state` instead of holding a
 * socket open.
 *
 * `storage` is anything with:
 *   get(code)              -> { state, etag } | null
 *   put(code, state, etag) -> boolean  (false when someone else wrote first)
 *   create(code, state)    -> boolean  (false when the code is taken)
 *
 * netlify/functions/api.mjs supplies a Netlify Blobs implementation; the tests
 * supply an in-memory one.
 */

const engine = require('./engine');

const MAX_ATTEMPTS = 6;
const HEARTBEAT_MS = engine.PRESENCE_TTL_MS / 3;

const reply = (status, body) => ({ status, body });

function createApi(storage, options = {}) {
  const now = options.now || (() => Date.now());

  async function loadRoom(code) {
    if (typeof code !== 'string' || !/^[A-Z0-9]{4}$/.test(code)) return null;
    const entry = await storage.get(code);
    if (!entry || !entry.state) return null;
    if (engine.isExpired(entry.state, now())) return null;
    return entry;
  }

  async function createRoom() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = engine.randomCode();
      const state = engine.createRoom(code, now());
      if (await storage.create(code, state)) return state;
    }
    return null;
  }

  /** Load -> change -> tick -> conditional write, retrying on a lost race. */
  async function mutate(code, playerId, change) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const room = await loadRoom(code);
      if (!room) return { error: 'ROOM_NOT_FOUND' };
      const clock = now();
      if (playerId && room.state.players[playerId]) {
        engine.touch(room.state, playerId, clock, 'poll');
      }
      const result = change(room.state, clock) || {};
      if (result.error) return { error: result.error, state: room.state };
      engine.tick(room.state, clock);
      if (await storage.put(code, room.state, room.etag)) return { result, state: room.state };
    }
    return { error: 'BUSY' };
  }

  /** Reads only write when the room moved or the player's presence went stale. */
  async function readRoom(code, playerId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const room = await loadRoom(code);
      if (!room) return { error: 'ROOM_NOT_FOUND' };
      const clock = now();
      const player = room.state.players[playerId];
      const before = room.state.version;
      const heartbeat = Boolean(player) && clock - (player.lastSeen || 0) > HEARTBEAT_MS;
      if (heartbeat) engine.touch(room.state, playerId, clock, 'poll');
      engine.tick(room.state, clock);
      if (room.state.version === before && !heartbeat) return { state: room.state };
      if (await storage.put(code, room.state, room.etag)) return { state: room.state };
      // Lost the race: whoever won already applied the same tick, so re-read.
    }
    const room = await loadRoom(code);
    return room ? { state: room.state } : { error: 'ROOM_NOT_FOUND' };
  }

  const hostOnly = (state, playerId, change) =>
    state.hostId === playerId ? change() : { error: 'NOT_HOST' };

  const OPS = {
    settings: (state, playerId, payload, clock) =>
      hostOnly(state, playerId, () => engine.updateSettings(state, payload, clock) || {}),

    update: (state, playerId, payload, clock) =>
      engine.updatePlayer(state, playerId, payload, clock) || {},

    botAdd: (state, playerId, _payload, clock) =>
      hostOnly(state, playerId, () => {
        const index = engine.playerList(state).filter((p) => p.isBot).length;
        const added = engine.addPlayer(state, {
          name: engine.BOT_NAMES[index % engine.BOT_NAMES.length],
          avatar: engine.BOT_AVATARS[index % engine.BOT_AVATARS.length],
          isBot: true,
          now: clock
        });
        return added.error ? { error: added.error } : {};
      }),

    botRemove: (state, playerId, _payload, clock) =>
      hostOnly(state, playerId, () => {
        const bots = engine.playerList(state).filter((p) => p.isBot);
        const last = bots[bots.length - 1];
        if (last) engine.removePlayer(state, last.id, clock);
        return {};
      }),

    start: (state, playerId, _payload, clock) =>
      hostOnly(state, playerId, () => {
        const result = engine.startGame(state, clock);
        return result.error ? { error: result.error, minPlayers: engine.MIN_PLAYERS } : { ok: true };
      }),

    skip: (state, playerId, _payload, clock) =>
      hostOnly(state, playerId, () => engine.skipPhase(state, clock) || {}),

    lobby: (state, playerId, _payload, clock) =>
      hostOnly(state, playerId, () => engine.backToLobby(state, clock) || {}),

    draft: (state, playerId, payload, clock) => engine.saveDraft(state, playerId, payload, clock),
    swap: (state, playerId, _payload, clock) => engine.swapTemplate(state, playerId, clock),
    submit: (state, playerId, payload, clock) => engine.submitMeme(state, playerId, payload, clock),
    vote: (state, playerId, payload, clock) => engine.castVote(state, playerId, payload.rating, clock),
    leave: (state, playerId, _payload, clock) => engine.removePlayer(state, playerId, clock) || {}
  };

  async function rpc(body = {}) {
    const { op, code, playerId, payload = {} } = body;

    if (op === 'create') {
      const created = await createRoom();
      if (!created) return reply(503, { error: 'ROOM_NOT_FOUND' });
      const joined = await mutate(created.code, null, (state, clock) =>
        engine.addPlayer(state, { name: payload.name, avatar: payload.avatar, mode: 'poll', now: clock })
      );
      if (joined.error) return reply(409, { error: joined.error });
      const id = joined.result.player.id;
      return reply(200, {
        code: created.code,
        playerId: id,
        state: engine.snapshotFor(joined.state, id, now())
      });
    }

    if (op === 'join') {
      const joined = await mutate(code, null, (state, clock) =>
        engine.addPlayer(state, { name: payload.name, avatar: payload.avatar, mode: 'poll', now: clock })
      );
      if (joined.error) {
        return reply(joined.error === 'ROOM_NOT_FOUND' ? 404 : 409, { error: joined.error });
      }
      const id = joined.result.player.id;
      return reply(200, { code, playerId: id, state: engine.snapshotFor(joined.state, id, now()) });
    }

    if (op === 'rejoin') {
      const rejoined = await mutate(code, null, (state, clock) => {
        if (!state.players[playerId]) return { error: 'SEAT_NOT_FOUND' };
        engine.touch(state, playerId, clock, 'poll');
        return {};
      });
      if (rejoined.error) return reply(404, { error: rejoined.error });
      return reply(200, {
        code,
        playerId,
        state: engine.snapshotFor(rejoined.state, playerId, now())
      });
    }

    const action = OPS[op];
    if (!action) return reply(400, { error: 'UNKNOWN_OP' });

    const outcome = await mutate(code, playerId, (state, clock) => {
      if (!state.players[playerId]) return { error: 'SEAT_NOT_FOUND' };
      return action(state, playerId, payload, clock);
    });
    if (outcome.error && !outcome.state) return reply(404, { error: outcome.error });
    return reply(200, {
      result: outcome.error ? { error: outcome.error } : outcome.result,
      state: engine.snapshotFor(outcome.state, playerId, now())
    });
  }

  async function state(code, playerId) {
    const room = await readRoom((code || '').toUpperCase(), playerId);
    if (room.error) return reply(404, { error: room.error });
    if (!room.state.players[playerId]) return reply(404, { error: 'SEAT_NOT_FOUND' });
    return reply(200, { state: engine.snapshotFor(room.state, playerId, now()) });
  }

  return { rpc, state };
}

module.exports = { createApi };
