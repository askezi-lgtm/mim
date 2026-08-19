/* Tiny two-language dictionary. Hebrew is the default (RTL); English is a toggle. */
(function () {
  'use strict';

  const STRINGS = {
    he: {
      dir: 'rtl',
      langButton: 'EN',
      room: 'חדר',
      heroTitle: 'כתבו את המם. תנו ציון. תצחיקו הכי הרבה.',
      heroSub: 'כל סיבוב מקבלים תמונה, כותבים כיתוב, ומדרגים את הממים של כולם. הכי מצחיק מנצח.',
      namePlaceholder: 'השם שלך',
      createRoom: 'פתחו חדר חדש',
      codePlaceholder: 'קוד',
      joinRoom: 'הצטרפו',
      how1: 'מזמינים חברים עם קוד החדר',
      how2: 'כל אחד מקבל תמונה וכותב כיתוב',
      how3: 'מדרגים את הממים של השאר מ‑1 עד 5',
      how4: 'כל כוכב = 20 נקודות. הכי הרבה נקודות מנצח',
      shareCode: 'שתפו את הקוד כדי שיצטרפו',
      copyLink: 'העתיקו קישור',
      copied: 'הקישור הועתק!',
      players: 'שחקנים',
      settings: 'הגדרות',
      rounds: 'סיבובים',
      writeTime: 'זמן כתיבה',
      voteTime: 'זמן דירוג',
      bots: 'בוטים לתרגול',
      startGame: 'התחילו לשחק',
      waitHost: 'מחכים שהמארח יתחיל…',
      leaveRoom: 'יציאה מהחדר',
      leaveConfirm: 'לצאת מהחדר?',
      resumeGame: 'חזרה למשחק',
      forgetGame: 'משחק חדש',
      resumeText: (code) => `יש לכם משחק פתוח בחדר ${code}`,
      writeTitle: 'כתבו כיתוב מצחיק',
      topPlaceholder: 'שורה עליונה',
      bottomPlaceholder: 'שורה תחתונה',
      linePlaceholder: (n) => `שורה ${n}`,
      addLine: '＋ שורה',
      removeLine: 'מחקו שורה',
      dragHint: 'גררו שורה על התמונה כדי להזיז אותה',
      swapTemplate: '🎲 החליפו תמונה',
      swapsLeft: (n) => `🎲 החליפו תמונה (${n})`,
      noSwapsLeft: '🎲 נגמרו ההחלפות',
      swaps: 'החלפות תמונה',
      submitMeme: 'שלחו מם',
      updateMeme: 'עדכנו את המם',
      submitted: 'המם נשלח ✔ אפשר עוד לשנות',
      voteTitle: 'כמה זה מצחיק?',
      yourMeme: 'זה המם שלכם — מחכים לציונים 😏',
      voteDone: 'דירגתם! מחכים לשאר…',
      scoreboard: 'טבלת ניקוד',
      roundBest: 'הממים של הסיבוב',
      skip: 'דלגו',
      playAgain: 'שחקו שוב',
      backToLobby: 'חזרה ללובי',
      footer: 'משחק מסיבות בהשראת Make It Meme · קוד פתוח',
      round: (n, total) => `סיבוב ${n} מתוך ${total}`,
      writeProgress: (done, total) => `${done} מתוך ${total} שלחו מם`,
      voteProgress: (done, total) => `${done} מתוך ${total} דירגו`,
      nextRoundIn: (s) => `הסיבוב הבא בעוד ${s}…`,
      points: (n) => `\u202A+${n}\u202C נק'`,
      roundWinner: 'מם הסיבוב 🔥',
      noVotes: 'אף אחד לא הספיק לדרג 😅',
      winnerTie: 'תיקו!',
      needName: 'צריך שם קודם',
      needCode: 'הקלידו קוד חדר',
      you: 'אתם',
      host: 'מארח',
      bot: 'בוט',
      offline: 'מנותק',
      waitingOthers: 'מחכים לשאר…',
      connecting: 'מתחבר…',
      offlineBanner: 'אין חיבור לשרת — מנסים להתחבר מחדש…',
      roomGone: 'החדר כבר לא קיים (השרת עלה מחדש) — פתחו חדר חדש',
      reconnected: 'חזרנו לחדר',
      errors: {
        ROOM_NOT_FOUND: 'לא נמצא חדר עם הקוד הזה',
        ROOM_FULL: 'החדר מלא',
        GAME_IN_PROGRESS: 'המשחק כבר התחיל — חכו לסיבוב הבא',
        NEED_MORE_PLAYERS: 'צריך לפחות 2 שחקנים (אפשר להוסיף בוט)',
        NOT_HOST: 'רק המארח יכול לעשות את זה',
        SEAT_NOT_FOUND: 'המקום שלכם בחדר כבר לא קיים',
        WRONG_PHASE: 'לא הזמן לזה עכשיו',
        CANNOT_VOTE_OWN: 'אי אפשר לדרג את המם של עצמכם',
        NO_SWAPS_LEFT: 'נגמרו ההחלפות לסיבוב הזה',
        DEFAULT: 'משהו השתבש'
      },
      ratings: ['בכלל לא', 'חיוך קטן', 'מצחיק', 'מצחיק מאוד', 'גאוני']
    },

    en: {
      dir: 'ltr',
      langButton: 'עב',
      room: 'Room',
      heroTitle: 'Caption it. Rate it. Be the funniest.',
      heroSub: 'Every round you get an image, write a caption, then rate everyone else. Funniest wins.',
      namePlaceholder: 'Your name',
      createRoom: 'Create a room',
      codePlaceholder: 'Code',
      joinRoom: 'Join',
      how1: 'Invite friends with the room code',
      how2: 'Everyone gets an image and writes a caption',
      how3: 'Rate the other memes from 1 to 5',
      how4: 'Each star = 20 points. Most points wins',
      shareCode: 'Share this code so friends can join',
      copyLink: 'Copy link',
      copied: 'Link copied!',
      players: 'Players',
      settings: 'Settings',
      rounds: 'Rounds',
      writeTime: 'Writing time',
      voteTime: 'Rating time',
      bots: 'Practice bots',
      startGame: 'Start game',
      waitHost: 'Waiting for the host to start…',
      leaveRoom: 'Leave room',
      leaveConfirm: 'Leave this room?',
      resumeGame: 'Back to the game',
      forgetGame: 'New game',
      resumeText: (code) => `You have a game open in room ${code}`,
      writeTitle: 'Write a funny caption',
      topPlaceholder: 'Top line',
      bottomPlaceholder: 'Bottom line',
      linePlaceholder: (n) => `Line ${n}`,
      addLine: '＋ line',
      removeLine: 'Remove line',
      dragHint: 'Drag a line on the image to move it',
      swapTemplate: '🎲 Swap image',
      swapsLeft: (n) => `🎲 Swap image (${n})`,
      noSwapsLeft: '🎲 No swaps left',
      swaps: 'Image swaps',
      submitMeme: 'Submit meme',
      updateMeme: 'Update meme',
      submitted: 'Submitted ✔ you can still edit',
      voteTitle: 'How funny is this?',
      yourMeme: 'This one is yours — sit back and collect stars 😏',
      voteDone: 'Rated! Waiting for the others…',
      scoreboard: 'Scoreboard',
      roundBest: 'This round’s memes',
      skip: 'Skip',
      playAgain: 'Play again',
      backToLobby: 'Back to lobby',
      footer: 'A party game inspired by Make It Meme · open source',
      round: (n, total) => `Round ${n} of ${total}`,
      writeProgress: (done, total) => `${done} of ${total} submitted`,
      voteProgress: (done, total) => `${done} of ${total} rated`,
      nextRoundIn: (s) => `Next round in ${s}…`,
      points: (n) => `+${n} pts`,
      roundWinner: 'Meme of the round 🔥',
      noVotes: 'Nobody managed to rate this one 😅',
      winnerTie: 'It’s a tie!',
      needName: 'Pick a name first',
      needCode: 'Type a room code',
      you: 'you',
      host: 'host',
      bot: 'bot',
      offline: 'offline',
      waitingOthers: 'Waiting for the others…',
      connecting: 'Connecting…',
      offlineBanner: 'Lost the connection — reconnecting…',
      roomGone: 'That room is gone (the server restarted) — start a new one',
      reconnected: 'Back in the room',
      errors: {
        ROOM_NOT_FOUND: 'No room with that code',
        ROOM_FULL: 'That room is full',
        GAME_IN_PROGRESS: 'The game already started — wait for the next one',
        NEED_MORE_PLAYERS: 'You need at least 2 players (a bot counts)',
        NOT_HOST: 'Only the host can do that',
        SEAT_NOT_FOUND: 'Your seat in that room is gone',
        WRONG_PHASE: 'Not the right moment for that',
        CANNOT_VOTE_OWN: 'You cannot rate your own meme',
        NO_SWAPS_LEFT: 'No image swaps left this round',
        DEFAULT: 'Something went wrong'
      },
      ratings: ['Nope', 'Small smile', 'Funny', 'Very funny', 'Genius']
    }
  };

  const listeners = new Set();
  let lang = localStorage.getItem('mim:lang') || 'he';
  if (!STRINGS[lang]) lang = 'he';

  function t(key, ...args) {
    const value = STRINGS[lang][key];
    if (typeof value === 'function') return value(...args);
    if (value === undefined) return key;
    return value;
  }

  function errorText(code) {
    return STRINGS[lang].errors[code] || STRINGS[lang].errors.DEFAULT;
  }

  /** Re-apply every data-i18n / data-i18n-placeholder binding in the document. */
  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = STRINGS[lang].dir;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    listeners.forEach((fn) => fn(lang));
  }

  function setLang(next) {
    if (!STRINGS[next]) return;
    lang = next;
    localStorage.setItem('mim:lang', lang);
    apply();
  }

  window.I18N = {
    t,
    errorText,
    apply,
    setLang,
    onChange: (fn) => listeners.add(fn),
    get lang() {
      return lang;
    },
    get other() {
      return lang === 'he' ? 'en' : 'he';
    }
  };
})();
