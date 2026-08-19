'use strict';

/**
 * Socket.IO event wiring. Kept separate from server/index.js so tests can
 * mount the exact same handlers on their own throwaway server instead of
 * maintaining a copy that can drift.
 */

const { MIN_PLAYERS, BOT_NAMES, BOT_AVATARS } = require('./game');

const ack = (cb, payload) => {
  if (typeof cb === 'function') cb(payload);
};

function registerHandlers(io, manager) {
  io.on('connection', (socket) => {
    const roomOf = (code) => manager.get(code);

    /**
     * Find the caller's room. After a reconnect a client can flush an action it
     * queued while offline before its room:rejoin lands, and that arrives on a
     * brand new socket with no session data - so actions also carry their seat
     * and we adopt it here instead of answering "no room with that code".
     */
    const currentRoom = (payload) => {
      const known = roomOf(socket.data.roomCode);
      if (known && socket.data.playerId && known.players.has(socket.data.playerId)) return known;

      const claimed = payload && payload.seat;
      if (!claimed || !claimed.code || !claimed.playerId) return null;
      const room = roomOf(claimed.code);
      if (!room || !room.players.has(claimed.playerId)) return null;
      socket.data.roomCode = room.code;
      socket.data.playerId = claimed.playerId;
      socket.join(room.code);
      room.attachSocket(claimed.playerId, socket.id);
      return room;
    };

    const seat = (room, player) => {
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      socket.join(room.code);
    };

    socket.on('room:create', (payload = {}, cb) => {
      const room = manager.create();
      const { player, error } = room.addPlayer({
        name: payload.name,
        avatar: payload.avatar,
        socketId: socket.id
      });
      if (error) return ack(cb, { error });
      if (payload.settings) room.updateSettings(payload.settings);
      seat(room, player);
      ack(cb, { code: room.code, playerId: player.id });
      room.broadcast();
    });

    socket.on('room:join', (payload = {}, cb) => {
      const room = roomOf(payload.code);
      if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
      const { player, error } = room.addPlayer({
        name: payload.name,
        avatar: payload.avatar,
        socketId: socket.id
      });
      if (error) return ack(cb, { error });
      seat(room, player);
      ack(cb, { code: room.code, playerId: player.id });
      room.broadcast();
    });

    socket.on('room:rejoin', (payload = {}, cb) => {
      const room = roomOf(payload.code);
      if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
      if (!room.players.has(payload.playerId)) return ack(cb, { error: 'SEAT_NOT_FOUND' });
      room.attachSocket(payload.playerId, socket.id);
      socket.data.roomCode = room.code;
      socket.data.playerId = payload.playerId;
      socket.join(room.code);
      ack(cb, { code: room.code, playerId: payload.playerId });
      room.broadcast();
    });

    socket.on('player:update', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room) return;
      room.updatePlayer(socket.data.playerId, payload);
      room.broadcast();
    });

    socket.on('settings:update', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room || room.hostId !== socket.data.playerId) return;
      room.updateSettings(payload);
      room.broadcast();
    });

    socket.on('bot:add', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room || room.hostId !== socket.data.playerId || room.phase !== 'lobby') return;
      const index = room.playerList.filter((p) => p.isBot).length;
      room.addPlayer({
        name: BOT_NAMES[index % BOT_NAMES.length],
        avatar: BOT_AVATARS[index % BOT_AVATARS.length],
        isBot: true
      });
      room.broadcast();
    });

    socket.on('bot:remove', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room || room.hostId !== socket.data.playerId || room.phase !== 'lobby') return;
      const bots = room.playerList.filter((p) => p.isBot);
      const last = bots[bots.length - 1];
      if (last) room.removePlayer(last.id);
      room.broadcast();
    });

    socket.on('game:start', (payload = {}, cb) => {
      const room = currentRoom(payload);
      if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
      if (room.hostId !== socket.data.playerId) return ack(cb, { error: 'NOT_HOST' });
      const { error } = room.start();
      if (error) return ack(cb, { error, minPlayers: MIN_PLAYERS });
      ack(cb, { ok: true });
    });

    socket.on('game:skip', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room || room.hostId !== socket.data.playerId) return;
      room.skipPhase();
    });

    socket.on('game:lobby', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room || room.hostId !== socket.data.playerId) return;
      room.backToLobby();
    });

    socket.on('meme:submit', (payload = {}, cb) => {
      const room = currentRoom(payload);
      if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
      ack(cb, room.submitMeme(socket.data.playerId, payload));
    });

    socket.on('meme:draft', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room) return;
      room.saveDraft(socket.data.playerId, payload);
    });

    socket.on('vote:cast', (payload = {}, cb) => {
      const room = currentRoom(payload);
      if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
      ack(cb, room.castVote(socket.data.playerId, payload.rating));
    });

    socket.on('room:leave', (payload = {}) => {
      const room = currentRoom(payload);
      if (!room) return;
      const { playerId } = socket.data;
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      room.removePlayer(playerId);
      room.broadcast();
    });

    socket.on('disconnect', () => {
      const room = currentRoom(null);
      if (!room) return;
      room.detachSocket(socket.data.playerId);
      room.broadcast();
    });
  });
}

module.exports = { registerHandlers, ack };
