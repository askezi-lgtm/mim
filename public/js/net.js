/**
 * Transport shim.
 *
 * The same client runs on two very different backends:
 *   - Socket.IO (the Node server) — real push, used whenever /socket.io loaded.
 *   - HTTP polling (the Netlify deployment) — no sockets exist there, so the
 *     client posts actions to /api/rpc and polls /api/state for changes.
 *
 * Both expose the socket-style `on(event, fn)` / `emit(event, payload, cb)`
 * pair, so app.js never has to care which one it is talking to.
 */
(function () {
  'use strict';

  const POLL_MS = 1500;
  const POLL_HIDDEN_MS = 4000;

  // socket event name -> serverless op name
  const OPS = {
    'room:create': 'create',
    'room:join': 'join',
    'room:rejoin': 'rejoin',
    'player:update': 'update',
    'settings:update': 'settings',
    'bot:add': 'botAdd',
    'bot:remove': 'botRemove',
    'game:start': 'start',
    'game:skip': 'skip',
    'game:lobby': 'lobby',
    'meme:draft': 'draft',
    'meme:swap': 'swap',
    'meme:submit': 'submit',
    'vote:cast': 'vote',
    'room:leave': 'leave'
  };

  const listeners = new Map();
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  };
  const fire = (event, payload) => (listeners.get(event) || []).forEach((fn) => fn(payload));

  /* ------------------------------------------------------------ socket.io */

  function socketTransport() {
    const socket = window.io({ transports: ['websocket', 'polling'] });
    let seat = null;

    socket.on('state', (snapshot) => {
      seat = { code: snapshot.code, playerId: snapshot.youId };
      fire('state', snapshot);
    });
    ['connect', 'disconnect'].forEach((event) => socket.on(event, () => fire(event)));

    return {
      mode: 'socket',
      on,
      // Every action carries the seat: after a reconnect socket.io flushes
      // whatever was queued while offline, and that can reach the server before
      // room:rejoin does - on a socket the server has never seen before.
      emit: (event, payload, cb) => socket.emit(event, { ...(payload || {}), seat }, cb)
    };
  }

  /* --------------------------------------------------------- http polling */

  function pollingTransport() {
    let code = null;
    let playerId = null;
    let version = -1;
    let timer = null;
    let inFlight = false;
    let online = true;

    function publish(snapshot) {
      if (!snapshot || snapshot.version === version) return;
      version = snapshot.version;
      fire('state', snapshot);
    }

    function setOnline(next) {
      if (next === online) return;
      online = next;
      fire(next ? 'connect' : 'disconnect');
    }

    async function poll() {
      if (!code || !playerId || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(
          `/api/state?code=${encodeURIComponent(code)}&playerId=${encodeURIComponent(playerId)}`,
          { headers: { accept: 'application/json' } }
        );
        const data = await res.json();
        if (data.error) {
          stop();
          fire('seatlost', data.error);
          return;
        }
        setOnline(true);
        publish(data.state);
      } catch (_) {
        setOnline(false);
      } finally {
        inFlight = false;
      }
    }

    function start() {
      stop();
      timer = setInterval(poll, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
      poll();
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    document.addEventListener('visibilitychange', () => {
      if (code && playerId) start();
    });

    async function rpc(op, payload) {
      const res = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, code, playerId, payload })
      });
      return res.json();
    }

    function emit(event, payload = {}, cb) {
      const op = OPS[event];
      if (!op) return;

      if (op === 'join' || op === 'rejoin') {
        code = (payload.code || code || '').toUpperCase();
        if (payload.playerId) playerId = payload.playerId;
      }
      if (op === 'leave') {
        stop();
        rpc(op, payload).catch(() => {});
        code = null;
        playerId = null;
        version = -1;
        return;
      }

      rpc(op, payload)
        .then((data) => {
          setOnline(true);
          if (data.playerId) {
            code = data.code;
            playerId = data.playerId;
            version = -1;
            start();
          }
          if (data.state) publish(data.state);
          if (typeof cb === 'function') cb(data.error ? { error: data.error } : data.result || {});
        })
        .catch(() => {
          setOnline(false);
          if (typeof cb === 'function') cb({ error: 'NETWORK' });
        });
    }

    // app.js expects a "connect" event to kick off its rejoin attempt.
    setTimeout(() => fire('connect'), 0);

    return { mode: 'poll', on, emit };
  }

  // The Netlify build strips the socket.io tag and sets MIM_TRANSPORT instead.
  const useSockets = window.MIM_TRANSPORT !== 'poll' && typeof window.io === 'function';
  window.Net = useSockets ? socketTransport() : pollingTransport();
})();
