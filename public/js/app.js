/* Make It Mem — client. One socket, one state snapshot, one render pass. */
(function () {
  'use strict';

  const RESUME_WINDOW_MS = 5 * 60 * 1000; // auto-rejoin only a very recent seat
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
      if (v) localStorage.setItem('mim:seat', JSON.stringify({ ...v, at: v.at || Date.now() }));
      else localStorage.removeItem('mim:seat');
    }
  };

  const net = window.Net; // net.io on the Node server, HTTP polling on Netlify
  let state = null;
  let clockOffset = 0; // serverNow - clientNow
  let currentTemplateId = null;
  let draftTimer = null;
  let lastPhase = null;
  let votingKey = null; // rebuild the rating row only when the meme changes

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

  const LOST_SEAT = ['ROOM_NOT_FOUND', 'SEAT_NOT_FOUND'];

  /** The room (or our seat in it) is gone for good - back to the home screen. */
  function dropSeat(error) {
    store.seat = null;
    state = null;
    $('resume-card').hidden = true;
    history.replaceState(null, '', '/');
    render();
    toast(error === 'ROOM_NOT_FOUND' ? I18N.t('roomGone') : I18N.errorText(error), 'error');
  }

  /**
   * Send an action, and if the server does not recognise us any more - which
   * happens when a reconnect lands before our rejoin - claim the seat again and
   * retry the action once before bothering the player with an error.
   */
  function send(event, payload, cb, retried) {
    net.emit(event, payload, (result) => {
      const lost = result && LOST_SEAT.includes(result.error);
      if (!lost || retried || !store.seat) return (cb || handleError)(result);

      net.emit('room:rejoin', store.seat, (rejoin) => {
        if (rejoin && rejoin.error) {
          dropSeat(rejoin.error);
          return;
        }
        send(event, payload, cb, true);
      });
    });
  }

  function setOffline(offline) {
    const bar = $('offline-bar');
    bar.hidden = !offline;
    bar.textContent = I18N.t('offlineBanner');
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
        if (state) net.emit('player:update', { name: store.name, avatar: emoji });
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
    $('set-swaps').value = state.settings.swapsPerRound;
    $('val-rounds').textContent = state.settings.rounds;
    $('val-write').textContent = state.settings.writeSeconds;
    $('val-vote').textContent = state.settings.voteSeconds;
    $('val-swaps').textContent = state.settings.swapsPerRound;

    const canStart = state.players.filter((p) => p.connected || p.isBot).length >= state.minPlayers;
    $('start-btn').disabled = !canStart;
  }

  /* --------------------------------------------------------------- writing */

  // The captions being edited live here while writing: the server only hears
  // about them through autosaved drafts, so typing is never interrupted by an
  // incoming state (another player submitting, a timer tick, a swap).
  let captions = [];
  let writeRound = null;
  let activeLine = 0;

  function renderWriting() {
    const w = state.writing || {};
    $('write-round').textContent = I18N.t('round', state.round, state.settings.rounds);

    if (state.round !== writeRound) {
      writeRound = state.round;
      captions = (w.captions || []).map((caption) => ({ ...caption }));
      activeLine = 0;
      renderCaptionRows();
    }
    if (w.template && w.template.id !== currentTemplateId) {
      currentTemplateId = w.template.id;
    }

    drawWriteCanvas();

    const swaps = w.swapsLeft || 0;
    $('swap-btn').textContent = swaps ? I18N.t('swapsLeft', swaps) : I18N.t('noSwapsLeft');
    $('swap-btn').disabled = swaps <= 0;
    $('add-line').disabled = captions.length >= (w.maxCaptions || 5);

    $('submit-btn').textContent = w.submitted ? I18N.t('updateMeme') : I18N.t('submitMeme');
    $('submit-btn').classList.toggle('done', Boolean(w.submitted));
    const progress = I18N.t('writeProgress', w.done || 0, w.total || 0);
    $('write-progress').textContent = w.submitted ? `${I18N.t('submitted')} · ${progress}` : progress;
  }

  /** One row per caption; the rows are rebuilt only when lines are added or removed. */
  function renderCaptionRows() {
    const wrap = $('caption-rows');
    wrap.innerHTML = '';
    captions.forEach((caption, index) => {
      const row = el('div', 'caption-row');
      if (index === activeLine) row.classList.add('active');

      const input = document.createElement('input');
      input.className = 'input';
      input.maxLength = (state && state.maxTextLength) || 90;
      input.value = caption.text || '';
      input.placeholder =
        captions.length === 2 && index === 0
          ? I18N.t('topPlaceholder')
          : captions.length === 2 && index === 1
            ? I18N.t('bottomPlaceholder')
            : I18N.t('linePlaceholder', index + 1);
      input.addEventListener('input', () => {
        captions[index].text = input.value;
        drawWriteCanvas();
        saveDraft();
      });
      input.addEventListener('focus', () => setActiveLine(index));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('submit-btn').click();
      });
      row.appendChild(input);

      if (captions.length > 1) {
        const remove = el('button', 'drop-line', '×');
        remove.type = 'button';
        remove.title = I18N.t('removeLine');
        remove.addEventListener('click', () => {
          captions.splice(index, 1);
          activeLine = Math.max(0, Math.min(activeLine, captions.length - 1));
          renderCaptionRows();
          drawWriteCanvas();
          saveDraft();
        });
        row.appendChild(remove);
      }
      wrap.appendChild(row);
    });
  }

  function setActiveLine(index) {
    activeLine = index;
    [...$('caption-rows').children].forEach((row, i) => row.classList.toggle('active', i === index));
  }

  function drawWriteCanvas() {
    const w = state && state.writing;
    if (!w || !w.template) return;
    MemeRender.draw($('write-canvas'), { template: w.template, captions });
  }

  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      net.emit('meme:draft', { captions });
    }, 400);
  }

  /* Dragging a caption around the image (mouse and touch alike). */
  function bindCanvasDragging() {
    const canvas = $('write-canvas');
    let dragging = null;

    const ratioY = (event) => {
      const rect = canvas.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (!captions.some((caption) => caption.text)) return;
      const index = MemeRender.captionAt(canvas, ratioY(event));
      if (index === null || index === undefined) return;
      dragging = index;
      setActiveLine(index);
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    canvas.addEventListener('pointermove', (event) => {
      if (dragging === null) return;
      captions[dragging].y = Math.min(0.98, Math.max(0.02, ratioY(event)));
      drawWriteCanvas();
      event.preventDefault();
    });

    const release = () => {
      if (dragging === null) return;
      dragging = null;
      saveDraft();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }

  /* ---------------------------------------------------------------- voting */

  function buildRatingRow() {
    const row = $('rating-row');
    row.innerHTML = '';
    RATING_EMOJI.forEach((emoji, i) => {
      const value = i + 1;
      const button = el('button', 'rate');
      button.type = 'button';
      button.dataset.rating = String(value);
      button.appendChild(el('span', 'rate-emoji', emoji));
      button.appendChild(el('span', 'rate-label', I18N.t('ratings')[i]));
      button.addEventListener('click', () => {
        send('vote:cast', { rating: value });
        [...row.children].forEach((c) => c.classList.toggle('picked', c === button));
      });
      row.appendChild(button);
    });
  }

  function renderVoting() {
    const meme = state.meme;
    if (!meme) return;
    $('vote-progress').textContent = `${meme.index}/${meme.total}`;

    // Every incoming state re-renders, so only touch the buttons and the canvas
    // when the meme itself changed - otherwise a tap can land on a fresh node.
    const key = `${meme.index}:${meme.template.id}:${meme.isMine}:${I18N.lang}`;
    if (key !== votingKey) {
      votingKey = key;
      MemeRender.draw($('vote-canvas'), meme);
      if (meme.isMine) $('rating-row').innerHTML = '';
      else buildRatingRow();
    }

    $('vote-title').textContent = meme.isMine ? I18N.t('yourMeme') : I18N.t('voteTitle');
    [...$('rating-row').children].forEach((button) => {
      button.classList.toggle('picked', Number(button.dataset.rating) === meme.yourRating);
    });
    const progress = I18N.t('voteProgress', meme.voted, meme.voters);
    $('vote-note').textContent =
      !meme.isMine && meme.yourRating ? `${I18N.t('voteDone')} (${progress})` : progress;
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
    $('resume-card').hidden = true;
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

  net.on('connect', () => {
    setOffline(false);
    const seat = store.seat;
    if (!seat || !seat.code || !seat.playerId) return;

    // A seat that was live seconds ago means a blip or a reload mid-game: go
    // straight back in. An older one is an abandoned game - offer it instead of
    // dragging the player into it.
    if (state || Date.now() - (seat.at || 0) < RESUME_WINDOW_MS) {
      rejoinSeat(seat);
    } else {
      showResume(seat);
    }
  });

  function rejoinSeat(seat, onFail) {
    net.emit('room:rejoin', seat, (result) => {
      if (result && result.error) {
        dropSeat(result.error);
        if (onFail) onFail(result.error);
      }
    });
  }

  function showResume(seat) {
    $('resume-text').textContent = I18N.t('resumeText', seat.code);
    $('resume-card').hidden = false;
  }

  net.on('state', (snapshot) => {
    clockOffset = snapshot.serverNow - Date.now();
    const previous = state;
    state = snapshot;
    store.seat = { code: snapshot.code, playerId: snapshot.youId, at: Date.now() };
    if (previous && previous.phase !== snapshot.phase) currentTemplateId = null;
    if (snapshot.phase !== 'voting') votingKey = null;
    if (snapshot.phase !== 'writing') {
      currentTemplateId = null;
      writeRound = null;
    }
    if (lastPhase !== snapshot.phase) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      lastPhase = snapshot.phase;
    }
    render();
  });

  net.on('disconnect', () => setOffline(true));

  // Polling backend only: the room or our seat in it is gone for good.
  net.on('seatlost', (error) => dropSeat(error || 'SEAT_NOT_FOUND'));

  /* ----------------------------------------------------------------- wires */

  function joinFlow(event, payload) {
    const who = identity();
    if (!who) return;
    net.emit(event, { ...who, ...payload }, (result) => {
      if (handleError(result)) return;
      store.seat = { code: result.code, playerId: result.playerId, at: Date.now() };
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
    net.emit('room:leave');
    store.seat = null;
    state = null;
    history.replaceState(null, '', '/');
    render();
  });

  const confirmLeave = () => {
    if (!state) return;
    if (confirm(I18N.t('leaveConfirm'))) $('leave-btn').click();
  };
  $('brand').addEventListener('click', confirmLeave);
  $('room-chip').addEventListener('click', confirmLeave);

  $('resume-btn').addEventListener('click', () => {
    const seat = store.seat;
    $('resume-card').hidden = true;
    if (seat) rejoinSeat(seat);
  });

  $('forget-btn').addEventListener('click', () => {
    net.emit('room:leave', { seat: store.seat });
    store.seat = null;
    $('resume-card').hidden = true;
    // The old room code is still in the URL and the join box - clear both.
    $('code-input').value = '';
    history.replaceState(null, '', '/');
  });

  const settingInputs = [
    ['set-rounds', 'rounds', 'val-rounds'],
    ['set-write', 'writeSeconds', 'val-write'],
    ['set-vote', 'voteSeconds', 'val-vote'],
    ['set-swaps', 'swapsPerRound', 'val-swaps']
  ];
  settingInputs.forEach(([id, key, labelId]) => {
    $(id).addEventListener('input', () => {
      $(labelId).textContent = $(id).value;
    });
    $(id).addEventListener('change', () => {
      net.emit('settings:update', { [key]: Number($(id).value) });
    });
  });

  $('bot-add').addEventListener('click', () => net.emit('bot:add'));
  $('bot-remove').addEventListener('click', () => net.emit('bot:remove'));
  $('start-btn').addEventListener('click', () => send('game:start', {}));
  $('skip-btn').addEventListener('click', () => net.emit('game:skip'));
  $('again-btn').addEventListener('click', () => send('game:start', {}));
  $('tolobby-btn').addEventListener('click', () => net.emit('game:lobby'));

  $('add-line').addEventListener('click', () => {
    const max = (state && state.writing && state.writing.maxCaptions) || 5;
    if (captions.length >= max) return;
    const used = captions.map((caption) => caption.y);
    // Drop the new line into the emptiest part of the image.
    const spot = [0.5, 0.28, 0.72, 0.08, 0.92].find(
      (y) => !used.some((taken) => Math.abs(taken - y) < 0.12)
    );
    captions.push({ text: '', y: spot === undefined ? 0.5 : spot });
    activeLine = captions.length - 1;
    renderCaptionRows();
    $('caption-rows').lastChild.querySelector('input').focus();
    saveDraft();
  });

  $('swap-btn').addEventListener('click', () => {
    send('meme:swap', {}, (result) => {
      if (result && result.error) toast(I18N.errorText(result.error), 'error');
    });
  });

  $('submit-btn').addEventListener('click', () => {
    send('meme:submit', { captions });
  });

  bindCanvasDragging();

  $('lang-toggle').addEventListener('click', () => I18N.setLang(I18N.other));
  I18N.onChange(() => {
    $('lang-toggle').textContent = I18N.t('langButton');
    // Caption rows keep the player's text but their placeholders are localised.
    if (state && state.phase === 'writing') renderCaptionRows();
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
