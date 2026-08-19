'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { io: ioClient } = require('socket.io-client');
const express = require('express');
const { Server } = require('socket.io');

// server/index.js binds a port on require, so tests mount the real handlers
// on their own throwaway server.
const { RoomManager } = require('../server/game');
const { registerHandlers } = require('../server/socket');

function buildServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const manager = new RoomManager(io);
  registerHandlers(io, manager);
  return { server, io, manager };
}

function connect(port) {
  const socket = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
  socket.states = [];
  socket.on('state', (s) => {
    socket.latest = s;
    socket.states.push(s);
  });
  return socket;
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitFor(socket, predicate, label = 'state', timeout = 15000) {
  if (socket.latest && predicate(socket.latest)) return Promise.resolve(socket.latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', onState);
      reject(new Error(`timeout waiting for ${label} (last phase: ${socket.latest && socket.latest.phase})`));
    }, timeout);
    function onState(s) {
      if (!predicate(s)) return;
      clearTimeout(timer);
      socket.off('state', onState);
      resolve(s);
    }
    socket.on('state', onState);
  });
}

test('a full game runs from lobby to a winner', async (t) => {
  const { server, manager } = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const host = connect(port);
  const bob = connect(port);
  const eve = connect(port);
  t.after(() => {
    [host, bob, eve].forEach((s) => s.close());
    manager.rooms.forEach((r) => r.destroy());
    clearInterval(manager.sweeper);
    server.close();
  });

  const created = await emit(host, 'room:create', { name: 'Alice', avatar: '😂' });
  assert.match(created.code, /^[A-Z0-9]{4}$/);

  assert.deepEqual(await emit(bob, 'room:join', { code: created.code, name: 'Bob', avatar: '😎' }), {
    code: created.code,
    playerId: (await waitFor(bob, (s) => s.youId)).youId
  });
  await emit(eve, 'room:join', { code: created.code, name: 'Eve', avatar: '🐸' });

  const lobby = await waitFor(host, (s) => s.players.length === 3, 'three players');
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.isHost, true);
  assert.equal(lobby.players.find((p) => p.name === 'Bob').isHost, false);

  host.emit('settings:update', { rounds: 1, writeSeconds: 20, voteSeconds: 8, revealSeconds: 3 });
  await waitFor(host, (s) => s.settings.rounds === 1, 'settings applied');

  assert.deepEqual(await emit(host, 'game:start', {}), { ok: true });
  const writing = await waitFor(host, (s) => s.phase === 'writing', 'writing');
  assert.ok(writing.writing.template.url, 'each player gets a template');
  assert.equal(writing.writing.total, 3);

  // Everyone submits; the room should advance without waiting for the timer.
  await emit(host, 'meme:submit', { top: 'ALICE TOP', bottom: 'ALICE BOTTOM' });
  await emit(bob, 'meme:submit', { top: 'BOB TOP', bottom: '' });
  await emit(eve, 'meme:submit', { top: '', bottom: 'EVE BOTTOM' });

  const voting = await waitFor(host, (s) => s.phase === 'voting', 'voting');
  assert.equal(voting.meme.total, 3, 'all three memes are up for rating');

  // Rate every meme: authors cannot vote on their own, everyone else gives 5.
  for (let i = 0; i < 3; i++) {
    const round = await waitFor(host, (s) => s.phase === 'voting' && s.meme.index === i + 1, `meme ${i + 1}`);
    assert.equal(round.meme.total, 3);
    const views = [];
    for (const client of [host, bob, eve]) {
      views.push([
        client,
        await waitFor(client, (s) => s.phase === 'voting' && s.meme.index === i + 1, 'client meme')
      ]);
    }
    // The author votes first: the last rater ends the phase, so testing the
    // "cannot rate your own meme" guard afterwards would just hit WRONG_PHASE.
    const author = views.find(([, view]) => view.meme.isMine);
    assert.ok(author, 'exactly one player sees the meme as their own');
    assert.deepEqual(await emit(author[0], 'vote:cast', { rating: 5 }), { error: 'CANNOT_VOTE_OWN' });
    for (const [client, view] of views) {
      if (view.meme.isMine) continue;
      assert.deepEqual(await emit(client, 'vote:cast', { rating: 5 }), {});
    }
    const reveal = await waitFor(host, (s) => s.phase === 'reveal' && s.meme.index === i + 1, 'reveal');
    assert.equal(reveal.meme.points, 2 * 5 * 20, 'two voters at 5 stars = 200 points');
    assert.ok(reveal.meme.author.name, 'the author is revealed');
  }

  const final = await waitFor(host, (s) => s.phase === 'final', 'final', 20000);
  assert.equal(final.roundResults.length, 3);
  // Everyone scored identically, so every player ties for the win.
  assert.equal(final.winners.length, 3);
  final.leaderboard.forEach((p) => assert.equal(p.score, 200 + 50));
});

test('a disconnected player keeps their seat mid-game and can rejoin', async (t) => {
  const { server, manager } = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const host = connect(port);
  let bob = connect(port);
  t.after(() => {
    [host, bob].forEach((s) => s.close());
    manager.rooms.forEach((r) => r.destroy());
    clearInterval(manager.sweeper);
    server.close();
  });

  const created = await emit(host, 'room:create', { name: 'Alice' });
  const joined = await emit(bob, 'room:join', { code: created.code, name: 'Bob' });
  host.emit('settings:update', { rounds: 1, writeSeconds: 30 });
  await emit(host, 'game:start', {});
  await waitFor(host, (s) => s.phase === 'writing', 'writing');

  bob.close();
  await waitFor(host, (s) => s.players.some((p) => p.name === 'Bob' && !p.connected), 'bob offline');

  bob = connect(port);
  const back = await emit(bob, 'room:rejoin', { code: created.code, playerId: joined.playerId });
  assert.deepEqual(back, { code: created.code, playerId: joined.playerId });
  const resumed = await waitFor(bob, (s) => s.youId === joined.playerId, 'bob back');
  assert.equal(resumed.phase, 'writing');
  assert.ok(resumed.writing.template, 'the same seat still holds a template');
});

test('the lobby refuses to start a one-player game', async (t) => {
  const { server, manager } = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const host = connect(server.address().port);
  t.after(() => {
    host.close();
    manager.rooms.forEach((r) => r.destroy());
    clearInterval(manager.sweeper);
    server.close();
  });

  await emit(host, 'room:create', { name: 'Solo' });
  assert.deepEqual(await emit(host, 'game:start', {}), {
    error: 'NEED_MORE_PLAYERS',
    minPlayers: 2
  });
});

test('a player who joins mid-round gets a template right away', async (t) => {
  const { server, manager } = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const host = connect(port);
  const bob = connect(port);
  const late = connect(port);
  t.after(() => {
    [host, bob, late].forEach((s) => s.close());
    manager.rooms.forEach((r) => r.destroy());
    clearInterval(manager.sweeper);
    server.close();
  });

  const created = await emit(host, 'room:create', { name: 'Alice' });
  await emit(bob, 'room:join', { code: created.code, name: 'Bob' });
  host.emit('settings:update', { rounds: 1, writeSeconds: 30 });
  await emit(host, 'game:start', {});
  await waitFor(host, (s) => s.phase === 'writing', 'writing');

  const joined = await emit(late, 'room:join', { code: created.code, name: 'Zoe' });
  assert.equal(joined.error, undefined, 'joining mid-game is allowed');
  const view = await waitFor(late, (s) => s.phase === 'writing', 'late writing view');
  assert.ok(view.writing.template, 'the latecomer is dealt a template');
  assert.deepEqual(await emit(late, 'meme:submit', { top: 'LATE BUT FUNNY', bottom: '' }), {});

  const hostView = await waitFor(host, (s) => s.writing && s.writing.total === 3, 'three submissions');
  assert.equal(hostView.writing.total, 3);
});

test('an action queued during a reconnect is not lost', async (t) => {
  // Production bug: a phone that locks or switches apps drops its socket, and
  // socket.io flushes the queued action on a brand new socket - before the
  // client's room:rejoin lands. The action used to fail with ROOM_NOT_FOUND.
  const { server, manager } = buildServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const host = connect(port);
  const guest = connect(port);
  let reconnected;
  t.after(() => {
    [host, guest, reconnected].forEach((s) => s && s.close());
    manager.rooms.forEach((r) => r.destroy());
    clearInterval(manager.sweeper);
    server.close();
  });

  const created = await emit(host, 'room:create', { name: 'Host' });
  await emit(guest, 'room:join', { code: created.code, name: 'Guest' });
  await waitFor(host, (s) => s.players.length === 2, 'both players');

  host.close(); // the phone drops off the network
  await waitFor(guest, (s) => s.players.some((p) => p.name === 'Host' && !p.connected), 'host away');

  // A fresh socket the server has never seen, sending the action straight away.
  reconnected = connect(port);
  const seat = { code: created.code, playerId: created.playerId };
  const started = await emit(reconnected, 'game:start', { seat });
  assert.deepEqual(started, { ok: true }, 'the seat carried in the action was honoured');

  const playing = await waitFor(reconnected, (s) => s.phase === 'writing', 'writing');
  assert.equal(playing.youId, created.playerId, 'still the same player');
  assert.ok(playing.writing.template, 'and they are dealt a template');
});
