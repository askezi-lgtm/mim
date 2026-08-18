/* Make It Mem — client. One socket, one state snapshot, one render pass. */
(function () {
  'use strict';

  const AVATARS = ['😂', '😎', '🤡', '👽', '🐸', '🦄', '🐙', '🍕', '👻', '🔥', '🧠', '🦖', '🌮', '💀', '🐧', '🥑'];
  const RATING_EMOJI = ['💩', '😐', '🙂', '😂', '🤣'];

  const $ = (id) => document.getElementById(id);
  const store = {
    get name() {
      return localStorage.getItem('mim:name') || '';
    },
    set name(v) {
      localStorage.setItem('mim:name', v);
    },
    get avatar() {
      return localStorage.getItem('mim:avatar') || AVATARS[0];
    },
    set avatar(v) {
      localStorage.setItem('mim:avatar', v);
    },
    get seat() {
      try {
        return JSON.parse(localStorage.getItem('mim:seat') || 'null');
      } catch (_) {
        return null;
      }
    },
    set seat(v) {
      if (v) localStorage.setItem('mim:seat', JSON.stringify(v));
      else localStorage.removeItem('mim:seat');
    }
  };

  const socket = io({ transports: ['websocket', 'polling'] });
  let state = null;
  let clockOffset = 0; // serverNow - clientNow
  let currentTemplateId = null;
  let draftTimer = null;
  let lastPhase = null;

  /* --------------------------------------------------------------- helpers */

  function toast(message, kind = 'info') {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  function handleError(result) {
    if (result && result.error) {
      toast(I18N.errorText(result.error), 'error');
      return true;
    }
    return false;
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((el) => {
      el.hidden = el.id !== `screen-${name}`;
    });
  }

  function secondsLeft() {
    if (!state || !state.deadline) return null;
    return Math.max(0, (state.deadline - (Date.now() + clockOffset)) / 1000);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ------------------------------------------------------------ home / id */

  function renderAvatarPicker() {
    const wrap = $('avatar-picker');
    wrap.innerHTML = '';
    AVATARS.forEach((emoji) => {
      const button = el('button', 'avatar', emoji);
      button.type = 'button';
      if (emoji === store.avatar) button.classList.add('selected');
      button.addEventListener('click', () => {
        store.avatar = emoji;
        renderAvatarPicker();
        if (state) socket.emit('player:update', { name: store.name, avatar: emoji });
      });
      wrap.appendChild(button);
    });
  }

  function identity() {
    const name = $('name-input').value.trim();
    if (!name) {
      toast(I18N.t('needName'), 'error');
      $('name-input').focus();
      return null;
    }
    store.name = name;
    return { name, avatar: store.avatar };
  }

  /* ----------------------------------------------------------------- lobby */

  function playerCard(player, you) {
    const card = el('div', 'player-card');
    if (!player.connected && !player.isBot) card.classList.add('offline');
    card.appendChild(el('span', 'player-avatar', player.avatar));
    const meta = el('div', 'player-meta');
    meta.appendChild(el('span', 'player-name', player.name));
    const tags = el('span', 'tags');
    if (player.id === you) tags.appendChild(el('i', 'tag you', I18N.t('you')));
    if (player.isHost) tags.appendChild(el('i', 'tag host', I18N.t('host')));
    if (player.isBot) tags.appendChild(el('i', 'tag bot', I18N.t('bot')));
    if (!player.connected && !player.isBot) tags.appendChild(el('i', 'tag off', I18N.t('offline')));
    meta.appendChild(tags);
    card.appendChild(meta);
    return card;
  }

  function renderLobby() {
    $('lobby-code').textContent = state.code;
    $('player-count').textContent = state.players.length;
    const grid = $('lobby-players');
    grid.innerHTML = '';
    state.players.forEach((p) => grid.appendChild(playerCard(p, state.youId)));

    $('host-panel').hidden = !state.isHost;
    $('wait-host').hidden = state.isHost;
    $('bot-count').textContent = state.players.filter((p) => p.isBot).length;

    $('set-rounds').value = state.settings.rounds;
    $('set-write').value = state.settings.writeSeconds;
    $('set-vote').value = state.settings.voteSeconds;
    $('val-rounds').textContent = state.settings.rounds;
    $('val-write').textContent = state.settings.writeSeconds;
    $('val-vote').textContent = state.settings.voteSeconds;

    const canStart = state.players.filter((p) => p.connected || p.isBot).length >= state.minPlayers;
    $('start-btn').disabled = !canStart;
  }

  /* --------------------------------------------------------------- writing */

  function renderWriting() {
    const w = state.writing || {};
    $('write-round').textContent = I18N.t('round', state.round, state.settings.rounds);
    if (w.template && w.template.id !== currentTemplateId) {
      currentTemplateId = w.template.id;
      $('top-input').value = w.top || '';
      $('bottom-input').value = w.bottom || '';
    }
    drawWriteCanvas();
    $('submit-btn').textContent = w.submitted ? I18N.t('updateMeme') : I18N.t('submitMeme');
    $('submit-btn').classList.toggle('done', Boolean(w.submitted));
    const progress = I18N.t('writeProgress', w.done || 0, w.total || 0);
    $('write-progress').textContent = w.submitted ? `${I18N.t('submitted')} · ${progress}` : progress;
  }

  function drawWriteCanvas() {
    const w = state && state.writing;
    if (!w || !w.template) return;
    MemeRender.draw($('write-canvas'), {
      template: w.template,
      top: $('top-input').value,
      bottom: $('bottom-input').value
    });
  }

  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      socket.emit('meme:draft', { top: $('top-input').value, bottom: $('bottom-input').value });
    }, 400);
  }

  /* ---------------------------------------------------------------- voting */

  function renderVoting() {
    const meme = state.meme;
    if (!meme) return;
    $('vote-progress').textContent = `${meme.index}/${meme.total}`;
    MemeRender.draw($('vote-canvas'), meme);

    const row = $('rating-row');
    row.innerHTML = '';
    if (meme.isMine) {
      $('vote-title').textContent = I18N.t('yourMeme');
      $('vote-note').textContent = I18N.t('voteProgress', meme.voted, meme.voters);
      return;
    }
    $('vote-title').textContent = I18N.t('voteTitle');
    RATING_EMOJI.forEach((emoji, i) => {
      const value = i + 1;
      const button = el('button', 'rate');
      button.type = 'button';
      button.appendChild(el('span', 'rate-emoji', emoji));
      button.appendChild(el('span', 'rate-label', I18N.t('ratings')[i]));
      if (meme.yourRating === value) button.classList.add('picked');
      button.addEventListener('click', () => {
        socket.emit('vote:cast', { rating: value }, handleError);
        [...row.children].forEach((c) => c.classList.remove('picked'));
        button.classList.add('picked');
      });
      row.appendChild(button);
    });
    $('vote-note').textContent = meme.yourRating
      ? `${I18N.t('voteDone')} (${I18N.t('voteProgress', meme.voted, meme.voters)})`
      : I18N.t('voteProgress', meme.voted, meme.voters);
  }

  /* ---------------------------------------------------------------- reveal */

  function renderReveal() {
    const meme = state.meme;
    if (!meme) return;
    MemeRender.draw($('reveal-canvas'), meme);
    const author = meme.author || { avatar: '❓', name: '???' };
    $('reveal-author').textContent = `${author.avatar} ${author.name}`;
    $('reveal-points').textContent = I18N.t('points', meme.points || 0);
    const stars = $('reveal-stars');
    stars.innerHTML = '';
    if (!meme.ratings || meme.ratings.length === 0) {
      stars.appendChild(el('span', 'muted', I18N.t('noVotes')));
    } else {
      meme.ratings.forEach((rating, i) => {
        const chip = el('span', 'star-chip', RATING_EMOJI[rating - 1]);
        chip.style.animationDelay = `${i * 90}ms`;
        stars.appendChild(chip);
      });
    }
  }

  /* --------------------------------------------------------- scores/final */

  function renderBoard(container) {
    container.innerHTML = '';
    state.leaderboard.forEach((player, i) => {
      const row = el('div', 'board-row');
      if (player.id === state.youId) row.classList.add('me');
      row.appendChild(el('span', 'rank', `${i + 1}`));
      row.appendChild(el('span', 'player-avatar', player.avatar));
      row.appendChild(el('span', 'board-name', player.name));
      if (player.roundScore > 0) row.appendChild(el('span', 'delta', `+${player.roundScore}`));
      row.appendChild(el('span', 'board-score', String(player.score)));
      container.appendChild(row);
    });
  }

  function renderResults(container) {
    container.innerHTML = '';
    (state.roundResults || [])
      .slice()
      .sort((a, b) => b.points - a.points)
      .forEach((result) => {
        const card = el('div', 'result-card');
        if (result.roundWinner) card.classList.add('winner');
        const canvas = document.createElement('canvas');
        canvas.className = 'meme-canvas small';
        card.appendChild(canvas);
        MemeRender.draw(canvas, result);
        const foot = el('div', 'result-foot');
        foot.appendChild(el('span', 'result-author', `${result.author.avatar} ${result.author.name}`));
        foot.appendChild(el('span', 'result-points', I18N.t('points', result.points)));
        card.appendChild(foot);
        if (result.roundWinner) card.appendChild(el('div', 'ribbon', I18N.t('roundWinner')));
        container.appendChild(card);
      });
  }

  function renderScores() {
    renderBoard($('score-board'));
    renderResults($('round-results'));
    $('skip-btn').hidden = !state.isHost;
  }

  function renderFinal() {
    const winners = state.winners || [];
    $('winner-name').textContent = winners.length
      ? winners.length > 1
        ? `${I18N.t('winnerTie')} ${winners.map((w) => `${w.avatar} ${w.name}`).join(' · ')}`
        : `${winners[0].avatar} ${winners[0].name}`
      : '—';
    renderBoard($('final-board'));
    renderResults($('final-results'));
    $('again-btn').hidden = !state.isHost;
    $('tolobby-btn').hidden = !state.isHost;
  }

  /* ----------------------------------------------------------- main render */

  function render() {
    if (!state) {
      showScreen('home');
      $('room-chip').hidden = true;
      return;
    }
    $('room-chip').hidden = false;
    $('room-chip-code').textContent = state.code;

    switch (state.phase) {
      case 'lobby':
        showScreen('lobby');
        renderLobby();
        break;
      case 'writing':
        showScreen('write');
        renderWriting();
        break;
      case 'voting':
        showScreen('vote');
        renderVoting();
        break;
      case 'reveal':
        showScreen('reveal');
        renderReveal();
        break;
      case 'scores':
        showScreen('scores');
        renderScores();
        break;
      case 'final':
        showScreen('final');
        renderFinal();
        break;
      default:
        showScreen('home');
    }
    tickTimers();
  }

  function tickTimers() {
    if (!state) return;
    const left = secondsLeft();
    const label = left === null ? '' : String(Math.ceil(left));

    if (state.phase === 'writing') {
      $('write-timer').textContent = label;
      const total = state.settings.writeSeconds;
      $('write-bar').style.width = left === null ? '0%' : `${Math.min(100, (left / total) * 100)}%`;
      $('write-timer').classList.toggle('urgent', left !== null && left <= 10);
    } else if (state.phase === 'voting') {
      $('vote-timer').textContent = label;
      const total = state.settings.voteSeconds;
      $('vote-bar').style.width = left === null ? '0%' : `${Math.min(100, (left / total) * 100)}%`;
      $('vote-timer').classList.toggle('urgent', left !== null && left <= 5);
    } else if (state.phase === 'scores') {
      $('next-round-in').textContent = left === null ? '' : I18N.t('nextRoundIn', Math.ceil(left));
    }
  }

  setInterval(tickTimers, 250);

  /* ---------------------------------------------------------------- socket */

  socket.on('connect', () => {
    const seat = store.seat;
    if (seat && seat.code && seat.playerId) {
      socket.emit('room:rejoin', seat, (result) => {
        if (result && result.error) {
          store.seat = null;
          state = null;
          render();
        }
      });
    }
  });

  socket.on('state', (snapshot) => {
    clockOffset = snapshot.serverNow - Date.now();
    const previous = state;
    state = snapshot;
    store.seat = { code: snapshot.code, playerId: snapshot.youId };
    if (previous && previous.phase !== snapshot.phase) currentTemplateId = null;
    if (snapshot.phase !== 'writing') currentTemplateId = null;
    if (lastPhase !== snapshot.phase) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      lastPhase = snapshot.phase;
    }
    render();
  });

  socket.on('disconnect', () => toast(I18N.t('connecting'), 'warn'));

  /* ----------------------------------------------------------------- wires */

  function joinFlow(event, payload) {
    const who = identity();
    if (!who) return;
    socket.emit(event, { ...who, ...payload }, (result) => {
      if (handleError(result)) return;
      store.seat = { code: result.code, playerId: result.playerId };
      history.replaceState(null, '', `/${result.code}`);
    });
  }

  $('create-btn').addEventListener('click', () => joinFlow('room:create'));
  $('join-btn').addEventListener('click', () => {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) return toast(I18N.t('needCode'), 'error');
    joinFlow('room:join', { code });
  });
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });
  $('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const code = $('code-input').value.trim();
      (code ? $('join-btn') : $('create-btn')).click();
    }
  });

  $('copy-link').addEventListener('click', async () => {
    const url = `${location.origin}/${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(I18N.t('copied'));
    } catch (_) {
      prompt('', url);
    }
  });

  $('leave-btn').addEventListener('click', () => {
    socket.emit('room:leave');
    store.seat = null;
    state = null;
    history.replaceState(null, '', '/');
    render();
  });

  $('brand').addEventListener('click', () => {
    if (!state) return;
    if (confirm(`${I18N.t('leaveRoom')}?`)) $('leave-btn').click();
  });

  const settingInputs = [
    ['set-rounds', 'rounds', 'val-rounds'],
    ['set-write', 'writeSeconds', 'val-write'],
    ['set-vote', 'voteSeconds', 'val-vote']
  ];
  settingInputs.forEach(([id, key, labelId]) => {
    $(id).addEventListener('input', () => {
      $(labelId).textContent = $(id).value;
    });
    $(id).addEventListener('change', () => {
      socket.emit('settings:update', { [key]: Number($(id).value) });
    });
  });

  $('bot-add').addEventListener('click', () => socket.emit('bot:add'));
  $('bot-remove').addEventListener('click', () => socket.emit('bot:remove'));
  $('start-btn').addEventListener('click', () => socket.emit('game:start', {}, handleError));
  $('skip-btn').addEventListener('click', () => socket.emit('game:skip'));
  $('again-btn').addEventListener('click', () => socket.emit('game:start', {}, handleError));
  $('tolobby-btn').addEventListener('click', () => socket.emit('game:lobby'));

  ['top-input', 'bottom-input'].forEach((id) => {
    $(id).addEventListener('input', () => {
      drawWriteCanvas();
      saveDraft();
    });
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('submit-btn').click();
    });
  });

  $('submit-btn').addEventListener('click', () => {
    socket.emit(
      'meme:submit',
      { top: $('top-input').value, bottom: $('bottom-input').value },
      handleError
    );
  });

  $('lang-toggle').addEventListener('click', () => I18N.setLang(I18N.other));
  I18N.onChange(() => {
    $('lang-toggle').textContent = I18N.t('langButton');
    render();
  });

  /* ------------------------------------------------------------- bootstrap */

  renderAvatarPicker();
  $('name-input').value = store.name;
  const codeFromUrl = location.pathname.replace('/', '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(codeFromUrl)) $('code-input').value = codeFromUrl;
  I18N.apply();
  $('lang-toggle').textContent = I18N.t('langButton');
  render();
})();
