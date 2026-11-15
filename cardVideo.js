// "סרטון לכרטיס שלי" (2026-11-15): בונה לעצמאית סרטון קצר (720x1280, ~16 שניות) של הכרטיס שלה באתר -
// טלפון במרכז שגולל לאט בכרטיס האמיתי שלה, כותרת למעלה, כפתור shecan.co.il למטה, כרטיס סיום של SheCan,
// והג'ינגל של SheCan ברקע (assets/jingle-shecan.mp3 - אם הקובץ חסר, הסרטון יוצא בלי מוזיקה).
//
// איך זה עובד: אותו Playwright/Chromium שכבר משמש את joinStory.js/flyer.js פותח עמוד "סטודיו" פנימי
// (HTML שנבנה כאן) שבו הכרטיס שלה נטען בתוך iframe בגודל מסך טלפון. גוללים את ה-iframe צעד אחר צעד,
// מצלמים כל צעד (JPEG), ומזרימים את התמונות ל-ffmpeg (מהחבילה ffmpeg-static) שמחבר אותן לסרטון MP4
// עם הג'ינגל. אין כאן AI ואין עלות לכל סרטון - רק זמן מעבד של השרת.
//
// זיכרון: רץ דרך התור הסדרתי של Chromium ב-server.js (runChromiumSerialized), כך שאף פעם לא רצים שני
// דפדפנים במקביל - בדיוק כמו תמונות הסטורי. בנוסף server.js מריץ רק סרטון אחד בכל פעם (תור משלו).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const W = 720, H = 1280, FPS = 20;
const JINGLE_PATH = path.join(__dirname, "assets", "jingle-shecan.mp3");

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// מסגרת הטלפון: המסך הפנימי 390x844 (רוחב מובייל אמיתי) מוגדל ב-CSS לגודל שנכנס יפה ב-720x1280.
const PHONE_SCALE = 1.1;
const SCREEN_W = 390, SCREEN_H = 844;

function studioHtml({ cardUrl, title, sub, cta }) {
  const pw = Math.round(SCREEN_W * PHONE_SCALE), ph = Math.round(SCREEN_H * PHONE_SCALE);
  const left = Math.round((W - pw) / 2), top = 176;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  body{width:${W}px;height:${H}px;overflow:hidden;position:relative;font-family:"Heebo","Assistant","Rubik","Segoe UI","Arial",sans-serif;color:#5D5E56;
    background:radial-gradient(circle at 50% 30%,#FBF8F4 0%,#F3EDE8 60%,#E9DFD6 100%)}
  .k{position:absolute;top:30px;width:100%;text-align:center;font-weight:700;font-size:20px;color:#9a8e81}
  .t{position:absolute;top:62px;width:100%;text-align:center;font-weight:800;font-size:38px;line-height:1.25;color:#8a6d5a;padding:0 30px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ph{position:absolute;left:${left - 8}px;top:${top - 8}px;width:${pw}px;height:${ph}px;border:8px solid #3d3b38;border-radius:44px;overflow:hidden;background:#fff;box-shadow:0 20px 50px rgba(93,94,86,.30)}
  .ph iframe{width:${SCREEN_W}px;height:${SCREEN_H}px;border:0;transform:scale(${PHONE_SCALE});transform-origin:0 0;display:block}
  .notch{position:absolute;left:${Math.round(W / 2 - 62)}px;top:${top}px;width:124px;height:22px;background:#3d3b38;border-radius:0 0 14px 14px;z-index:2}
  .c{position:absolute;bottom:40px;left:80px;right:80px;height:80px;border-radius:40px;background:#8a6d5a;color:#fff;font-weight:800;font-size:30px;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px rgba(138,109,90,.35)}
  #end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:0;
    background:radial-gradient(circle at 50% 40%,#FBF8F4 0%,#F3EDE8 60%,#E9DFD6 100%);z-index:5}
  #end .l{font-size:74px;font-weight:800;letter-spacing:3px;color:#5D5E56}
  #end .tg{font-size:27px;color:#9a8e81;margin-top:2px}
  #end .h{height:2px;width:280px;background:#c1b2a1;margin:34px 0}
  #end .m{font-size:42px;font-weight:800;color:#8a6d5a;line-height:1.3}
  #end .p{font-size:28px;margin-top:20px;line-height:1.5}
  #end .b{margin-top:46px;padding:22px 54px;border-radius:50px;background:#8a6d5a;color:#fff;font-weight:800;font-size:35px}
  </style></head><body>
  <div class="k">${escHtml(sub)}</div>
  <div class="t">${escHtml(title)}</div>
  <div class="notch"></div>
  <div class="ph"><iframe id="card" src="${escHtml(cardUrl)}"></iframe></div>
  <div class="c">${escHtml(cta)}</div>
  <div id="end"><div class="l">SheCan</div><div class="tg">העצמאיות של ישראל</div><div class="h"></div>
    <div class="m">כרטיס עסק משלך,<br>שלקוחות מוצאות 🩷</div>
    <div class="p">תמונות · הטבה · חוות דעת · וואטסאפ בלחיצה</div>
    <div class="b">shecan.co.il</div></div>
  </body></html>`;
}

// מנקה מתוך הכרטיס את מה שלא שייך לסרטון (באנר עוגיות, כפתור תמיכה צף וכו') - ה-iframe מאותו מקור
// (השרת עצמו, 127.0.0.1), אז מותר לגשת ל-DOM שלו.
const CLEAN_IFRAME_JS = `(() => {
  const f = document.getElementById('card'); const d = f.contentDocument; if (!d) return 0;
  d.querySelectorAll('#scCookieBanner,#scInstallBanner,.sc-support-widget,.sc-a11y-widget,.sc-status-rail,.story-notice,.sc-modal-overlay,#scWelcomePopup').forEach(e => e.remove());
  const s = d.createElement('style'); s.textContent = 'html{scroll-behavior:auto!important;scrollbar-width:none}::-webkit-scrollbar{display:none}'; d.head.appendChild(s);
  const rev = d.getElementById('scReview');
  const max = d.documentElement.scrollHeight - f.contentWindow.innerHeight;
  const stop = rev ? Math.min(max, rev.getBoundingClientRect().bottom + f.contentWindow.scrollY - f.contentWindow.innerHeight + 40) : max * 0.75;
  return Math.max(0, stop);
})()`;

async function buildCardVideo({ cardUrl, outPath, title, sub, cta, chromiumArgs, executablePath, ffmpegPath }) {
  const ffmpeg = ffmpegPath || require("ffmpeg-static");
  if (!ffmpeg) throw new Error("ffmpeg-static binary missing");
  const { chromium } = require("playwright");
  const hasJingle = fs.existsSync(JINGLE_PATH);
  const holdStart = Math.round(1.5 * FPS), scrollFrames = Math.round(11 * FPS), holdEnd = Math.round(1.2 * FPS);
  const fadeFrames = Math.round(0.6 * FPS), endFrames = Math.round(2.4 * FPS);
  const total = (holdStart + scrollFrames + holdEnd + fadeFrames + endFrames) / FPS;

  const args = ["-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "-"];
  if (hasJingle) args.push("-stream_loop", "-1", "-i", JINGLE_PATH);
  args.push("-vf", `scale=${W}:${H},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-r", String(FPS));
  if (hasJingle) args.push("-filter_complex", `[1:a]atrim=0:${total.toFixed(2)},afade=t=in:d=0.3,afade=t=out:st=${(total - 1.5).toFixed(2)}:d=1.4[a]`, "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "96k", "-shortest");
  args.push("-movflags", "+faststart", outPath);

  const ff = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let ffErr = "";
  ff.stderr.on("data", (b) => { ffErr = (ffErr + b.toString()).slice(-2000); });
  const ffDone = new Promise((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg failed: " + ffErr.slice(-400)))));
  });
  const write = (buf) => new Promise((resolve) => { if (!ff.stdin.write(buf)) ff.stdin.once("drain", resolve); else resolve(); });

  const browser = await chromium.launch({ args: chromiumArgs || ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--no-zygote"], executablePath: executablePath || process.env.CARD_VIDEO_CHROME || undefined });
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: "he-IL" });
    const page = await ctx.newPage();
    // מסמנים שכבר נבחרה העדפת עוגיות כדי שהבאנר לא יופיע בתוך הכרטיס
    const origin = new URL(cardUrl).origin;
    await page.goto(origin + "/robots.txt").catch(() => {});
    await page.evaluate(() => { try { localStorage.setItem("scCookieConsent", "essential"); } catch (e) {} }).catch(() => {});
    await page.setContent(studioHtml({ cardUrl, title, sub, cta }), { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const stop = await page.evaluate(CLEAN_IFRAME_JS);
    const shot = () => page.screenshot({ type: "jpeg", quality: 82 });
    const scrollTo = (y) => page.evaluate((yy) => document.getElementById("card").contentWindow.scrollTo(0, yy), y);

    let frame = await shot();
    for (let i = 0; i < holdStart; i++) await write(frame);
    for (let i = 1; i <= scrollFrames; i++) {
      const t = i / scrollFrames, e = 0.5 - 0.5 * Math.cos(Math.PI * t);
      await scrollTo(stop * e);
      frame = await shot();
      await write(frame);
    }
    for (let i = 0; i < holdEnd; i++) await write(frame);
    for (let i = 1; i <= fadeFrames; i++) {
      await page.evaluate((o) => { document.getElementById("end").style.opacity = String(o); }, i / fadeFrames);
      await write(await shot());
    }
    frame = await shot();
    for (let i = 0; i < endFrames; i++) await write(frame);
  } finally {
    ff.stdin.end();
    await browser.close().catch(() => {});
  }
  await ffDone;
  return { seconds: total, withMusic: hasJingle };
}

module.exports = { buildCardVideo };
