'use strict';

/**
 * Meme templates used by the game.
 *
 * `url` may be either a remote image or a path served from `public/`.
 * Drop your own images into `public/templates/` and add them here as
 * `{ id: 'my-meme', name: 'My meme', url: '/templates/my-meme.jpg' }`
 * to play with a fully offline template set.
 *
 * If an image fails to load the client draws a labelled placeholder,
 * so a missing template never breaks a round.
 */
const TEMPLATES = [
  { id: 'drake', name: 'Drake', url: 'https://i.imgflip.com/30b1gx.jpg' },
  { id: 'distracted-bf', name: 'Distracted Boyfriend', url: 'https://i.imgflip.com/1ur9b0.jpg' },
  { id: 'two-buttons', name: 'Two Buttons', url: 'https://i.imgflip.com/1g8my4.jpg' },
  { id: 'change-my-mind', name: 'Change My Mind', url: 'https://i.imgflip.com/24y43o.jpg' },
  { id: 'exit-ramp', name: 'Left Exit 12', url: 'https://i.imgflip.com/22bdq6.jpg' },
  { id: 'expanding-brain', name: 'Expanding Brain', url: 'https://i.imgflip.com/1jwhww.jpg' },
  { id: 'batman-slap', name: 'Batman Slapping Robin', url: 'https://i.imgflip.com/9ehk.jpg' },
  { id: 'woman-cat', name: 'Woman Yelling at a Cat', url: 'https://i.imgflip.com/345v97.jpg' },
  { id: 'balloon', name: 'Running Away Balloon', url: 'https://i.imgflip.com/261o3j.jpg' },
  { id: 'mocking-sponge', name: 'Mocking SpongeBob', url: 'https://i.imgflip.com/1otk96.jpg' },
  { id: 'skeleton', name: 'Waiting Skeleton', url: 'https://i.imgflip.com/2fm6x.jpg' },
  { id: 'success-kid', name: 'Success Kid', url: 'https://i.imgflip.com/1bhk.jpg' },
  { id: 'disaster-girl', name: 'Disaster Girl', url: 'https://i.imgflip.com/23ls.jpg' },
  { id: 'one-does-not', name: 'One Does Not Simply', url: 'https://i.imgflip.com/1bij.jpg' },
  { id: 'ancient-aliens', name: 'Ancient Aliens', url: 'https://i.imgflip.com/26am.jpg' },
  { id: 'roll-safe', name: 'Roll Safe', url: 'https://i.imgflip.com/1h7in3.jpg' },
  { id: 'pikachu', name: 'Surprised Pikachu', url: 'https://i.imgflip.com/2kbn1e.jpg' },
  { id: 'this-is-fine', name: 'This Is Fine', url: 'https://i.imgflip.com/wxica.jpg' },
  { id: 'harold', name: 'Hide the Pain Harold', url: 'https://i.imgflip.com/gk5el.jpg' },
  { id: 'trade-offer', name: 'Trade Offer', url: 'https://i.imgflip.com/54hjww.jpg' },
  { id: 'bernie', name: 'Bernie Asking for Support', url: 'https://i.imgflip.com/3oevdk.jpg' },
  { id: 'panik-kalm', name: 'Panik / Kalm / Panik', url: 'https://i.imgflip.com/3qqcim.png' },
  { id: 'doge-cheems', name: 'Buff Doge vs Cheems', url: 'https://i.imgflip.com/43a45p.png' },
  { id: 'always-has-been', name: 'Always Has Been', url: 'https://i.imgflip.com/46e43q.png' },
  { id: 'monkey-puppet', name: 'Monkey Puppet', url: 'https://i.imgflip.com/2gnnjh.jpg' },
  { id: 'gru-plan', name: "Gru's Plan", url: 'https://i.imgflip.com/26jxvz.jpg' },
  { id: 'is-this-pigeon', name: 'Is This a Pigeon?', url: 'https://i.imgflip.com/1o00in.jpg' },
  { id: 'sad-pablo', name: 'Sad Pablo Escobar', url: 'https://i.imgflip.com/1c1uej.jpg' },
  { id: 'boardroom', name: 'Boardroom Meeting Suggestion', url: 'https://i.imgflip.com/m78d.jpg' },
  { id: 'they-dont-know', name: "They Don't Know", url: 'https://i.imgflip.com/3d5aj2.jpg' }
];

/** Fisher-Yates shuffle on a copy of the array. */
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deal `count` templates, avoiding repeats until the deck runs out.
 * `used` is a Set of template ids already handed out in this game.
 */
function dealTemplates(count, used = new Set()) {
  let pool = TEMPLATES.filter((t) => !used.has(t.id));
  if (pool.length < count) {
    used.clear();
    pool = TEMPLATES.slice();
  }
  const dealt = shuffle(pool).slice(0, count);
  dealt.forEach((t) => used.add(t.id));
  return dealt;
}

module.exports = { TEMPLATES, dealTemplates, shuffle };
