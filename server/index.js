'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const {
  RoomManager,
  MIN_PLAYERS,
  MAX_NAME,
  BOT_NAMES,
  BOT_AVATARS
} = require('./game');
const { TEMPLATES } = require('./templates');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const manager = new RoomManager(io);

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, ...manager.stats() }));
app.get('/api/templates', (_req, res) => res.json(TEMPLATES));

/** A room code in the URL (/ABCD) just opens the app; the client reads it. */
app.get('/:code([A-Za-z0-9]{4})', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const ack = (cb, payload) => {
  if (typeof cb === 'function') cb(payload);
};

io.on('connection', (socket) => {
  const roomOf = (code) => manager.get(code);

  const currentRoom = () => {
    const room = roomOf(socket.data.roomCode);
    if (!room || !socket.data.playerId || !room.players.has(socket.data.playerId)) return null;
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
    const room = currentRoom();
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, MAX_NAME) : '';
    if (name) player.name = name;
    if (typeof payload.avatar === 'string' && payload.avatar) player.avatar = payload.avatar.slice(0, 4);
    room.broadcast();
  });

  socket.on('settings:update', (payload = {}) => {
    const room = currentRoom();
    if (!room || room.hostId !== socket.data.playerId) return;
    room.updateSettings(payload);
    room.broadcast();
  });

  socket.on('bot:add', () => {
    const room = currentRoom();
    if (!room || room.hostId !== socket.data.playerId || room.phase !== 'lobby') return;
    const index = room.playerList.filter((p) => p.isBot).length;
    room.addPlayer({
      name: BOT_NAMES[index % BOT_NAMES.length],
      avatar: BOT_AVATARS[index % BOT_AVATARS.length],
      isBot: true
    });
    room.broadcast();
  });

  socket.on('bot:remove', () => {
    const room = currentRoom();
    if (!room || room.hostId !== socket.data.playerId || room.phase !== 'lobby') return;
    const bots = room.playerList.filter((p) => p.isBot);
    const last = bots[bots.length - 1];
    if (last) room.removePlayer(last.id);
    room.broadcast();
  });

  socket.on('game:start', (_payload, cb) => {
    const room = currentRoom();
    if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
    if (room.hostId !== socket.data.playerId) return ack(cb, { error: 'NOT_HOST' });
    const { error } = room.start();
    if (error) return ack(cb, { error, minPlayers: MIN_PLAYERS });
    ack(cb, { ok: true });
  });

  socket.on('game:skip', () => {
    const room = currentRoom();
    if (!room || room.hostId !== socket.data.playerId) return;
    room.skipPhase();
  });

  socket.on('game:lobby', () => {
    const room = currentRoom();
    if (!room || room.hostId !== socket.data.playerId) return;
    room.backToLobby();
  });

  socket.on('meme:submit', (payload = {}, cb) => {
    const room = currentRoom();
    if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
    ack(cb, room.submitMeme(socket.data.playerId, payload));
  });

  socket.on('meme:draft', (payload = {}) => {
    const room = currentRoom();
    if (!room) return;
    room.saveDraft(socket.data.playerId, payload);
  });

  socket.on('vote:cast', (payload = {}, cb) => {
    const room = currentRoom();
    if (!room) return ack(cb, { error: 'ROOM_NOT_FOUND' });
    ack(cb, room.castVote(socket.data.playerId, payload.rating));
  });

  socket.on('room:leave', () => {
    const room = currentRoom();
    if (!room) return;
    const { playerId } = socket.data;
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    room.removePlayer(playerId);
    room.broadcast();
  });

  socket.on('disconnect', () => {
    const room = currentRoom();
    if (!room) return;
    room.detachSocket(socket.data.playerId);
    room.broadcast();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Make It Mem running on http://localhost:${PORT}`);
});

module.exports = { app, server, io, manager };
