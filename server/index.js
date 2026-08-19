'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { registerHandlers } = require('./socket');

const { RoomManager } = require('./game');
const { TEMPLATES } = require('../shared/templates');

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

registerHandlers(io, manager);

server.listen(PORT, HOST, () => {
  console.log(`Make It Mem running on http://localhost:${PORT}`);
});

module.exports = { app, server, io, manager };
