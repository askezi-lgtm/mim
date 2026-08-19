'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../shared/api');

/** Stand-in for Netlify Blobs: JSON values plus etag-based conditional writes. */
function memoryStorage() {
  const rooms = new Map();
  let counter = 0;
  return {
    rooms,
    writes: 0,
    async get(code) {
      const entry = rooms.get(code);
      return entry ? { state: JSON.parse(entry.json), etag: entry.etag } : null;
    },
    async put(code, state, etag) {
      const entry = rooms.get(code);
      if (!entry) return false;
      if (etag && entry.etag !== etag) return false; // somebody wrote first
      rooms.set(code, { json: JSON.stringify(state), etag: `e${++counter}` });
      this.writes += 1;
      return true;
    },
    async create(code, state) {
      if (rooms.has(code)) return false;
      rooms.set(code, { json: JSON.stringify(state), etag: `e${++counter}` });
      this.writes += 1;
      return true;
    }
  };
}

function harness() {
  const storage = memoryStorage();
  let clock = 1_700_000_000_000;
  const api = createApi(storage, { now: () => clock });
  return {
    storage,
    api,
    advance: (ms) => (clock += ms),
    at: () => clock
  };
}

async function newGame({ api }, names) {
  const created = await api.rpc({ op: 'create', payload: { name: names[0], avatar: '😂' } });
  assert.equal(created.status, 200);
  const code = created.body.code;
  const players = [{ id: created.body.playerId, name: names[0] }];
  for (const name of names.slice(1)) {
    const joined = await api.rpc({ op: 'join', code, payload: { name } });
    assert.equal(joined.status, 200, `${name} joined`);
    players.push({ id: joined.body.playerId, name });
  }
  return { code, players };
}

test('a whole game runs over plain HTTP requests', async () => {
  const h = harness();
  const { code, players } = await newGame(h, ['Alice', 'Bob']);
  const [alice, bob] = players;

  const settings = await h.api.rpc({
    op: 'settings',
    code,
    playerId: alice.id,
    payload: { rounds: 1, writeSeconds: 20, voteSeconds: 8, revealSeconds: 3 }
  });
  assert.equal(settings.body.state.settings.rounds, 1);

  const notHost = await h.api.rpc({ op: 'settings', code, playerId: bob.id, payload: { rounds: 9 } });
  assert.deepEqual(notHost.body.result, { error: 'NOT_HOST' }, 'only the host changes settings');

  const started = await h.api.rpc({ op: 'start', code, playerId: alice.id });
  assert.deepEqual(started.body.result, { ok: true });
  assert.equal(started.body.state.phase, 'writing');
  assert.ok(started.body.state.writing.template.url);

  await h.api.rpc({ op: 'submit', code, playerId: alice.id, payload: { top: 'ALICE', bottom: '' } });
  const second = await h.api.rpc({ op: 'submit', code, playerId: bob.id, payload: { top: 'BOB', bottom: '' } });
  assert.equal(second.body.state.phase, 'voting', 'both submitted, so rating starts early');

  // Rate every meme; the author of the current one is not allowed to vote.
  for (let i = 0; i < 2; i++) {
    const view = await h.api.state(code, alice.id);
    assert.equal(view.body.state.phase, 'voting');
    const voter = view.body.state.meme.isMine ? bob : alice;
    const own = view.body.state.meme.isMine ? alice : bob;
    const refused = await h.api.rpc({ op: 'vote', code, playerId: own.id, payload: { rating: 5 } });
    assert.deepEqual(refused.body.result, { error: 'CANNOT_VOTE_OWN' });
    const voted = await h.api.rpc({ op: 'vote', code, playerId: voter.id, payload: { rating: 5 } });
    assert.equal(voted.body.state.phase, 'reveal');
    assert.equal(voted.body.state.meme.points, 100);
    h.advance(3500); // let the reveal timer lapse
  }

  const final = await h.api.state(code, alice.id);
  assert.equal(final.body.state.phase, 'final');
  assert.equal(final.body.state.roundResults.length, 2);
  final.body.state.leaderboard.forEach((p) => assert.equal(p.score, 100 + 50));
});

test('polling does not write unless the room actually moved', async () => {
  const h = harness();
  const { code, players } = await newGame(h, ['Alice', 'Bob']);
  const before = h.storage.writes;

  await h.api.state(code, players[0].id);
  await h.api.state(code, players[0].id);
  assert.equal(h.storage.writes, before, 'idle polls are reads only');

  // Once the heartbeat window passes, one poll refreshes presence.
  h.advance(20000);
  await h.api.state(code, players[0].id);
  assert.equal(h.storage.writes, before + 1, 'exactly one presence write');
});

test('a lost write race is retried instead of dropped', async () => {
  const h = harness();
  const { code, players } = await newGame(h, ['Alice', 'Bob']);
  await h.api.rpc({ op: 'settings', code, playerId: players[0].id, payload: { rounds: 1 } });
  await h.api.rpc({ op: 'start', code, playerId: players[0].id });

  // Simulate a concurrent invocation winning the first conditional write.
  const realPut = h.storage.put.bind(h.storage);
  let sabotaged = false;
  h.storage.put = async (roomCode, state, etag) => {
    if (!sabotaged) {
      sabotaged = true;
      await realPut(roomCode, JSON.parse(JSON.stringify(state)), etag); // other writer lands
      return false; // ...so our conditional write is rejected
    }
    return realPut(roomCode, state, etag);
  };

  const submitted = await h.api.rpc({
    op: 'submit',
    code,
    playerId: players[1].id,
    payload: { top: 'RETRIED', bottom: '' }
  });
  assert.equal(submitted.status, 200);
  assert.ok(sabotaged, 'the race actually happened');
  const stored = JSON.parse(h.storage.rooms.get(code).json);
  const mine = stored.submissions.find((s) => s.authorId === players[1].id);
  assert.equal(mine.captions[0].text, 'RETRIED', 'the caption survived the lost race');
});

test('unknown rooms and lost seats answer 404', async () => {
  const h = harness();
  const { code, players } = await newGame(h, ['Alice', 'Bob']);

  assert.equal((await h.api.state('ZZZZ', players[0].id)).status, 404);
  assert.equal((await h.api.rpc({ op: 'join', code: 'ZZZZ', payload: { name: 'X' } })).status, 404);
  assert.equal((await h.api.state(code, 'nobody')).status, 404);
  assert.equal(
    (await h.api.rpc({ op: 'rejoin', code, playerId: 'nobody' })).body.error,
    'SEAT_NOT_FOUND'
  );
  const rejoined = await h.api.rpc({ op: 'rejoin', code, playerId: players[1].id });
  assert.equal(rejoined.status, 200);
  assert.equal(rejoined.body.state.youId, players[1].id);
});

test('bots play the serverless game too', async () => {
  const h = harness();
  const { code, players } = await newGame(h, ['Alice', 'Bob']);
  const host = players[0].id;
  await h.api.rpc({ op: 'botAdd', code, playerId: host });
  const withBot = await h.api.rpc({ op: 'settings', code, playerId: host, payload: { rounds: 1, writeSeconds: 20 } });
  assert.equal(withBot.body.state.players.filter((p) => p.isBot).length, 1);

  await h.api.rpc({ op: 'start', code, playerId: host });
  h.advance(21000); // past the bot's write delay and the 20s writing deadline
  const view = await h.api.state(code, host);
  assert.equal(view.body.state.phase, 'voting', 'the deadline advanced the round on a poll');
  assert.ok(view.body.state.meme, 'the bot produced a meme to rate');
});

test('swapping a template works over HTTP too', async () => {
  const h = harness();
  const { code, players } = await newGame(h, ['Alice', 'Bob']);
  await h.api.rpc({ op: 'settings', code, playerId: players[0].id, payload: { swapsPerRound: 1 } });
  await h.api.rpc({ op: 'start', code, playerId: players[0].id });

  const before = (await h.api.state(code, players[0].id)).body.state.writing;
  const swapped = await h.api.rpc({ op: 'swap', code, playerId: players[0].id });
  assert.equal(swapped.status, 200);
  assert.notEqual(swapped.body.state.writing.template.id, before.template.id);
  assert.equal(swapped.body.state.writing.swapsLeft, 0);

  const spent = await h.api.rpc({ op: 'swap', code, playerId: players[0].id });
  assert.deepEqual(spent.body.result, { error: 'NO_SWAPS_LEFT' });
});
