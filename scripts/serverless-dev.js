'use strict';

/**
 * Local stand-in for the Netlify deployment.
 *
 * It serves `public/` without Socket.IO (so the client falls back to polling)
 * and mounts the very same shared/api.js the Netlify function uses, backed by
 * an in-memory store instead of Netlify Blobs. Handy for working on the
 * polling path without a Netlify account:
 *
 *   npm run dev:serverless    # http://localhost:8888
 */

const path = require('path');
const express = require('express');
const { createApi } = require('../shared/api');

const PORT = Number(process.env.PORT) || 8888;
// Serve the source client by default; MIM_PUBLISH_DIR=dist checks the built one.
const PUBLISH_DIR = path.join(__dirname, '..', process.env.MIM_PUBLISH_DIR || 'public');

function memoryStorage() {
  const rooms = new Map();
  let counter = 0;
  return {
    async get(code) {
      const entry = rooms.get(code);
      return entry ? { state: JSON.parse(entry.json), etag: entry.etag } : null;
    },
    async put(code, state, etag) {
      const entry = rooms.get(code);
      if (!entry || (etag && entry.etag !== etag)) return false;
      rooms.set(code, { json: JSON.stringify(state), etag: `e${++counter}` });
      return true;
    },
    async create(code, state) {
      if (rooms.has(code)) return false;
      rooms.set(code, { json: JSON.stringify(state), etag: `e${++counter}` });
      return true;
    }
  };
}

const api = createApi(memoryStorage());
const app = express();
app.use(express.json());

const send = (res, reply) => res.status(reply.status).set('cache-control', 'no-store').json(reply.body);

app.get('/api/state', async (req, res) => send(res, await api.state(req.query.code, req.query.playerId)));
app.post('/api/rpc', async (req, res) => send(res, await api.rpc(req.body)));
app.get('/api/health', (_req, res) => res.json({ ok: true, runtime: 'serverless-dev' }));
app.get('/api/templates', (_req, res) => res.json(require('../shared/templates').TEMPLATES));

app.use(express.static(PUBLISH_DIR));
app.get('/:code([A-Za-z0-9]{4})', (_req, res) => res.sendFile(path.join(PUBLISH_DIR, 'index.html')));

const server = app.listen(PORT, () => {
  console.log(
    `Serverless-style Make It Mem on http://localhost:${PORT} (polling, in-memory rooms, serving ${path.basename(PUBLISH_DIR)}/)`
  );
});

module.exports = { app, server };
