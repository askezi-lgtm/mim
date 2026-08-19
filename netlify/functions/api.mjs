/**
 * Netlify entry point for the game backend.
 *
 * Netlify has no long-lived process and no WebSockets, so the room lives in
 * Netlify Blobs and clients poll instead of holding a socket open. All the
 * logic is in shared/api.js (storage-agnostic) and shared/engine.js (the same
 * rules the Socket.IO server runs); this file only bridges Blobs and Request.
 */

import { getStore } from '@netlify/blobs';
import api from '../../shared/api.js';

const { createApi } = api.default || api;

const store = () => getStore({ name: 'mim-rooms', consistency: 'strong' });

const blobStorage = {
  async get(code) {
    const entry = await store().getWithMetadata(code, { type: 'json', consistency: 'strong' });
    if (!entry || !entry.data) return null;
    return { state: entry.data, etag: entry.etag };
  },
  async put(code, state, etag) {
    const result = await store().setJSON(code, state, etag ? { onlyIfMatch: etag } : {});
    return result.modified !== false;
  },
  async create(code, state) {
    const result = await store().setJSON(code, state, { onlyIfNew: true });
    return result.modified !== false;
  }
};

const game = createApi(blobStorage);

const json = ({ status, body }) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export default async (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/api/health') {
    return json({ status: 200, body: { ok: true, runtime: 'netlify-functions' } });
  }

  if (url.pathname === '/api/templates') {
    const templates = await import('../../shared/templates.js');
    return json({ status: 200, body: (templates.default || templates).TEMPLATES });
  }

  if (url.pathname === '/api/state') {
    return json(
      await game.state(url.searchParams.get('code') || '', url.searchParams.get('playerId') || '')
    );
  }

  if (req.method !== 'POST') return json({ status: 405, body: { error: 'METHOD_NOT_ALLOWED' } });

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return json({ status: 400, body: { error: 'BAD_REQUEST' } });
  }
  return json(await game.rpc(body));
};

export const config = {
  path: ['/api/state', '/api/rpc', '/api/templates', '/api/health']
};
