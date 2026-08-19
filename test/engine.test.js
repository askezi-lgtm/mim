'use strict';

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../shared/engine');

const T0 = 1_700_000_000_000; // fixed clock: the engine never reads Date.now()

function roomWith(names, now = T0, settings = {}) {
  const state = engine.createRoom('TEST', now);
  const ids = names.map((name) => engine.addPlayer(state, { name, now }).player.id);
  engine.updateSettings(state, { rounds: 1, writeSeconds: 20, voteSeconds: 8, revealSeconds: 3, ...settings }, now);
  return { state, ids };
}

test('a round plays out on the clock alone', () => {
  const { state, ids } = roomWith(['A', 'B']);
  assert.deepEqual(engine.startGame(state, T0), {});
  assert.equal(state.phase, 'writing');

  engine.submitMeme(state, ids[0], { top: 'ONE', bottom: '' }, T0 + 1000);
  assert.equal(state.phase, 'writing', 'still waiting for the second player');

  engine.submitMeme(state, ids[1], { top: 'TWO', bottom: '' }, T0 + 2000);
  assert.equal(state.phase, 'voting', 'everyone submitted, so voting starts early');

  // Nobody rates the first meme: the vote deadline moves the game on.
  engine.tick(state, T0 + 2000 + 8000);
  assert.equal(state.phase, 'reveal');
  assert.equal(engine.snapshotFor(state, ids[0], T0).meme.points, 0);

  // Reveal -> second meme -> rate it -> reveal -> final (single round).
  engine.tick(state, T0 + 2000 + 8000 + 3000);
  assert.equal(state.phase, 'voting');
  const second = engine.snapshotFor(state, ids[0], T0).meme;
  const voter = second.isMine ? ids[1] : ids[0];
  engine.castVote(state, voter, 5, T0 + 14000);
  assert.equal(state.phase, 'reveal', 'the only eligible voter ended the round early');
  assert.equal(engine.snapshotFor(state, voter, T0).meme.points, 100);

  engine.tick(state, T0 + 30000);
  assert.equal(state.phase, 'final');
  assert.equal(state.winners.length, 1, 'the rated meme wins outright');
  assert.equal(state.winners[0].score, 100 + 50, 'stars plus the round bonus');
});

test('tick is idempotent, so concurrent callers agree', () => {
  const { state, ids } = roomWith(['A', 'B']);
  engine.startGame(state, T0);
  engine.submitMeme(state, ids[0], { top: 'ONE', bottom: '' }, T0);
  engine.submitMeme(state, ids[1], { top: 'TWO', bottom: '' }, T0);

  const now = T0 + 60000;
  engine.tick(state, now);
  const first = JSON.stringify(state);
  const changed = engine.tick(state, now);
  assert.equal(changed, false, 'a repeated tick at the same clock does nothing');
  assert.equal(JSON.stringify(state), first);
});

test('bot moves are deterministic, so two replicas of a state agree', () => {
  const state = engine.createRoom('BOTS', T0);
  engine.addPlayer(state, { name: 'Human', now: T0 });
  engine.addPlayer(state, { name: 'MemeBot', isBot: true, now: T0 });
  engine.updateSettings(state, { rounds: 1, writeSeconds: 20, voteSeconds: 8 }, T0);
  engine.startGame(state, T0);

  // Two serverless invocations can load the same room and tick it at once.
  const replica = JSON.parse(JSON.stringify(state));
  engine.tick(state, T0 + 19000);
  engine.tick(replica, T0 + 19000);

  const captionOf = (s) => {
    const bot = engine.playerList(s).find((p) => p.isBot);
    const sub =
      s.submissions.find((x) => x.authorId === bot.id) ||
      s.roundResults.find((r) => r.author.id === bot.id);
    return sub ? `${sub.top}|${sub.bottom}` : null;
  };
  assert.ok(captionOf(state), 'the bot wrote something');
  assert.equal(captionOf(state), captionOf(replica), 'both replicas wrote the same caption');
});

test('drafts survive a writing phase nobody submitted', () => {
  const { state, ids } = roomWith(['A', 'B']);
  engine.startGame(state, T0);
  engine.saveDraft(state, ids[0], { top: 'AUTOSAVED', bottom: '' }, T0 + 500);
  engine.tick(state, T0 + 21000);
  assert.equal(state.phase, 'voting');
  assert.equal(state.submissions.length, 1, 'only the drafted meme made it through');
  assert.equal(state.submissions[0].top, 'AUTOSAVED');
});

test('a lobby seat survives a blip and is reclaimed only after the grace period', () => {
  const state = engine.createRoom('POLL', T0);
  const a = engine.addPlayer(state, { name: 'A', mode: 'poll', now: T0 }).player.id;
  const b = engine.addPlayer(state, { name: 'B', mode: 'poll', now: T0 }).player.id;
  assert.equal(state.hostId, a);

  // A's phone locks: it stops polling but must still be able to come back.
  const away = T0 + engine.PRESENCE_TTL_MS + 1000;
  engine.touch(state, b, away, 'poll');
  engine.tick(state, away);
  assert.equal(state.players[a].connected, false, 'marked away');
  assert.equal(state.hostId, a, 'the badge waits for them rather than jumping to B');

  engine.touch(state, a, away + 5000, 'poll');
  assert.equal(state.players[a].connected, true, 'A came back to the same seat');

  // Gone for good: marked away first, then the seat is freed a grace later.
  const away2 = away + 5000 + engine.PRESENCE_TTL_MS + 1000;
  engine.touch(state, b, away2, 'poll');
  engine.tick(state, away2);
  assert.equal(state.players[a].connected, false);

  const gone = away2 + engine.LOBBY_GRACE_MS + 1000;
  engine.touch(state, b, gone, 'poll');
  engine.tick(state, gone);
  assert.equal(state.players[a], undefined, 'the abandoned lobby seat is reclaimed');
  assert.equal(state.hostId, b, 'and the host badge follows');
});

test('a polling player who stalls mid-game keeps their seat and score', () => {
  const state = engine.createRoom('POLL', T0);
  const a = engine.addPlayer(state, { name: 'A', mode: 'poll', now: T0 }).player.id;
  const b = engine.addPlayer(state, { name: 'B', mode: 'poll', now: T0 }).player.id;
  engine.updateSettings(state, { rounds: 2, writeSeconds: 60 }, T0);
  engine.startGame(state, T0);
  state.players[a].score = 120;

  const later = T0 + engine.PRESENCE_TTL_MS + 1000;
  engine.touch(state, b, later, 'poll');
  engine.tick(state, later);
  assert.equal(state.players[a].connected, false, 'marked away');
  assert.equal(state.players[a].score, 120, 'but the seat and the score are still theirs');
  assert.equal(state.hostId, a, 'a mid-game blip does not hand over the host badge');
});

test('a rejoining player is dealt a template mid-writing', () => {
  const { state, ids } = roomWith(['A', 'B']);
  engine.startGame(state, T0);
  engine.setConnected(state, ids[1], false, T0 + 1000);
  assert.equal(state.players[ids[1]].connected, false);

  engine.setConnected(state, ids[1], true, T0 + 2000);
  const snapshot = engine.snapshotFor(state, ids[1], T0 + 2000);
  assert.ok(snapshot.writing.template, 'the returning player can still play this round');
});
