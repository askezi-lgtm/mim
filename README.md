# 😂 Make It Mem

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/askezi-lgtm/mim)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/askezi-lgtm/mim)

משחק מסיבות מרובה־משתתפים בהשראת [Make It Meme](https://makeitmeme.com):
כל סיבוב כל שחקן מקבל תמונת מם, כותב עליה כיתוב, ואז כולם מדרגים את הממים
של השאר. הכי מצחיק — מנצח.

A realtime multiplayer meme-captioning party game. Hebrew (RTL) by default,
English with one click.

---

## הפעלה מהירה / Quick start

```bash
npm install
npm start              # http://localhost:3000  (Socket.IO)
npm run dev:serverless # http://localhost:8888  (the Netlify-style polling backend)
```

פותחים חדר, משתפים את הקוד בן 4 התווים (או את הקישור `http://<host>:3000/ABCD`),
וכולם מצטרפים מהדפדפן — גם מהנייד. אין צורך בהרשמה.

## איך משחקים / How to play

1. **לובי** — המארח קובע מספר סיבובים וזמנים, ואפשר להוסיף בוטים כדי לתרגל לבד.
2. **כתיבה** — כל שחקן מקבל תבנית מם אקראית וכותב שורה עליונה/תחתונה. יש
   תצוגה מקדימה חיה, והטקסט נשמר אוטומטית גם בלי ללחוץ "שלחו מם".
3. **דירוג** — הממים מוצגים אחד־אחד בעילום שם, וכל אחד נותן ציון 1–5.
   אי אפשר לדרג את המם של עצמך.
4. **חשיפה** — מגלים מי הכותב, כמה כוכבים קיבל וכמה נקודות נצברו.
5. **סיום** — טבלת ניקוד אחרי כל סיבוב, ומנצח בסוף.

**ניקוד:** כל כוכב = 20 נקודות. המם הכי מדורג בסיבוב מקבל בונוס של 50 נקודות
(תיקו מתחלק). הסיבוב מתקדם מוקדם ברגע שכולם שלחו/דירגו — בלי לחכות לטיימר.

## תכונות / Features

- חדרים עם קוד קצר, קישור הזמנה ישיר, ועד 12 שחקנים.
- שרת סמכותי: כל הטיימרים, ההגרלות והניקוד רצים בצד השרת.
- חיבור מחדש — מי שהתנתק באמצע משחק שומר את המקום והניקוד וחוזר עם אותו קישור.
- העברת תפקיד המארח אוטומטית אם המארח יצא.
- בוטים להרצת משחק גם כששחקן אחד בלבד נוכח.
- ציור המם ב־Canvas בצד הלקוח (טקסט עוקב, שבירת שורות, הקטנה אוטומטית),
  עם תמיכה בעברית ובאנגלית.
- ממשק דו־לשוני (עברית/English) עם החלפת כיוון RTL/LTR.

## תבניות ממים / Meme templates

רשימת התבניות נמצאת ב־[`server/templates.js`](server/templates.js) ומצביעה
כברירת מחדל לתמונות ציבוריות של imgflip. אם התמונה לא נטענת (רשת חסומה,
למשל), הלקוח מצייר רקע צבעוני עם שם התבנית — המשחק ממשיך כרגיל.

להרצה לגמרי מקומית: שימו קבצי תמונה ב־`public/templates/` והוסיפו אותם לרשימה:

```js
{ id: 'my-meme', name: 'My meme', url: '/templates/my-meme.jpg' }
```

## פריסה / Deploy

המשחק רץ על שני סוגי אירוח, עם אותה חוקיות בדיוק ([`shared/engine.js`](shared/engine.js)):

| | **Netlify** | **Render** |
| --- | --- | --- |
| ריצה | Functions + Netlify Blobs | תהליך Node שרץ ברציפות |
| עדכונים | polling כל 1.5 שניות | WebSockets (Socket.IO) |
| קובץ הגדרה | [`netlify.toml`](netlify.toml) | [`render.yaml`](render.yaml) |
| השהיה בין שחקנים | ~1.5 שניות | מיידית |
| שינה / התעוררות | אין | התוכנית החינמית נרדמת אחרי ~15 דק' |

### Netlify (לינק בלחיצה אחת)

1. <https://app.netlify.com/start/deploy?repository=https://github.com/askezi-lgtm/mim>
2. מאשרים ל‑Netlify גישה לריפו ולוחצים **Deploy** — היא קוראת את `netlify.toml`,
   מריצה `node scripts/netlify-build.js` ומפרסמת את `dist/` יחד עם הפונקציה.
3. מקבלים כתובת `https://<שם-הפרויקט>.netlify.app`; קישורי חדרים הם `/ABCD`.

אין מה להגדיר ידנית: Netlify Blobs נדלק אוטומטית לפרויקטים שנבנים אצלה,
ושם ה‑store (`mim-rooms`) מוגדר בקוד.

### Render (WebSockets מלאים)

1. <https://render.com/deploy?repo=https://github.com/askezi-lgtm/mim>
2. לוחצים **Apply** — Render קוראת את `render.yaml` ומקימה שירות web חינמי
   (Frankfurt, Node 22, health check `/healthz`).
3. מקבלים כתובת `https://<שם-השירות>.onrender.com`.

בתוכנית החינמית של Render השירות נרדם אחרי ~15 דקות ללא תעבורה (הכניסה
הראשונה אחריה לוקחת 30–60 שניות), ומצב המשחק חי בזיכרון — דיפלוי מחדש מאפס
חדרים פתוחים.

## איך הגרסה ה־serverless עובדת

ב־Netlify אין תהליך שרץ ברציפות ואין WebSockets, אז:

- החדר נשמר כאובייקט JSON ב־Netlify Blobs, מפתח אחד לכל קוד חדר.
- כל בקשה טוענת את החדר, מריצה `engine.tick(state, now)` — שמחיל דדליינים,
  מהלכי בוטים ונוכחות — וכותבת חזרה בכתיבה מותנית (compare-and-swap לפי ETag),
  כך ששתי הפעלות מקבילות לא דורסות זו את זו.
- `tick` אידמפוטנטי ומהלכי הבוטים נגזרים מ־hash ולא מ־`Math.random`, ולכן שתי
  הפעלות שמעבדות את אותו מצב מגיעות לאותה תוצאה.
- הלקוח שולח פעולות ל־`POST /api/rpc` ומושך מצב מ־`GET /api/state` כל 1.5
  שניות (4 שניות כשהלשונית ברקע). קריאה שלא שינתה כלום לא כותבת ל־Blobs.
- [`public/js/net.js`](public/js/net.js) מסתיר את ההבדל: אם `socket.io` נטען —
  משתמשים בו; אחרת עוברים ל־polling. שאר הלקוח זהה בשתי הפריסות.

**מה לשים לב אליו:** כל poll הוא קריאת פונקציה, כך שמשחק ארוך עם הרבה שחקנים
צורך מהמכסה החינמית של Netlify; והשהיית התגובה היא עד ~1.5 שניות במקום מיידית.

## הגדרות / Configuration

| משתנה | ברירת מחדל | תיאור |
| --- | --- | --- |
| `PORT` | `3000` | פורט ההאזנה (שרת Socket.IO) |
| `HOST` | `0.0.0.0` | כתובת ההאזנה |
| `MIM_PUBLISH_DIR` | `public` | איזו תיקייה `dev:serverless` מגיש (`dist` לבדיקת הבנייה) |

הגדרות המשחק (סיבובים, זמן כתיבה, זמן דירוג) נקבעות בלובי על ידי המארח.
ברירות המחדל והגבולות מוגדרים ב־[`server/game.js`](server/game.js).

## בדיקות / Tests

```bash
npm test
```

16 בדיקות על שלוש שכבות:

- **engine** — משחק שלם מול שעון מזויף, אידמפוטנטיות של `tick`, דטרמיניזם של
  הבוטים, שמירת טיוטות ותפוגת נוכחות.
- **api** (נתיב Netlify) — משחק שלם מעל בקשות HTTP, כתיבה רק כשמשהו זז,
  התאוששות מתחרות על כתיבה (CAS), ותשובות 404 לחדר/מושב שלא קיימים.
- **game** (נתיב Socket.IO) — משחק שלם מקצה לקצה מול Socket.IO אמיתי,
  התנתקות וחיבור מחדש באמצע סיבוב, הצטרפות באמצע, וסירוב להתחיל עם שחקן אחד.

## מבנה הפרויקט / Project layout

```
server/index.js      Express + Socket.IO, חיווט האירועים
server/game.js       חדרים, מכונת המצבים של המשחק, ניקוד, בוטים
server/templates.js  קטלוג תבניות המם
render.yaml          blueprint לפריסה ב-Render
public/index.html    כל המסכים
public/js/app.js     לקוח: מצב אחד, פונקציית render אחת
public/js/meme.js    ציור המם על Canvas
public/js/i18n.js    מילון עברית/אנגלית
public/styles.css    עיצוב (RTL + LTR)
test/game.test.js    בדיקות אינטגרציה
```

## פרוטוקול Socket.IO

| אירוע (לקוח → שרת) | תיאור |
| --- | --- |
| `room:create` / `room:join` / `room:rejoin` | כניסה לחדר |
| `player:update` | שינוי שם/אווטאר |
| `settings:update`, `bot:add`, `bot:remove` | מארח בלבד |
| `game:start`, `game:skip`, `game:lobby` | מארח בלבד |
| `meme:draft`, `meme:submit` | שמירת טיוטה / שליחת מם |
| `vote:cast` | דירוג 1–5 |

בפריסת Netlify אותם שמות ממופים ל־`POST /api/rpc` עם `op` מתאים
(ראו [`public/js/net.js`](public/js/net.js)), והמצב נמשך מ־`GET /api/state`.

השרת משדר `state` — תמונת מצב מלאה ומותאמת אישית לכל שחקן (כולל מי המחבר
רק בשלב החשיפה). הלקוח פשוט מצייר מחדש את המסך לפי המצב האחרון.

## רישיון

MIT. תבניות הממים עצמן שייכות לבעליהן ומשמשות כאן לצורכי משחק.
