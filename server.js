// Forces Playwright to look for its downloaded Chromium browser inside this project's own
// node_modules folder (node_modules/playwright-core/.local-browsers) instead of its normal
// default location, a shared cache folder in the OS user's home directory
// (~/.cache/ms-playwright). This must be set BEFORE anything requires "playwright" anywhere in
// the app (joinStory.js/reviewStory.js/flyer.js each do that lazily, inside their own
// functions - setting it here, first thing, guarantees it's already in place no matter which of
// them runs first). Added after confirming - by having /deploy-check read the actual folder off
// disk - that ~/.cache/ms-playwright didn't exist AT ALL on Render even right after a deploy
// whose build log showed the Playwright install step running: the browser download was
// succeeding during the build step, but the runtime instance was starting from a filesystem that
// didn't carry that shared home-cache folder over (a known quirk on multi-stage/ephemeral build
// platforms). node_modules, by contrast, unambiguously *has* to survive from build to runtime -
// the app can't even start otherwise - so installing there instead sidesteps the problem
// entirely, without needing any Render dashboard/env-var change (which has been unreliable here
// before) since it's fully controlled from code. Only takes effect if nothing already overrode
// it (e.g. a real env var Sapir sets later in Render's dashboard still wins).
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "0";

// EMERGENCY KILL SWITCH - flip to false to disable again if memory problems come back. Turned
// off 2026-08-19 after the site went into an actual crash loop (restarting every 1-3 minutes)
// on Render's 512MB Starter plan, right after Chromium-based image generation started working
// for the first time - each launch is memory-heavy enough on a 512MB instance to be the most
// likely trigger. Turned back on 2026-08-21 after Sapir confirmed the Render Instance Type is
// actually Standard (2GB), and after the GET /freelancer/:id unthrottled-db.save()-per-view bug
// was fixed separately. Turned back OFF again on 2026-08-22 (temporarily) as one extra safety
// margin during a live OOM-crash-loop-on-every-deploy incident, alongside the real fix that
// night: assets/*.html magazine flipbook files (some embed every page as a full-resolution
// image and can be tens of MB each) were being eagerly read into memory at boot for EVERY
// server start, including the extra "old + new instance both briefly alive" memory overlap
// Render does on every deploy - see the emergency-fix comment near MAGAZINE_ISSUE_FILES below,
// which is almost certainly the actual trigger. This flag was flipped off at the same time
// purely as belt-and-suspenders for that one critical redeploy, since Chromium launches are a
// real (if smaller) memory cost too - safe to flip back to true once the site has been stable
// for a while after the magazine fix lands, to restore the join/review-story image attachments.
// While this is false, server.js never calls buildJoinStoryImageBuffer/buildReviewStoryImageBuffer
// at all, so approvals go back to sending the plain email with no image attachments (safe,
// non-blocking, same as any other build failure).
// Turned back ON 2026-08-24, per explicit request, now that both real root causes of the
// 2026-08-22 crash loop have been fixed for 2+ days (db.json base64-image bloat, and the
// magazine flipbook eager-load) - plus the chromiumQueue serialization + 20s timeout above
// already guard against the ORIGINAL (2026-08-19) trigger, overlapping Chromium launches. If
// Render's logs show memory trouble again after this deploys, flip this back to false - that
// alone (no other change) safely disables it again.
const STORY_IMAGES_ENABLED = true;

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const db = require("./db");

// Where uploaded/generated images live on disk from 2026-08-22 onward (see fileToDataUri and
// migrateEmbeddedPhotosToFiles below) - a sibling folder to db.json itself, so it lives on the
// same persistent disk (DATA_DIR) and survives every redeploy exactly like db.json does.
const UPLOADS_DIR = path.join(path.dirname(db.DB_PATH), "uploads");
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (e) {
  console.warn("[uploads] could not create uploads dir:", e.message);
}

const auth = require("./auth");
const webpush = require("./webpush");
const { page, esc, categoryIcon, cityAutocompleteHtml, breadcrumbHtml } = require("./layout");
const { buildJoinStoryImageBuffer } = require("./joinStory");
const { buildReviewStoryImageBuffer } = require("./reviewStory");

// Global serialization for ANY Chromium-based image build (join-story + review-story below -
// both launch their own headless Chromium instance, see joinStory.js/reviewStory.js). Added
// after a second OOM crash on the Standard (2GB) plan, right after STORY_IMAGES_ENABLED was
// turned back on - even though each individual approval already closes its own browser in a
// finally block (so a single approval can't leak memory), nothing previously stopped TWO
// approvals processed close together in time (e.g. working through a backlog of pending
// freelancers) from each launching their own Chromium instance at the same moment - each easily
// 150-300MB, and a handful of those overlapping is enough to blow past even a 2GB container
// alongside the rest of the app's own memory (Node baseline + the in-memory DB, which holds
// every freelancer's photo as base64). This queue guarantees only ONE Chromium instance is ever
// running at a time, process-wide - a second approval arriving mid-build simply waits its turn
// instead of racing to launch a second browser alongside the first.
let chromiumQueue = Promise.resolve();
// Hard ceiling on a single Chromium build - without this, a job that never settles (e.g.
// browser.close() itself hangs because the OS already killed the Chromium process out from
// under Node, which can happen under real memory pressure) would wedge this queue PERMANENTLY:
// every approval after it would silently wait forever for its turn, with no crash and no
// obvious error - a much worse failure mode than today's "one build fails, the rest of the
// approval still goes through" behavior. 20s is generous for a one-shot screenshot job that
// normally takes well under a second.
const CHROMIUM_JOB_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function runChromiumSerialized(fn, label) {
  const run = chromiumQueue.then(() => withTimeout(fn(), CHROMIUM_JOB_TIMEOUT_MS, label), () => withTimeout(fn(), CHROMIUM_JOB_TIMEOUT_MS, label));
  // Swallow here so one failed/timed-out build doesn't wedge the queue for every job queued
  // after it - the caller's own `run` promise still rejects normally with the real error.
  chromiumQueue = run.catch(() => {});
  return run;
}

const PORT = process.env.PORT || 4000;

// Small inline WhatsApp glyph (green, matches .whatsapp-link's text color) shown right next
// to the "WhatsApp" contact-detail link on a freelancer's profile, replacing the generic 💬
// emoji per explicit request - a single shared constant since it's static markup used in a
// couple of places (main profile + additional-listing profile).
const whatsappIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true" style="vertical-align:middle;"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.148.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z M12.001 2c-5.514 0-9.999 4.485-9.999 9.999 0 1.762.464 3.464 1.343 4.964L2 22l5.164-1.362a9.955 9.955 0 0 0 4.837 1.239h.005c5.514 0 9.999-4.485 9.999-9.999S17.515 2 12.001 2z"/></svg>`;

// ---------- email (password reset) ----------
// Sends transactional email via Resend's HTTP API (https://resend.com) using the
// built-in fetch (no npm dependency needed - Node 18+ ships fetch globally).
// Requires two environment variables set in Render, NOT committed to code:
//   RESEND_API_KEY   - the API key from your Resend account
//   RESEND_FROM_EMAIL - the sender address, e.g. "SheCan <noreply@shecan.co.il>"
//                        (needs that domain verified in Resend first)
// If RESEND_API_KEY isn't set yet, sendEmail logs a warning and returns { ok: false }
// instead of crashing, so the site keeps working while email isn't configured.
// `attachments` (optional) is Resend's own format: [{ filename, content: <base64 string> }] -
// used for the join/review QR images on freelancer approval (see /admin/freelancer/:id/approve).
async function sendEmail(to, subject, html, attachments) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "SheCan <onboarding@resend.dev>";
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set - skipping send to", to, "subject:", subject);
    return { ok: false, reason: "not_configured" };
  }
  try {
    const payload = { from, to, subject, html };
    if (attachments && attachments.length) payload.attachments = attachments;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn("[email] Resend API error", res.status, await res.text().catch(() => ""));
      return { ok: false, reason: "send_failed" };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[email] send threw", e.message);
    return { ok: false, reason: "send_failed" };
  }
}

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// Render sits in front of the app behind a reverse proxy, so the real visitor IP arrives in
// x-forwarded-for (same trust assumption already made for x-forwarded-proto in getOrigin above)
// - falls back to the raw socket address for local/dev runs where there's no proxy at all.
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// ---------- הגנת ספאם לטופס "צרי קשר" (נוסף 2026-08-31, אחרי שספיר קיבלה הצפה של עשרות
// הודעות זהות מבוט פרסומת; עודכן באותו יום אחרי ששאלה בצדק "מה אם לקוחה אמיתית שולחת כמה
// הודעות שונות ברצף?" - הגרסה הראשונה חסמה לפי כמות גולמית בלבד (עד 3 הודעות/10 דק') וזה היה
// עלול לתפוס לקוחה אמיתית בטעות) ----------
// שלושה מנגנונים משלימים, כולם "נכשלים בשקט": ר' POST /contact למטה - ההגשה מקבלת בדיוק אותה
// הודעת "תודה" כמו הגשה תקינה גם כשהיא נחסמת, כדי לא ללמד בוט להתחמק בפעם הבאה (רק שההודעה
// בפועל לא נשמרת ולא מגיעה לספיר):
// (1) honeypot - שדה טקסט מוסתר ב-CSS (לא type="hidden", כי בוטים "חכמים" יותר סורקים ומדלגים
//     בדיוק על type=hidden אבל עדיין ממלאים כל שדה עם label שנראה לקורא-קוד; בן/בת אדם אמיתיים
//     פשוט לא רואים את השדה בכלל ולכן לעולם לא ימלאו אותו) - אם הוא לא ריק, זה כמעט בוודאות בוט.
// (2) חסימת תוכן כפול - אם אותה כתובת IP שולחת בדיוק את אותו טקסט הודעה פעם נוספת תוך
//     CONTACT_DUPLICATE_WINDOW_MS, זה בדיוק הדפוס שראינו בפועל (אותה הודעת פרסומת, מילה
//     במילה, שוב ושוב) - נחסם כבר מהפעם השנייה, בלי קשר לספירה הכוללת. לקוחה אמיתית ששולחת
//     כמה הודעות שונות בזמן קצר (למשל נזכרה שהיא שכחה לציין משהו) אף פעם לא נתקלת בזה, כי
//     הטקסט שלה משתנה בין הודעה להודעה.
// (3) הגבלת קצב לפי IP - רשת ביטחון נוספת בלבד למקרה של בוט שמדלג במכוון גם על ה-honeypot
//     וגם משנה מעט את הטקסט בכל פעם: עד CONTACT_RATE_LIMIT_MAX הגשות מאותה IP תוך
//     CONTACT_RATE_LIMIT_WINDOW_MS. הסף גבוה בכוונה (הרבה מעבר למה שלקוחה אמיתית תשלח) - הוא
//     נועד לתפוס רק הצפה אמיתית, לא כמה הודעות שונות ולגיטימיות ברצף.
// שני המנגנונים (2)+(3) נשמרים בזיכרון בלבד (Map), לא ב-DB - מספיק כדי לעצור הצפה חיה,
// ומתאפס ממילא בכל הפעלה מחדש של השרת; לא בעיה בקנה מידה של טופס יצירת קשר של אתר קטן.
const contactDuplicateMap = new Map(); // `${ip}::${normalizedText}` -> timestamp of last occurrence
const CONTACT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
function isDuplicateContactMessage(ip, text) {
  const key = `${ip}::${String(text || "").trim().toLowerCase().slice(0, 300)}`;
  const now = Date.now();
  const last = contactDuplicateMap.get(key);
  contactDuplicateMap.set(key, now);
  return last !== undefined && (now - last) < CONTACT_DUPLICATE_WINDOW_MS;
}
const contactRateLimitMap = new Map(); // ip -> [timestamps of recent submissions]
const CONTACT_RATE_LIMIT_MAX = 12; // רשת ביטחון בלבד - הרבה מעבר לכמות שלקוחה אמיתית תשלח
const CONTACT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
function isContactRateLimited(ip) {
  const now = Date.now();
  const recent = (contactRateLimitMap.get(ip) || []).filter((t) => now - t < CONTACT_RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  contactRateLimitMap.set(ip, recent);
  return recent.length > CONTACT_RATE_LIMIT_MAX;
}

// ---------- push notifications (installable app) ----------
// Zero-dependency Web Push (see webpush.js) - no npm package needed. Requires two env vars
// set in Render, generated ONCE and never changed afterward (every stored subscription is
// tied to this exact public key - rotating it would silently break all existing subscribers):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY - generate via: node -e "console.log(require('./webpush').generateVAPIDKeys())"
// If they aren't set yet, push sends are skipped (falling back to email) instead of crashing -
// same graceful-degradation pattern as sendEmail above.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:shecan.office@gmail.com";
const PUSH_CONFIGURED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (!PUSH_CONFIGURED) {
  console.warn("[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set - push notifications disabled, falling back to email for everyone.");
}

// Sends one push notification to every device a user (customer/freelancer/admin record) has
// subscribed from, pruning any subscription the push service reports as gone (404/410 - the
// browser unsubscribed, or the endpoint expired). Returns true if at least one push was
// delivered successfully, so callers know whether they still need to fall back to email.
async function sendPushToUser(user, { title, body, url }) {
  if (!PUSH_CONFIGURED || !user || !Array.isArray(user.pushSubscriptions) || !user.pushSubscriptions.length) return false;
  let delivered = false;
  const stillValid = [];
  for (const sub of user.pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, { title, body, url }, { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY });
      delivered = true;
      stillValid.push(sub);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        // this device's subscription is gone - drop it silently, nothing to notify anyone about
      } else {
        console.warn("[push] send failed", e.statusCode || "", e.message);
        stillValid.push(sub); // keep it - could be a transient error, not a dead subscription
      }
    }
  }
  if (stillValid.length !== user.pushSubscriptions.length) {
    user.pushSubscriptions = stillValid;
    db.save();
  }
  return delivered;
}

// Bulk-imported freelancers with no real email on file get a placeholder address
// (id@imported.shecan.co.il - see /admin/bulk-import) purely so the rest of the code can keep
// treating `email` as always-present, NOT a real mailbox anyone can send to. Every place that
// decides whether to attempt an email send needs to treat that placeholder as "no email", the
// same way /admin/freelancer/:id/resend-credentials already does - centralized here so every
// caller (notify() below, and any direct sendEmail(f.email, ...) call) shares one definition
// instead of duplicating (and risking drifting) the same regex.
function hasRealEmail(user) {
  return !!(user && user.email && !/@imported\.shecan\.co\.il$/.test(user.email));
}

// The single place every notification in the app should go through: try a push notification
// first (if this user has an active subscription on at least one device), and only send the
// email as a fallback when push isn't available for her yet (hasn't installed the app / hasn't
// granted notification permission) - so nothing gets silently lost for people who haven't
// opted into push. `emailHtml` is a function so we don't build the (often larger) HTML string
// unless we actually need to send it.
async function notify(user, { pushTitle, pushBody, url, emailSubject, emailHtml }) {
  const pushed = await sendPushToUser(user, { title: pushTitle, body: pushBody, url });
  if (!pushed && hasRealEmail(user)) {
    await sendEmail(user.email, emailSubject, emailHtml()).catch(() => {});
  }
}

// ---------- shared AI integration (Anthropic API) ----------
// Powers TWO features that both call Anthropic's Messages API (https://docs.claude.com/en/api/messages)
// using the built-in fetch (no npm dependency), same zero-dependency-with-graceful-degradation
// pattern as sendEmail/push above:
//   1. suggestSupportReply - the "💡 הצע לי תשובה" button on GET /admin/support/thread/:key.
//   2. aiSearchInterpret - the "🤖 חיפוש חכם" box on /search (see POST /search/ai below), which
//      used to run ONLY on a free local heuristic (smartSearchHeuristic) - now it tries real AI
//      first and falls back to that same heuristic if the AI isn't configured or a call fails,
//      so the search box never breaks even without a key or during an Anthropic outage.
// Requires ONE environment variable set in Render, NOT committed to code:
//   ANTHROPIC_API_KEY - get one at https://console.anthropic.com (Settings -> API Keys)
// If it isn't set yet, both functions return { ok:false, reason:"not_configured" } instead of
// crashing - the support button shows a setup hint, and search silently falls back to the
// heuristic. suggestSupportReply NEVER sends anything on its own - it only returns a suggested
// draft that pre-fills the existing reply textarea; the admin still has to review, (optionally)
// edit, and press "שליחה" herself, exactly as she asked for.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_CONFIGURED = !!ANTHROPIC_API_KEY;
if (!AI_CONFIGURED) {
  console.warn("[ai] ANTHROPIC_API_KEY not set - 'suggest a reply' button will show a setup hint, and smart search will use the free local heuristic instead of real AI.");
}

async function suggestSupportReply(d, messages) {
  if (!AI_CONFIGURED) return { ok: false, reason: "not_configured" };
  const knowledgeBase = (d.settings.supportKnowledgeBase || "").trim();
  const convoText = messages.map((m) => (m.from === "admin" ? "נציגת SheCan" : (m.name || "הפונה")) + ": " + m.text).join("\n");
  const systemPrompt = "את עוזרת שכותבת טיוטות תשובה עבור נציגת התמיכה של SheCan, אתר קהילתי לעצמאיות ישראליות וללקוחות שלהן. " +
    "כתבי תמיד בעברית, בטון חם, אישי וממוקד, כמו נציגה אנושית שכותבת הודעה קצרה - לא מייל רשמי וארוך. " +
    "התבססי אך ורק על מסמך המדיניות/השאלות-הנפוצות שמופיע למטה. אם המסמך לא מכיל תשובה ברורה לשאלה שנשאלה, אמרי בכנות בטיוטה עצמה שאת לא בטוחה ושכדאי לבדוק את זה לפני שליחה - לעולם אל תמציאי מדיניות או פרטים שלא מופיעים במסמך.\n\n" +
    "מסמך המדיניות/FAQ של SheCan:\n" + (knowledgeBase || "(לא הוזן עדיין מסמך מדיניות/FAQ באתר - עדיף לציין בטיוטה שאין עדיין מידע רשמי בנושא)");
  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: "זו שיחת התמיכה עד כה (מהישנה לחדשה):\n\n" + convoText + "\n\nכתבי טיוטת תשובה קצרה, חמה וממוקדת להודעה האחרונה של הפונה - טיוטה שאפשר כמעט לשלוח כמו שהיא." }],
      }),
    });
    if (!apiRes.ok) {
      console.warn("[ai-support] Anthropic API error", apiRes.status, await apiRes.text().catch(() => ""));
      return { ok: false, reason: "api_error" };
    }
    const json = await apiRes.json();
    const text = (json.content || []).map((block) => block.text || "").join("").trim();
    if (!text) return { ok: false, reason: "empty" };
    return { ok: true, text };
  } catch (e) {
    console.warn("[ai-support] call threw", e.message);
    return { ok: false, reason: "call_failed" };
  }
}

// Powers the real-AI version of "🤖 חיפוש חכם" (see POST /search/ai below). Sends the customer's
// free-text request PLUS the site's actual list of category/subcategory/city ids+names, and forces
// the model to answer via a tool call (tool_choice) instead of free-form text - much more reliable
// than asking it to "reply with JSON", since the API itself enforces the shape of the answer. The
// caller (POST /search/ai) still re-validates every id against the real data before using it -
// never trusts the model blindly, same defensive posture as everywhere else in this codebase that
// handles ids coming from outside.
async function aiSearchInterpret(freeText, d) {
  if (!AI_CONFIGURED) return { ok: false, reason: "not_configured" };
  const categoriesDesc = d.categories.map((c) => {
    const subs = (c.subcategories || []).map((s) => `      - תת-תחום: id="${s.id}" שם="${s.name}"`).join("\n");
    return `    תחום: id="${c.id}" שם="${c.name}"` + (subs ? `\n${subs}` : "");
  }).join("\n");
  const citiesDesc = d.cities.map((c) => `id="${c.id}" שם="${c.name}"`).join(", ");
  const systemPrompt = "את מנוע חיפוש חכם באתר SheCan, אתר קהילתי לעצמאיות ישראליות. לקוחה מתארת במילים שלה מה היא מחפשת, " +
    "והתפקיד שלך הוא להמיר את זה לפרמטרי סינון מובנים באתר, בעזרת הכלי shecan_search_filters.\n\n" +
    "רשימת התחומים ותתי-התחומים הקיימים באתר כרגע (חובה לבחור רק id שמופיע ממש ברשימה הזו, ואסור בשום אופן להמציא id שלא ברשימה):\n" + categoriesDesc + "\n\n" +
    "רשימת הערים הקיימות באתר כרגע (חובה לבחור רק id שמופיע ממש ברשימה הזו):\n" + citiesDesc + "\n\n" +
    "אם הבקשה לא מזכירה בבירור תחום/תת-תחום/עיר מסוימים - עדיף להשאיר את השדה ריק מאשר לנחש משהו לא קשור.";
  const tool = {
    name: "shecan_search_filters",
    description: "ממיר בקשת חיפוש חופשית של לקוחה לפרמטרי סינון מובנים באתר SheCan",
    input_schema: {
      type: "object",
      properties: {
        categoryId: { type: "string", description: "ה-id המדויק של התחום המתאים ביותר מהרשימה שסופקה, או מחרוזת ריקה אם אין תחום ברור" },
        subcategoryId: { type: "string", description: "ה-id המדויק של תת-התחום, רק אם הוא שייך בדיוק לאותו categoryId שנבחר, אחרת מחרוזת ריקה" },
        cityId: { type: "string", description: "ה-id המדויק של העיר מהרשימה שסופקה, או מחרוזת ריקה אם לא צוינה עיר" },
        wantsHighQuality: { type: "boolean", description: "true אם היא ציינה שהיא מחפשת רמה גבוהה/איכות/מקצועיות/עצמאית מומלצת ומנוסה" },
        wantsGoodPrice: { type: "boolean", description: "true אם היא ציינה שהיא מחפשת מחיר טוב/זול/משתלם/תקציב" },
        keywords: { type: "string", description: "מילות חיפוש חופשיות נוספות שלא נתפסות ע\"י תחום/תת-תחום/עיר שנבחרו - למשל שם עסק ספציפי או תיאור סגנון/שירות מדויק - מחרוזת ריקה אם אין" },
      },
      required: ["categoryId", "subcategoryId", "cityId", "wantsHighQuality", "wantsGoodPrice", "keywords"],
    },
  };
  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 400,
        system: systemPrompt,
        tools: [tool],
        tool_choice: { type: "tool", name: "shecan_search_filters" },
        messages: [{ role: "user", content: freeText }],
      }),
    });
    if (!apiRes.ok) {
      console.warn("[ai-search] Anthropic API error", apiRes.status, await apiRes.text().catch(() => ""));
      return { ok: false, reason: "api_error" };
    }
    const json = await apiRes.json();
    const toolUse = (json.content || []).find((block) => block.type === "tool_use");
    if (!toolUse || !toolUse.input) return { ok: false, reason: "empty" };
    return { ok: true, filters: toolUse.input };
  } catch (e) {
    console.warn("[ai-search] call threw", e.message);
    return { ok: false, reason: "call_failed" };
  }
}

// ---------- seed admin password once ----------
(function ensureAdminPassword() {
  const d = db.load();
  if (!d.admins[0].passwordHash) {
    d.admins[0].passwordHash = auth.hashPassword("shecan2026");
    db.save();
  }
})();

// ---------- helpers ----------
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB per individual photo - generous for a full-res phone photo
const MAX_REQUEST_BYTES = 40 * 1024 * 1024; // 40MB total per form submission - covers a logo + a few showcase photos together
// Inspiration-story feature: a few one-line answers don't make for much of a story, so any
// submission (at /join or the dashboard) needs at least this many non-empty answers. Capped by
// the actual configured question count too, so this stays submittable even if an admin ever
// trims d.settings.storyQuestions down below 3 (see the delete-guard on /admin/story-question/:index/delete).
const STORY_MIN_ANSWERS = 3;

// Reads a request body. For normal forms this returns a URLSearchParams (unchanged
// behaviour). For multipart/form-data (file uploads) it returns a URLSearchParams-like
// object too - so every existing `body.get("field")` call keeps working as-is - with an
// extra `.files` map of { fieldName: { filename, contentType, data (Buffer) } }, and a
// `.tooBig` flag if the upload exceeded MAX_UPLOAD_BYTES.
function readBody(req) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.startsWith("multipart/form-data")) return parseMultipart(req, contentType);
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const params = new URLSearchParams(data);
      params.files = {};
      resolve(params);
    });
  });
}

function parseMultipart(req, contentType) {
  return new Promise((resolve) => {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!boundaryMatch) { const p = new URLSearchParams(); p.files = {}; return resolve(p); }
    const boundary = "--" + (boundaryMatch[1] || boundaryMatch[2]).trim();
    const boundaryBuf = Buffer.from(boundary);
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_REQUEST_BYTES) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const fields = new URLSearchParams();
      const files = {};
      let start = buf.indexOf(boundaryBuf);
      while (start !== -1) {
        const next = buf.indexOf(boundaryBuf, start + boundaryBuf.length);
        if (next === -1) break;
        let part = buf.slice(start + boundaryBuf.length, next);
        if (part.slice(0, 2).toString() === "\r\n") part = part.slice(2);
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd !== -1) {
          const headerStr = part.slice(0, headerEnd).toString("utf8");
          let content = part.slice(headerEnd + 4);
          if (content.slice(-2).toString() === "\r\n") content = content.slice(0, -2);
          const nameMatch = headerStr.match(/name="([^"]*)"/);
          const filenameMatch = headerStr.match(/filename="([^"]*)"/);
          const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
          const name = nameMatch ? nameMatch[1] : null;
          if (name) {
            if (filenameMatch) {
              if (filenameMatch[1]) {
                files[name] = { filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1].trim() : "application/octet-stream", data: content };
              }
            } else {
              fields.append(name, content.toString("utf8"));
            }
          }
        }
        start = next;
      }
      fields.files = files;
      fields.tooBig = tooBig;
      resolve(fields);
    });
    req.on("error", () => { const p = new URLSearchParams(); p.files = {}; resolve(p); });
  });
}

// Server-side backstop for the maxlength attributes on free-text bio fields - a browser
// maxlength is easy to bypass with a direct POST, so the real limit is enforced here.
function clip(str, max) { return (str || "").slice(0, max); }

// שולף מספר גולמי ממחרוזת מחיר חופשית כמו "150 ₪" או "1,200 ש\"ח" - לשימוש בסינון לפי
// מחיר מקסימלי בהשכרת שמלות (ר' GET /community/:type). מחזיר null אם אין ספרות בכלל.
function parsePriceNum(str) {
  const m = String(str || "").match(/[\d,.]+/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extFromImageContentType(ct) {
  const map = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "image/heic": "heic", "image/heif": "heif", "image/avif": "avif",
    "image/bmp": "bmp", "image/svg+xml": "svg",
  };
  return map[(ct || "").toLowerCase()] || "jpg";
}

// NOTE ON THE NAME: despite still being called fileToDataUri, this no longer returns a literal
// "data:image/...;base64,...." string - as of 2026-08-22 it WRITES the uploaded image to a file
// under UPLOADS_DIR and returns a short "/uploads/<name>.<ext>" URL instead. The name was kept
// on purpose so every existing call site (freelancer registration/profile edits, additional
// listings, reviews, stories, site logo/banner/background) keeps working with zero changes -
// they all just store whatever string this returns and drop it into an <img src="..."> later,
// which works identically for a data: URI or a normal URL path.
//
// This is the real fix for the 2026-08-22 OOM crash-loop: db.json had grown to ~290MB because
// every one of those images was being stored as full base64 text directly inside the one JSON
// file. Every server boot had to JSON.parse that whole ~290MB string, and every single db.save()
// (which happens on nearly every page view / write, see saveSiteStatsThrottled and friends) had
// to JSON.stringify it all again - on a 2GB instance that alone was enough to exhaust memory
// within seconds of starting, independent of any traffic. See migrateEmbeddedPhotosToFiles
// below for the one-time cleanup of images already embedded in db.json from before this fix.
function fileToDataUri(file, maxBytes) {
  if (!file || !file.data || !file.data.length) return null;
  if (!/^image\//.test(file.contentType || "")) return null;
  if (maxBytes && file.data.length > maxBytes) return null;
  const ext = extFromImageContentType(file.contentType);
  const filename = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.data);
  } catch (e) {
    console.warn("[fileToDataUri] failed to write uploaded image to disk:", e.message);
    return null;
  }
  return `/uploads/${filename}`;
}

// One-time cleanup (gated by settings.photosMigratedToFiles) that walks every place an image
// used to be stored as an embedded base64 data: URI and rewrites it to a file under
// UPLOADS_DIR + a short "/uploads/<name>" path instead - see the big comment on fileToDataUri
// above for why. Safe to run on every boot: after the first successful run it flips the flag
// and every subsequent boot returns immediately without touching anything. If writing any single
// image to disk fails for some reason, that one field is simply left as-is (still a working
// base64 image, just not yet migrated) rather than risking data loss - it'll be retried the
// next time this runs, which is only possible by manually resetting the flag, so in practice a
// failure here should be investigated rather than assumed to self-heal.
function migrateEmbeddedPhotosToFiles(d) {
  if (d.settings.photosMigratedToFiles) return false;
  let moved = 0;
  function moveOne(dataUri, prefix) {
    if (typeof dataUri !== "string") return dataUri;
    const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUri);
    if (!m) return dataUri; // not a base64 data URI (already a /uploads/ path, external URL, or empty) - leave untouched
    const ext = extFromImageContentType(`image/${m[1]}`);
    const filename = `migrated-${prefix}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    try {
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(m[2], "base64"));
      moved++;
      return `/uploads/${filename}`;
    } catch (e) {
      console.warn(`[migrate-photos] failed to write ${prefix}:`, e.message);
      return dataUri;
    }
  }
  function moveField(obj, field, prefix) { if (obj && obj[field]) obj[field] = moveOne(obj[field], prefix); }
  function moveArray(obj, field, prefix) {
    if (obj && Array.isArray(obj[field])) obj[field] = obj[field].map((v, i) => moveOne(v, `${prefix}-${i}`));
  }
  (d.freelancers || []).forEach((f) => {
    moveField(f, "photoDataUri", `freelancer-${f.id}-photo`);
    moveField(f, "logoDataUri", `freelancer-${f.id}-logo`);
    moveArray(f, "galleryPhotos", `freelancer-${f.id}-gallery`);
    (f.additionalListings || []).forEach((l) => {
      moveField(l, "logoDataUri", `listing-${l.id}-logo`);
      moveArray(l, "galleryPhotos", `listing-${l.id}-gallery`);
    });
  });
  (d.reviews || []).forEach((r) => moveField(r, "photoDataUri", `review-${r.id}-photo`));
  (d.stories || []).forEach((s) => moveField(s, "photoDataUri", `story-${s.id}-photo`));
  moveField(d.settings, "siteLogoDataUri", "site-logo");
  moveField(d.settings, "topBannerDataUri", "site-banner");
  moveField(d.settings, "siteBackgroundImageDataUri", "site-bg");
  d.settings.photosMigratedToFiles = true;
  console.log(`[migrate-photos] moved ${moved} embedded base64 image(s) out of db.json into ${UPLOADS_DIR}`);
  return true;
}

(function runPhotoMigration() {
  const d = db.load();
  if (migrateEmbeddedPhotosToFiles(d)) db.save();
})();

// ----- "סטטוסים" (24 שעות, נוסף 2026-09-02) - תמונה/סרטון שעצמאית פרימיום מעלה, נשמר בדיסק
// (בדיוק כמו fileToDataUri, לא כ-base64 ב-DB - ר' ההערה שם) - לא באמצעות fileToDataUri עצמו כי
// הוא מקבל רק image/*; זה כמעט זהה, רק תומך גם בסוגי וידאו נפוצים ובתקרת גודל גדולה יותר. -----
const MAX_STATUS_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_VIDEO_BYTES = 30 * 1024 * 1024;
function saveStatusFile(file) {
  if (!file || !file.data || !file.data.length) return null;
  const ct = (file.contentType || "").toLowerCase();
  const extMap = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  };
  const ext = extMap[ct];
  if (!ext) return null;
  const isVideo = ct.startsWith("video/");
  const maxBytes = isVideo ? MAX_STATUS_VIDEO_BYTES : MAX_STATUS_IMAGE_BYTES;
  if (file.data.length > maxBytes) return null;
  const filename = `status-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.data);
  } catch (e) {
    console.warn("[saveStatusFile] failed to write uploaded status file to disk:", e.message);
    return null;
  }
  return { url: `/uploads/${filename}`, type: isVideo ? "video" : "image" };
}

// מסננת החוצה כל סטטוס שכבר פג (expiresAt עבר) ומוחקת גם את הקובץ שלו מהדיסק, כדי שקבצים
// ישנים לא יצטברו שם לנצח - קריאה זולה, בטוחה להריץ בכל פעם שנוגעים ברשימת הסטטוסים (לפני
// בדיקת מגבלת 3 הפעילים בהעלאה חדשה, ובכניסה לאזור האישי/לוח הניהול). לא רצה אוטומטית על כל
// בקשה באתר (זה היה קורה ב-layout.js/page(), שרץ על כל עמוד) כי מחיקת קבצים היא פעולת דיסק לא
// קריטית לתצוגה עצמה - שם, page() רק מסנן מה להציג (ר' statusRailHtml), בלי לגעת בדיסק או לשמור.
function pruneFreelancerStatuses(d) {
  const now = Date.now();
  const kept = [];
  let removed = false;
  (d.freelancerStatuses || []).forEach((s) => {
    if (new Date(s.expiresAt).getTime() > now) { kept.push(s); return; }
    removed = true;
    const filename = (s.url || "").split("/").pop();
    if (filename) { try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch (e) {} }
  });
  if (removed) d.freelancerStatuses = kept;
  return removed;
}

// Combines a cookie already set earlier in the request (via res.setHeader("Set-Cookie", ...) -
// e.g. the scVisit visit-tracking cookie set by trackSiteVisit() before the route handler even
// runs, near the bottom of this file) with whatever cookie THIS response also wants to set (e.g.
// login setting sid+scUid). Required because res.writeHead(status, headers) does NOT merge an
// earlier setHeader("Set-Cookie", ...) with a "Set-Cookie" key present in its own headers object -
// it silently DROPS the earlier one instead (verified directly with a throwaway Node script:
// writeHead's headers always win for a header name present in both places). Every response path
// in this file funnels through sendHtml()/redirect() below, so merging here once covers all of
// them - no need to touch the ~2 raw res.writeHead() calls elsewhere (static file/asset routes)
// since those never pass a "Set-Cookie" key of their own, so the earlier setHeader value survives
// untouched for them regardless.
function mergedSetCookie(res, cookie) {
  const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const merged = [...toArray(res.getHeader("Set-Cookie")), ...toArray(cookie)];
  return merged.length ? merged : null;
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const merged = mergedSetCookie(res, extraHeaders["Set-Cookie"]);
  const headers = { "Content-Type": "text/html; charset=utf-8", ...extraHeaders };
  if (merged) headers["Set-Cookie"] = merged; else delete headers["Set-Cookie"];
  res.writeHead(status, headers);
  res.end(html);
}

function redirect(res, location, cookie) {
  const merged = mergedSetCookie(res, cookie);
  const headers = { Location: location };
  if (merged) headers["Set-Cookie"] = merged;
  res.writeHead(302, headers);
  res.end();
}

function sessionCookie(sid) {
  return `sid=${sid}; HttpOnly; Path=/; Max-Age=2592000`;
}
const clearCookie = "sid=; HttpOnly; Path=/; Max-Age=0";

// Long-lived identity cookie, separate from the session cookie ("sid") above and NOT cleared
// on logout - per explicit request to count a registered customer/freelancer's visits even
// when she's just browsing without being logged in. Set/refreshed every time she establishes
// a session (see the login route and the two persona-switch routes below); read back on every
// page load in trackSiteVisit() to attribute the visit to her account. Admin logins deliberately
// don't get one - admin visits already aren't counted at all (see trackSiteVisit).
function identityCookie(role, id) {
  return `scUid=${encodeURIComponent(role + ":" + id)}; HttpOnly; Path=/; Max-Age=31536000`;
}

function getSession(req) {
  const cookies = auth.parseCookies(req);
  return { session: auth.getSession(cookies.sid), sid: cookies.sid };
}

// Turns admin-edited free text (terms/privacy policy, edited via a plain <textarea> in the
// admin panel - not code) into simple HTML: a blank line starts a new paragraph, a line
// starting with "## " becomes a subheading, and **text** becomes bold. Deliberately not a
// full markdown parser - just enough structure for a legal-style policy page, kept
// zero-dependency like the rest of the app. Content is admin-authored, but every block still
// goes through esc() first before any tag is added, so no raw HTML can leak in either way.
function renderRichText(text) {
  if (!text) return "";
  const blocks = text.trim().split(/\n\s*\n/);
  return blocks.map((block) => {
    const trimmed = block.trim();
    if (trimmed.startsWith("## ")) return `<h3 style="margin-top:28px;">${esc(trimmed.slice(3))}</h3>`;
    if (trimmed.startsWith("# ")) return `<h2 class="section-title">${esc(trimmed.slice(2))}</h2>`;
    const escaped = esc(trimmed).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>");
    return `<p style="margin:14px 0;line-height:1.8;">${escaped}</p>`;
  }).join("");
}

function catName(d, id) { const c = d.categories.find((x) => x.id === id); return c ? c.name : "-"; }
function cityName(d, id) { const c = d.cities.find((x) => x.id === id); return c ? c.name : "-"; }
// A category's own subcategory list, e.g. subcategoriesOf(d, "1") -> [{id:"1-1", name:"מאפרת כלות וערב"}, ...]
function subcategoriesOf(d, categoryId) { const c = d.categories.find((x) => x.id === categoryId); return (c && c.subcategories) || []; }
function subcatName(d, categoryId, subcategoryId) {
  if (!subcategoryId) return "";
  const sub = subcategoriesOf(d, categoryId).find((s) => s.id === subcategoryId);
  return sub ? sub.name : "";
}
// Plural version for a freelancer who marked more than one subcategory in her category
// (see f.subcategoryIds) - joins all her matched subcategory names into one readable string,
// e.g. "מניקוריסטית, איפור כלות". Silently drops any stale id that no longer matches a real
// subcategory (category changed since, etc.) rather than showing a broken empty entry.
function subcatNames(d, categoryId, subcategoryIds) {
  return (subcategoryIds || []).map((id) => subcatName(d, categoryId, id)).filter(Boolean).join(", ");
}
// Strict: true only when the target subcategory is explicitly one of hers - used by
// GET /search, where filtering by a specific subcategory should only surface freelancers who
// actually tagged themselves with it (picking no subcategory at all means "unfiltered/every
// subcategory" from the dropdown's own side, not "matches every specific subcategory too").
function freelancerSubcatMatches(f, subcategoryId) {
  if (!subcategoryId) return true;
  const ids = f.subcategoryIds || (f.subcategoryId ? [f.subcategoryId] : []);
  return ids.includes(subcategoryId);
}
// Lenient: also counts as a match when she hasn't picked any subcategory at all (works the
// category broadly) - used for arena-question/service-request matching & notifications,
// where casting a slightly wider net for a generalist is intentional (see freelancersForCategory
// below and matchingServiceRequests in the dashboard, which both used this looser rule already).
function freelancerSubcatMatchesBroad(f, subcategoryId) {
  if (!subcategoryId) return true;
  const ids = f.subcategoryIds || (f.subcategoryId ? [f.subcategoryId] : []);
  return !ids.length || ids.includes(subcategoryId);
}
// Highlight box shown to Sapir in the admin panel (both the pending-approval cards and the
// already-approved freelancers table) whenever a freelancer just introduced a brand-new
// subcategory (see resolveCategorySelection / customSubcategoryPending) - lets her fix the
// wording right there (renames the actual shared subcategory record, so the fix applies
// everywhere it's used) or just confirm it's fine, either way clearing the flag so it doesn't
// keep nagging her once she's looked at it.
function customSubcategoryNoteHtml(f, d) {
  if (!f.customSubcategoryPending) return "";
  const subName = subcatName(d, f.categoryId, f.subcategoryId) || "";
  const catNameStr = catName(d, f.categoryId) || "";
  return `
  <div class="panel" style="background:#FBF3EC;border:1px solid #E8D9C9;margin-top:8px;">
    <p style="margin:0 0 8px;font-weight:700;">🆕 היא הוסיפה תת-תחום חדש: "${esc(subName)}" (בתחום ${esc(catNameStr)}) - כדאי לוודא שהניסוח תקין.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <form method="post" action="/admin/freelancer/${f.id}/subcategory-note/rename" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <input type="text" name="newName" value="${esc(subName)}" maxlength="80" style="width:220px;" />
        <button type="submit" class="btn btn-small btn-outline">עדכון שם תת-התחום</button>
      </form>
      <form method="post" action="/admin/freelancer/${f.id}/subcategory-note/dismiss">
        <button type="submit" class="btn btn-small btn-outline">✓ בדקתי, זה בסדר</button>
      </form>
    </div>
  </div>`;
}
// Count of approved reviews/recommendations for a freelancer's main profile (listingId
// omitted) or for one specific additional listing (listingId passed) - used to sort
// freelancer listings so whoever has the most recommendations shows up first, wherever
// freelancers are listed on the site (home page, search, deals, ...).
function reviewCountFor(d, freelancerId, listingId) {
  return d.reviews.filter((r) => r.type === "freelancer" && r.status === "approved" && r.targetId === freelancerId && String(r.listingId || "") === String(listingId || "")).length;
}
// Average star rating (1-5, rounded to the nearest whole star for display) across a
// freelancer's main-profile reviews or one specific additional listing's reviews - null
// when there are none yet, so the caller can show nothing at all rather than "0 stars".
function avgRatingFor(d, freelancerId, listingId) {
  const revs = d.reviews.filter((r) => r.type === "freelancer" && r.status === "approved" && r.targetId === freelancerId && String(r.listingId || "") === String(listingId || ""));
  if (!revs.length) return null;
  const sum = revs.reduce((s, r) => s + (Number(r.rating) || 0), 0);
  return sum / revs.length;
}
// הציון המספרי המדויק של הדירוג לתצוגה (למשל ליד כוכבי הדירוג בפרופיל) - עד ספרה אחת אחרי
// הנקודה, אבל בלי ".0" מיותר כשהציון הוא בעצם מספר שלם (5 ולא 5.0) - לפי בקשה מפורשת 2026-08-31.
function formatRatingNumber(n) {
  const oneDecimal = Number(n).toFixed(1);
  return oneDecimal.endsWith(".0") ? oneDecimal.slice(0, -2) : oneDecimal;
}
// The location line shown on a card/profile: her city if she set one, otherwise whichever
// delivery option she picked instead (online / comes to the customer) - so the line is never
// just blank for a freelancer who works online-only or only does home visits.
function locationLabel(d, cityId, offersOnline, offersHomeVisit) {
  // cityName() itself falls back to the placeholder string "-" for an unknown/empty cityId (used
  // on purpose elsewhere, e.g. admin lists, to flag an incomplete profile) - but that made THIS
  // function's own "if (city) return city" always true, since "-" is a non-empty string, so the
  // online/home-visit fallback below could never actually run. Guarding on cityId directly (and
  // treating a stray "-" as "no real city") is the actual fix.
  const city = cityId ? cityName(d, cityId) : "";
  if (city && city !== "-") return city;
  if (offersOnline) return "שירות אונליין";
  if (offersHomeVisit) return "מגיעה אלייך";
  return "";
}
// The icon paired with locationLabel() above wherever it's shown (card/profile) - added
// 2026-08-25 per explicit request, after Sapir noticed the pin icon (📍) stayed put even when
// the text next to it had already fallen back to "שירות אונליין"/"מגיעה אלייך" (no real city),
// which visually contradicted itself. Mirrors locationLabel()'s exact branching so the icon can
// never drift out of sync with the text it sits beside - a real city keeps the pin, online
// service gets a laptop, a home-visit-only freelancer gets a car.
function locationIcon(d, cityId, offersOnline, offersHomeVisit) {
  const city = cityId ? cityName(d, cityId) : "";
  if (city && city !== "-") return "📍";
  if (offersOnline) return "💻";
  if (offersHomeVisit) return "🚗";
  return "📍";
}
// Short "X שנים בתחום" form for the card - e.g. "0-2 שנים בתחום" - the full option label
// (used on the join form) has a parenthetical explanation like "(מתחילה את הדרך)" that's too
// long to show on the compact card, so this drops it.
function yearsInFieldShortLabel(value) {
  const o = YEARS_IN_FIELD_OPTIONS.find((x) => x.value === value);
  return o ? `${o.value} שנים בתחום` : "";
}
// Card photo: a real profile photo is cropped to fill the frame (background-size:cover) same
// as before; when she only has a logo (no photo), it's shown scaled DOWN to fit inside the
// frame without cropping (background-size:contain) against a plain white backing, since a
// logo cropped/stretched to fill the frame like a photo tends to look cut off or distorted.
// With neither, falls back to her initials over the card's uniform accent color.
// defaultLogoUri (optional) - d.settings.defaultBusinessLogoDataUri (the SheCan monogram Sapir
// set as the sitewide default), shown instead of bare initials for a business that hasn't
// uploaded its own photo OR logo yet. She can always replace this default via the admin panel,
// and any business that HAS uploaded its own photo/logo keeps showing that as usual - this is
// only the fallback for the ones that never uploaded anything at all.
function cardPhotoHtml(photoUri, logoUri, name, cssClass, defaultLogoUri) {
  if (photoUri) return `<div class="${cssClass}" style="background-image:url('${esc(photoUri)}');background-size:cover;background-position:center;"></div>`;
  if (logoUri) return `<div class="${cssClass} ${cssClass}-logo" style="background-image:url('${esc(logoUri)}');background-size:contain;background-repeat:no-repeat;background-position:center;"></div>`;
  if (defaultLogoUri) return `<div class="${cssClass} ${cssClass}-logo" style="background-image:url('${esc(defaultLogoUri)}');background-size:contain;background-repeat:no-repeat;background-position:center;"></div>`;
  return `<div class="${cssClass}">${initials(name)}</div>`;
}
// The area line shown on a card/profile: main category, plus the specific subcategory
// in parentheses when she picked one (e.g. "יופי וטיפוח (מניקוריסטית ולק ג'ל)").
function categoryLine(d, f) {
  const main = catName(d, f.categoryId);
  const sub = subcatName(d, f.categoryId, f.subcategoryId);
  return sub ? `${main} (${sub})` : main;
}

// Backs the "אחר" (Other) option on category selects - if she types a category name that
// already exists (case-insensitive match), reuse it instead of creating a duplicate, so
// the category list doesn't fill up with near-identical entries over time.
function findOrCreateCategory(d, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const existing = d.categories.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  const id = String(d.categories.length + 1) + "-" + Date.now();
  const category = { id, name: trimmed, subcategories: [] };
  d.categories.push(category);
  return category;
}
// Returns { sub, isNew } - isNew is true only when a brand-new subcategory record was just
// created (not when an existing one, matched case-insensitively, was reused instead). Callers
// use isNew to flag "she just introduced a new subcategory" for a quick admin review (see
// wasCustomSubcategory below, and customSubcategoryPending on the freelancer record).
function findOrCreateSubcategory(d, categoryId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const category = d.categories.find((c) => c.id === categoryId);
  if (!category) return null;
  category.subcategories = category.subcategories || [];
  const existing = category.subcategories.find((s) => s.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (existing) return { sub: existing, isNew: false };
  const sub = { id: categoryId + "-custom-" + Date.now(), name: trimmed };
  category.subcategories.push(sub);
  return { sub, isNew: true };
}
// "מחיקה חוסמת שימוש" (נוסף 2026-08-30, לפי בקשה מפורשת: אף פעם לא למחוק תחום/תת-תחום
// שמשויכים אליו עסקים/בקשות בפועל, כדי לא להשאיר רשומה עם שיוך "יתום") - סופרות בכמה מקומות
// באתר תחום/תת-תחום נתון עדיין בשימוש בפועל: התחום/תת-התחום הראשי של עצמאית, התחומים הנוספים
// שלה (additionalCategoryIds), כל אחד מ"התחומים הנוספים" שלה כרשומה נפרדת (additionalListings),
// בקשות שירות פתוחות (serviceRequests) ושאלות בזירה (arenaQuestions). אם הספירה גדולה מ-0,
// המחיקה חסומה בצד השרת (לא רק מוסתר הכפתור בתצוגה) - היא צריכה קודם לשייך את מה שמשתמש בזה
// מחדש דרך פאנל "שיוך מחדש" (ר' POST /admin/reassign-listing למטה).
function categoryUsageCount(d, categoryId) {
  let count = 0;
  d.freelancers.forEach((f) => {
    if (f.categoryId === categoryId) count++;
    if ((f.additionalCategoryIds || []).includes(categoryId)) count++;
    (f.additionalListings || []).forEach((l) => { if (l.categoryId === categoryId) count++; });
  });
  (d.serviceRequests || []).forEach((r) => { if (r.categoryId === categoryId) count++; });
  (d.arenaQuestions || []).forEach((q) => { if (q.categoryId === categoryId) count++; });
  return count;
}
function subcategoryUsageCount(d, categoryId, subcategoryId) {
  let count = 0;
  d.freelancers.forEach((f) => {
    if (f.categoryId === categoryId) {
      const ids = f.subcategoryIds && f.subcategoryIds.length ? f.subcategoryIds : (f.subcategoryId ? [f.subcategoryId] : []);
      if (ids.includes(subcategoryId)) count++;
    }
    (f.additionalListings || []).forEach((l) => { if (l.categoryId === categoryId && l.subcategoryId === subcategoryId) count++; });
  });
  (d.serviceRequests || []).forEach((r) => { if (r.categoryId === categoryId && r.subcategoryId === subcategoryId) count++; });
  (d.arenaQuestions || []).forEach((q) => { if (q.categoryId === categoryId && q.subcategoryId === subcategoryId) count++; });
  return count;
}
// Resolves the category/subcategory a freelancer picked at registration or profile-update time.
// categoryId === "__other__" is still the one remaining "אחר" (Other) escape hatch - her field
// isn't in the top-level category list at all, so she typed a whole new category (and
// optionally a brand-new subcategory under it, created live immediately - this is a much
// bigger/rarer decision than a subcategory tweak, so it's left as-is).
// A brand-new SUBCATEGORY under an EXISTING category, though, no longer has a live "אחר" escape
// hatch (removed 2026-08-27, per explicit request) - she can only pick from the category's real
// existing subcategory list now (or leave it blank), and separately, optionally, write a
// free-text *recommendation* for a missing one (ר' recordSubcategorySuggestion למטה) that goes
// to a real admin approval queue instead of appearing live immediately. If a stale/tampered
// subcategoryId ever comes in that doesn't actually belong to the chosen category, it's
// silently dropped rather than trusted.
// wasCustomSubcategory is true only when path (1) (a genuinely new top-level category) created a
// brand-new subcategory too - the caller uses this to set customSubcategoryPending on the
// freelancer record, which surfaces a review highlight for Sapir on the admin panel.
// Multi-subcategory-aware (נוסף 2026-08-27) - קוראת body.getAll("subcategoryId") כי הטופס
// שולח עכשיו כמה תיבות סימון עם אותו name, לא <select> יחיד. מחזירה subcategoryIds (מערך,
// המקור האמיתי) וגם subcategoryId (הראשון ברשימה, לתאימות לאחור לכל מקום שעדיין מציג רק
// "תת-תחום אחד" בתצוגה).
function resolveCategorySelection(d, body) {
  let categoryId = body.get("categoryId");
  let subcategoryIds = body.getAll("subcategoryId").filter(Boolean);
  let wasCustomSubcategory = false;
  if (categoryId === "__other__") {
    const category = findOrCreateCategory(d, body.get("customCategory"));
    categoryId = category ? category.id : "";
    const subName = (body.get("customSubcategory") || "").trim();
    if (category && subName) {
      const result = findOrCreateSubcategory(d, category.id, subName);
      subcategoryIds = result ? [result.sub.id] : [];
      wasCustomSubcategory = !!(result && result.isNew);
    } else {
      subcategoryIds = [];
    }
  } else {
    // Silently drop any stale/tampered id that doesn't actually belong to the chosen
    // category, same protection the old single-value version had.
    const validIds = new Set(subcategoriesOf(d, categoryId).map((s) => s.id));
    subcategoryIds = subcategoryIds.filter((id) => validIds.has(id));
  }
  return { categoryId, subcategoryIds, subcategoryId: subcategoryIds[0] || "", wasCustomSubcategory };
}
// "המלצה על תת-תחום חדש" (נוסף 2026-08-27) - הדרך היחידה כיום להציע תת-תחום שלא ברשימה הקיימת.
// בניגוד למנגנון הישן (ר' resolveCategorySelection למעלה) - זה לא יוצר שום דבר חי מיד, רק
// שומר המלצה שממתינה לאישור המנהלת (d.subcategorySuggestions ב-db.js). קוראות לזה גם POST
// /join וגם POST /freelancer-dashboard, אחרי resolveCategorySelection. לא נשמרת המלצה כפולה -
// לא אם כבר קיים תת-תחום אמיתי באותו שם (אולי בדיוק אושרה המלצה קודמת), ולא אם כבר יש המלצה
// תלויה זהה (אותה קטגוריה + אותו שם) מעצמאית אחרת, כדי לא להציף את המנהלת בכפילויות.
function recordSubcategorySuggestion(d, body, categoryId, freelancerId, freelancerLabel) {
  const name = clip((body.get("subcategorySuggestion") || "").trim(), 80);
  if (!name || !categoryId || categoryId === "__other__") return;
  const category = d.categories.find((c) => c.id === categoryId);
  if (!category) return;
  const alreadyExists = (category.subcategories || []).some((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  if (alreadyExists) return;
  d.subcategorySuggestions = d.subcategorySuggestions || [];
  const alreadyPending = d.subcategorySuggestions.some((s) => s.status === "pending" && s.categoryId === categoryId && s.name.trim().toLowerCase() === name.toLowerCase());
  if (alreadyPending) return;
  d.subcategorySuggestions.push({
    id: db.nextId("subcategorySuggestion"),
    categoryId, name, freelancerId, freelancerLabel,
    status: "pending", createdAt: new Date().toISOString(),
  });
}

// "כמה שנים את בתחום?" - required at signup (and separately for every additional field she
// adds), shown on her card so customers can see her experience level at a glance.
const YEARS_IN_FIELD_OPTIONS = [
  { value: "0-2", label: "0-2 שנים (מתחילה את הדרך)" },
  { value: "3-5", label: "3-5 שנים" },
  { value: "6-10", label: "6-10 שנים" },
  { value: "10+", label: "10+ שנים (מומחית וותיקה)" },
];
function yearsInFieldOptionsHtml(selected) {
  return YEARS_IN_FIELD_OPTIONS.map((o) => `<option value="${o.value}" ${selected === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("");
}
function yearsInFieldLabel(value) {
  const o = YEARS_IN_FIELD_OPTIONS.find((x) => x.value === value);
  return o ? o.label : "";
}

// One "add another field of work" form block - own category/subcategory, business name,
// logo, gallery, deal, description, delivery method and portfolio link, but deliberately
// no story option (that stays tied to her one real story) and no city/phone/email fields
// (those are shared from her main profile, since it's the same person). Used both for a
// brand-new slot at registration/dashboard, and pre-filled when editing an existing listing.
function extraListingFormBlock(d, prefix, idx, listing) {
  const l = listing || {};
  const catOptions = d.categories.map((c) => `<option value="${c.id}" ${l.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const subSelId = `${prefix}Subcat${idx}`;
  const subOptions = l.categoryId ? subcategoriesOf(d, l.categoryId).map((s) => `<option value="${s.id}" ${l.subcategoryId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("") : "";
  return `
    <label>שם העסק בתחום הזה<input type="text" name="${prefix}BusinessName${idx}" value="${esc(l.businessName || "")}" /></label>
    <label>תחום<select name="${prefix}CategoryId${idx}" onchange="scUpdateSubcats(this, document.getElementById('${subSelId}'), '')"><option value="">בחרי תחום</option>${catOptions}</select></label>
    <label>תת-תחום (לא חובה)<select name="${prefix}SubcategoryId${idx}" id="${subSelId}"><option value="">בחרי קודם תחום</option>${subOptions}</select></label>
    <label>לוגו (לא חובה)<input type="file" name="${prefix}Logo${idx}" accept="image/*" data-sc-crop="1" /></label>
    <label>תמונות להתרשמות (עד 4, לא חובה)
    <input type="file" name="${prefix}Gallery1_${idx}" accept="image/*" style="margin-bottom:8px;" /></label>
    <input type="file" name="${prefix}Gallery2_${idx}" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="${prefix}Gallery3_${idx}" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="${prefix}Gallery4_${idx}" accept="image/*" />
    <label>ספרי בכמה מילים על התחום הזה (עד 500 תווים)<textarea name="${prefix}Description${idx}" maxlength="500">${esc(l.description || "")}</textarea></label>
    <label>ההטבה בתחום הזה (עד 200 תווים) *<textarea name="${prefix}DealText${idx}" maxlength="200">${esc(l.dealText || "")}</textarea></label>
    <p class="muted" style="margin:-6px 0 0;font-size:13px;">* חובה - בלי הטבה התחום הזה לא יאושר לפרסום.</p>
    <label>כמה שנים את בתחום הזה?
    <select name="${prefix}YearsInField${idx}" ${idx === "" ? "required" : ""}><option value="">בחרי</option>${yearsInFieldOptionsHtml(l.yearsInField || "")}</select></label>
    <label>איך את נותנת את השירות הזה? (אפשר לסמן כמה)</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:0;"><input type="checkbox" name="${prefix}OffersOnline${idx}" value="1" ${l.offersOnline ? "checked" : ""} style="width:auto;" /> 💻 נותנת שירות אונליין / דיגיטלית</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:6px;"><input type="checkbox" name="${prefix}OffersHomeVisit${idx}" value="1" ${l.offersHomeVisit ? "checked" : ""} style="width:auto;" /> 🚗 מגיעה עד הבית של הלקוחה</label>
    <label>קישור לתיק עבודות (לא חובה)<input type="text" name="${prefix}PortfolioUrl${idx}" value="${esc(l.portfolioUrl || "")}" placeholder="https://..." /></label>
    <label>איזו רמה מתאימה לתחום הזה?
    <select name="${prefix}Tier${idx}"><option value="basic" ${l.tier === "basic" ? "selected" : ""}>בסיסית</option><option value="premium" ${l.tier === "premium" ? "selected" : ""}>מומלצת</option></select></label>
  `;
}
// Reads one extraListingFormBlock's submitted fields (by index) into a listing object, or
// returns null if she didn't fill in a business name + category for that slot (so partially
// touched/empty slots are silently skipped instead of creating junk empty listings).
function readExtraListingFromBody(d, body, prefix, idx) {
  const businessName = (body.get(`${prefix}BusinessName${idx}`) || "").trim();
  const categoryId = body.get(`${prefix}CategoryId${idx}`) || "";
  if (!businessName || !categoryId) return null;
  const galleryPhotos = [`${prefix}Gallery1_${idx}`, `${prefix}Gallery2_${idx}`, `${prefix}Gallery3_${idx}`, `${prefix}Gallery4_${idx}`]
    .map((field) => fileToDataUri(body.files[field], MAX_UPLOAD_BYTES))
    .filter(Boolean);
  return {
    id: db.nextId("listing"),
    categoryId, subcategoryId: body.get(`${prefix}SubcategoryId${idx}`) || "",
    businessName,
    logoDataUri: fileToDataUri(body.files[`${prefix}Logo${idx}`], MAX_UPLOAD_BYTES),
    galleryPhotos,
    description: clip(body.get(`${prefix}Description${idx}`), 500),
    dealText: clip(body.get(`${prefix}DealText${idx}`), 200),
    yearsInField: body.get(`${prefix}YearsInField${idx}`) || "",
    dealCode: generateCouponCode(),
    offersOnline: body.get(`${prefix}OffersOnline${idx}`) === "1",
    offersHomeVisit: body.get(`${prefix}OffersHomeVisit${idx}`) === "1",
    portfolioUrl: (body.get(`${prefix}PortfolioUrl${idx}`) || "").trim(),
    tier: body.get(`${prefix}Tier${idx}`) === "premium" ? "premium" : "basic",
    isAdvertised: false, adPaymentStatus: "none",
    status: "pending", createdAt: new Date().toISOString(),
  };
}
// Updates an existing additional listing in place from a resubmitted extraListingFormBlock
// (called with idx="" so field names match, e.g. "editListing5BusinessName") - keeps her
// existing logo/gallery/id/dealCode/status if she didn't touch those fields, same "only
// replace what she actually re-uploaded" pattern as the main profile update above. Editing
// does NOT reset status back to pending, matching how editing her main profile already works.
function applyExtraListingUpdate(d, body, prefix, listing) {
  const businessName = (body.get(`${prefix}BusinessName`) || "").trim();
  if (businessName) listing.businessName = businessName;
  const categoryId = body.get(`${prefix}CategoryId`);
  if (categoryId) {
    listing.categoryId = categoryId;
    listing.subcategoryId = body.get(`${prefix}SubcategoryId`) || "";
  }
  const newLogo = fileToDataUri(body.files[`${prefix}Logo`], MAX_UPLOAD_BYTES);
  if (newLogo) listing.logoDataUri = newLogo;
  const newGallery = [`${prefix}Gallery1_`, `${prefix}Gallery2_`, `${prefix}Gallery3_`, `${prefix}Gallery4_`]
    .map((field) => fileToDataUri(body.files[field], MAX_UPLOAD_BYTES))
    .filter(Boolean);
  if (newGallery.length) listing.galleryPhotos = newGallery;
  listing.description = clip(body.get(`${prefix}Description`), 500);
  listing.dealText = clip(body.get(`${prefix}DealText`), 200);
  const yearsInField = body.get(`${prefix}YearsInField`);
  if (yearsInField) listing.yearsInField = yearsInField;
  listing.offersOnline = body.get(`${prefix}OffersOnline`) === "1";
  listing.offersHomeVisit = body.get(`${prefix}OffersHomeVisit`) === "1";
  listing.portfolioUrl = (body.get(`${prefix}PortfolioUrl`) || "").trim();
  listing.tier = body.get(`${prefix}Tier`) === "premium" ? "premium" : "basic";
}

// A freelancer who does a few different things can pick extra categories beyond her main
// one (additionalCategoryIds) - this returns the full list (primary first) and is the
// single place that knows about that, so search/filtering/display all stay consistent.
function allCategoryIds(f) {
  const extra = (f.additionalCategoryIds || []).filter((id) => id && id !== f.categoryId);
  return [f.categoryId, ...extra].filter(Boolean);
}
function freelancerMatchesCategory(f, categoryId) {
  if (!categoryId) return true;
  return allCategoryIds(f).includes(categoryId);
}
// Names of any extra categories beyond the primary one, for a small "+ also does X, Y" note.
function additionalCategoryNames(d, f) {
  return (f.additionalCategoryIds || []).filter((id) => id && id !== f.categoryId).map((id) => catName(d, id));
}
// Checkbox list for a freelancer who does more than one thing to pick extra categories
// beyond her main one - a scrollable list rather than a second dropdown, since she may
// want to check several at once.
function categoryCheckboxList(d, selectedIds) {
  const sel = new Set(selectedIds || []);
  return `<div style="max-height:160px;overflow-y:auto;border:1px solid #ddd3c4;border-radius:8px;padding:10px;">
    ${d.categories.map((c) => `<label style="display:flex;align-items:center;gap:8px;font-weight:500;margin:4px 0;"><input type="checkbox" name="additionalCategoryIds" value="${c.id}" ${sel.has(c.id) ? "checked" : ""} style="width:auto;" /> ${esc(c.name)}</label>`).join("")}
  </div>`;
}
// Checkbox list of a CHOSEN category's own subcategories, so a freelancer can mark several at
// once instead of picking just one (נוסף 2026-08-27, לפי בקשה מפורשת) - same visual pattern as
// categoryCheckboxList above. Server-rendered for the initial page load (a normal /join or
// /freelancer-dashboard GET, or a POST-validation retry that already had a category chosen);
// scUpdateSubcatCheckboxes (see layout.js) takes over from there and rebuilds this same markup
// client-side whenever she changes the category dropdown, without a page reload. Kept
// completely separate from the single-value <select> that scUpdateSubcats still drives for
// the other, still-single-choice forms (arena question, service requests) - those are
// unaffected by this feature.
function subcategoryCheckboxesHtml(d, categoryId, selectedIds) {
  if (!categoryId || categoryId === "__other__") return `<p class="muted" style="margin:0;font-size:13px;">בחרי קודם תחום למעלה</p>`;
  const subs = subcategoriesOf(d, categoryId);
  if (!subs.length) return `<p class="muted" style="margin:0;font-size:13px;">אין תת-תחומים לתחום הזה כרגע</p>`;
  const sel = new Set(selectedIds || []);
  return subs.map((s) => `<label style="display:flex;align-items:center;gap:8px;font-weight:500;margin:4px 0;"><input type="checkbox" name="subcategoryId" value="${s.id}" ${sel.has(s.id) ? "checked" : ""} style="width:auto;" /> ${esc(s.name)}</label>`).join("");
}

// A "[icon] text" row that always keeps the icon visually first (rightmost) in RTL,
// regardless of whether the emoji itself carries RTL/LTR/neutral bidi metadata - plain
// "icon + text" inside one RTL text node can flip the icon to the wrong side depending on
// the specific emoji, so this uses flex layout (which orders by DOM order, not bidi rules)
// instead of relying on character-level text direction.
function detailLine(icon, html, extraStyle = "") {
  return `<div style="display:flex;align-items:flex-start;gap:6px;justify-content:center;max-width:100%;${extraStyle}"><span style="flex-shrink:0;">${icon}</span><span style="flex:1;min-width:0;overflow-wrap:break-word;word-break:break-word;">${html}</span></div>`;
}

// Fixed-size deal badge for grid cards (used by both freelancerCard and
// additionalListingCard) - replaces the previous variable-length deal text so every card in
// a row stays the same height regardless of how long any one freelancer's real deal text is.
// The real deal text is stashed in a data-deal attribute and revealed in a small floating
// tooltip on hover/tap by scSetupDealBadges() in layout.js's client script (a JS-positioned
// tooltip, not a CSS-only one, so it isn't clipped by .card's own overflow:hidden). Admin can
// optionally show her site logo next to the label via settings.showLogoOnDealBadge.
function dealBadgeHtml(d, dealText) {
  const logoImg = (d.settings.showLogoOnDealBadge && d.settings.siteLogoDataUri)
    ? `<img src="${d.settings.siteLogoDataUri}" alt="" class="card-deal-badge-logo" />`
    : "";
  return `<div class="card-deal card-deal-badge" tabindex="0" data-deal="${esc(dealText || "הטבה בלעדית")}"><span style="flex-shrink:0;">🎁</span><span>הטבת SheCan</span>${logoImg}</div>`;
}

// Converts a local Israeli phone number into the digits-only international format
// wa.me links expect (e.g. "050-123-4567" -> "972501234567").
function waPhoneDigits(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  if (digits.startsWith("972")) return digits;
  return digits;
}

// f.instagram was always a free-text field (she can type a full profile URL, an @handle, or
// just a bare handle) but was only ever rendered as plain, non-clickable text - and a long
// pasted URL (e.g. "https://www.instagram.com/name?igsi=...") would visibly overflow past the
// profile card's edge since there was nothing to shorten or wrap it. This extracts just the
// handle regardless of what she typed, and returns both a clean https://instagram.com/<handle>
// link AND a short "@handle" display label - fixing the overflow and making the link actually
// clickable in one change, since the profile card only ever displayed the raw stored text.
function instagramHandleAndUrl(raw) {
  const val = (raw || "").trim();
  if (!val) return null;
  const m = /instagram\.com\/([^/?#\s]+)/i.exec(val);
  let handle = (m ? m[1] : val).replace(/^@/, "").trim();
  if (!handle) return null;
  return { handle, url: `https://www.instagram.com/${encodeURIComponent(handle)}` };
}
function instagramLinkHtml(raw) {
  const ig = instagramHandleAndUrl(raw);
  if (!ig) return "";
  return `<div class="profile-detail-row"><span class="profile-detail-icon">📸</span><a href="${esc(ig.url)}" target="_blank" rel="noopener">@${esc(ig.handle)}</a></div>`;
}

// A small, purely decorative icon per category name - falls back to a generic sparkle
// for any category she adds later that isn't in the list below.

// ---- Weekly-rotation clock (weekly tip + inspiration story) -----------------------------
// Both the homepage "weekly tip" and the "story of the week" rotate through an ordered queue
// on a fixed real-world schedule (Israel local time): the tip turns over every Sunday 08:00,
// the story every Wednesday 20:00. An admin can manually pin a specific pick, but that pin
// only holds for ONE cycle - once the next scheduled boundary passes, it's cleared
// automatically and the automatic queue resumes exactly where it left off (the freelancer/
// story whose turn was "paused" by the manual pin gets shown next, nobody's turn is skipped).
//
// No external date library is used (the app is zero-dependency) - Node's built-in Intl (with
// full ICU) reads real Israel local time including DST, which plain UTC math can't do
// reliably for a fixed wall-clock schedule like "Sunday 08:00".

const WEEKLY_TIP_BOUNDARY = { weekday: 0, hour: 8 }; // Sunday 08:00 Israel time
const STORY_BOUNDARY = { weekday: 3, hour: 20 }; // Wednesday 20:00 Israel time

// Converts an Israel-local wall-clock date/time into the UTC timestamp (ms) it corresponds
// to, correctly accounting for DST. Works by guessing a UTC ms, reading back what that guess
// actually looks like in Israel local time via Intl, and nudging the guess by the difference
// - this converges in at most 2-3 iterations since the only possible error is the DST offset.
function israelLocalToUtc(year, month, day, hour, minute) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const wantMs = Date.UTC(year, month, day, hour, minute);
  let guess = Date.UTC(year, month, day, hour - 3, minute); // start assuming Israel Daylight Time (UTC+3)
  for (let i = 0; i < 4; i++) {
    const parts = fmt.formatToParts(guess);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const gotHour = get("hour") === 24 ? 0 : get("hour");
    const gotMs = Date.UTC(get("year"), get("month") - 1, get("day"), gotHour, get("minute"));
    const diff = wantMs - gotMs;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

// Returns the Israel-local calendar-day key ("YYYY-MM-DD") for a given moment - used everywhere
// "day" is bucketed (site visits, daily signups, the exact-numbers table in "מגמות יומיות", the
// backup-file date stamp) so a day rolls over at Israel midnight, correctly adjusted for DST,
// instead of at UTC midnight - which used to roll over at 2am/3am Israel time depending on the
// season. Per explicit request 2026-08-30: "day" should mean an actual Israel calendar day
// everywhere, like a normal calendar, not a UTC one. `en-CA` is just a locale that happens to
// format dates as YYYY-MM-DD - nothing Canada-specific about the date itself.
const ISRAEL_DATE_KEY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" });
function israelDateKey(date) {
  return ISRAEL_DATE_KEY_FMT.format(date instanceof Date ? date : new Date(date));
}

// Today's Israel-local calendar date, as {year, month (1-12), day} - a single Intl query that
// israelDayKeyOffset (below) then does plain UTC day-arithmetic from, instead of re-querying
// Intl for every day in a loop (e.g. building 30 day-keys for the "מגמות יומיות" 30-day view).
// This is safe because Israel's UTC offset is always positive (+2 or +3) - so Date.UTC(y, m-1,
// d) for any Israel calendar day Y-M-D always falls a few hours INTO that same Israel day, and
// reading it back as an ISO date trivially returns the same Y-M-D with no further conversion.
function israelTodayParts() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}
// "YYYY-MM-DD" key for today's Israel-local date minus `daysAgo` days (0 = today itself).
function israelDayKeyOffset(daysAgo) {
  const { year, month, day } = israelTodayParts();
  return new Date(Date.UTC(year, month - 1, day - daysAgo)).toISOString().slice(0, 10);
}

// Given a known-correct boundary (matching weekday+hour in Israel time), returns the next
// one exactly `days` Israel-calendar-days later (default 7) - stepping in local calendar days
// (not raw ms) so a DST shift that happens to fall inside that span is absorbed correctly.
// Note: `weekday` is accepted for symmetry with the other boundary helpers but isn't used
// here - if `days` isn't a multiple of 7 (e.g. an admin-configured story rotation), the
// boundary will naturally drift off its original weekday over time, which is expected.
function nextIsraelBoundary(boundaryUtc, weekday, hour, days = 7) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(boundaryUtc);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const nextDay = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + days));
  return israelLocalToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth(), nextDay.getUTCDate(), hour, 0);
}

// The most recent boundary at or before `beforeMs` - used once, to initialize the clock the
// very first time this ever runs (so it doesn't take a full week to "start ticking").
function mostRecentIsraelBoundary(beforeMs, weekday, hour) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(beforeMs);
  const get = (t) => parts.find((p) => p.type === t).value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const y = Number(get("year")), mo = Number(get("month")) - 1, da = Number(get("day"));
  const daysBack = (wdMap[get("weekday")] - weekday + 7) % 7;
  const candidateDay = new Date(Date.UTC(y, mo, da - daysBack));
  let candUtc = israelLocalToUtc(candidateDay.getUTCFullYear(), candidateDay.getUTCMonth(), candidateDay.getUTCDate(), hour, 0);
  if (candUtc > beforeMs) {
    const earlier = new Date(candidateDay.getTime() - 7 * 24 * 60 * 60 * 1000);
    candUtc = israelLocalToUtc(earlier.getUTCFullYear(), earlier.getUTCMonth(), earlier.getUTCDate(), hour, 0);
  }
  return candUtc;
}

// Generic rotation clock shared by the weekly tip and the story-of-the-week. `queue` is the
// ordered list of eligible items (already sorted); `getId` extracts a stable id from an item.
// `keys` names the three settings fields used to persist state: currentIdKey (whose turn it
// automatically is right now), lastBoundaryKey (timestamp of the last processed boundary),
// manualIdKey (the admin's one-cycle pin, if any). Returns the id that's automatically "due"
// right now (the caller still checks manualIdKey itself to decide whether the pin overrides
// it for display - tickRotation's job is only to advance the clock and expire stale pins).
// `onAdvance(id)` (optional) fires every time the automatic pointer actually moves to a new
// item - used by getCurrentStory to mark EVERY story the pointer passes through as "already
// featured", not just whichever one is current right now. That matters if nobody visits the
// site for more than one full rotation window (e.g. a short admin-configured rotation on a
// quiet period) - without this, a story the queue passed through in the meantime, with nobody
// around to observe it as "current", would never get marked and would wrongly stay missing
// from the "previous stories" archive forever.
function tickRotation(d, queue, getId, boundary, keys, onAdvance) {
  if (!queue.length) return null;
  const now = Date.now();
  let changed = false;
  if (!d.settings[keys.lastBoundaryKey]) {
    d.settings[keys.lastBoundaryKey] = mostRecentIsraelBoundary(now, boundary.weekday, boundary.hour);
    changed = true;
  }
  if (!d.settings[keys.currentIdKey] || !queue.some((it) => getId(it) === d.settings[keys.currentIdKey])) {
    d.settings[keys.currentIdKey] = getId(queue[0]);
    changed = true;
  }
  let cursor = d.settings[keys.lastBoundaryKey];
  let next = nextIsraelBoundary(cursor, boundary.weekday, boundary.hour, boundary.days);
  while (next <= now) {
    if (d.settings[keys.manualIdKey]) {
      // The manual pin just used up its one cycle - clear it, but do NOT advance the
      // automatic pointer, so whoever was "waiting" is next once the pin is gone.
      d.settings[keys.manualIdKey] = null;
    } else {
      const idx = queue.findIndex((it) => getId(it) === d.settings[keys.currentIdKey]);
      d.settings[keys.currentIdKey] = getId(queue[(Math.max(idx, 0) + 1) % queue.length]);
      if (onAdvance) onAdvance(d.settings[keys.currentIdKey]);
    }
    cursor = next;
    next = nextIsraelBoundary(cursor, boundary.weekday, boundary.hour, boundary.days);
    changed = true;
  }
  if (cursor !== d.settings[keys.lastBoundaryKey]) d.settings[keys.lastBoundaryKey] = cursor;
  if (changed) db.save();
  return d.settings[keys.currentIdKey];
}

// Picks the text shown in the homepage "weekly tip" panel. An admin-picked freelancer
// (settings.freelancerOfWeekId) wins for one cycle if set (see tickRotation above).
// Otherwise, freelancers who filled in their own inspiration quote are rotated through
// automatically, in the order they registered, turning over every Sunday 08:00 Israel time.
// The freelancer whose turn actually comes up gets marked weeklyTipPublished so her dashboard
// can lock further edits to that quote (she can still freely edit it right up until then).
function getWeeklyFeature(d) {
  const withQuotes = d.freelancers
    .filter((f) => f.status === "approved" && f.active !== false && (f.inspirationQuote || "").trim())
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  // tickRotation still runs unconditionally, exactly as before the referral-winner override
  // below existed - it keeps its own internal automatic-rotation state (currentIdKey/
  // lastBoundaryKey) correctly advancing in the background even while the override is showing
  // instead of the auto pick, the same way it already tolerates nobody visiting for a while
  // (see the comment above tickRotation) - so the automatic queue is never surprised or thrown
  // off once the override eventually expires.
  const autoId = tickRotation(d, withQuotes, (f) => f.id, WEEKLY_TIP_BOUNDARY, {
    currentIdKey: "weeklyTipCurrentFreelancerId", lastBoundaryKey: "weeklyTipLastBoundary", manualIdKey: "freelancerOfWeekId",
  });
  // "זכיית מרוץ ההפניות" - פרס אמיתי של חשיפה בדף הבית למשך פרק זמן שהיא קובעת (למשל חודש
  // שלם), לא רק מחזור שבועי אחד כמו הפין הידני freelancerOfWeekId למטה - לפי בקשה מפורשת
  // 2026-08-30 ("רוצה שההבטחה בפועל תתקיים בלי מאמץ נוסף ממך"). עדיפות עליונה על הפין הרגיל
  // ועל הרוטציה האוטומטית, כל עוד freelancerReferralWinnerUntil (תאריך "YYYY-MM-DD", לפי
  // israelDayKeyOffset) עדיין היום או בעתיד - נבדק בכל טעינה, בלי צורך "לנקות" אותו בעצמה
  // כשהוא פג: הוא פשוט מפסיק להתאים מעצמו וחוזרים לפין הרגיל/לרוטציה האוטומטית.
  if (d.settings.freelancerReferralWinnerId && d.settings.freelancerReferralWinnerUntil && israelDayKeyOffset(0) <= d.settings.freelancerReferralWinnerUntil) {
    const winner = d.freelancers.find((x) => x.id === d.settings.freelancerReferralWinnerId && x.status === "approved" && x.active !== false);
    if (winner) {
      if ((winner.inspirationQuote || "").trim() && !winner.weeklyTipPublished) { winner.weeklyTipPublished = true; db.save(); }
      return { text: winner.inspirationQuote || d.settings.weeklyMessage, freelancer: winner, isReferralWinner: true };
    }
  }
  if (d.settings.freelancerOfWeekId) {
    const picked = d.freelancers.find((x) => x.id === d.settings.freelancerOfWeekId && x.status === "approved" && x.active !== false);
    if (picked) {
      // Her own quote (if she has one) is now genuinely live on the homepage too, via the
      // manual pin - lock it from further edits just like the automatic path does below.
      if ((picked.inspirationQuote || "").trim() && !picked.weeklyTipPublished) { picked.weeklyTipPublished = true; db.save(); }
      return { text: picked.inspirationQuote || d.settings.weeklyMessage, freelancer: picked };
    }
  }
  if (!withQuotes.length) return { text: d.settings.weeklyMessage, freelancer: null };
  const chosen = withQuotes.find((f) => f.id === autoId) || withQuotes[0];
  if (!chosen.weeklyTipPublished) { chosen.weeklyTipPublished = true; db.save(); }
  return { text: chosen.inspirationQuote, freelancer: chosen };
}

// Picks which approved story is "currently featured" on the /stories page - same one-cycle
// admin pin + auto-advancing queue mechanic as getWeeklyFeature, turning over every
// `storyRotationDays` days (default 7, admin-editable in the panel) at 20:00 Israel time,
// ordered by when each story itself was APPROVED (not by when the linked freelancer
// registered - that was the original behavior, but per explicit request 2026-09-01 it made
// the rotation feel "out of order": a freelancer who joined the site early could jump ahead
// of someone whose story was actually approved earlier, just because her own account was
// older. Falls back to createdAt for the rare case approvedAt is somehow missing. Note: this
// changes the sort order of an existing queue, so right after this ships, whichever story was
// "current"/"next" can shift once as everything re-settles into approval order - that's a
// one-time side effect of fixing the ordering, not a bug.
function getCurrentStory(d) {
  const approved = (d.stories || []).filter((s) => s.status === "approved");
  if (!approved.length) return null;
  const sorted = approved.slice().sort((a, b) => new Date(a.approvedAt || a.createdAt) - new Date(b.approvedAt || b.createdAt));
  // NOTE (2026-08-23): this used to pass a 4th "onAdvance" callback to tickRotation that
  // stamped featuredAt on EVERY story the automatic pointer passed through during a catch-up
  // (e.g. nobody visiting the site for more than one full rotation window, or the rotation
  // frequency being lowered so several windows suddenly fall in the past at once) - not just
  // the one story actually being shown right now. That turned out to be too eager: right after
  // storyRotationDays became admin-editable, a burst catch-up could stamp several stories as
  // "already featured" in one shot, even though only the very last one was ever actually shown
  // as the current story on the page. Removed so a story's featuredAt is ONLY ever set at the
  // exact moment it's genuinely returned as `result` below (a real "previous stories" entry
  // now always means it was truly, at some point, the story shown on the page) - see the
  // one-time backfill comment further down for the same reasoning applied retroactively.
  const autoId = tickRotation(d, sorted, (s) => s.id, {
    weekday: STORY_BOUNDARY.weekday, hour: STORY_BOUNDARY.hour, days: d.settings.storyRotationDays || 7,
  }, {
    currentIdKey: "currentStoryId", lastBoundaryKey: "storyLastBoundary", manualIdKey: "storyOfWeekId",
  });

  let result = null;
  if (d.settings.storyOfWeekId) {
    const picked = approved.find((s) => s.id === d.settings.storyOfWeekId);
    if (picked) result = picked;
  }
  if (!result) result = sorted.find((s) => s.id === autoId) || sorted[0];
  if (result && !result.featuredAt) {
    result.featuredAt = new Date().toISOString();
    db.save();
  }
  return result;
}

// The exact date+time the story rotation will next turn over (whether that lands on the
// automatic queue advancing, or on a manual admin pin's one cycle expiring - tickRotation
// treats both the same way, so this is correct either way). Calls getCurrentStory(d) first
// purely for its side effect of running tickRotation, which lazily initializes/advances
// settings.storyLastBoundary the first time it's ever needed - so this stays correct even
// before any story has ever been picked yet. Used to show a small "next update" hint at the
// bottom of a story page. Always reflects the CURRENT value of settings.storyRotationDays, so
// changing it in the admin panel updates this label immediately (going forward only - it never
// moves backward in time).
// Per explicit request 2026-09-01 (after "אמור היה להתחלף ב-1.9 ולא התחלף" turned out to
// simply mean "not before 20:00 Israel time yet", since the label used to show only the date)
// - this now ALWAYS shows the exact date AND time, formatted explicitly in Israel time (not
// the server's own timezone, which on Render is UTC - a bare toLocaleDateString/toLocaleString
// call with no timeZone option would silently use that instead and could even show the wrong
// calendar day). The switch day itself can land on any weekday when storyRotationDays isn't a
// multiple of 7 (explicitly confirmed as fine, "רק תציגו לי תמיד תאריך+שעה מדויקים") - so no
// attempt is made to keep it anchored to a fixed weekday.
const STORY_ROTATION_LABEL_FMT = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
});
function nextStoryRotationLabel(d) {
  getCurrentStory(d);
  if (!d.settings.storyLastBoundary) return null;
  const days = d.settings.storyRotationDays || 7;
  const next = nextIsraelBoundary(d.settings.storyLastBoundary, STORY_BOUNDARY.weekday, STORY_BOUNDARY.hour, days);
  return STORY_ROTATION_LABEL_FMT.format(next);
}

function initials(name) { return (name || "?").trim().charAt(0).toUpperCase(); }

// Coupon codes look like SheCan1234 - a random 4-digit number so they're not sequential
// or guessable, checked against existing codes so two freelancers never get the same one.
function generateCouponCode() {
  const d = db.load();
  const existing = new Set(d.freelancers.map((f) => f.dealCode).filter(Boolean));
  d.freelancers.forEach((f) => (f.additionalListings || []).forEach((l) => l.dealCode && existing.add(l.dealCode)));
  let code;
  do {
    code = "SheCan" + Math.floor(1000 + Math.random() * 9000);
  } while (existing.has(code));
  return code;
}

// d (optional) - when given, falls back to d.settings.defaultBusinessLogoDataUri when the
// freelancer has neither her own photo nor her own logo (see cardPhotoHtml above for the same
// fallback used on the grid cards). Left optional (rather than required) so the handful of
// call sites that intentionally want "did SHE upload anything at all" (e.g. her own dashboard
// edit-preview) can keep calling avatarUri(f) with no default applied.
function avatarUri(f, d) { return f.photoDataUri || f.logoDataUri || (d && d.settings.defaultBusinessLogoDataUri) || null; }

function photoOrInitials(photoDataUri, name, cssClass) {
  if (photoDataUri) return `<div class="${cssClass}" style="background-image:url('${photoDataUri}');background-size:cover;background-position:center;"></div>`;
  return `<div class="${cssClass}">${initials(name)}</div>`;
}

// Same as photoOrInitials, but clicking the photo opens it larger in a lightbox (used on
// the freelancer's own profile page - her hero photo and gallery shots). HTML-escaping the
// data URI in the attribute is safe: the browser decodes entities back to the original
// string when JS reads it via getAttribute, so the image itself is unaffected.
// galleryList (optional) is the full array of sibling image sources - when given, the
// lightbox gets prev/next arrows so she can scroll through the whole gallery without
// closing and reopening it each time.
function zoomableImage(photoDataUri, name, cssClass, galleryList) {
  if (!photoDataUri) return `<div class="${cssClass}">${initials(name)}</div>`;
  const safe = esc(photoDataUri);
  const galleryAttr = (galleryList && galleryList.length > 1) ? ` data-gallery="${esc(JSON.stringify(galleryList))}"` : "";
  const onclickCall = (galleryList && galleryList.length > 1)
    ? `scOpenLightbox(this.getAttribute('data-src'), JSON.parse(this.getAttribute('data-gallery')))`
    : `scOpenLightbox(this.getAttribute('data-src'))`;
  return `<div class="${cssClass} sc-zoomable" style="background-image:url(${safe});background-size:cover;background-position:center;" data-src="${safe}"${galleryAttr} onclick="${onclickCall}" title="להגדלה"></div>`;
}

function freelancerCard(f, d, opts = {}) {
  // Only badges that still make sense on the compact grid card - the delivery-method and
  // whatsapp badges moved to live below the contact details on the full profile page
  // instead, and the "מודעה" tag only shows on the dedicated sidebar ad card now, never
  // on the regular grid card, per the redesign request.
  const badges = [];
  if (f.availableNow) badges.push(`<span class="badge badge-available">🟢 זמינה כרגע</span>`);
  if (f.isLeadingBusiness) badges.push(`<span class="badge badge-leading">👑 עסק מוביל</span>`);
  if (f.tier === "premium") badges.push(`<span class="badge">מומלצת</span>`);
  const cardClass = "card" + (f.isLeadingBusiness ? " card-leading" : "") + (f.isAdvertised ? " card-ad" : "");
  // Search by name should match either her business name or her own personal name, not
  // just whichever one happens to be shown - a customer typing the freelancer's own name
  // (rather than the business name) was getting zero matches before this fix.
  const nameForSearch = esc(`${f.businessName || ""} ${f.name || ""}`.trim().toLowerCase());
  // Also folds in her subcategory (e.g. "עיצוב שיער" under the broader "יופי וטיפוח") and her
  // own free-text bio, so the instant-as-you-type filter (scLiveFilter, see layout.js) matches
  // the exact same things as a full /search submit - per explicit request, after "שיער" found
  // nothing even though hair-focused freelancers were on the site under a category name that
  // doesn't contain that word.
  const categoryForSearch = esc(`${catName(d, f.categoryId)} ${subcatNames(d, f.categoryId, f.subcategoryIds)} ${f.description || ""}`.toLowerCase());
  const extraCats = additionalCategoryNames(d, f);
  // If her inspiration story happens to be this week's featured story on SheCan Stories, she
  // gets a small badge overlaid on her card, linking to it. This used to be rendered as a
  // sibling <a> wrapped together with the card in an extra <div> (to avoid illegally nesting
  // an <a> inside another <a>) - but that extra wrapper div became its OWN separate grid cell
  // inside the CSS Grid results list (since every direct child of .grid is auto-placed into
  // its own cell), so the badge showed up floating in its own empty tile instead of overlaid
  // on her actual card. Fixed by keeping everything inside the single .card <a> (one grid
  // item, like every other card) and using a <span> with a click handler instead of a nested
  // <a>, so it stays valid HTML while still navigating to the story on click.
  const currentStory = getCurrentStory(d);
  const featuredStoryBadge = (currentStory && currentStory.freelancerId === f.id)
    ? `<span class="badge badge-leading" style="position:absolute;top:10px;left:10px;z-index:2;cursor:pointer;" onclick="event.preventDefault();event.stopPropagation();location.href='/stories/${currentStory.id}';" role="link" tabindex="0">📖 הסיפור שלה מככב השבוע</span>`
    : "";
  const reviewCount = reviewCountFor(d, f.id);
  const catNameStr = catName(d, f.categoryId);
  const cardFieldLabel = subcatNames(d, f.categoryId, f.subcategoryIds) || catNameStr;
  const cardLocation = locationLabel(d, f.cityId, f.offersOnline, f.offersHomeVisit) + (extraCats.length ? ` · גם ב${extraCats.join(", ")}` : "");
  const cardLocationIcon = locationIcon(d, f.cityId, f.offersOnline, f.offersHomeVisit);
  // Redesigned card body (per explicit request): business name stays as-is, category sits
  // directly under it with no icon, then a thin divider in the name's own text color, then
  // location + years-in-field - that whole top block has a fixed min-height (.card-top) so
  // the location/years line starts on the same straight line across a row of cards,
  // regardless of how long any one card's name/category text is. Review count/description/
  // deal/view-btn keep their previous behavior (hidden by default, revealed by the /search
  // view-mode toggle via the [data-view] CSS rules) - only location/years moved out of that
  // gated block since they're now part of the base card look.
  const cardHtml = `
  <a class="${cardClass}" href="/freelancer/${f.id}" data-name="${nameForSearch}" data-category="${categoryForSearch}" data-home-visit="${f.offersHomeVisit ? "1" : "0"}" style="${featuredStoryBadge ? "position:relative;" : ""}">
    ${featuredStoryBadge}
    ${cardPhotoHtml(f.photoDataUri, f.logoDataUri, f.businessName || f.name, "card-photo", d.settings.defaultBusinessLogoDataUri)}
    <div class="card-body">
      <div class="card-top">
        <h3 class="card-name">${esc(f.businessName || f.name)}</h3>
        <div class="card-category">${esc(cardFieldLabel)}</div>
        <div class="card-name-divider"></div>
      </div>
      <div class="card-meta-block">
        ${cardLocation ? `<div class="card-meta-row">${cardLocationIcon} ${esc(cardLocation)}</div>` : ""}
        ${f.yearsInField ? `<div class="card-meta-row">🌱 ${esc(yearsInFieldShortLabel(f.yearsInField))}</div>` : ""}
      </div>
      ${badges.length ? `<div class="card-badges">${badges.join(" ")}</div>` : ""}
      <div class="card-info">
        ${d.settings.showProfileViewCount ? `<p class="card-reviewcount">👁️ ${f.viewCount || 0} צפיות</p>` : ""}
        ${reviewCount > 5 ? `<p class="card-reviewcount">⭐ ${reviewCount} דירוגים</p>` : ""}
        ${f.description ? `<div class="card-desc">${detailLine("📝", esc(f.description), "justify-content:center;")}</div>` : ""}
        ${dealBadgeHtml(d, f.dealText)}
        <span class="btn btn-small card-view-btn">לצפייה בפרופיל</span>
      </div>
    </div>
  </a>`;
  return cardHtml;
}

// A freelancer's additional listing (a second/third line of work she registered
// separately, e.g. also does balloons) renders as its own card in the grid, just like a
// regular freelancer card - it links to its own detail page, but contact info (phone,
// whatsapp, email, city) is shared from the parent freelancer record since that's the
// same real person underneath.
function additionalListingCard(f, listing, d) {
  const catNameStr = catName(d, listing.categoryId);
  const badges = [];
  if (listing.tier === "premium") badges.push(`<span class="badge">מומלצת</span>`);
  const nameForSearch = esc((listing.businessName || "").trim().toLowerCase());
  // Same subcategory + bio-text widening as the main freelancer card above, for this listing.
  const categoryForSearch = esc(`${catNameStr} ${subcatName(d, listing.categoryId, listing.subcategoryId)} ${listing.description || ""}`.toLowerCase());
  const cardClass = "card" + (listing.isAdvertised ? " card-ad" : "");
  const reviewCount = reviewCountFor(d, f.id, listing.id);
  const listingFieldLabel = subcatName(d, listing.categoryId, listing.subcategoryId) || catNameStr;
  const listingLocation = locationLabel(d, f.cityId, listing.offersOnline, listing.offersHomeVisit);
  const listingLocationIcon = locationIcon(d, f.cityId, listing.offersOnline, listing.offersHomeVisit);
  return `
  <a class="${cardClass}" href="/freelancer/${f.id}/listing/${listing.id}" data-name="${nameForSearch}" data-category="${categoryForSearch}" data-home-visit="${listing.offersHomeVisit ? "1" : "0"}">
    ${cardPhotoHtml(null, listing.logoDataUri, listing.businessName, "card-photo", d.settings.defaultBusinessLogoDataUri)}
    <div class="card-body">
      <div class="card-top">
        <h3 class="card-name">${esc(listing.businessName)}</h3>
        <div class="card-category">${esc(listingFieldLabel)}</div>
        <div class="card-name-divider"></div>
      </div>
      <div class="card-meta-block">
        ${listingLocation ? `<div class="card-meta-row">${listingLocationIcon} ${esc(listingLocation)}</div>` : ""}
        ${listing.yearsInField ? `<div class="card-meta-row">🌱 ${esc(yearsInFieldShortLabel(listing.yearsInField))}</div>` : ""}
      </div>
      ${badges.length ? `<div class="card-badges">${badges.join(" ")}</div>` : ""}
      <div class="card-info">
        ${reviewCount > 5 ? `<p class="card-reviewcount">⭐ ${reviewCount} דירוגים</p>` : ""}
        ${listing.description ? `<div class="card-desc">${detailLine("📝", esc(listing.description), "justify-content:center;")}</div>` : ""}
        ${dealBadgeHtml(d, listing.dealText)}
        <span class="btn btn-small card-view-btn">לצפייה בפרופיל</span>
      </div>
    </div>
  </a>`;
}

// Sponsor/ad sidebar rendering now lives in layout.js's page() template, so every page on
// the site gets the same shared sidebar slots automatically (see item 13/24 of the batch).

function starRow(n) {
  n = Math.max(1, Math.min(5, Number(n) || 5));
  return `<span class="stars">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
}

// Clickable 5-star input (replaces a plain "rate 1-5" number field) - renders as a row of
// star spans plus a hidden "rating" input that scInitStarInputs() (in layout.js's client
// script) keeps in sync as she clicks. Falls back to a plain filled row if JS never runs,
// since the hidden input already carries a sensible default value.
function starInputHtml(current) {
  const val = Math.min(5, Math.max(1, Math.round(Number(current) || 5)));
  return `<div class="sc-star-input">
    ${[1, 2, 3, 4, 5].map((n) => `<span class="sc-star${n <= val ? " sc-star-filled" : ""}" data-v="${n}">${n <= val ? "★" : "☆"}</span>`).join("")}
    <input type="hidden" name="rating" value="${val}" />
  </div>`;
}

// A favorite is keyed by freelancer id alone for her main listing, or "freelancerId:listingId"
// for one of her additional listings - so favoriting "hair styling by Roni" and "makeup by
// Roni" (same underlying freelancer) show up and toggle as two fully independent favorites,
// each linking to its own page, instead of being conflated into one.
function favKey(freelancerId, listingId) {
  return listingId ? `${freelancerId}:${listingId}` : freelancerId;
}

// ---- Referral contest helpers (shared shape for the customer "bring a friend" race and the
// freelancer "bring a business" race - see /signup, /account, /join, /freelancer-dashboard) ----

// Counts how many records in `list` have `refField` pointing at each referrer id, e.g.
// referralCounts(d.customers, "referredByCustomerId") -> { "3": 2, "7": 1 }.
function referralCounts(list, refField) {
  const counts = {};
  list.forEach((item) => {
    const ref = item[refField];
    if (ref) counts[ref] = (counts[ref] || 0) + 1;
  });
  return counts;
}

// A one-line "who's leading and by how much" callout above an admin referral-ranking table
// (see freelancerReferralRanking/customerReferralRanking in /admin) - per explicit request
// 2026-08-30. `ranking` is already sorted highest-first and filtered to count > 0.
function leaderGapSummaryHtml(ranking, noun) {
  if (!ranking.length) return "";
  const leader = ranking[0];
  const second = ranking[1];
  const gap = second ? leader.count - second.count : leader.count;
  return `<p style="font-weight:800;color:var(--rose-dark);margin:0 0 12px;">👑 ${esc(leader.name)} מובילה כרגע עם ${leader.count} ${esc(noun)}${second ? ` - יתרון של ${gap} על המקום השני (${esc(second.name)}, ${second.count})` : " - עדיין אין מי שמתקרבת אליה"}!</p>`;
}

// Renders the personalized "your status in the race" panel shown to a logged-in customer
// (in /account) or freelancer (in /freelancer-dashboard) - same ranking/leaderboard logic for
// both, driven by small role-specific labels so the copy reads naturally in each context.
function referralStatusHtml(opts) {
  const { entities, refField, selfId, nameOf, firstNameOf, endDateLabel, noun, rivalNoun } = opts;
  const counts = referralCounts(entities, refField);
  const ranked = entities.map((e) => ({ id: e.id, name: nameOf(e), firstName: firstNameOf(e), count: counts[e.id] || 0 }))
    .sort((a, b) => b.count - a.count);
  const selfIdx = ranked.findIndex((r) => r.id === selfId);
  if (selfIdx === -1) return "";
  const self = ranked[selfIdx];
  const leader = ranked[0];
  const isLeader = selfIdx === 0 && self.count > 0;
  const top4 = ranked.slice(0, 4).filter((r) => r.count > 0);
  return `
  <div class="panel referral-status-panel">
    <h4 style="margin-top:0;">הסטטוס שלך בתחרות</h4>
    <p>עד כה נרשמו דרכך <strong>${self.count}</strong> ${esc(noun)}. את במקום ה-${selfIdx + 1} במירוץ!</p>
    ${top4.length ? `<div class="muted" style="font-size:13px;margin:8px 0;line-height:1.7;">
      ${top4.map((r, i) => `<div>${i + 1}. ${esc(r.name)} - ${r.count}${i === 0 ? " 👑" : ""}</div>`).join("")}
    </div>` : ""}
    ${isLeader
      ? `<p style="font-weight:800;color:var(--rose-dark);margin-bottom:4px;">את במקום הראשון! 🏆</p>
         <p class="muted">נרשמו דרכך כבר ${self.count} ${esc(noun)}, אבל המירוץ פתוח עד ה-${esc(endDateLabel)} ויש המון ${esc(rivalNoun)} שנלחמות על המקום שלך. המשיכי לשלוח את הקישור ואל תוותרי על המקום הזה!</p>`
      : leader.count > 0
      ? `<p class="muted">${esc(leader.name)} מובילה כרגע עם ${leader.count} ${esc(noun)}! ${esc(self.firstName)}, תצליחי לעקוף אותה עד ה-${esc(endDateLabel)}?</p>`
      : `<p class="muted">עדיין אין מי שהובילה - זו ההזדמנות שלך להיות הראשונה!</p>`}
  </div>`;
}

// Loose (trimmed, case-insensitive) match on businessName, for resolving the free-typed "who
// referred you" field on /join to an actual freelancer record.
function findFreelancerByBusinessNameLoose(d, name) {
  if (!name) return null;
  const norm = (s) => (s || "").trim().toLowerCase();
  const target = norm(name);
  if (!target) return null;
  return d.freelancers.find((x) => norm(x.businessName || x.name) === target) || null;
}

// A customer's display name on a public review - "first name in full + last letter of her
// surname" (e.g. "דנה ל.") rather than her full name, for privacy; if she checked "prefer to
// stay anonymous" when writing the review, a generic community-member label is shown instead
// and her real name never appears at all.
function reviewDisplayName(r) {
  if (r.isAnonymous) return "חברת קהילה שמעדיפה להישאר אנונימית 😊";
  const parts = (r.authorName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "לקוחה";
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1];
  return `${first} ${last.charAt(0)}.`;
}

// ---------- "הזירה" (Arena) helpers ----------
// Every approved freelancer whose MAIN profile, or ANY approved additional listing, matches
// the given category (and subcategory, if the asker picked one) - used to decide who gets
// notified by email when a new arena question is approved. When the question has a
// subcategory, a freelancer still counts as a match if either her subcategory is the exact
// same one, OR she never narrowed down to a subcategory at all (works the category broadly) -
// per explicit request, so a generalist in the field doesn't silently miss every subcategorized
// question just because she didn't pick one of her own. A freelancer with a DIFFERENT specific
// subcategory (e.g. manicure, when the question was tagged "bridal makeup") still doesn't match.
function freelancersForCategory(d, categoryId, subcategoryId) {
  const subMatches = (candidateSub) => !subcategoryId || !candidateSub || candidateSub === subcategoryId;
  const matchIds = new Set();
  d.freelancers.forEach((f) => {
    if (f.status !== "approved") return;
    // Her own subcategories (see f.subcategoryIds) can now be several at once - a match if
    // ANY of them fits, same "no subcategory at all = works it broadly" rule as before.
    if (f.categoryId === categoryId && freelancerSubcatMatchesBroad(f, subcategoryId)) matchIds.add(f.id);
    (f.additionalListings || []).forEach((l) => {
      if (l.status === "approved" && l.categoryId === categoryId && subMatches(l.subcategoryId)) matchIds.add(f.id);
    });
  });
  return d.freelancers.filter((f) => matchIds.has(f.id));
}

// A stable identity for "who is voting" on a poll - a logged-in customer votes under her
// account; anyone else (not logged in, including outside visitors who arrived via a shared
// poll link) votes under a long-lived anonymous cookie, generated the first time she votes so
// the same browser can't vote twice on the same poll. Returns { voterKey, newCookie } where
// newCookie is only set the first time an anonymous visitor votes.
function arenaVoterIdentity(req, ctx) {
  if (ctx.session && ctx.session.role === "customer") {
    return { voterKey: `customer:${ctx.session.id}`, newCookie: null };
  }
  const cookies = auth.parseCookies(req);
  if (cookies.scAnon) return { voterKey: `anon:${cookies.scAnon}`, newCookie: null };
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return { voterKey: `anon:${token}`, newCookie: `scAnon=${token}; Path=/; Max-Age=31536000` };
}

// Read-only lookup of the current visitor's voter key, WITHOUT generating a new cookie - used
// when just rendering a page (GET), so viewing a poll never has the side effect of minting an
// anonymous identity for someone who hasn't voted yet.
function arenaVoterKeyReadOnly(req, ctx) {
  if (ctx.session && ctx.session.role === "customer") return `customer:${ctx.session.id}`;
  const cookies = auth.parseCookies(req);
  return cookies.scAnon ? `anon:${cookies.scAnon}` : null;
}

// Same identity idea as arenaVoterIdentity/arenaVoterKeyReadOnly above, but for the "יש לך
// שאלה? 💬" support widget - reused here rather than duplicated, since it's the exact same
// need: a stable way to say "who is this" for a logged-in customer/freelancer OR an anonymous
// visitor, using the SAME long-lived scAnon cookie (so someone who already voted on a poll
// gets the same identity here too, from the same browser). Freelancers are included here
// (unlike the arena voter identity, which is customer-only) since a freelancer should be able
// to ask a question and find her own thread again just as easily as a customer can.
function supportIdentity(req, ctx) {
  if (ctx.session && (ctx.session.role === "customer" || ctx.session.role === "freelancer")) {
    return { key: `${ctx.session.role}:${ctx.session.id}`, newCookie: null };
  }
  const cookies = auth.parseCookies(req);
  if (cookies.scAnon) return { key: `anon:${cookies.scAnon}`, newCookie: null };
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return { key: `anon:${token}`, newCookie: `scAnon=${token}; Path=/; Max-Age=31536000` };
}

function supportKeyReadOnly(req, ctx) {
  if (ctx.session && (ctx.session.role === "customer" || ctx.session.role === "freelancer")) {
    return `${ctx.session.role}:${ctx.session.id}`;
  }
  const cookies = auth.parseCookies(req);
  return cookies.scAnon ? `anon:${cookies.scAnon}` : null;
}

// "מחוברת עכשיו" = both (a) Sapir explicitly turned the support service ON (d.settings.
// adminSupportOnline - see the toggle panel/popup in /admin and POST /admin/support/toggle,
// added per explicit request 2026-08-30 so she's only shown as online when she actually wants
// to be, not just because she happens to be on some admin page) AND (b) she's hit
// /admin/support/heartbeat (fired quietly in the background by every admin page, see the inline
// script in layout.js's page()) sometime in the last 90 seconds - so if she closes the tab/
// laptop without remembering to turn it off, she still stops showing as online after a short
// while. 90s (vs. e.g. 20s) gives a little slack for a slow tick or a brief tab-switch without
// flickering the asker's "🟢 online" banner off and back on.
function isAdminOnline(d) {
  if (!d.settings.adminSupportOnline) return false;
  const at = d.settings.adminSupportActiveAt;
  if (!at) return false;
  return Date.now() - new Date(at).getTime() < 90 * 1000;
}

// The support thread "id" used in admin URLs (/admin/support/thread/:key) is just the voterKey
// (e.g. "anon:abc123" or "customer:5") base64url-encoded - simpler and safer than trying to
// URL-encode/decode a colon-containing raw string through the router's path-param matching.
function encodeSupportKey(key) { return Buffer.from(String(key), "utf8").toString("base64url"); }
function decodeSupportKey(enc) { try { return Buffer.from(String(enc), "base64url").toString("utf8"); } catch { return ""; } }

// "לסגור את השיחה" (נוסף 2026-08-30, לפי בקשה מפורשת) - d.supportClosed הוא פשוט רשימת
// voterKey שסומנו כסגורים על ידה. זה נפרד לגמרי מ"המשך טיפול" (isSnoozed/d.adminSnoozed עם
// מפתח support:<voterKey>, ר' הפאנל הגנרי למעלה): "סגירה" אומרת "השיחה הזו נגמרה", "המשך
// טיפול" אומר "אני עוד אחזור לזה". שתיהן מוציאות את השיחה מ"ממתינה למענה" (openSupportMessages/
// התג בניווט/הוידג'ט הצף/תזכורת חצי השעה), אבל שיחה סגורה עדיין מופיעה בטבלת השיחות (מסומנת
// "🔒 סגורה") בעוד ששיחה במעקב נעלמת ממנה לגמרי (בדיוק כמו כל פריט אחר שהועבר להמשך טיפול).
function isSupportClosed(d, key) {
  return (d.supportClosed || []).includes(key);
}
// הודעה חדשה מהשואלת היא סימן חיים - "מפתיעה" אותה בחזרה לתור הרגיל גם אם היא הייתה סגורה וגם
// אם הייתה מסומנת "המשך טיפול", כדי שהודעה טרייה אף פעם לא תישאר קבורה מבלי שהיא תשים לב.
function reopenSupportThread(d, key) {
  if (d.supportClosed && d.supportClosed.includes(key)) {
    d.supportClosed = d.supportClosed.filter((k) => k !== key);
  }
  if (d.adminSnoozed && d.adminSnoozed.some((s) => s.key === `support:${key}`)) {
    d.adminSnoozed = d.adminSnoozed.filter((s) => s.key !== `support:${key}`);
  }
}
// תזכורת "עדיין לא ענית" אחרי חצי שעה בלי מענה (לפי בקשה מפורשת 2026-08-30). האתר לא מריץ
// תהליך רקע קבוע (אין setInterval בצד שרת בכל הקובץ) - הבדיקה הזו רצה בכל פינג-חי/טעינת עמוד
// ניהול (ר' קריאות ל-checkAndSendUnansweredReminders למטה), כלומר כל עוד היא פעילה איפשהו
// באזור הניהול. remindedAt נשמר על ההודעה הישנה ביותר שעדיין לא נענתה בכל שרשור, כדי לשלוח את
// התזכורת פעם אחת בלבד לכל "פרק זמן בלי מענה" - לא בכל פעם שהבדיקה רצה, ולא שוב לאחר שהיא
// ענתה/סגרה/העבירה להמשך טיפול (שתי הפעולות האלה גם חוסמות את הבדיקה מלכתחילה, ר' isSupportClosed/
// isSnoozed למטה).
function checkAndSendUnansweredReminders(d) {
  const REMIND_AFTER_MS = 30 * 60 * 1000;
  const now = Date.now();
  const byKey = {};
  (d.supportMessages || []).forEach((m) => { (byKey[m.voterKey] = byKey[m.voterKey] || []).push(m); });
  let changed = false;
  Object.keys(byKey).forEach((key) => {
    if (isSupportClosed(d, key) || isSnoozed(d, `support:${key}`)) return;
    const oldestUnread = byKey[key]
      .filter((m) => m.from === "asker" && !m.read)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    if (!oldestUnread || oldestUnread.remindedAt) return;
    if (now - new Date(oldestUnread.createdAt).getTime() < REMIND_AFTER_MS) return;
    oldestUnread.remindedAt = new Date().toISOString();
    changed = true;
    const notifyAdmin = d.admins[0];
    const notifyTo = d.settings.contactEmail || notifyAdmin.email;
    const url = `/admin/support/thread/${encodeSupportKey(key)}`;
    sendPushToUser(notifyAdmin, { title: "עדיין לא ענית בתמיכה 💬", body: `${oldestUnread.name}: ${oldestUnread.text}`.slice(0, 140), url })
      .then((pushed) => {
        if (!pushed) {
          sendEmail(notifyTo, `תזכורת - לא ענית ל${oldestUnread.name} בתמיכה`,
            `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>ההודעה הזו מ${esc(oldestUnread.name)} מחכה למענה כבר יותר מחצי שעה:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(oldestUnread.text)}</p><p>אפשר לענות, לסגור את השיחה או להעביר להמשך טיפול מפאנל הניהול.</p></div>`
          ).catch(() => {});
        }
      }).catch(() => {});
  });
  if (changed) db.save();
}

function supportBubbleHtml(m) {
  const cls = m.from === "admin" ? "from-admin" : "from-asker";
  return `<div class="chat-msg ${cls}" data-id="${esc(m.id)}">${esc(m.text)}<span class="chat-meta">${esc(new Date(m.createdAt).toLocaleString("he-IL"))}</span></div>`;
}

// Renders one poll's question, options (as vote buttons, or result bars once this visitor has
// voted), and a copyable share link - shared between the "מה דעתך?" section on /arena and the
// dedicated single-poll page at /arena/poll/:id (the whole point of the share link).
function pollCardHtml(poll, voterKey, redirectTarget, shareUrl, canManage) {
  const totalVotes = poll.options.reduce((sum, o) => sum + (o.votes || 0), 0);
  poll.voterChoices = poll.voterChoices || {};
  const hasVoted = !!(voterKey && (poll.voters || []).includes(voterKey));
  // A voter can change her answer (per explicit request 2026-08-30) as long as we actually know
  // which option she picked before - tracked in poll.voterChoices (voterKey -> optionIndex,
  // added alongside the older poll.voters list). A vote cast before this feature existed has no
  // entry in voterChoices, so we can't safely tell POST /arena/poll/:id/vote which option's
  // count to decrement if she tried to switch - those legacy votes stay read-only forever (a
  // rare, harmless edge case that resolves itself as old polls close/expire) rather than risk
  // corrupting the vote totals.
  const myChoiceKnown = hasVoted && Object.prototype.hasOwnProperty.call(poll.voterChoices, voterKey);
  const myChoice = myChoiceKnown ? poll.voterChoices[voterKey] : -1;
  const canSwitch = myChoiceKnown && !poll.closed;
  const optionsHtml = poll.options.map((o, i) => {
    const pct = totalVotes ? Math.round(((o.votes || 0) / totalVotes) * 100) : 0;
    const isMine = canSwitch && myChoice === i;
    if (!hasVoted && !poll.closed) {
      return `<form method="post" action="/arena/poll/${poll.id}/vote" style="margin-top:8px;">
        <input type="hidden" name="optionIndex" value="${i}" />
        <input type="hidden" name="redirectTo" value="${esc(redirectTarget)}" />
        <button type="submit" class="btn-arena" style="width:100%;text-align:right;display:flex;justify-content:space-between;gap:10px;">
          <span>${esc(o.text)}</span><span style="opacity:.85;">(${o.votes || 0})</span>
        </button>
      </form>`;
    }
    if (canSwitch) {
      // Still voted/closed-looking (result bars), but clickable - clicking a different bar
      // re-submits to the same vote route, which now moves her vote instead of just ignoring it.
      return `<form method="post" action="/arena/poll/${poll.id}/vote" style="margin-top:8px;">
        <input type="hidden" name="optionIndex" value="${i}" />
        <input type="hidden" name="redirectTo" value="${esc(redirectTarget)}" />
        <button type="submit" class="poll-option-row${isMine ? " poll-option-selected" : ""}" style="width:100%;background:none;border:none;padding:0;cursor:pointer;font:inherit;color:inherit;text-align:right;">
          <div class="poll-bar-wrap">
            <div class="poll-bar-fill" style="width:${pct}%;"></div>
            <span class="poll-bar-label">${esc(o.text)} - ${pct}% (${o.votes || 0})${isMine ? " ✓ הבחירה שלך" : ""}</span>
          </div>
        </button>
      </form>`;
    }
    return `<div class="poll-option-row"><div class="poll-bar-wrap"><div class="poll-bar-fill" style="width:${pct}%;"></div><span class="poll-bar-label">${esc(o.text)} - ${pct}% (${o.votes || 0})</span></div></div>`;
  }).join("");
  // Admin-created surveys (source: "admin") are shown with a distinct "from the system" badge
  // instead of the usual "מאת <freelancer>" attribution line, so they read clearly as an
  // official SheCan survey rather than another freelancer's "מה דעתך?" poll - per explicit
  // request. The badge also names who the survey is aimed at (audience), since an admin survey
  // is only ever shown to its intended audience in the first place (see the visibility filter
  // where activePolls is built) but she still wanted that spelled out on the card itself.
  const audienceLabel = poll.audience === "freelancers" ? "עצמאיות" : poll.audience === "customers" ? "לקוחות" : "עצמאיות ולקוחות";
  const attributionHtml = poll.source === "admin"
    ? `<p class="muted" style="margin:0 0 8px;font-size:13px;"><span class="badge" style="margin-inline-end:6px;">📋 סקר מהמערכת · ${esc(audienceLabel)}</span>בסה"כ ${totalVotes} הצבעות</p>`
    : `<p class="muted" style="margin:0 0 8px;font-size:13px;">מאת <a href="/freelancer/${poll.freelancerId}" style="color:var(--arena-dark);font-weight:800;text-decoration:underline;">${esc(poll.freelancerName)}</a> · בסה"כ ${totalVotes} הצבעות</p>`;
  return `
  <div id="poll-${poll.id}" class="arena-card">
    ${poll.closed ? `<span class="badge badge-outline" style="margin-bottom:6px;display:inline-block;">🔒 סגור להצבעות</span>` : ""}
    <p style="margin:0 0 4px;font-weight:800;font-size:17px;">${esc(poll.question)}</p>
    ${attributionHtml}
    ${optionsHtml}
    ${canSwitch ? `<p class="muted" style="font-size:12px;margin-top:6px;">אפשר ללחוץ על תשובה אחרת כדי לשנות את ההצבעה שלך.</p>` : ""}
    <div style="margin-top:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span class="muted" style="font-size:13px;" id="pollShareUrl-${poll.id}">${esc(shareUrl)}</span>
      <button type="button" class="arena-toggle" onclick="scArenaCopyLink('pollShareUrl-${poll.id}', this)">העתקת קישור לשיתוף</button>
    </div>
    ${canManage ? `
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <form method="post" action="/arena/poll/${poll.id}/close"><button type="submit" class="btn btn-small btn-outline">${poll.closed ? "🔓 פתיחה מחדש להצבעות" : "🔒 סגירת הסקר להצבעות נוספות"}</button></form>
      <form method="post" action="/arena/poll/${poll.id}/delete" onsubmit="return confirm('למחוק את הסקר הזה?');"><button type="submit" class="btn btn-small btn-outline">מחיקת הסקר שלי</button></form>
    </div>` : ""}
  </div>`;
}

// Renders the "leave/edit a review" block shown on a freelancer's (or one of her additional
// listings') profile page - a single shared template so the wording, star widget and photo
// caption stay identical everywhere, and so editing an existing review (from her personal
// area) reuses the exact same form instead of a separate one-off.
function reviewFormHtml(businessName, formAction, listingId, existingReview) {
  const r = existingReview || {};
  return `
    <h4 style="margin:0 0 10px;text-align:center;">קיבלת שירות מ${esc(businessName)}? מוזמנת לספר לנו איך היה</h4>
    <form method="post" action="${formAction}" enctype="multipart/form-data">
      <input type="hidden" name="listingId" value="${esc(listingId || "")}" />
      ${starInputHtml(r.rating)}
      <textarea name="text" placeholder="ספרי לנו על החוויה שלך – מה קיבלת ואיך היה השירות. תמונות מהתוצאה הסופית עושות הבדל עצום ועוזרות לעסק הזה לצמוח. תודה שבחרת לפרגן!" required style="margin-top:10px;">${esc(r.text || "")}</textarea>
      <label style="margin-top:10px;">שתפי תמונה של התוצאה (לא חובה אבל משמעותי)</label>
      <input type="file" name="photo" accept="image/*" />
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;margin-top:10px;"><input type="checkbox" name="isAnonymous" value="1" ${r.isAnonymous ? "checked" : ""} style="width:auto;" /> מעדיפה להישאר אנונימית</label>
      <button class="btn" style="margin-top:12px;" type="submit">${existingReview ? "עדכון ההמלצה" : "שליחה"}</button>
    </form>
  `;
}

// Which business a "freelancer" type review is actually about - her main profile, or the
// specific additional listing it was left on - used in the admin review-management panel
// where she needs to see real names/targets (unlike reviewDisplayName, which is for public
// display and may mask the reviewer's identity).
function reviewTargetLabel(d, r) {
  const f = d.freelancers.find((x) => x.id === r.targetId);
  if (!f) return "לא ידוע";
  if (!r.listingId) return f.businessName || f.name;
  const l = (f.additionalListings || []).find((x) => String(x.id) === String(r.listingId));
  return l ? `${l.businessName} (תחום נוסף של ${f.businessName || f.name})` : (f.businessName || f.name);
}

// Which business (main profile or a specific additional listing) a chat message from a
// customer was sent about - shown to the freelancer in her inbox so she always knows which
// of her businesses the customer messaged from, whenever she has more than one. For a
// message sent from her main profile, this now also names the main business explicitly
// (rather than staying silent) as long as she has at least one additional listing - if she
// only has the one business, there's no ambiguity to clear up, so no label is shown.
function chatMessageTargetLabel(d, f, m) {
  if (!f) return null;
  if (!m.listingId) {
    if (!(f.additionalListings || []).length) return null;
    const fieldLabel = subcatName(d, f.categoryId, f.subcategoryId) || catName(d, f.categoryId);
    return `${f.businessName || f.name} (${fieldLabel})`;
  }
  const l = (f.additionalListings || []).find((x) => String(x.id) === String(m.listingId));
  if (!l) return null;
  const fieldLabel = subcatName(d, l.categoryId, l.subcategoryId) || catName(d, l.categoryId);
  return `${l.businessName} (${fieldLabel})`;
}

function reviewCard(r) {
  // Stars are rendered as a separate flex child that comes BEFORE the text child in the
  // DOM - in an RTL context flexbox's default row places the first child at the visual
  // right, so this reliably puts the stars on the right, immediately before the review
  // text, regardless of bidi quirks with the star characters themselves.
  return `<div class="review">
    <div class="review-header"><span class="review-name">${esc(reviewDisplayName(r))}</span></div>
    <div class="review-text" style="display:flex;align-items:flex-start;gap:6px;"><span>${starRow(r.rating)}</span><span>${esc(r.text)}</span></div>
    ${r.photoDataUri ? `<img src="${r.photoDataUri}" alt="" style="max-width:220px;border-radius:10px;margin-top:10px;display:block;" />` : ""}
    ${r.response ? `<div class="review-response"><strong>תגובת בעלת העסק:</strong> ${esc(r.response)}</div>` : ""}
  </div>`;
}

function requireRole(session, role) {
  return session && session.role === role;
}

// Shown wherever an action (writing a review, sending a message, leaving a comment) requires a
// CUSTOMER account specifically. A freelancer who's already logged in - just under the wrong
// role - gets an explicit note that she needs to switch to a customer account, instead of a
// bare "log in" link that's confusing when she's already logged in. Anonymous visitors keep
// the original plain "log in" prompt, unchanged. actionText is the Hebrew infinitive phrase
// that completes "כדי ..." (e.g. "לכתוב המלצה", "לשלוח הודעה") - shared between both branches
// so they read as one consistent sentence. Per explicit request.
//
// UPDATED 2026-09-02: the freelancer branch used to send her to a full /login form to log back
// in as a customer - per explicit follow-up ("קצת מסרבל... תעשה את זה אוטומטית... פשוט עברי
// למצב לקוחה"), that's now a genuine one-click switch instead: a tiny form posts straight to
// the existing /freelancer-dashboard/switch-to-customer route (no password re-entry - she's
// already authenticated), carrying the current page as `next` so it lands her right back where
// she was and she can immediately finish the action she started. Every call site already builds
// loginUrl as "/login?next=<currentPage>", so the current page is simply read back out of that
// URL's own `next` param instead of changing every call site's signature. Every freelancer now
// has a linked customer account by this point (see ensureLinkedCustomerAccount + the db.js
// backfill), so the switch essentially never fails - but the route itself still has its own
// "no linked account" fallback message just in case.
function customerOnlyPrompt(ctx, loginUrl, actionText) {
  if (ctx.session && ctx.session.role === "freelancer") {
    let nextPath = "";
    try { nextPath = new URL(loginUrl, "https://x.invalid").searchParams.get("next") || ""; } catch (e) {}
    return `
    <form method="post" action="/freelancer-dashboard/switch-to-customer">
      ${nextPath ? `<input type="hidden" name="next" value="${esc(nextPath)}" />` : ""}
      <p class="muted">שימי לב: את מחוברת כרגע כעצמאית - כדי ${actionText} צריך חשבון לקוחה.
        <button type="submit" style="background:none;border:none;padding:0;margin:0;font:inherit;color:var(--rose-dark);font-weight:800;text-decoration:underline;cursor:pointer;">מעבר למצב לקוחה</button>
      </p>
    </form>`;
  }
  return `<p class="muted"><a href="${loginUrl}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי ${actionText}.</p>`;
}

// מוצג במקום כפתור "לצפייה בקוד קופון" הרגיל, כשמועדון YouCan מופעל ולקוחה מחוברת אינה חברה בו
// (ר' couponGated ב-GET /freelancer/:id) - קוד הקופון עצמו לא מוטמע ב-HTML בכלל במקרה הזה (לא
// רק מוסתר ב-CSS כמו scRevealCoupon הרגיל), כך שאין שום דרך לחלץ אותו מקוד המקור. gateId מבדיל
// בין הכרטיסייה הראשית לכל אחת מהרשימות הנוספות שלה, כדי שכמה תיבות כאלה יוכלו לדור בעמוד אחד.
function youCanGateBoxHtml(gateId, returnPath, d) {
  const price = d.settings.youCanMonthlyPrice || 13;
  return `
  <button type="button" class="btn btn-small" style="margin-top:8px;" onclick="document.getElementById('${gateId}').style.display='block';this.style.display='none';">לצפייה בקוד קופון</button>
  <div id="${gateId}" style="display:none;margin-top:8px;padding:10px;border-radius:8px;background:#f3ede8;">
    <p style="font-weight:800;margin:0 0 6px;">🎟️ קוד הקופון פתוח לחברות מועדון YouCan</p>
    <p class="muted" style="margin:0 0 8px;">ב-${esc(String(price))} ש"ח לחודש בלבד את יכולה לממש כמה קודי קופון שתרצי, בכל העסקים באתר, בלי הגבלה.</p>
    <a class="btn btn-small" href="/youcan/join?next=${encodeURIComponent(returnPath)}">להצטרפות למועדון</a>
  </div>`;
}

function paymentStatusLabel(status) {
  return { free: "חינמי (תקופת השקה)", active: "פעיל", paused: "מושהה", pending_payment: "ממתין לתשלום" }[status] || status;
}

function adPaymentStatusLabel(status) {
  return { none: "-", pending_payment: "ממתינה לתשלום", paid: "שולם" }[status] || status;
}

// ---------- route handlers ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regexStr = pattern.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  });
  routes.push({ method, regex: new RegExp("^" + regexStr + "$"), keys, handler });
}

// Bumped by hand every time an updated server.js is handed off, specifically so Sapir can
// confirm a deploy actually picked up the newest code with one glance at /deploy-check in her
// browser - instead of having to dig through Render's dashboard/logs each time to answer "did my
// last upload actually go live?". Added after that exact question came up repeatedly in a row
// (the magazine flipbook file, then this approval-email/attachment fix) and turned out, at least
// once, to genuinely be the root cause (a real code fix that Render just hadn't deployed yet).
const DEPLOY_MARKER = "update123 - 2026-09-02 - (1) מעבר בין מצב לקוחה/עצמאית: כשעצמאית מחוברת כרגע כמצב לקוחה וממשיכה לקבל הודעות כעצמאית (הודעות צ'אט מלקוחות, הודעות מהנהלה) - עכשיו מופיע לה בתפריט העליון כפתור 'הודעות כעצמאית' עם מספר, שמעביר אותה בלחיצה אחת ישר לדשבורד שלה כדי לענות. בנוסף, בזירה - אם יש שאלה בתחום שלה שהיא עדיין לא ענתה עליה והיא כרגע מחוברת כלקוחה, מוצג לה 'זו שאלה בתחום שלך' עם כפתור מעבר מיידי למצב עצמאית שמחזיר אותה בדיוק לאותו עמוד כדי לענות (בלי לאבד את המקום). (2) שדרוג עצמי לרמת 'מומלצת': עצמאית ברמת 'בסיסית' יכולה עכשיו ללחוץ על כפתור באזור האישי שלה כדי לבקש שדרוג - הבקשה מופיעה בפאנל ייעודי חדש בניהול ('בקשות שדרוג לרמת מומלצת') שם מאשרים אחרי שסידרתן תשלום מולה (עדיין תהליך ידני, כמו כל תשלום אחר באתר כרגע). (3) תיקון עיצוב בעמוד המודליסטיות: כפתורי 'לצפייה בפרופיל' בכרטיסיות עכשיו תמיד מיושרים באותו גובה בשורה (לא קופצים למעלה/למטה לפי אורך הטקסט מעליהם), והטקסט ההסברי מעל הכרטיסיות קוצר וצומצם. וגם (מ-update122) - השלמות למועדון YouCan: (1) באזור האישי של הלקוחה (/account) נוסף פאנל 'מועדון YouCan' שמראה את הסטטוס שלה בזמן אמת - חברה פעילה (ועם תאריך הצטרפות), ממתינה לאישור, או לא חברה (עם כפתור הצטרפות) - מוצג רק כשהמועדון פעיל בניהול. (2) נוספה אפשרות ביטול עצמית ללקוחה (בעמוד /youcan/join, גם מקושר מהפאנל באזור האישי) - הביטול נכנס לתוקף מיידית. (3) נוספה מדיניות מועדון מפורשת: ביטול הוא סופי ולא מתחדש אוטומטית - כדי לחזור לחברות צריך להצטרף מחדש ולשלם מחדש. הטקסט הזה מוצג גם בטופס ההצטרפות עם צ'קבוקס אישור חובה (נשמר בתאריך על הלקוחה, youCanPolicyAgreedAt) וגם ליד כפתור הביטול לחברה פעילה. נבדק קצה-לקצה: בקשת הצטרפות בלי לסמן את הצ'קבוקס לא עוברת; עם הסימון - נשמר תאריך האישור, אישור ידני בניהול הופך לחברות פעילה, מופיע נכון בפאנל באזור האישי, וביטול עצמי מאפס את הסטטוס בחזרה למצב 'לא חברה' (מחייב תהליך הצטרפות ותשלום חדשים לחידוש). וגם (מ-update121) - (1) מועדון YouCan: אפשר להגביל את פעולת 'לצפייה בקוד קופון' בלבד (שאר האתר פתוח כרגיל) לחברות מועדון בתשלום (13 ש\"ח לחודש, ניתן לעריכה) - מתג הפעלה/כיבוי בניהול, כרגע (בלי סליקה מחוברת) זה תהליך ידני: לקוחה רואה הסבר קצר + הוראות תשלום (ביט/העברה, ממלאים בניהול) ושולחת בקשת הצטרפות שאת מאשרת ידנית; ברגע שיהיה חיבור סליקה אמיתי, מספיק להדביק קישור בניהול והכפתור יוביל ישר לשם. (2) סטטוסים 24 שעות לעצמאיות 'מומלצות': תמונה/סרטון שנעלם אוטומטית אחרי 24 שעות, עד 3 בו-זמנית, מוצג בעיגולים בפס קבוע באתר (תחתית או צד ימין - ניתן לבחירה/שינוי בניהול), עם לב, שיתוף, וכפתור מעבר לפרופיל; מתג הפעלה/כיבוי + פאנל פיקוח על כל הסטטוסים הפעילים בניהול. וגם (מ-update120): (1) פינת ההתייעצויות בזירה: נוסף מתג ניהול (פאנל 'פינת ההתייעצויות בזירה') להצגה/הסתרה שלה בכלל מהאתר הציבורי, בלי למחוק שום תוכן קיים - שימושי כדי להוריד אותה זמנית בזמן שמחכים לתשובת נטפרי. (2) חיבור אוטומטי בין חשבון עצמאית לחשבון לקוחה: מעכשיו כל עצמאית שנרשמת מקבלת אוטומטית גם חשבון לקוחה תואם (אותו מייל/סיסמה), וגם כל העצמאיות הקיימות קיבלו את זה רטרואקטיבית - כדי שכפתור 'מעבר למצב לקוחה' תמיד יעבוד. בנוסף, בכל מקום באתר שבו רק לקוחה יכולה לפעול (כתיבת המלצה, שליחת הודעה, תגובה בזירה/בסיפורים/בקהילה) ועצמאית מחוברת מנסה - היא רואה עכשיו כפתור 'מעבר למצב לקוחה' שמעביר אותה בלחיצה אחת (בלי סיסמה) וחוזר אותה בדיוק לאותו מקום, במקום לשלוח אותה להתחבר מחדש מהתחלה. וגם (מ-update119): תיקון שני באגים בסיפור השראה השבועי: (1) תור הרוטציה האוטומטי עכשיו ממויין לפי מתי כל סיפור עצמו אושר (approvedAt), לא לפי מתי העצמאית שמאחוריו נרשמה לאתר - זה היה גורם לסיפורים להיראות 'לא לפי סדר'. (2) התאריך של 'הסיפור הבא יתעדכן ב-' עכשיו מציג גם שעה מדויקת (20:00) וגם מחושב באזור זמן ישראל במפורש, ולא רק תאריך לפי אזור הזמן של השרת (UTC ב-Render) - זה מה שגרם לתחושה שהסיפור 'לא התחלף' למרות שהתאריך המוצג כבר הגיע, כשבפועל השעה המדויקת פשוט עוד לא הגיעה. שימו לב: יום ההחלפה עצמו עדיין יכול לנחות בכל יום בשבוע אם משך הרוטציה בניהול (storyRotationDays) אינו כפולה של 7 - זה נשאר מכוון, לפי אישור מפורש. וגם (מ-update118): שיפור תצוגת הצפיות/דירוג (מ-update115): מספר הצפיות מוצג עכשיו גם על כרטיסיית העצמאית בתוצאות חיפוש/עיון (לפני שנכנסים לפרופיל), לא רק בעמוד הפרופיל עצמו; והציון המספרי של הדירוג מוצג כמספר שלם בלי נקודה כשהוא עגול (5 ולא 5.0), עשרוני רק כשצריך (4.7). שני השינויים כפופים לאותו מתג קיים בניהול. וגם (מ-update117): הגנת ספאם חכמה יותר בטופס 'צרי קשר' - חסימה לפי תוכן כפול במקום כמות גולמית בלבד. וגם (מ-update116): honeypot סמוי + כפתור מחיקה להודעות בניהול. וגם (מ-update114): פאנל ניהול 'עסקאות שדווחו'. וגם (מ-update113): התאמה למדיניות נטפרי - אישור ידני לתגובות בזירה; פאנל צפייה בהתכתבויות פרטיות; שדה מגדר עם נעילה אוטומטית לחשבון גבר. וגם (מ-update112): אישור חובה בהרשמה שהתוכן הפומבי גלוי לכלל הציבור. וגם (מ-update109-111): עוזרת AI לתמיכה + חיפוש חכם מבוסס AI - דורש ANTHROPIC_API_KEY ב-Render";
route("GET", "/deploy-check", async (req, res) => {
  // Lists what's actually sitting in every plausible Playwright browser-cache location on disk
  // right now - a direct, no-guesswork answer to "did the chromium download actually succeed
  // this deploy, and is it somewhere the running app can actually find it?" (the exact question
  // that took several rounds of digging through Render's Logs tab to answer by hand, chasing the
  // "[join-story] ... Executable doesn't exist" error each time). Checks both the *old* default
  // location (~/.cache/ms-playwright - confirmed via this same check to not exist at all on
  // Render, even right after a deploy whose build log showed the install step running) and the
  // *new* node_modules-local locations that PLAYWRIGHT_BROWSERS_PATH=0 (see near the top of this
  // file) redirects the download to instead.
  function listDir(label, dir) {
    try {
      const entries = fs.readdirSync(dir);
      return `${label} (${dir}):\n` + (entries.length ? entries.map((e) => "  - " + e).join("\n") : "  (התיקייה קיימת אבל ריקה)");
    } catch (e) {
      return `${label} (${dir}): לא קיימת/לא נגישה - ${e.message}`;
    }
  }
  const homeCache = path.join(require("os").homedir(), ".cache", "ms-playwright");
  const localBrowsersPlaywright = path.join(__dirname, "node_modules", "playwright", ".local-browsers");
  const localBrowsersCore = path.join(__dirname, "node_modules", "playwright-core", ".local-browsers");
  const browserCacheReport = [
    `PLAYWRIGHT_BROWSERS_PATH env var: ${JSON.stringify(process.env.PLAYWRIGHT_BROWSERS_PATH || null)}`,
    listDir("תיקיית מטמון ישנה (ברירת מחדל)", homeCache),
    listDir("תיקייה חדשה בתוך node_modules/playwright", localBrowsersPlaywright),
    listDir("תיקייה חדשה בתוך node_modules/playwright-core", localBrowsersCore),
  ].join("\n\n");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(`SheCan deploy marker: ${DEPLOY_MARKER}\nProcess started at: ${new Date(Date.now() - process.uptime() * 1000).toISOString()}\nChecked at: ${new Date().toISOString()}\n\n--- Playwright browser cache check ---\n${browserCacheReport}`);
});

// ----- Home -----
route("GET", "/", async (req, res, params, query, ctx) => {
  const d = db.load();
  // Sponsors ("נותנות חסות") used to also get their own big showcase strip directly on the
  // home page - per request, that's been removed so they only appear in the side columns
  // (rendered on every page via sidebarColumnsHtml), not duplicated in the main content here.
  // Whoever has the most approved recommendations shows up first, in descending order -
  // applied wherever freelancers are listed (home, search, deals), per explicit request.
  const byReviewCountDesc = (a, b) => reviewCountFor(d, b.id) - reviewCountFor(d, a.id);
  const featured = d.freelancers.filter((f) => f.status === "approved" && f.active !== false && f.tier === "premium" && !f.isLeadingBusiness && !f.isAdvertised).slice().sort(byReviewCountDesc).slice(0, 6);
  const recentBasic = d.freelancers.filter((f) => f.status === "approved" && f.active !== false && f.tier !== "premium" && !f.isLeadingBusiness && !f.isAdvertised).slice().sort(byReviewCountDesc).slice(0, 6);
  const shown = [...featured, ...recentBasic].slice(0, 6);
  const siteReviews = d.reviews.filter((r) => r.type === "site" && r.status === "approved").slice(-3).reverse();

  const catOptions = d.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");

  const weekly = getWeeklyFeature(d);
  // Anyone (not just registered customers/freelancers) can like the weekly quote - a small
  // heart icon + running total next to it. The like is attributed to whichever freelancer's
  // quote is currently live (weeklyQuoteLikeCount on her own record), or to a shared
  // settings counter when the default admin message is showing instead (no freelancer picked
  // yet). Duplicate-like prevention is client-side only (localStorage), same simplicity level
  // as the rest of the site's anonymous interactions (e.g. story-notice dismissal).
  const weeklyLikeKey = weekly.freelancer ? String(weekly.freelancer.id) : "default";
  const weeklyLikeCount = weekly.freelancer ? (weekly.freelancer.weeklyQuoteLikeCount || 0) : (d.settings.weeklyMessageLikeCount || 0);
  const currentStory = getCurrentStory(d);
  const currentStoryFreelancer = currentStory ? d.freelancers.find((x) => x.id === currentStory.freelancerId) : null;

  const body = `
      ${currentStoryFreelancer ? `
      <a href="/stories/${currentStory.id}" class="story-of-week-banner">📖 השבוע מככבת בסיפור <strong>${esc(currentStoryFreelancer.businessName || currentStoryFreelancer.name)}</strong> - בואי לצפות בסיפור שלה</a>
      <div id="scStoryNotice" class="story-notice" data-story-id="${currentStory.id}" style="display:none;">
        <button type="button" id="scStoryNoticeClose" class="story-notice-close" aria-label="סגירה">✕</button>
        <p class="story-notice-text">סיפור השבוע התעדכן והשבוע הסיפור של <strong>${esc(currentStoryFreelancer.businessName || currentStoryFreelancer.name)}</strong> מופיע.</p>
        <a href="/stories/${currentStory.id}" class="story-notice-link">לקריאת הסיפור ←</a>
      </div>
      <script>
      (function(){
        var KEY = "scStoryNoticeDismissed";
        var storyId = ${JSON.stringify(String(currentStory.id))};
        try {
          if (localStorage.getItem(KEY) === storyId) return;
        } catch (e) {}
        var el = document.getElementById("scStoryNotice");
        if (!el) return;
        el.style.display = "block";
        var btn = document.getElementById("scStoryNoticeClose");
        if (btn) btn.addEventListener("click", function(){
          try { localStorage.setItem(KEY, storyId); } catch (e) {}
          el.style.display = "none";
        });
      })();
      </script>
      ` : ""}

      <section class="hero">
        <p class="hero-sub2">כל העסקים. כל התחומים. מקום אחד. SheCan</p>
      </section>

      ${weekly.text ? `
      <div class="weekly-tip">
        <span class="weekly-tip-kicker">${weekly.isReferralWinner ? "🏆 העסק המוביל של מרוץ ההפניות" : "From the Pros | טיפ שבועי מהמומחית"}</span>
        <p class="weekly-tip-quote">${esc(weekly.text)}</p>
        <button type="button" class="weekly-tip-like" id="scWeeklyLike" data-like-key="${esc(weeklyLikeKey)}" onclick="scLikeWeeklyQuote(this)" aria-label="סמני לייק למשפט השבוע">
          <span class="weekly-tip-like-icon">🤍</span><span class="weekly-tip-like-count">${weeklyLikeCount}</span>
        </button>
        ${weekly.freelancer ? `
        <a class="weekly-tip-attr" href="/freelancer/${weekly.freelancer.id}">${esc(weekly.freelancer.businessName || weekly.freelancer.name)} | ${esc(subcatName(d, weekly.freelancer.categoryId, weekly.freelancer.subcategoryId) || catName(d, weekly.freelancer.categoryId))}</a>
        ` : `<a class="weekly-tip-btn" href="/arena">מעבר לזירה</a>`}
      </div>` : ""}

      <form class="search-box" action="/search" method="get" role="search" aria-label="חיפוש עצמאיות">
        <div class="search-row">
          <input type="text" name="q" placeholder="חפשי לפי שם עסק, עצמאית או תחום" autocomplete="off" />
        </div>
        <div class="search-row" style="margin-top:10px;">
          <select name="category"><option value="">איזה תחום מעניין אותך?</option>${catOptions}</select>
          ${cityAutocompleteHtml({ fieldName: "city", placeholder: "מאיזו עיר?" })}
          <button class="btn" type="submit">חפשי</button>
        </div>
        <div class="search-row" style="margin-top:10px;justify-content:space-between;align-items:center;">
          <label style="display:flex;align-items:center;gap:4px;font-weight:600;width:auto;white-space:nowrap;margin:0;">
            <input type="checkbox" name="homeVisit" value="1" style="width:auto;margin:0;" /><span>🚗 מגיעה עד הבית</span>
          </label>
          <div class="view-toggle" role="group" aria-label="בחירת תצוגה">
            <span class="view-toggle-label">תצוגה</span>
            <button type="button" class="view-btn" data-view-mode="expanded" onclick="scSetResultsView('expanded')" title="תצוגה מורחבת" aria-label="תצוגה מורחבת"><span class="view-icon view-icon-expanded"><i></i><i></i><i></i><i></i></span></button>
            <button type="button" class="view-btn active" data-view-mode="medium" onclick="scSetResultsView('medium')" title="תצוגה בינונית" aria-label="תצוגה בינונית"><span class="view-icon view-icon-medium"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></button>
            <button type="button" class="view-btn" data-view-mode="compact" onclick="scSetResultsView('compact')" title="תצוגה קומפקטית" aria-label="תצוגה קומפקטית"><span class="view-icon view-icon-compact"><i></i><i></i><i></i><i></i></span></button>
          </div>
        </div>
      </form>

      <h2 class="section-title">מה למצוא לך היום?</h2>
      <div class="cat-grid">
        ${d.categories.slice(0, 12).map((c) => `<a class="cat-card" href="/search?category=${c.id}"><span class="cat-icon">${categoryIcon(c.name)}</span>${esc(c.name)}</a>`).join("")}
      </div>

      ${shown.length ? `<h2 class="section-title">קצת מהעצמאיות שלנו</h2><div class="grid" id="scCardsGrid" data-view="medium">${shown.map((f) => freelancerCard(f, d)).join("")}</div>` : ""}

      ${siteReviews.length ? `<h2 class="section-title">מה אומרות עלינו</h2>${siteReviews.map(reviewCard).join("")}` : ""}

      <section style="text-align:center;margin-top:50px;">
        <h2 class="section-title">יש לך עסק? בואי נכיר</h2>
        <p class="muted">הצטרפי למאגר SheCan, תתחילי לקבל חשיפה לקהילה שלנו, ותני הצצה להטבה שרק את יודעת לתת.</p>
        <p class="muted">מקום שבו כל עצמאית מוצאת את הבית העסקי שלה. הצטרפי אלינו, הציגי את העסק שלך בקלות, ותני ללקוחות הבאות למצוא אותך בדיוק בזמן הנכון.</p>
        <a class="btn" href="/join">ספרי לי עוד</a>
      </section>

      ${d.settings.showPublicStats ? `
      <section class="panel" style="text-align:center;margin-top:30px;">
        <h2 class="section-title" style="margin-top:0;">הקהילה שלנו במספרים</h2>
        <div style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-top:14px;">
          <div style="flex:1;min-width:150px;max-width:220px;">
            <div style="font-size:38px;font-weight:800;color:var(--rose-dark);">${d.freelancers.filter((f) => f.status === "approved" && f.active !== false).length}</div>
            <div class="muted" style="margin-top:4px;">עצמאיות באתר</div>
          </div>
          <div style="flex:1;min-width:150px;max-width:220px;">
            <div style="font-size:38px;font-weight:800;color:var(--rose-dark);">${d.customers.length}</div>
            <div class="muted" style="margin-top:4px;">לקוחות רשומות</div>
          </div>
          <div style="flex:1;min-width:150px;max-width:220px;">
            <div style="font-size:38px;font-weight:800;color:var(--rose-dark);">${(d.deals || []).filter((x) => x.status === "confirmed").length}</div>
            <div class="muted" style="margin-top:4px;">עסקאות שנסגרו</div>
          </div>
        </div>
      </section>` : ""}

      ${(d.settings.communityWhatsappLink || d.settings.contactEmail) ? `
      <section class="panel" style="text-align:center;margin-top:30px;">
        <h2 class="section-title" style="margin-top:0;">רוצה להיות חלק מהקהילה שלנו?</h2>
        <p class="muted">מוזמנת להצטרף לקבוצת הנשים שלנו, או פשוט לכתוב לנו כמה מילים.</p>
        <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:14px;">
          ${d.settings.communityWhatsappLink ? `<a class="btn" href="${esc(d.settings.communityWhatsappLink)}" target="_blank" rel="noopener">מצטרפת לקבוצת הווטסאפ</a>` : ""}
          ${d.settings.contactEmail ? `<a class="btn btn-outline" href="mailto:${esc(d.settings.contactEmail)}">כתבי לנו מייל</a>` : ""}
        </div>
      </section>` : ""}
  `;
  sendHtml(res, 200, page({
    title: "קהילת העצמאיות בישראל - מצאי בעלת עסק לפי תחום ועיר",
    session: ctx.session, body, query,
    description: "SheCan - כל העסקים, כל התחומים, במקום אחד. מצאי בעלת עסק עצמאית לפי תחום ועיר, קבלי הטבה בלעדית וסגרי איתה עסקה ישירות באתר.",
    canonicalUrl: `${getOrigin(req)}/`,
    ogImage: `${getOrigin(req)}/icons/icon-512.png`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "SheCan",
      alternateName: "SheCan - קהילת העצמאיות",
      url: `${getOrigin(req)}/`,
      description: "כל העסקים, כל התחומים, במקום אחד - קהילת העצמאיות של ישראל.",
      inLanguage: "he",
    },
  }));
});

// ----- חיפוש חכם (נוסף 2026-08-26, הוחלף לגרסה חינמית ללא AI חיצוני ב-2026-08-27, קיבלה אופציה
// למעבר ל-AI אמיתי ב-2026-08-30, ומיד אחר כך - לאחר שהוסבר שכל חיפוש AI עולה כסף בפועל, בניגוד
// לכפתור "הצע לי תשובה" הידני בתמיכה - הוגדרה כברירת מחדל ל"כבוי" עם מתג הפעלה/כיבוי ידני
// בניהול, ר' d.settings.aiSearchEnabled ו-POST /admin/ai-search-toggle) -----
// לקוחה מקלידה משפט חופשי (למשל "מאפרת באזור ירושלים ברמה גבוהה ומחיר טוב"). POST /search/ai
// מנסה AI אמיתי (aiSearchInterpret) רק אם d.settings.aiSearchEnabled === true (וגם אז, רק אם יש
// מפתח מוגדר) - אחרת, ואם הקריאה נכשלה מכל סיבה שהיא, נופל לפונקציה למטה - שסורקת את הטקסט
// בעצמה (בלי לקרוא לשום שירות חיצוני, בלי שום עלות) מול הרשימות האמיתיות של האתר - קטגוריות/
// תת-קטגוריות/ערים - ומול כמה ביטויי מפתח נפוצים ("רמה גבוהה"/"מחיר טוב" וכו') כדי לבנות סינון
// מובנה. שתי הגרסאות מחזירות בדיוק אותה צורת "filters", כך שהפלט המובנה מוזן חזרה לתוך GET
// /search הרגיל (כפרמטרי query) בלי כפילות קוד משנֵי המסלולים. זו גם רשת הביטחון האוטומטית אם
// המפתח לא מוגדר, נגמר, או שיש תקלה זמנית אצל Anthropic. המחיר: פחות "חכמה" מ-AI אמיתי - לא
// מבינה ניסוחים יצירתיים, שגיאות כתיב, או משפטים עקיפים כמו שה-AI מבין - אבל בחינם ותמיד עובד.
// מילות-חיבור נפוצות שאין להתייחס אליהן כאילו הן "מזהות תחום/עיר" בפני עצמן (למשל תת-הקטגוריה
// "עיצוב גבות וריסים" לא אמורה "לתפוס" כל משפט שמכיל את המילה "וכן"/"של" סתם כי שתיהן קצרות).
const HEB_STOPWORDS = new Set(["של", "עם", "אל", "זה", "זו", "גם", "רק", "כל", "הוא", "היא", "הם", "הן", "או", "אם", "כי", "על", "עד", "בין", "כמו", "וגם", "וכן"]);
// מפרקת שם (של קטגוריה/תת-קטגוריה/עיר) למילים המשמעותיות שלו - כדי לבדוק אם הלקוחה הזכירה
// אחת מהן בבקשה שלה, במקום לבדוק אם היא הקלידה את השם המלא והמדויק (שכמעט אף אחת לא עושה -
// לקוחה כותבת "מאפרת" ולא "מאפרת כלות וערב" מילה במילה).
function significantWords(name, minLen) {
  return (name || "").split(/[^א-ת]+/).filter((w) => w.length >= (minLen || 2) && !HEB_STOPWORDS.has(w));
}
// רשימת מילות "מילוי" נפוצות בבקשות חיפוש (מיקום/רצון/נימוס) שכדאי להוריד משאריות מילות
// המפתח כדי שלא יישארו שם בטעות ויצרו סינון-טקסט שגוי (למשל "באזור" לא אמורה "להיתפס" כמילת
// חיפוש בפני עצמה - אף עצמאית לא כותבת את המילה "באזור" בביוגרפיה שלה).
const FILLER_WORDS = ["באזור", "אזור", "בסביבות", "סביבות", "מחפשת", "מחפש", "מחפשות", "רוצה", "רוצות", "צריכה", "צריך", "בבקשה", "אנא", "קרוב", "קרובה", "ליד"];

function smartSearchHeuristic(freeText, d) {
  const text = ` ${freeText.toLowerCase()} `;
  let matchedCategoryId = "", matchedSubcategoryId = "", matchedCityId = "";
  let matchedCategoryName = "", matchedSubcategoryName = "", matchedCityName = "";
  // סף מינימום 3 אותיות למילה "מזהה" של תחום/עיר (ולא 2) - מילים בנות 2 אותיות בעברית הן
  // לרוב סיומות ריבוי/שייכות נפוצות (למשל "ים" בסוף "מיוחדים") ומצטרפות בטעות למילים אחרות
  // לגמרי לא קשורות - סף של 3 מוריד כמעט את כל ההתאמות-שווא האלה, במחיר שעיר/תחום שכל
  // המילים המזהות שלו קצרות מ-3 אותיות (למשל "בת ים") לא יזוהו אוטומטית - עדיין אפשר לבחור
  // אותם ידנית בטופס הסינון הרגיל למטה.
  const nameMatchesText = (name) => significantWords(name, 3).some((w) => text.includes(w));

  // תת-קטגוריה קודם (יותר ספציפית) - אם נמצאה התאמה, היא גוררת אוטומטית גם את הקטגוריה שלה.
  outer:
  for (const cat of d.categories) {
    for (const sub of (cat.subcategories || [])) {
      if (sub.name && nameMatchesText(sub.name)) {
        matchedCategoryId = cat.id; matchedSubcategoryId = sub.id;
        matchedCategoryName = cat.name; matchedSubcategoryName = sub.name;
        break outer;
      }
    }
  }
  if (!matchedCategoryId) {
    for (const cat of d.categories) {
      if (cat.name && nameMatchesText(cat.name)) {
        matchedCategoryId = cat.id; matchedCategoryName = cat.name;
        break;
      }
    }
  }
  for (const c of d.cities) {
    if (c.name && nameMatchesText(c.name)) {
      matchedCityId = c.id; matchedCityName = c.name;
      break;
    }
  }

  const QUALITY_RE = /רמה גבוהה|רמה טובה|איכות|מקצועית|מקצועי|מעולה|הכי טובה|מומלצת|מנוסה|מיומנת|מומחית|מדהימה/gi;
  const PRICE_RE = /מחיר טוב|מחירים טובים|זולה|זול|משתלמת|משתלם|הוזלה|מחיר הוגן|לא יקר|תקציב|חסכוני/gi;
  const wantsHighQuality = QUALITY_RE.test(text);
  const wantsGoodPrice = PRICE_RE.test(text);

  // מה שנשאר אחרי הסרת המילים המשמעותיות של הקטגוריה/תת-הקטגוריה/העיר שכבר "נתפסו" למעלה,
  // ביטויי האיכות/המחיר, ומילות-מילוי נפוצות - הולך כמילות חיפוש חופשיות רגילות (כמו בתיבת
  // החיפוש הרגילה למטה). אם לא נשאר כלום בעל משמעות - עדיף להשאיר ריק מאשר לסנן בטעות לפי
  // שארית חסרת משמעות שהייתה יכולה לאפס תוצאות שהן בעצם התאמה טובה.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let leftover = freeText;
  const wordsToStrip = [
    ...significantWords(matchedSubcategoryName),
    ...significantWords(matchedCategoryName),
    ...significantWords(matchedCityName),
    ...FILLER_WORDS,
  ];
  wordsToStrip.forEach((w) => {
    leftover = leftover.replace(new RegExp(escapeRe(w), "gi"), " ");
  });
  leftover = leftover.replace(QUALITY_RE, " ").replace(PRICE_RE, " ").replace(/[^א-ת\s]/g, " ").replace(/\s+/g, " ").trim();
  // מסננת החוצה שאריות של אות בודדת - אלה כמעט תמיד "יתומות" (למשל ה-ב' שנשארה תלויה כש-
  // "רמה גבוהה" הוסר מתוך "ברמה גבוהה" ונשאר רק ה-ב' שהייתה מודבקת לפניה), ולא מילת חיפוש
  // אמיתית - אם משאירים אותן, חיפוש-הטקסט למטה דורש את המחרוזת המלאה כולל האות התלויה,
  // ומפספס בטעות תוצאות טובות. אם לא נשארה אף מילה אמיתית - התוצאה ריקה, וזה בסדר.
  leftover = leftover.split(/\s+/).filter((w) => w.length >= 2).join(" ");

  return {
    ok: true,
    filters: {
      categoryId: matchedCategoryId,
      subcategoryId: matchedSubcategoryId,
      cityId: matchedCityId,
      wantsHighQuality,
      wantsGoodPrice,
      keywords: leftover,
    },
  };
}

// ----- Search / results -----
route("GET", "/search", async (req, res, params, query, ctx) => {
  const d = db.load();
  const category = query.get("category") || "";
  // Only meaningful together with `category` (a subcategory belongs to one category) - a
  // stale subcategory left over from a since-changed category is simply ignored below rather
  // than accidentally excluding everyone, since freelancerMatchesCategory already narrowed to
  // the chosen category first.
  const subcategory = query.get("subcategory") || "";
  const city = query.get("city") || "";
  const homeVisit = query.get("homeVisit") === "1";
  const q = (query.get("q") || "").trim().toLowerCase();
  // sortQuality מגיע רק מהחיפוש החכם (ר' POST /search/ai + smartSearchHeuristic למעלה) כשהלקוחה
  // ציינה שהיא מחפשת "רמה גבוהה"/איכות - ממיין לפי דירוג ממוצע (avgRatingFor) בתוך כל קבוצת tier,
  // במקום לפי כמות ביקורות כרגיל. aiUsed רק לצורך הצגת "חיפשנו בשבילך" למעלה בתוצאות.
  const sortQuality = query.get("sortQuality") === "1";
  const aiUsed = query.get("ai") === "1";
  const results = d.freelancers.filter((f) => {
    if (f.status !== "approved") return false;
    if (f.active === false) return false;
    if (!freelancerMatchesCategory(f, category)) return false;
    // She can now have several subcategories (f.subcategoryIds) - matches if the searched-for
    // one is among hers. A freelancer with NO subcategory picked at all still matches (works
    // the whole category broadly) - same behavior as before this feature.
    if (subcategory && !freelancerSubcatMatches(f, subcategory)) return false;
    if (city && f.cityId !== city) return false;
    if (homeVisit && !f.offersHomeVisit) return false;
    if (q) {
      // Matches her business name AND her own personal name, not just whichever one
      // happens to be displayed - searching "רוני" should find her even if the card
      // shows the business name "רוני מאפרת". Also matches her subcategory (e.g. "עיצוב
      // שיער" under the broader "יופי וטיפוח" category - searching "שיער" used to miss her
      // entirely since only the category name was checked) and her own free-text "about the
      // business" bio - per explicit request, since customers often search by a word she
      // actually wrote rather than the exact category/subcategory label.
      const nameMatch = `${f.businessName || ""} ${f.name || ""}`.toLowerCase().includes(q);
      const categoryMatch = catName(d, f.categoryId).toLowerCase().includes(q);
      const subcatMatch = subcatNames(d, f.categoryId, f.subcategoryIds).toLowerCase().includes(q);
      const descMatch = (f.description || "").toLowerCase().includes(q);
      if (!nameMatch && !categoryMatch && !subcatMatch && !descMatch) return false;
    }
    return true;
  });

  // Approved additional listings (a freelancer's second/third line of work) are searched
  // and filtered the same way, but against the LISTING's own category/deliverable flags
  // while borrowing the parent freelancer's city - they're rendered as their own cards
  // mixed into the same results grid, not shown separately.
  const listingMatches = [];
  d.freelancers.forEach((lf) => {
    if (lf.status !== "approved" || lf.active === false) return;
    (lf.additionalListings || []).forEach((l) => {
      if (l.status !== "approved") return;
      if (category && l.categoryId !== category) return;
      if (subcategory && l.subcategoryId !== subcategory) return;
      if (city && lf.cityId !== city) return;
      if (homeVisit && !l.offersHomeVisit) return;
      if (q) {
        const nameMatch = (l.businessName || "").toLowerCase().includes(q);
        const categoryMatch = catName(d, l.categoryId).toLowerCase().includes(q);
        const subcatMatch = subcatName(d, l.categoryId, l.subcategoryId).toLowerCase().includes(q);
        const descMatch = (l.description || "").toLowerCase().includes(q);
        if (!nameMatch && !categoryMatch && !subcatMatch && !descMatch) return;
      }
      listingMatches.push({ f: lf, l });
    });
  });

  const combinedCards = results.map((f) => ({ tier: f.tier, reviewCount: reviewCountFor(d, f.id), avgRating: avgRatingFor(d, f.id), html: freelancerCard(f, d) }))
    .concat(listingMatches.map(({ f, l }) => ({ tier: l.tier, reviewCount: reviewCountFor(d, f.id, l.id), avgRating: avgRatingFor(d, f.id, l.id), html: additionalListingCard(f, l, d) })))
    .sort((a, b) => ((b.tier === "premium") - (a.tier === "premium")) || (sortQuality ? (b.avgRating - a.avgRating) || (b.reviewCount - a.reviewCount) : (b.reviewCount - a.reviewCount)));

  const catOptions = d.categories.map((c) => `<option value="${c.id}" ${c.id === category ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  // Pre-rendered so the dropdown already shows the right subcategory list on a normal page
  // load (e.g. reloading a search-results link with both params set) - scUpdateSubcats (see
  // layout.js) takes over from there for live changes without a page reload.
  const subcatOptions = category ? subcategoriesOf(d, category).map((s) => `<option value="${s.id}" ${s.id === subcategory ? "selected" : ""}>${esc(s.name)}</option>`).join("") : "";

  // ניתוב מיקום (breadcrumb) לפי בקשה מפורשת - מוצג רק כשבאמת יש קטגוריה/תת-קטגוריה נבחרת
  // (חיפוש חופשי בלי סינון תחום לא מציג breadcrumb, אין מה "לנתב" שם).
  const breadcrumbItems = [];
  if (category) {
    breadcrumbItems.push({ label: catName(d, category), href: `/search?category=${category}` });
    if (subcategory) breadcrumbItems.push({ label: subcatName(d, category, subcategory), href: `/search?category=${category}&subcategory=${subcategory}` });
  }
  // תיבת "חיפוש חכם" - שולחת לראוט נפרד (POST /search/ai) שמפרש את הטקסט בעצמו (בלי AI חיצוני,
  // ר' smartSearchHeuristic למעלה) ומפנה בחזרה לעמוד הזה עם פרמטרים מובנים. aiUsed מציג הודעת
  // שקיפות קטנה מעל התוצאות עם מה שהובן מהבקשה, כדי שהלקוחה תדע שהחיפוש אכן "הבין" אותה
  // ותוכל לתקן בקלות דרך טופס הסינון הרגיל למטה אם משהו לא היה מדויק.
  const aiSearchBoxHtml = `
  <form method="post" action="/search/ai" class="panel" style="max-width:640px;margin:0 auto 20px;text-align:center;">
    <h3 style="margin-top:0;">🤖 חיפוש חכם</h3>
    <p class="muted" style="font-size:13px;margin-top:-6px;">ספרי לנו במילים שלך מה את מחפשת - לדוגמה: "מאפרת באזור ירושלים ברמה גבוהה ומחיר טוב"</p>
    <textarea name="q" required maxlength="300" placeholder="תארי כאן מה את מחפשת..." style="min-height:60px;"></textarea>
    <button class="btn" style="margin-top:10px;" type="submit">חיפוש חכם</button>
  </form>`;
  const aiUsedBannerHtml = aiUsed ? `
  <p class="muted" style="text-align:center;margin-top:-10px;">🤖 חיפשנו בשבילך${category ? `: <b>${esc(catName(d, category))}</b>` : ""}${subcategory ? ` › <b>${esc(subcatName(d, category, subcategory))}</b>` : ""}${city ? ` ב<b>${esc(cityName(d, city))}</b>` : ""}${sortQuality ? ` · ממוינות לפי דירוג` : ""}${q ? ` · "${esc(query.get("q") || "")}"` : ""} - לא בדיוק מה שרצית? אפשר לדייק בטופס הרגיל למטה.</p>` : "";
  const body = `
  ${breadcrumbItems.length ? breadcrumbHtml(breadcrumbItems) : ""}
  <h1 class="section-title">מי מחכה לך היום?</h1>
  ${aiSearchBoxHtml}
  ${aiUsedBannerHtml}
      <form class="search-box" action="/search" method="get" role="search" aria-label="חיפוש עצמאיות" style="margin-right:0;margin-left:0;">
        <div class="search-row">
          <input type="text" id="scSearchQ" name="q" value="${esc(query.get("q") || "")}" placeholder="חפשי לפי שם עסק, עצמאית או תחום - הסינון אוטומטי תוך כדי הקלדה" oninput="scLiveFilter()" autocomplete="off" />
        </div>
        <div class="search-row" style="margin-top:10px;">
          <select name="category" onchange="scUpdateSubcats(this, document.getElementById('scSearchSubcat'), '', 'כל תת-התחומים');"><option value="">כל התחומים</option>${catOptions}</select>
          <select name="subcategory" id="scSearchSubcat"><option value="">${category ? "כל תת-התחומים" : "בחרי קודם תחום"}</option>${subcatOptions}</select>
          ${cityAutocompleteHtml({ fieldName: "city", selectedId: city, selectedName: city ? cityName(d, city) : "", placeholder: "מאיזו עיר?" })}
        </div>
        <div class="search-row" style="margin-top:10px;justify-content:center;">
          <label style="display:flex;align-items:center;gap:4px;font-weight:600;width:auto;white-space:nowrap;margin:0;">
            <input type="checkbox" id="scHomeVisitFilter" name="homeVisit" value="1" ${homeVisit ? "checked" : ""} style="width:auto;margin:0;" onchange="scLiveFilter()" /><span>🚗 מגיעה עד הבית</span>
          </label>
        </div>
        <div class="search-row" style="margin-top:10px;justify-content:center;">
          <button class="btn" type="submit">חפשי</button>
        </div>
        <div class="search-row" style="margin-top:10px;justify-content:center;">
          <div class="view-toggle" role="group" aria-label="בחירת תצוגה">
            <span class="view-toggle-label">תצוגה</span>
            <button type="button" class="view-btn" data-view-mode="expanded" onclick="scSetResultsView('expanded')" title="תצוגה מורחבת" aria-label="תצוגה מורחבת"><span class="view-icon view-icon-expanded"><i></i><i></i><i></i><i></i></span></button>
            <button type="button" class="view-btn active" data-view-mode="medium" onclick="scSetResultsView('medium')" title="תצוגה בינונית" aria-label="תצוגה בינונית"><span class="view-icon view-icon-medium"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></button>
            <button type="button" class="view-btn" data-view-mode="compact" onclick="scSetResultsView('compact')" title="תצוגה קומפקטית" aria-label="תצוגה קומפקטית"><span class="view-icon view-icon-compact"><i></i><i></i><i></i><i></i></span></button>
          </div>
        </div>
      </form>
      <div id="scResultsGrid">
      ${combinedCards.length ? `<div class="grid" id="scCardsGrid" data-view="medium">${combinedCards.map((c) => c.html).join("")}</div>` : `<p class="muted" style="text-align:center;">הפעם לא מצאנו התאמה... נסי לפתוח קצת את החיפוש, בטוח יש מישהי בשבילך.</p>`}
      </div>
      <p id="scNoLiveMatch" class="muted" style="text-align:center;display:none;">אין כרגע עצמאית שמתאימה לזה... נסי לשנות קצת את החיפוש.</p>
      ${category ? `<p class="muted" style="text-align:center;margin-top:18px;">לא מצאת בדיוק את מי שאת מחפשת? <a href="/service-requests?category=${category}" style="color:var(--rose-dark);font-weight:700;">פרסמי בקשה</a> ועצמאיות בתחום הזה יוכלו לפנות אלייך.</p>` : ""}
  `;
  // כותרת/תיאור/canonical דינמיים לפי הסינון (נוסף 2026-08-27, לפי בקשה מפורשת לשיפור הדירוג
  // בגוגל) - עמוד "תחום X בעיר Y" ממוקד וברור לגוגל שווה הרבה יותר מ"חיפוש" גנרי לכל
  // הקומבינציות. ה-canonical במכוון מתעלם מ-q/ai/sortQuality/homeVisit (טקסט חופשי ומיון) -
  // כל אלה מציגים תת-קבוצה של אותה תוצאה בסיסית, ולא כדאי לפזר את "משקל" הדירוג בין המון
  // כתובות כמעט-זהות; העמוד הנקי (תחום+תת-תחום+עיר) הוא זה שאמור להצטבר ולהיות מדורג.
  const searchCatName = category ? catName(d, category) : "";
  const searchSubName = (category && subcategory) ? subcatName(d, category, subcategory) : "";
  const searchCityName = city ? cityName(d, city) : "";
  let searchTitle = "חיפוש עצמאיות לפי תחום ועיר";
  if (searchSubName || searchCatName) {
    searchTitle = `${searchSubName || searchCatName}${searchCityName ? ` ב${searchCityName}` : ""} - חיפוש עצמאיות`;
  } else if (searchCityName) {
    searchTitle = `עצמאיות ב${searchCityName} - חיפוש`;
  }
  const searchDescription = (searchCatName || searchCityName)
    ? `מחפשת ${searchSubName || searchCatName || "עצמאית"}${searchCityName ? ` ב${searchCityName}` : ""}? מצאי אותה ב-SheCan - כרטיסיות עסק, ביקורות אמיתיות והטבה בלעדית לכל עצמאית.`
    : "חפשי עצמאיות לפי תחום ועיר, קבלי הטבה בלעדית וסגרי עסקה ישירות - הכל במקום אחד ב-SheCan.";
  const canonicalParams = new URLSearchParams();
  if (category) canonicalParams.set("category", category);
  if (category && subcategory) canonicalParams.set("subcategory", subcategory);
  if (city) canonicalParams.set("city", city);
  const searchCanonical = `${getOrigin(req)}/search${canonicalParams.toString() ? `?${canonicalParams.toString()}` : ""}`;
  sendHtml(res, 200, page({
    title: searchTitle, session: ctx.session, body, query,
    description: searchDescription, canonicalUrl: searchCanonical,
  }));
});

// מקבל את הטקסט החופשי מתיבת "חיפוש חכם" ומפנה בחזרה ל-/search עם פרמטרים מובנים. מנסה קודם
// AI אמיתי (aiSearchInterpret למעלה - מבין ניסוחים יצירתיים, שגיאות כתיב ומשפטים עקיפים הרבה
// יותר טוב), ורק אם אין מפתח AI מוגדר, או שהקריאה נכשלה מכל סיבה שהיא (כולל תקלה זמנית אצל
// Anthropic), נופל בחזרה אל smartSearchHeuristic המקומי והחינמי (ר' למעלה) - כך שהחיפוש החכם
// תמיד עובד, גם בלי מפתח וגם אם ה-AI זמנית לא זמין. בשני המקרים ה-id-ים שחוזרים נבדקים מול
// הנתונים האמיתיים (d.categories/d.cities) לפני שהם נכנסים ל-URL - לעולם לא סומכים על קלט
// חיצוני (גם לא כזה שמגיע מ-AI) בלי אימות.
route("POST", "/search/ai", async (req, res, params, query, ctx) => {
  const d = db.load();
  const body = await readBody(req);
  const freeText = clip((body.get("q") || "").trim(), 300);
  if (!freeText) return redirect(res, "/search");
  // חיפוש ה-AI האמיתי כבוי כברירת מחדל (לפי בקשה מפורשת 2026-08-30, אחרי שהוסבר שבניגוד לכפתור
  // "הצע לי תשובה" הידני בתמיכה, כל חיפוש בודד כאן היה עולה כסף בפועל) - נבדק כאן, לפני
  // aiSearchInterpret, כדי שכל עוד d.settings.aiSearchEnabled לא true, לא יוצאת בכלל שום קריאת
  // רשת ל-Anthropic ולא נגבה שום עלות. ר' פאנל "🤖 עוזרת AI באתר" בניהול למתג ההפעלה/כיבוי.
  let result = d.settings.aiSearchEnabled ? await aiSearchInterpret(freeText, d) : { ok: false, reason: "disabled" };
  if (!result.ok) result = smartSearchHeuristic(freeText, d);
  if (!result.ok) {
    return redirect(res, `/search?q=${encodeURIComponent(freeText)}`);
  }
  const f = result.filters;
  const params2 = new URLSearchParams();
  if (f.categoryId && d.categories.some((c) => c.id === f.categoryId)) {
    params2.set("category", f.categoryId);
    if (f.subcategoryId && subcategoriesOf(d, f.categoryId).some((s) => s.id === f.subcategoryId)) {
      params2.set("subcategory", f.subcategoryId);
    }
  }
  if (f.cityId && d.cities.some((c) => c.id === f.cityId)) params2.set("city", f.cityId);
  if (f.wantsHighQuality) params2.set("sortQuality", "1");
  if (f.keywords) params2.set("q", f.keywords);
  params2.set("ai", "1");
  redirect(res, `/search?${params2.toString()}`);
});

// ----- Freelancer profile -----
route("GET", "/freelancer/:id", async (req, res, params, query, ctx) => {
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f || f.status !== "approved" || f.active === false) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הפרופיל הזה.</p>` }));
  const reviews = d.reviews.filter((r) => r.type === "freelancer" && r.targetId === f.id && r.status === "approved" && !r.listingId);
  // A freelancer who registered more than one line of work (e.g. also does balloons, not just
  // makeup) previously had those additional listings reachable only if a customer happened to
  // stumble on their own separate card somewhere else (search results, category page) - there
  // was no link from her own main profile at all. Per explicit request, they're now surfaced
  // right here so a customer already on her page can discover everything else she offers.
  const otherApprovedListings = (f.additionalListings || []).filter((l) => l.status === "approved");
  const isCustomer = requireRole(ctx.session, "customer");
  let customer = null;
  if (isCustomer) customer = d.customers.find((c) => c.id === ctx.session.id);
  const isFav = customer && customer.favorites.includes(favKey(f.id, null));
  const myExistingReview = customer ? d.reviews.find((r) => r.type === "freelancer" && r.targetId === f.id && r.authorCustomerId === customer.id && !r.listingId) : null;
  // מועדון YouCan (2026-09-02) - כל עוד d.settings.youCanEnabled==false (ברירת המחדל) זה תמיד
  // false ושום דבר לא משתנה בתצוגה, בדיוק לפי הבקשה ("שאר הפעולות פתוחות כמו שזה עכשיו"). כשהוא
  // מופעל, לקוחה מחוברת שאינה חברה רואה במקום קוד הקופון עצמו (שלא מוטמע לה כלל ב-HTML - לא רק
  // מוסתר ב-CSS, כמו שכבר קורה לכל מי שלא לקוחה בכלל) הסבר קצר + קישור להצטרפות.
  const couponGated = Boolean(d.settings.youCanEnabled && isCustomer && !(customer && customer.youCanMember));

  if (isCustomer) {
    customer.viewedDeals = customer.viewedDeals || [];
    if (!customer.viewedDeals.find((v) => v.freelancerId === f.id)) {
      customer.viewedDeals.push({ freelancerId: f.id, date: new Date().toISOString() });
      db.save();
    }
  }

  f.viewCount = (f.viewCount || 0) + 1;
  // This route (a single freelancer's public profile) is the single most-visited page type on
  // the whole site - every card click from the home page, search, or a category page lands
  // here. An unthrottled db.save() here means a full JSON.stringify + synchronous
  // fs.writeFileSync of the ENTIRE database (now 96+ freelancers' worth of base64 photos/logos/
  // galleries, plus every customer/review/story) on nearly every single page view site-wide -
  // exactly the same full-DB-write-per-request problem that already caused the "JavaScript heap
  // out of memory" crash for the old unthrottled site-visit counter (see saveSiteStatsThrottled's
  // own comment below), just triggered from a different, even higher-traffic page. Reusing that
  // same throttle here - it's a general "coalesce non-critical counter saves to at most once
  // every 20s" mechanism, not actually specific to site-wide stats - so this stops being a
  // per-request disk write without losing anything beyond a few seconds of the very latest view
  // count on a crash (the count itself still updates instantly in memory either way).
  saveSiteStatsThrottled();

  let myThread = [];
  if (isCustomer) {
    myThread = (d.chatMessages || []).filter((m) => m.freelancerId === f.id && m.customerId === ctx.session.id);
    let anyMarkedRead = false;
    myThread.forEach((m) => { if (m.fromRole === "freelancer" && !m.read) { m.read = true; anyMarkedRead = true; } });
    if (anyMarkedRead) db.save();
    myThread = myThread.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // So clicking "התחברי" from this page (to reveal a coupon, write a review, or send a
  // message) brings her back HERE after logging in, instead of dumping her on the generic
  // customer dashboard and losing the thing she actually came to do.
  const loginUrl = `/login?next=${encodeURIComponent(`/freelancer/${f.id}`)}`;
  const loginUrlToMessage = `/login?next=${encodeURIComponent(`/freelancer/${f.id}#scMessageBox`)}`;

  const currentStory = getCurrentStory(d);
  const isFeaturedStoryThisWeek = currentStory && currentStory.freelancerId === f.id;

  const heroBadges = [
    f.availableNow ? `<span class="badge badge-available">🟢 זמינה כרגע</span>` : "",
    f.isLeadingBusiness ? `<span class="badge badge-leading">👑 עסק מוביל</span>` : "",
    f.isAdvertised ? `<span class="badge badge-ad">📣 מודעה</span>` : "",
    f.tier === "premium" ? `<span class="badge">מומלצת</span>` : "",
    f.offersOnline ? `<span class="badge badge-outline">💻 שירות אונליין</span>` : "",
    f.offersHomeVisit ? `<span class="badge badge-outline">🚗 מגיעה אלייך</span>` : "",
    isFeaturedStoryThisWeek ? `<a href="/stories/${currentStory.id}" class="badge badge-leading" style="text-decoration:none;">📖 הסיפור שלה מככב השבוע</a>` : "",
  ].filter(Boolean).join(" ");

  const profileReviewCount = reviewCountFor(d, f.id);
  const profileAvgRating = avgRatingFor(d, f.id);
  // "כמה כוכבי דירוג" (הציון המספרי המדויק, למשל "4.7") ו"כמה צופות" (f.viewCount) - שתיהן
  // מוצגות בפרופיל הפומבי רק אם d.settings.showProfileViewCount מופעל (ר' הפאנל בניהול), לפי
  // בקשה מפורשת 2026-08-31. כשהטוגל כבוי, ההתנהגות הקודמת (רק כוכבים ויזואליים, ומספר
  // הביקורות בסוגריים רק כשהוא מעל 5) נשארת בדיוק כמו שהייתה.
  const profileRatingExtraHtml = [
    d.settings.showProfileViewCount && profileAvgRating !== null ? esc(formatRatingNumber(profileAvgRating)) : "",
    profileReviewCount > 5 ? `(${profileReviewCount})` : "",
  ].filter(Boolean).join(" ");
  const profileLocation = locationLabel(d, f.cityId, f.offersOnline, f.offersHomeVisit);
  const profileLocationIcon = locationIcon(d, f.cityId, f.offersOnline, f.offersHomeVisit);
  // Redesigned profile header (per explicit request): horizontal layout, logo on the right,
  // name/years/rating/location beside it, contact details in their own column further left,
  // "נעים להכיר" removed entirely in favor of her own description text directly.
  const contactRows = [
    f.phone ? `<div class="profile-detail-row"><span class="profile-detail-icon">📞</span><a href="tel:${esc(f.phone)}">${esc(f.phone)}</a></div>` : "",
    (f.hasWhatsapp && f.phone) ? `<div class="profile-detail-row"><span class="profile-detail-icon">${whatsappIconSvg}</span><a class="whatsapp-link" href="https://wa.me/${esc(waPhoneDigits(f.phone))}" target="_blank" rel="noopener">WhatsApp</a></div>` : "",
    f.portfolioUrl ? `<div class="profile-detail-row"><span class="profile-detail-icon">🔗</span><a href="${esc(f.portfolioUrl)}" target="_blank" rel="noopener">תיק עבודות</a></div>` : "",
    f.email ? `<div class="profile-detail-row"><span class="profile-detail-icon">📧</span><a href="#scMessageBox" onclick="var t=document.querySelector('#scMessageBox textarea');if(t){t.focus();}">${esc(f.email)}</a></div>` : "",
    instagramLinkHtml(f.instagram),
  ].filter(Boolean).join("");
  const body = `
  ${breadcrumbHtml([
    { label: catName(d, f.categoryId), href: `/search?category=${f.categoryId}` },
    ...(f.subcategoryId ? [{ label: subcatName(d, f.categoryId, f.subcategoryId), href: `/search?category=${f.categoryId}&subcategory=${f.subcategoryId}` }] : []),
    { label: f.businessName || f.name },
  ])}
  <div class="panel profile-detail profile-merged">
    <div class="profile-header-row">
      <div class="profile-header-namelogo">
        ${zoomableImage(avatarUri(f, d), f.businessName || f.name, "profile-header-logo")}
        <div class="profile-header-info">
          <h1 class="profile-header-name">${esc(f.businessName || f.name)}</h1>
          ${f.yearsInField ? `<div class="profile-header-years">🌱 ${esc(yearsInFieldShortLabel(f.yearsInField))}</div>` : ""}
          ${profileAvgRating !== null ? `<div class="profile-stars-row">${starRow(Math.round(profileAvgRating))}${profileRatingExtraHtml ? `<span class="profile-review-count-small">${profileRatingExtraHtml}</span>` : ""}</div>` : ""}
          ${d.settings.showProfileViewCount ? `<div class="profile-header-location">👁️ ${f.viewCount || 0} צפיות בפרופיל</div>` : ""}
          ${profileLocation ? `<div class="profile-header-location">${profileLocationIcon} ${esc(profileLocation)}</div>` : ""}
        </div>
      </div>
      ${contactRows ? `<div class="profile-header-divider"></div><div class="profile-contact-col">${contactRows}</div>` : ""}
    </div>

    ${isCustomer ? `<form method="post" action="/freelancer/${f.id}/favorite" style="margin-top:10px;"><button class="btn btn-small favorite-btn ${isFav ? "btn" : "btn-outline"}" type="submit">${isFav ? "❤️ שמורה אצלך" : "❤️ הוספה למועדפות"}</button></form>` : ""}
    ${heroBadges ? `<div style="margin-top:10px;">${heroBadges}</div>` : ""}
    ${f.description ? `<p class="profile-header-desc">${esc(f.description)}</p>` : ""}

    <div class="deal-box deal-box-compact">
      ${detailLine("🎁", esc(f.dealText || ""))}
      ${f.dealCode ? (
        !isCustomer
          ? `<a class="btn btn-small" style="margin-top:8px;display:inline-block;" href="${loginUrl}">התחברי כדי לצפות בקוד הקופון</a>`
          : couponGated
          ? youCanGateBoxHtml(`scYouCanGate-${f.id}`, `/freelancer/${f.id}`, d)
          : `<button type="button" class="btn btn-small" style="margin-top:8px;" onclick="scRevealCoupon('${f.id}', this)">לצפייה בקוד קופון</button><div id="scCoupon-${f.id}" style="display:none;margin-top:6px;font-weight:800;">קוד: ${esc(f.dealCode)}</div>`
      ) : ""}
    </div>
  </div>

  ${(f.galleryPhotos && f.galleryPhotos.length) ? `
  <div class="panel profile-detail">
    <h3 style="color:var(--gray);font-size:22px;text-align:center;">גאה להציג</h3>
    <div class="gallery-scroll">
      ${f.galleryPhotos.map((src) => zoomableImage(src, "", "gallery-thumb", f.galleryPhotos)).join("")}
    </div>
  </div>` : ""}

  <div class="panel profile-detail" id="scReview">
    <h3 style="text-align:center;">⭐ מה אומרות עליה</h3>
    ${reviews.length ? reviews.map(reviewCard).join("") : `<p class="muted">עוד אין ביקורות - היי הראשונה לספר איך היה.</p>`}
    ${isCustomer ? reviewFormHtml(f.businessName || f.name, `/freelancer/${f.id}/review`, "", myExistingReview) : customerOnlyPrompt(ctx, loginUrl, "לכתוב המלצה")}
  </div>

  <div class="panel profile-detail" id="scMessageBox">
    <h3>💌 מוזמנת לשלוח הודעה ל ${esc(f.businessName || f.name)}, היא תקבל את ההודעה שלך גם במייל :)</h3>
    ${isCustomer ? `
      ${myThread.length ? `<div class="chat-thread" style="text-align:right;">${myThread.map((m) => `<div class="chat-msg from-${m.fromRole}">${esc(m.text)}<span class="chat-meta">${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`).join("")}</div>` : `<p class="muted">עדיין לא כתבתן - זו ההזדמנות לשאול אותה כל מה שמעניין אותך, ישירות.</p>`}
      <form method="post" action="/freelancer/${f.id}/message">
        <textarea name="text" placeholder="כתבי הודעה ל ${esc(f.businessName || f.name)}..." style="min-height:80px;" required></textarea>
        <button class="btn" style="margin-top:10px;" type="submit">שליחת הודעה</button>
      </form>
    ` : customerOnlyPrompt(ctx, loginUrlToMessage, "לשלוח הודעה ישירה לעצמאית")}
  </div>

  ${otherApprovedListings.length ? `
  <div class="panel profile-detail">
    <h3 style="text-align:center;">✨ העסקים הנוספים של ${esc(f.businessName || f.name)}</h3>
    <div class="grid">
      ${otherApprovedListings.map((l) => additionalListingCard(f, l, d)).join("")}
    </div>
  </div>` : ""}
  `;
  // SEO לעמוד הפרופיל הציבורי (נוסף 2026-08-27, לפי בקשה מפורשת) - זה עמוד הכרטיסייה, הכי הרבה
  // תנועה מגוגל צפויה לנחות בדיוק כאן. כותרת/תיאור עשירים בתחום+עיר (לא רק שם עסק), ו-JSON-LD
  // מסוג LocalBusiness עם aggregateRating (כשיש ביקורות) - זה בדיוק המנגנון שגוגל משתמש בו כדי
  // להציג כוכבי דירוג ישירות בתוצאות החיפוש (ר' Google Rich Results), מה שמעלה מאוד את אחוז
  // ההקלקה גם בלי לשנות את הדירוג עצמו.
  const profileCatLabel = subcatNames(d, f.categoryId, f.subcategoryIds) || catName(d, f.categoryId);
  const profileCityLabel = f.cityId ? cityName(d, f.cityId) : "";
  const profileDescription = clip((f.description || "").trim(), 160) ||
    `${f.businessName || f.name} - ${profileCatLabel}${profileCityLabel ? ` ב${profileCityLabel}` : ""}. ${f.dealText ? `הטבה: ${f.dealText}. ` : ""}מצאי עוד עצמאיות ב-SheCan.`;
  const profileTitle = `${f.businessName || f.name} - ${profileCatLabel}${profileCityLabel ? ` ב${profileCityLabel}` : ""}`;
  const profileCanonical = `${getOrigin(req)}/freelancer/${f.id}`;
  const profileAvatar = avatarUri(f, d);
  const profileImageAbs = (profileAvatar && !profileAvatar.startsWith("data:")) ? `${getOrigin(req)}${profileAvatar}` : null;
  const profileJsonLd = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: f.businessName || f.name,
    description: profileDescription,
    url: profileCanonical,
    ...(profileImageAbs ? { image: profileImageAbs } : {}),
    ...(f.phone ? { telephone: f.phone } : {}),
    ...(profileCityLabel ? { address: { "@type": "PostalAddress", addressLocality: profileCityLabel, addressCountry: "IL" } } : {}),
    ...(profileReviewCount > 0 && profileAvgRating !== null ? {
      aggregateRating: { "@type": "AggregateRating", ratingValue: Number(profileAvgRating.toFixed(1)), reviewCount: profileReviewCount },
    } : {}),
  };
  sendHtml(res, 200, page({
    title: profileTitle, session: ctx.session, body, query,
    description: profileDescription, canonicalUrl: profileCanonical,
    ogImage: profileImageAbs || undefined, jsonLd: profileJsonLd,
  }));
});

// A freelancer's additional listing gets its own detail page - name/category/logo/gallery/
// description/deal/tier/portfolio all come from the listing itself, contact info
// (phone/email/whatsapp/city) is shared with her main profile since it's the same real
// person underneath - but favorites and reviews are kept fully separate per listing (a
// customer favoriting/reviewing "hair styling by Roni" never touches "makeup by Roni"),
// per the explicit "don't let me get confused between her different businesses" request.
route("GET", "/freelancer/:id/listing/:lid", async (req, res, params, query, ctx) => {
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  const l = f && (f.additionalListings || []).find((x) => String(x.id) === params.lid);
  if (!f || f.status !== "approved" || f.active === false || !l || l.status !== "approved") {
    return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הפרופיל הזה.</p>` }));
  }
  const reviews = d.reviews.filter((r) => r.type === "freelancer" && r.targetId === f.id && r.status === "approved" && String(r.listingId || "") === String(l.id));
  const isCustomer = requireRole(ctx.session, "customer");
  let customer = null;
  if (isCustomer) customer = d.customers.find((c) => c.id === ctx.session.id);
  const isFav = customer && customer.favorites.includes(favKey(f.id, l.id));
  const loginUrl = `/login?next=${encodeURIComponent(`/freelancer/${f.id}/listing/${l.id}`)}`;
  const loginUrlToMessage = `/login?next=${encodeURIComponent(`/freelancer/${f.id}/listing/${l.id}#scMessageBox`)}`;
  const myExistingReview = customer ? d.reviews.find((r) => r.type === "freelancer" && r.targetId === f.id && r.authorCustomerId === customer.id && String(r.listingId || "") === String(l.id)) : null;
  const couponGated = Boolean(d.settings.youCanEnabled && isCustomer && !(customer && customer.youCanMember));

  let myThread = [];
  if (isCustomer) {
    myThread = (d.chatMessages || []).filter((m) => m.freelancerId === f.id && m.customerId === ctx.session.id)
      .slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  const heroBadges = [
    l.tier === "premium" ? `<span class="badge">מומלצת</span>` : "",
    l.offersOnline ? `<span class="badge badge-outline">💻 שירות אונליין</span>` : "",
    l.offersHomeVisit ? `<span class="badge badge-outline">🚗 מגיעה אלייך</span>` : "",
  ].filter(Boolean).join(" ");

  const listingReviewCount = reviewCountFor(d, f.id, l.id);
  const listingAvgRating = avgRatingFor(d, f.id, l.id);
  const listingLocation = locationLabel(d, f.cityId, l.offersOnline, l.offersHomeVisit);
  const listingLocationIcon = locationIcon(d, f.cityId, l.offersOnline, l.offersHomeVisit);
  const listingContactRows = [
    f.phone ? `<div class="profile-detail-row"><span class="profile-detail-icon">📞</span><a href="tel:${esc(f.phone)}">${esc(f.phone)}</a></div>` : "",
    (f.hasWhatsapp && f.phone) ? `<div class="profile-detail-row"><span class="profile-detail-icon">${whatsappIconSvg}</span><a class="whatsapp-link" href="https://wa.me/${esc(waPhoneDigits(f.phone))}" target="_blank" rel="noopener">WhatsApp</a></div>` : "",
    l.portfolioUrl ? `<div class="profile-detail-row"><span class="profile-detail-icon">🔗</span><a href="${esc(l.portfolioUrl)}" target="_blank" rel="noopener">תיק עבודות</a></div>` : "",
    f.email ? `<div class="profile-detail-row"><span class="profile-detail-icon">📧</span><a href="#scMessageBox" onclick="var t=document.querySelector('#scMessageBox textarea');if(t){t.focus();}">${esc(f.email)}</a></div>` : "",
    instagramLinkHtml(f.instagram),
  ].filter(Boolean).join("");
  const body = `
  <p class="muted" style="text-align:center;">תחום נוסף של <a href="/freelancer/${f.id}" style="color:var(--rose-dark);font-weight:800;">${esc(f.businessName || f.name)}</a></p>
  <div class="panel profile-detail profile-merged">
    <div class="profile-header-row">
      <div class="profile-header-namelogo">
        ${zoomableImage(l.logoDataUri || d.settings.defaultBusinessLogoDataUri, l.businessName, "profile-header-logo")}
        <div class="profile-header-info">
          <h1 class="profile-header-name">${esc(l.businessName)}</h1>
          ${l.yearsInField ? `<div class="profile-header-years">🌱 ${esc(yearsInFieldShortLabel(l.yearsInField))}</div>` : ""}
          ${listingAvgRating !== null ? `<div class="profile-stars-row">${starRow(Math.round(listingAvgRating))}${listingReviewCount > 5 ? `<span class="profile-review-count-small">(${listingReviewCount})</span>` : ""}</div>` : ""}
          ${listingLocation ? `<div class="profile-header-location">${listingLocationIcon} ${esc(listingLocation)}</div>` : ""}
        </div>
      </div>
      ${listingContactRows ? `<div class="profile-header-divider"></div><div class="profile-contact-col">${listingContactRows}</div>` : ""}
    </div>

    ${isCustomer ? `<form method="post" action="/freelancer/${f.id}/favorite" style="margin-top:10px;"><input type="hidden" name="listingId" value="${esc(l.id)}" /><button class="btn btn-small favorite-btn ${isFav ? "btn" : "btn-outline"}" type="submit">${isFav ? "❤️ שמורה אצלך" : "❤️ הוספה למועדפות"}</button></form>` : ""}
    ${heroBadges ? `<div style="margin-top:10px;">${heroBadges}</div>` : ""}
    ${l.description ? `<p class="profile-header-desc">${esc(l.description)}</p>` : ""}

    <div class="deal-box deal-box-compact">
      ${detailLine("🎁", esc(l.dealText || ""))}
      ${l.dealCode ? (
        !isCustomer
          ? `<a class="btn btn-small" style="margin-top:8px;display:inline-block;" href="${loginUrl}">התחברי כדי לצפות בקוד הקופון</a>`
          : couponGated
          ? youCanGateBoxHtml(`scYouCanGate-${f.id}-${l.id}`, `/freelancer/${f.id}/listing/${l.id}`, d)
          : `<button type="button" class="btn btn-small" style="margin-top:8px;" onclick="scRevealCoupon('${f.id}', this, '${l.id}')">לצפייה בקוד קופון</button><div id="scCoupon-${f.id}-${l.id}" style="display:none;margin-top:6px;font-weight:800;">קוד: ${esc(l.dealCode)}</div>`
      ) : ""}
    </div>
  </div>

  ${(l.galleryPhotos && l.galleryPhotos.length) ? `
  <div class="panel profile-detail">
    <h3 style="color:var(--gray);font-size:22px;text-align:center;">גאה להציג</h3>
    <div class="gallery-scroll">
      ${l.galleryPhotos.map((src) => zoomableImage(src, "", "gallery-thumb", l.galleryPhotos)).join("")}
    </div>
  </div>` : ""}

  <div class="panel profile-detail">
    <h3 style="text-align:center;">⭐ מה אומרות עליה</h3>
    ${reviews.length ? reviews.map(reviewCard).join("") : `<p class="muted">עוד אין ביקורות - היי הראשונה לספר איך היה.</p>`}
    ${isCustomer ? reviewFormHtml(l.businessName, `/freelancer/${f.id}/review`, l.id, myExistingReview) : customerOnlyPrompt(ctx, loginUrl, "לכתוב המלצה")}
  </div>

  <div class="panel profile-detail" id="scMessageBox">
    <h3>💌 מוזמנת לשלוח הודעה ל ${esc(l.businessName)}, היא תקבל את ההודעה שלך גם במייל :)</h3>
    ${isCustomer ? `
      ${myThread.length ? `<div class="chat-thread" style="text-align:right;">${myThread.map((m) => `<div class="chat-msg from-${m.fromRole}">${esc(m.text)}<span class="chat-meta">${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`).join("")}</div>` : `<p class="muted">עדיין לא כתבתן - זו ההזדמנות לשאול אותה כל מה שמעניין אותך, ישירות.</p>`}
      <form method="post" action="/freelancer/${f.id}/message">
        <input type="hidden" name="listingId" value="${esc(l.id)}" />
        <textarea name="text" placeholder="כתבי הודעה ל ${esc(l.businessName)}..." style="min-height:80px;" required></textarea>
        <button class="btn" style="margin-top:10px;" type="submit">שליחת הודעה</button>
      </form>
    ` : customerOnlyPrompt(ctx, loginUrlToMessage, "לשלוח הודעה ישירה לעצמאית")}
  </div>
  `;
  sendHtml(res, 200, page({ title: l.businessName, session: ctx.session, body, query }));
});

route("POST", "/freelancer/:id/message", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  const text = (body.get("text") || "").trim();
  const listingId = body.get("listingId") || "";
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f || !text) return redirect(res, `/freelancer/${params.id}`);
  const listing = listingId ? (f.additionalListings || []).find((l) => String(l.id) === String(listingId)) : null;
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const id = db.nextId("chat");
  d.chatMessages = d.chatMessages || [];
  d.chatMessages.push({
    id, freelancerId: f.id, customerId: ctx.session.id, fromRole: "customer",
    listingId: listing ? listing.id : null,
    text, date: new Date().toISOString(), read: false,
  });
  db.save();
  notify(f, {
    pushTitle: "הודעה חדשה ב-SheCan", pushBody: `${customer ? customer.name : "לקוחה"}: ${text}`, url: "/freelancer-dashboard",
    emailSubject: `הודעה חדשה ב-SheCan מ${customer ? customer.name : "לקוחה"}`,
    emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(f.name || "")},</p><p>קיבלת הודעה חדשה מ${esc(customer ? customer.name : "לקוחה")} ב-SheCan:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(text)}</p><p>אפשר לענות ישירות מהאזור האישי שלך באתר.</p></div>`,
  }).catch(() => {});
  redirect(res, `/freelancer/${f.id}?ok=${encodeURIComponent("ההודעה נשלחה!")}`);
});

route("POST", "/freelancer/:id/favorite", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  const listingId = body.get("listingId") || "";
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const key = favKey(params.id, listingId);
  const idx = customer.favorites.indexOf(key);
  if (idx === -1) customer.favorites.push(key); else customer.favorites.splice(idx, 1);
  db.save();
  redirect(res, listingId ? `/freelancer/${params.id}/listing/${listingId}` : `/freelancer/${params.id}`);
});

route("POST", "/freelancer/:id/reveal-coupon", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const listingId = body.get("listingId") || "";
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  // הגנת שרת נוספת (מעבר לכך שהקוד עצמו כבר לא מוטמע ב-HTML כשהיא חסומה - ר' couponGated
  // ב-GET /freelancer/:id) - מונעת רישום "צפייה" מזויפת בהיסטוריה שלה/בסטטיסטיקות אם מישהי
  // פונה ל-route הזה ישירות כשמועדון YouCan מופעל והיא לא חברה בו.
  if (d.settings.youCanEnabled) {
    const cust = requireRole(ctx.session, "customer") ? d.customers.find((c) => c.id === ctx.session.id) : null;
    if (!cust || !cust.youCanMember) { res.writeHead(204); return res.end(); }
  }
  if (f) {
    // A reveal can be for the main profile's coupon or for one of her additional listings'
    // own coupon - either way it's still gated behind the same login-required check below,
    // reusing the exact security model rather than duplicating it (the dealCode itself is
    // only ever embedded in the page HTML for an authenticated customer, same as before).
    const listing = listingId ? (f.additionalListings || []).find((l) => String(l.id) === listingId) : null;
    const dealCode = listing ? listing.dealCode : f.dealCode;
    f.couponRevealCount = (f.couponRevealCount || 0) + 1;
    const date = new Date().toISOString();
    d.couponRevealEvents = d.couponRevealEvents || [];
    d.couponRevealEvents.push({ freelancerId: f.id, listingId: listing ? listing.id : null, date });
    if (requireRole(ctx.session, "customer")) {
      const customer = d.customers.find((c) => c.id === ctx.session.id);
      if (customer) {
        customer.revealedCoupons = customer.revealedCoupons || [];
        // Keep just the latest reveal per freelancer+listing, so her list stays a clean
        // "coupons I've unlocked" summary instead of growing a duplicate per click.
        const existing = customer.revealedCoupons.find((r) => r.freelancerId === f.id && (r.listingId || null) === (listing ? listing.id : null));
        if (existing) existing.date = date;
        else customer.revealedCoupons.push({ freelancerId: f.id, listingId: listing ? listing.id : null, dealCode: dealCode || "", date });
      }
    }
    db.save();
  }
  res.writeHead(204);
  res.end();
});

// Anonymous "like" for the homepage weekly quote - open to anyone, not just registered
// customers/freelancers, per explicit request. Recomputes which freelancer's quote (or the
// default admin message) is currently live the same way the homepage does, and bumps that
// entity's own running like counter. The client already updates the count optimistically and
// remembers the like in localStorage (see scLikeWeeklyQuote in layout.js), so this route
// doesn't need to return anything beyond a plain 204.
route("POST", "/weekly-quote/like", async (req, res, params, query, ctx) => {
  const d = db.load();
  const weekly = getWeeklyFeature(d);
  if (weekly.freelancer) {
    weekly.freelancer.weeklyQuoteLikeCount = (weekly.freelancer.weeklyQuoteLikeCount || 0) + 1;
  } else {
    d.settings.weeklyMessageLikeCount = (d.settings.weeklyMessageLikeCount || 0) + 1;
  }
  db.save();
  res.writeHead(204);
  res.end();
});

// A review on a freelancer (or one of her additional listings) now publishes immediately -
// no admin approval queue - since Sapir wants it to show up on the freelancer's card right
// away; the tradeoff is handled by giving admin a dedicated delete button for anything
// inappropriate (see the admin review-management panel) instead of a pre-publish gate. Only
// ONE review per customer per business (main profile counts as one, each additional listing
// counts as its own) - submitting again updates her existing review in place rather than
// creating a duplicate, and that same update path is what her "edit my review" form in her
// personal area uses.
route("POST", "/freelancer/:id/review", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  const listingId = body.get("listingId") || "";
  const backUrl = listingId ? `/freelancer/${params.id}/listing/${listingId}` : `/freelancer/${params.id}`;
  if (body.tooBig) return redirect(res, `${backUrl}?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, backUrl);
  const listing = listingId ? (f.additionalListings || []).find((l) => String(l.id) === String(listingId)) : null;
  const text = (body.get("text") || "").trim();
  if (!text) return redirect(res, `${backUrl}?err=${encodeURIComponent("צריך לכתוב כמה מילים על החוויה.")}`);
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const rating = Math.min(5, Math.max(1, Math.round(Number(body.get("rating")) || 5)));
  const isAnonymous = body.get("isAnonymous") === "1";
  const newPhoto = fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES);
  const existing = d.reviews.find((r) => r.type === "freelancer" && r.targetId === f.id && r.authorCustomerId === customer.id && String(r.listingId || "") === String(listing ? listing.id : ""));
  if (existing) {
    existing.rating = rating;
    existing.text = text;
    existing.isAnonymous = isAnonymous;
    if (newPhoto) existing.photoDataUri = newPhoto;
    existing.updatedAt = new Date().toISOString();
  } else {
    const id = db.nextId("review");
    d.reviews.push({
      id, type: "freelancer", targetId: f.id, listingId: listing ? listing.id : null,
      authorCustomerId: customer.id, authorName: customer.name, isAnonymous,
      rating, text, photoDataUri: newPhoto, status: "approved", createdAt: new Date().toISOString(),
      response: "", responseDate: null,
    });
  }
  db.save();
  redirect(res, `${backUrl}?ok=${encodeURIComponent(existing ? "ההמלצה שלך עודכנה!" : "תודה על ההמלצה! היא כבר מופיעה בכרטיסייה שלה ❤️")}`);
});

// ----- Site reviews page -----
route("GET", "/reviews", async (req, res, params, query, ctx) => {
  const d = db.load();
  const siteReviews = d.reviews.filter((r) => r.type === "site" && r.status === "approved").reverse();
  const isCustomer = requireRole(ctx.session, "customer");
  const body = `
  <h1 class="section-title">מה חברות הקהילה אומרות עלינו</h1>
  ${siteReviews.length ? siteReviews.map(reviewCard).join("") : `<p class="muted" style="text-align:center;">עוד לא כתבו לנו כלום - רוצה להיות הראשונה? ❤️</p>`}
  <div class="panel">
    <h3>ספרי לנו איך היה אצלך</h3>
    ${isCustomer ? `
    <form method="post" action="/reviews" enctype="multipart/form-data">
      ${starInputHtml(5)}
      <label>מה היית רוצה לספר?
      <textarea name="text" required></textarea></label>
      <label>תמונה (לא חובה)
      <input type="file" name="photo" accept="image/*" /></label>
      <button class="btn" style="margin-top:12px;" type="submit">שליחה לאישור</button>
    </form>` : (ctx.session && ctx.session.role === "freelancer"
      ? customerOnlyPrompt(ctx, `/login?next=${encodeURIComponent("/reviews")}`, "לכתוב לנו כמה מילים")
      : `<p class="muted"><a href="/login">מתחברות</a> או <a href="/signup">נרשמות בחינם</a> כדי לכתוב לנו כמה מילים.</p>`)}
  </div>
  `;
  sendHtml(res, 200, page({ title: "המלצות", session: ctx.session, body, query }));
});

route("POST", "/reviews", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/reviews?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const id = db.nextId("review");
  db.load().reviews.push({
    id, type: "site", targetId: null, authorCustomerId: customer.id, authorName: customer.name,
    rating: Math.min(5, Math.max(1, Math.round(Number(body.get("rating")) || 5))), text: body.get("text") || "",
    photoDataUri: fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES), status: "pending",
    createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/reviews?ok=${encodeURIComponent("תודה מכל הלב! ברגע שנעבור עליה היא תעלה לאתר ❤️")}`);
});

// ----- Magazine -----
route("GET", "/magazine", async (req, res, params, query, ctx) => {
  if (!ctx.session) {
    return redirect(res, `/signup?err=${encodeURIComponent("מגזין SheCan פתוח רק לרשומות האתר, הרשמי למטה ותהני ממגזין איכותי")}`);
  }
  const d = db.load();
  const issues = (d.magazines || []).slice().reverse();
  const body = `
  <h1 class="section-title">מגזין SheCan</h1>
  <p class="muted" style="text-align:center;">כל הגיליונות של SheCan, במקום אחד.</p>
  ${issues.length ? `
  <div class="grid">
    ${issues.map((m) => `
      <div class="card">
        <div class="card-photo">📖</div>
        <div class="card-body">
          <h3>${esc(m.title)}</h3>
          ${m.description ? `<div class="muted">${esc(m.description)}</div>` : ""}
          <a class="btn" style="margin-top:10px;text-align:center;" href="${esc(m.url)}" target="_blank" rel="noopener">לצפייה בגיליון</a>
        </div>
      </div>
    `).join("")}
  </div>` : `<p class="muted" style="text-align:center;">הגיליון הראשון בדרך - חכי בסבלנות.</p>`}

  <h2 class="section-title">סיפורי השראה</h2>
  <p class="muted" style="text-align:center;">כל שבוע מכירים מקרוב עצמאית אחת מהקהילה שלנו.</p>
  <a class="btn btn-outline" style="display:block;max-width:220px;margin:14px auto 0;text-align:center;" href="/stories">לכל הסיפורים</a>
  `;
  sendHtml(res, 200, page({ title: "מגזין SheCan", session: ctx.session, body, query }));
});

// Each issue of the digital magazine is a fully self-contained "flipbook" HTML file (page
// images embedded as base64, with a page-turn animation) that Sapir uploads herself directly
// into the EXISTING assets/ folder via the GitHub web UI (plain "Add file -> Upload files",
// no subfolder needed - a nested assets/magazine/ folder was tried first but GitHub's web UI
// choked on creating it, so this deliberately reuses the one folder she already has working).
// The admin "המגזין שלנו" panel above only accepts a URL per issue (not a file upload), so this
// route is what turns an uploaded flipbook file into an actual public link she can paste into
// that "קישור לצפייה" field - e.g. a file uploaded as assets/issue-1.html becomes viewable at
// /magazine/view/issue-1. Only the file PATH per slug is resolved at boot (cheap - just a
// directory listing) - the actual file content is read/streamed from disk on demand, per
// request (see the emergency-fix comment above). A matching assets/<slug>.pdf (same slug as
// the .html flipbook) is optional - when present, the flipbook's own "הורדת המגזין" button
// links to /magazine/download/<slug> so readers can save/print a plain PDF copy instead of the
// interactive page-flip version. Only .html/.pdf files are picked up here, so this coexists
// fine with the .jpg template files that already live in the same assets/ folder for the
// join/review-story features.
const MAGAZINE_DIR = path.join(__dirname, "assets");
const MAGAZINE_ISSUE_FILES = {};
const MAGAZINE_PDF_FILES = {};
try {
  fs.readdirSync(MAGAZINE_DIR).forEach((name) => {
    if (/\.html?$/i.test(name)) {
      MAGAZINE_ISSUE_FILES[name.replace(/\.html?$/i, "")] = path.join(MAGAZINE_DIR, name);
    } else if (/\.pdf$/i.test(name)) {
      MAGAZINE_PDF_FILES[name.replace(/\.pdf$/i, "")] = path.join(MAGAZINE_DIR, name);
    }
  });
} catch (e) {
  console.warn("[magazine] assets/magazine folder not found yet - no flipbook issues loaded (this is fine until the first issue is uploaded).");
}

// EMERGENCY MEMORY FIX (2026-08-22): this used to eagerly read every magazine .html/.pdf file
// into memory at boot with fs.readFileSync (see the removed code, a few lines up in git
// history) and hold it in a MAGAZINE_ISSUES/MAGAZINE_PDFS object for the app's entire lifetime.
// That's fine for a couple of small files, but a flipbook export can easily be tens of MB
// (some formats embed every page as a full-resolution image directly in the HTML) - and this
// ran on EVERY server start, including the extra "old + new instance both briefly alive"
// memory overlap Render does on every single deploy, stacked on top of the full freelancer-
// photo DB already in memory. That combination is the leading suspect for the OOM-at-deploy
// crash loop from tonight. Fixed by keeping only the on-disk file PATH per slug (below), and
// reading/streaming each file's actual content only when someone requests that specific issue
// - so boot time and idle memory no longer depend on how many/how large the uploaded issues
// are at all.
// Pulls the :slug back out of an internal "/magazine/view/<slug>" link stored on a d.magazines
// record, so the admin table can look up that issue's view count (tracked by slug, not by the
// magazine record's own id - see /magazine/view/:slug below) - null for an external link
// (Canva/Google Drive/etc.), which was never trackable in the first place.
function magazineSlugFromUrl(url) {
  const m = /\/magazine\/view\/([^/?#]+)/.exec(url || "");
  return m ? m[1] : null;
}

route("GET", "/magazine/view/:slug", async (req, res, params, query, ctx) => {
  // :slug is matched against pre-resolved filenames only (see MAGAZINE_ISSUE_FILES above) -
  // never used to build a filesystem path directly from the request, so there's no path-
  // traversal concern here.
  const filePath = MAGAZINE_ISSUE_FILES[params.slug];
  if (!filePath) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הגיליון הזה.</p>` }));
  // Counts an actual open of one issue's flipbook - deliberately NOT tracked on GET /magazine
  // (the listing page itself), per explicit request to distinguish "landed on the magazine page"
  // from "actually opened an issue to read it". Keyed by slug (not tied to a d.magazines record,
  // since a flipbook file can exist before/without one) - same throttled-save reasoning as the
  // other per-page-view counters above.
  const d = db.load();
  d.magazineViewCounts = d.magazineViewCounts || {};
  d.magazineViewCounts[params.slug] = (d.magazineViewCounts[params.slug] || 0) + 1;
  saveSiteStatsThrottled();
  // Cache-Control kept short (rather than the long max-age this used to have) specifically
  // because Sapir iterates on the uploaded flipbook file directly (re-uploading the same
  // filename after edits like the clickable-links fix) - a long-lived cache meant her browser
  // could easily keep showing the old cached copy for up to an hour after a redeploy with no
  // visible sign anything was wrong, which is exactly the "I uploaded the new file and nothing
  // changed" confusion this caused once already.
  // Streamed straight from disk (not read into a Buffer first) so serving a large flipbook
  // file never holds its full content in memory at once - see the emergency-fix comment above.
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  fs.createReadStream(filePath).on("error", () => res.end()).pipe(res);
});

route("GET", "/magazine/download/:slug", async (req, res, params, query, ctx) => {
  const filePath = MAGAZINE_PDF_FILES[params.slug];
  if (!filePath) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו קובץ להורדה עבור הגיליון הזה.</p>` }));
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="SheCan-Magazine-${String(params.slug).replace(/[^a-zA-Z0-9_-]/g, "")}.pdf"`,
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).on("error", () => res.end()).pipe(res);
});

// ----- Inspiration stories - כל עצמאית יכולה לענות על כמה שאלות קבועות ולשלוח את הסיפור
// שלה לאישור. הסיפור המוצג מתחלף אוטומטית כל שבוע, לפי סדר ההרשמה של העצמאיות. -----

// Builds the display pieces (title/date/Q&A/comments) shared between the /stories index
// (current featured story) and a story's own permalink page.
function storyDetailHtml(s, d) {
  const f = d.freelancers.find((x) => x.id === s.freelancerId);
  const title = s.title || (f ? `הסיפור של ${f.businessName || f.name}` : "סיפור השראה");
  // The date shown must reflect when the story actually went LIVE on /stories (s.featuredAt,
  // set the moment getCurrentStory() first picks it as the current story - see server.js
  // rotation logic above) - NOT when it was written/approved, which can be well before its
  // real turn in the queue actually comes up. Falls back to approvedAt/createdAt only for the
  // rare case of a direct link to a story that (for some reason) has never been featured yet.
  const dateStr = esc(new Date(s.featuredAt || s.approvedAt || s.createdAt).toLocaleDateString("he-IL"));
  const qaHtml = (s.answers && s.answers.length)
    ? s.answers.map((qa) => `<div style="margin-bottom:16px;"><div class="muted" style="font-weight:800;margin-bottom:4px;">${esc(qa.question)}</div><p style="margin:0;">${esc(qa.answer)}</p></div>`).join("")
    : `<p style="white-space:pre-wrap;">${esc(s.content || "")}</p>`;
  const commentsHtml = (s.comments && s.comments.length)
    ? s.comments.map((c) => `<div class="review" style="margin-bottom:10px;"><div class="review-header"><span class="review-name">${esc(c.customerName)}</span><span class="muted" style="font-size:12px;">${esc(new Date(c.createdAt).toLocaleDateString("he-IL"))}</span></div><div class="review-text">${esc(c.text)}</div></div>`).join("")
    : `<p class="muted">עוד אין תגובות - היי הראשונה להגיב.</p>`;
  // Anonymous "heart" reaction at the end of the story - same simplicity level as the homepage
  // weekly-quote like (see /weekly-quote/like above): open to anyone, not just registered
  // customers, one per browser via localStorage (see scLikeStory in layout.js).
  const likeHtml = `
    <div style="text-align:center;">
      <button type="button" class="story-like-btn" data-story-id="${esc(s.id)}" onclick="scLikeStory(this)" aria-label="סמני לב לסיפור">
        <span class="story-like-icon">🤍</span><span class="story-like-count">${s.likeCount || 0}</span>
      </button>
    </div>`;
  return { f, title, dateStr, qaHtml, commentsHtml, likeHtml };
}

route("GET", "/stories", async (req, res, params, query, ctx) => {
  const d = db.load();
  const isCustomer = requireRole(ctx.session, "customer");
  const current = getCurrentStory(d);
  // "סיפורים קודמים" should only ever show stories that have genuinely already had their turn
  // as the featured story (s.featuredAt set by getCurrentStory) - NOT every approved story,
  // which used to also leak future stories still waiting in the automatic rotation queue.
  const featuredStories = (d.stories || [])
    .filter((s) => s.status === "approved" && s.featuredAt)
    .slice()
    .sort((a, b) => new Date(b.featuredAt) - new Date(a.featuredAt));
  const previousStories = current ? featuredStories.filter((s) => s.id !== current.id) : featuredStories;

  let currentHtml = `<p class="muted" style="text-align:center;">הסיפור הראשון בדרך - חכי בסבלנות.</p>`;
  if (current) {
    const { f, title, dateStr, qaHtml, commentsHtml, likeHtml } = storyDetailHtml(current, d);
    const nextRotationLabel = nextStoryRotationLabel(d);
    currentHtml = `
    <div class="panel">
      <span class="badge">הסיפור המוצג עכשיו</span>
      ${current.photoDataUri ? `<img src="${current.photoDataUri}" alt="" style="width:100%;max-height:320px;object-fit:cover;border-radius:10px;margin:10px 0;" />` : ""}
      <h3>${esc(title)}</h3>
      <p class="muted">${dateStr}</p>
      ${qaHtml}
      ${likeHtml}
      ${f ? `<a class="btn btn-small" style="margin-top:10px;" href="/freelancer/${f.id}">לכרטיסייה של ${esc(f.businessName || f.name)}</a>` : ""}
      ${nextRotationLabel ? `<p class="muted" style="font-size:11px;text-align:center;margin-top:16px;">הסיפור הבא יתעדכן ב-${esc(nextRotationLabel)}</p>` : ""}
      <h4 style="margin-top:24px;">תגובות</h4>
      ${commentsHtml}
      ${isCustomer ? `
        <form method="post" action="/stories/${current.id}/comment" style="margin-top:12px;">
          <textarea name="text" placeholder="מה חשבת על הסיפור?" required></textarea>
          <button class="btn btn-small" style="margin-top:8px;" type="submit">שליחת תגובה</button>
        </form>
      ` : customerOnlyPrompt(ctx, `/login?next=${encodeURIComponent("/stories")}`, "להגיב")}
    </div>`;
  }

  const archiveHtml = isCustomer
    ? (previousStories.length
        ? `<div class="grid">${previousStories.map((s) => {
            const f = d.freelancers.find((x) => x.id === s.freelancerId);
            const title = s.title || (f ? `הסיפור של ${f.businessName || f.name}` : "סיפור השראה");
            return `<div class="card"><div class="card-photo">📖</div><div class="card-body"><h3>${esc(title)}</h3><a class="btn btn-small" style="margin-top:8px;text-align:center;" href="/stories/${s.id}">לקריאת הסיפור</a></div></div>`;
          }).join("")}</div>`
        : `<p class="muted" style="text-align:center;">עוד אין סיפורים קודמים.</p>`)
    : `<p class="muted" style="text-align:center;"><a href="/login" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי לצפות בסיפורים הקודמים.</p>`;

  const isFreelancer = requireRole(ctx.session, "freelancer");
  const storyCta = isFreelancer
    ? `<div class="panel" style="text-align:center;"><h3>יש לך סיפור משלך?</h3><p class="muted">ספרי לנו את הסיפור שלך באזור האישי שלך - זה לוקח כמה דקות.</p><a class="btn" href="/freelancer-dashboard">לכתיבת הסיפור שלי</a></div>`
    : `<div class="panel" style="text-align:center;"><h3>הגיע הזמן שכולן יכירו אותך. בואי לשים את העסק שלך על הבמה.</h3><p class="muted">הצטרפי לקהילת SheCan - את יכולה לכתוב את הסיפור שלך כבר בהרשמה.</p><a class="btn" href="/join">להצטרפות</a></div>`;

  const body = `
  <h1 class="section-title">סיפורי השראה</h1>
  <p class="muted" style="text-align:center;">בכל שבוע אנחנו מכירות לעומק עצמאית אחת מהקהילה. מי היא? איך היא בנתה את האימפריה שלה? ומה הסוד שלה להצלחה? כל מה שאת צריכה כדי לקבל השראה שבועית.</p>
  ${currentHtml}
  <h2 class="section-title">סיפורים קודמים</h2>
  ${archiveHtml}
  ${storyCta}
  `;
  sendHtml(res, 200, page({ title: "סיפורי השראה", session: ctx.session, body, query }));
});

route("GET", "/stories/:id", async (req, res, params, query, ctx) => {
  const d = db.load();
  const s = (d.stories || []).find((x) => x.id === params.id && x.status === "approved");
  if (!s) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הסיפור הזה.</p>` }));
  s.viewCount = (s.viewCount || 0) + 1;
  // Same reasoning as the freelancer-profile view counter fix - this fires on every single
  // story page view, so it goes through the shared throttled save instead of an eager db.save()
  // to avoid reintroducing the full-DB-write-per-request problem that caused the earlier
  // slowness/OOM issues.
  saveSiteStatsThrottled();
  const isCustomer = requireRole(ctx.session, "customer");
  const { f, title, dateStr, qaHtml, commentsHtml, likeHtml } = storyDetailHtml(s, d);
  const nextRotationLabel = nextStoryRotationLabel(d);
  const body = `
  <div class="panel">
    ${s.photoDataUri ? `<img src="${s.photoDataUri}" alt="" style="width:100%;max-height:320px;object-fit:cover;border-radius:10px;margin-bottom:14px;" />` : ""}
    <h1 class="section-title" style="margin-top:0;">${esc(title)}</h1>
    <p class="muted" style="text-align:center;">${dateStr}</p>
    ${qaHtml}
    ${likeHtml}
    ${f ? `<a class="btn btn-small" style="margin-top:10px;" href="/freelancer/${f.id}">לכרטיסייה של ${esc(f.businessName || f.name)}</a>` : ""}
    ${nextRotationLabel ? `<p class="muted" style="font-size:11px;text-align:center;margin-top:16px;">הסיפור הבא באתר יתעדכן ב-${esc(nextRotationLabel)}</p>` : ""}
    <h4 style="margin-top:24px;">תגובות</h4>
    ${commentsHtml}
    ${isCustomer ? `
      <form method="post" action="/stories/${s.id}/comment" style="margin-top:12px;">
        <textarea name="text" placeholder="מה חשבת על הסיפור?" required></textarea>
        <button class="btn btn-small" style="margin-top:8px;" type="submit">שליחת תגובה</button>
      </form>
    ` : customerOnlyPrompt(ctx, `/login?next=${encodeURIComponent(`/stories/${s.id}`)}`, "להגיב")}
  </div>
  `;
  sendHtml(res, 200, page({ title, session: ctx.session, body, query }));
});

route("POST", "/stories/:id/comment", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  const text = (body.get("text") || "").trim();
  const d = db.load();
  const s = (d.stories || []).find((x) => x.id === params.id && x.status === "approved");
  if (!s || !text) return redirect(res, `/stories/${params.id}`);
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  s.comments = s.comments || [];
  s.comments.push({
    id: db.nextId("storyComment"), customerId: customer.id, customerName: customer.name,
    text, createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/stories/${s.id}?ok=${encodeURIComponent("התגובה שלך התווספה!")}`);
});

// Anonymous "heart" reaction on a story, at the bottom of the story text - open to anyone
// (not just registered customers), same pattern as /weekly-quote/like above. The client
// already updates the count optimistically and remembers the like in localStorage per story
// id (see scLikeStory in layout.js), so this route doesn't need to return anything beyond a
// plain 204.
route("POST", "/stories/:id/like", async (req, res, params, query, ctx) => {
  const d = db.load();
  const s = (d.stories || []).find((x) => x.id === params.id && x.status === "approved");
  if (s) {
    s.likeCount = (s.likeCount || 0) + 1;
    db.save();
  }
  res.writeHead(204);
  res.end();
});

// ===================== "הזירה" (The Arena) =====================
// A community hub page with 3 big sections: (1) customers ask questions in a chosen
// field and the freelancers in that field answer, (2) a public advice corner where
// customers post a request and freelancers reply, (3) freelancer-created polls ("מה
// דעתך?") that customers - and anyone with the share link - can vote on.
route("GET", "/arena", async (req, res, params, query, ctx) => {
  const d = db.load();
  const isCustomer = requireRole(ctx.session, "customer");
  const isFreelancer = requireRole(ctx.session, "freelancer");
  const currentFreelancer = isFreelancer ? d.freelancers.find((f) => f.id === ctx.session.id) : null;
  // עצמאית שנכנסת לזירה במצב לקוחה (2026-09-02, לפי בקשה מפורשת) - כשיש שאלה בתחום שלה שהיא
  // עדיין לא ענתה עליה, במקום לא להראות לה שום דבר (currentFreelancer==null כי היא מחוברת
  // כלקוחה), מציגים לה הזמנה לענות + כפתור "מעבר למצב עצמאית" שמחזיר אותה בדיוק לכאן (next).
  const currentCustomer = isCustomer ? d.customers.find((c) => c.id === ctx.session.id) : null;
  const myFreelancerAccount = currentCustomer ? d.freelancers.find((f) => f.email === currentCustomer.email && f.status === "approved") : null;
  const origin = getOrigin(req);

  // הוסר מכאן 2026-08-27 לפי בקשה מפורשת - עד עכשיו רק הכניסה לעמוד /arena (בלי קשר לאיזו
  // לשונית היא בכלל פתחה) כבר סימנה הכל כ"נראה" ומיד ניקתה את התג המספרי ליד "🥊 הזירה"
  // בתפריט, למרות שאף אחת מ-3 הלשוניות לא פתוחה כברירת מחדל (ר' scArenaShowTab ב-layout.js -
  // "nothing is open by default") - כלומר הלקוחה יכלה בכלל לא להגיע ללשונית "מה דעתך?" ועדיין
  // התג נעלם. הסימון כ"נראה" עבר לקרות רק כשהיא באמת פותחת את הלשונית עם הסקרים (ר' קריאת ה-
  // fetch ל-POST /arena/mark-seen בתוך scArenaShowTab), או כשהיא מגיעה ישירות לסקר ספציפי
  // (ר' GET /arena/poll/:id למטה, שלא השתנה).

  // ---- Section 1: אתן שואלות, המומחיות עונות ----
  const catOptions = d.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const approvedQuestions = (d.arenaQuestions || []).filter((q) => q.status === "approved").slice().reverse();
  const questionsHtml = approvedQuestions.length ? approvedQuestions.map((q) => {
    const answers = q.answers || [];
    const askerName = reviewDisplayName({ authorName: q.customerName, isAnonymous: false });
    const catLabel = catName(d, q.categoryId) + (q.subcategoryId ? ` (${subcatName(d, q.categoryId, q.subcategoryId)})` : "");
    // A logged-in freelancer browsing the arena directly (not just via the emailed link) can
    // answer right here if the question is in her own CATEGORY (main profile OR any approved
    // additional listing) - matched on category only, not the specific sub-category, so any
    // freelancer in the same broad field can pitch in even if the asker picked (or the
    // question got tagged with) a more specific sub-category than her own. Email
    // notifications still narrow down to the closer sub-category match when one is set - this
    // only widens who's ALLOWED to answer once she's here looking at the question herself.
    const alreadyAnswered = currentFreelancer ? answers.some((a) => a.freelancerId === currentFreelancer.id) : false;
    const isMatch = currentFreelancer && !alreadyAnswered && !q.closed && (
      currentFreelancer.categoryId === q.categoryId ||
      (currentFreelancer.additionalListings || []).some((l) => l.status === "approved" && l.categoryId === q.categoryId)
    );
    // אותה בדיקת התאמה, רק כשהיא מחוברת כרגע כלקוחה אבל יש לה גם חשבון עצמאית מאושר בתחום
    // הזה - ר' myFreelancerAccount למעלה.
    const myAnsweredAsFreelancer = myFreelancerAccount ? answers.some((a) => a.freelancerId === myFreelancerAccount.id) : false;
    const isMatchAsCustomer = myFreelancerAccount && !myAnsweredAsFreelancer && !q.closed && (
      myFreelancerAccount.categoryId === q.categoryId ||
      (myFreelancerAccount.additionalListings || []).some((l) => l.status === "approved" && l.categoryId === q.categoryId)
    );
    const isOwnQuestion = isCustomer && ctx.session.id === q.customerId;
    return `
    <div class="arena-card">
      <span class="badge badge-arena">${esc(catLabel)}</span>
      ${q.closed ? `<span class="badge badge-outline" style="margin-inline-start:6px;">🔒 סגורה לתשובות</span>` : ""}
      <p class="arena-question-text">${esc(q.questionText)}</p>
      <p class="arena-meta">נשאל/ה על ידי ${esc(askerName)} · ${new Date(q.createdAt).toLocaleDateString("he-IL")}</p>
      ${answers.length ? `
        <button type="button" class="arena-toggle" onclick="scArenaToggle('arena-ans-${q.id}', this)" data-show="+ הצגת ${answers.length} תשובות" data-hide="- הסתרת תשובות">+ הצגת ${answers.length} תשובות</button>
        <div class="arena-answers" id="arena-ans-${q.id}">
          ${answers.map((a) => `<div class="arena-answer"><a class="arena-answer-author" href="/freelancer/${a.freelancerId}" style="text-decoration:underline;">${esc(a.freelancerName)}</a><span class="arena-meta">${new Date(a.createdAt).toLocaleString("he-IL")}</span><p class="arena-answer-text">${esc(a.text)}</p></div>`).join("")}
        </div>
      ` : `<p class="muted" style="font-size:13px;">עוד אין תשובות - המומחיות בתחום קיבלו הודעה ובקרוב תגענה תשובות.</p>`}
      ${isMatch ? `
        <button type="button" class="arena-toggle" onclick="scArenaToggle('arena-answerform-${q.id}', this)" data-show="✍️ יש לך תשובה? עני כאן" data-hide="✕ סגירה">✍️ יש לך תשובה? עני כאן</button>
        <div id="arena-answerform-${q.id}" style="display:none;margin-top:10px;">
          <form method="post" action="/arena/question/${q.id}/answer">
            <textarea name="text" maxlength="800" required placeholder="שתפי את הידע והניסיון שלך..."></textarea>
            <button type="submit" class="btn-arena" style="margin-top:8px;">שליחת התשובה</button>
          </form>
        </div>
      ` : isMatchAsCustomer ? `
        <form method="post" action="/account/switch-to-freelancer" style="margin-top:8px;">
          <input type="hidden" name="next" value="/arena" />
          <p class="muted" style="font-size:13px;margin:0 0 6px;">זו שאלה בתחום שלך - את מחוברת כרגע כלקוחה, עברי למצב עצמאית כדי לענות.</p>
          <button type="submit" class="btn-arena">מעבר למצב עצמאית לעניית השאלה</button>
        </form>
      ` : ""}
      ${isOwnQuestion ? `
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
        <form method="post" action="/arena/question/${q.id}/close"><button type="submit" class="btn btn-small btn-outline">${q.closed ? "🔓 פתיחה מחדש לתשובות" : "🔒 סגירת השאלה לתשובות נוספות"}</button></form>
        <form method="post" action="/arena/question/${q.id}/delete" onsubmit="return confirm('למחוק את השאלה שלך?');"><button type="submit" class="btn btn-small btn-outline">מחיקת השאלה שלי</button></form>
      </div>` : ""}
    </div>`;
  }).join("") : `<p class="muted" style="text-align:center;">עוד אין שאלות בזירה - תהיי הראשונה לשאול!</p>`;

  const askFormHtml = isCustomer ? `
    <form method="post" action="/arena/ask" style="margin-bottom:20px;">
      <label>באיזה תחום השאלה שלך?
      <select name="categoryId" required onchange="scUpdateSubcats(this, document.getElementById('scArenaSubcat'), '');"><option value="">בחרי תחום</option>${catOptions}</select></label>
      <label>תת-תחום (לא חובה)
      <select name="subcategoryId" id="scArenaSubcat"><option value="">בחרי קודם תחום</option></select></label>
      <label>מה השאלה שלך?
      <textarea name="questionText" maxlength="500" required placeholder="לדוגמה: איך יודעים אם קרם לחות מתאים לעור רגיש?"></textarea></label>
      <button type="submit" class="btn-arena" style="margin-top:10px;">שליחת השאלה לאישור</button>
    </form>
  ` : `<p class="muted" style="text-align:center;margin-bottom:20px;"><a href="/login?next=${encodeURIComponent("/arena")}" style="color:var(--arena-dark);font-weight:800;text-decoration:underline;">התחברי כלקוחה</a> כדי לשאול שאלה.</p>`;

  // ---- Section 2: פינת ההתייעצויות ----
  const approvedConsultations = (d.consultations || []).filter((c) => c.status === "approved").slice().reverse();
  const isAdminHere = ctx.session && ctx.session.role === "admin";
  const consultationsHtml = approvedConsultations.length ? approvedConsultations.map((c) => {
    // רק תגובות מאושרות מוצגות לציבור הרחב - מנהלת האתר, כשהיא מחוברת, ממשיכה לראות גם תגובות
    // שממתינות לאישור כאן (בנוסף לפאנל הייעודי בניהול), כדי שיהיה לה עוד מקום נוח לתפוס אותן.
    const replies = (c.replies || []).filter((r) => r.status === "approved" || isAdminHere);
    const askerName = reviewDisplayName({ authorName: c.customerName, isAnonymous: false });
    const isOwnConsultation = isCustomer && ctx.session.id === c.customerId;
    return `
    <div class="arena-card" id="consultation-${c.id}">
      ${c.closed ? `<span class="badge badge-outline" style="margin-bottom:6px;display:inline-block;">🔒 סגורה לתגובות</span>` : ""}
      <p class="arena-question-text">${esc(c.text)}</p>
      <p class="arena-meta">מאת ${esc(askerName)} · ${new Date(c.createdAt).toLocaleDateString("he-IL")}</p>
      ${replies.length ? replies.map((r) => {
        const replyName = r.authorRole === "customer" ? reviewDisplayName({ authorName: r.authorName, isAnonymous: false }) : r.authorName;
        const roleLabel = r.authorRole === "customer" ? "לקוחה" : "עצמאית";
        // Only a freelancer's name links to her profile - a customer replying here doesn't
        // have a public profile page to link to, so hers stays plain text.
        const replyNameHtml = r.authorRole === "freelancer"
          ? `<a class="arena-answer-author" href="/freelancer/${r.authorId}" style="text-decoration:underline;">${esc(replyName)}</a>`
          : `<span class="arena-answer-author">${esc(replyName)}</span>`;
        return `
        <div class="arena-answer">
          ${r.status === "pending" ? `<span class="badge badge-outline" style="margin-inline-end:6px;">⏳ ממתינה לאישור</span>` : ""}
          ${replyNameHtml} <span class="muted" style="font-size:12px;">(${roleLabel})</span><span class="arena-meta">${new Date(r.createdAt).toLocaleString("he-IL")}</span><p class="arena-answer-text">${esc(r.text)}</p>
          ${isAdminHere ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">${r.status === "pending" ? `<form method="post" action="/admin/consultation/${c.id}/reply/${r.id}/approve"><button type="submit" class="btn btn-small">אישור ופרסום</button></form>` : ""}<form method="post" action="/admin/consultation/${c.id}/reply/${r.id}/delete"><button type="submit" class="btn btn-small btn-outline">מחיקת התגובה הזו</button></form></div>` : ""}
        </div>`;
      }).join("") : `<p class="muted" style="font-size:13px;">עוד אין תגובות - מוזמנות לענות ולעזור.</p>`}
      ${c.closed ? `<p class="muted" style="font-size:13px;margin-top:8px;">🔒 בעלת ההתייעצות סגרה אותה לתגובות נוספות.</p>` : (isCustomer || isFreelancer) ? `
        <form method="post" action="/arena/consultation/${c.id}/reply" style="margin-top:10px;">
          <textarea name="text" maxlength="500" required placeholder="שתפי עצה או ניסיון..."></textarea>
          <button type="submit" class="btn btn-small" style="margin-top:6px;">שליחת תגובה</button>
        </form>
      ` : `<p class="muted" style="font-size:13px;margin-top:8px;"><a href="/login?next=${encodeURIComponent("/arena?tab=2")}" style="color:var(--arena-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי להגיב.</p>`}
      ${isOwnConsultation ? `
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
        <form method="post" action="/arena/consultation/${c.id}/close"><button type="submit" class="btn btn-small btn-outline">${c.closed ? "🔓 פתיחה מחדש לתגובות" : "🔒 סגירת ההתייעצות לתגובות נוספות"}</button></form>
        <form method="post" action="/arena/consultation/${c.id}/delete" onsubmit="return confirm('למחוק את ההתייעצות שלך?');"><button type="submit" class="btn btn-small btn-outline">מחיקת ההתייעצות שלי</button></form>
      </div>` : ""}
    </div>`;
  }).join("") : `<p class="muted" style="text-align:center;">עוד אין התייעצויות בזירה.</p>`;

  const consultFormHtml = isCustomer ? `
    <form method="post" action="/arena/consult" style="margin-bottom:20px;">
      <label>מה תרצי להתייעץ עליו?
      <textarea name="consultText" maxlength="500" required placeholder="ספרי בקצרה במה תרצי לקבל עצה מהקהילה..."></textarea></label>
      <button type="submit" class="btn-arena" style="margin-top:10px;">שליחת ההתייעצות לאישור</button>
    </form>
  ` : `<p class="muted" style="text-align:center;margin-bottom:20px;"><a href="/login?next=${encodeURIComponent("/arena")}" style="color:var(--arena-dark);font-weight:800;text-decoration:underline;">התחברי כלקוחה</a> כדי לשלוח התייעצות.</p>`;

  // ---- Section 3: מה דעתך? ----
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const myRecentPoll = currentFreelancer ? (d.polls || []).find((p) => p.freelancerId === currentFreelancer.id && new Date(p.createdAt).getTime() > weekAgo) : null;
  const pollCreateHtml = isFreelancer ? (
    myRecentPoll
      ? `<p class="muted" style="text-align:center;margin-bottom:20px;">כבר פרסמת סקר השבוע - אפשר לפרסם את הבא ב-${new Date(new Date(myRecentPoll.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("he-IL")}.</p>`
      : `
      <div style="text-align:center;margin-bottom:20px;">
        <button type="button" class="btn-arena" onclick="scArenaToggle('arenaPollForm', this)" data-show="➕ פרסום סקר חדש" data-hide="✕ ביטול">➕ פרסום סקר חדש</button>
      </div>
      <div id="arenaPollForm" style="display:none;margin-bottom:20px;">
        <form method="post" action="/arena/poll">
          <label>שאלת הסקר שלך<input type="text" name="question" maxlength="200" required placeholder="לדוגמה: מה הכי חשוב לך כשבוחרים מטפלת?" /></label>
          <label>תשובה 1<input type="text" name="option0" maxlength="80" required /></label>
          <label>תשובה 2<input type="text" name="option1" maxlength="80" required /></label>
          <label>תשובה 3 (לא חובה)<input type="text" name="option2" maxlength="80" /></label>
          <label>תשובה 4 (לא חובה)<input type="text" name="option3" maxlength="80" /></label>
          <button type="submit" class="btn-arena" style="margin-top:10px;">פרסום הסקר</button>
        </form>
      </div>`
  ) : `<p class="muted" style="text-align:center;margin-bottom:20px;">הסקרים כאן נוצרים על ידי העצמאיות שלנו - את מוזמנת לסמן תשובה בכל סקר שמעניין אותך.</p>`;

  // A freelancer-created poll (no `source` field, or source !== "admin") stays visible to
  // everyone exactly as before. An admin-created survey (source: "admin") is targeted - only
  // shown to the audience she picked when creating it, and only to an actually logged-in
  // customer/freelancer (never to an anonymous visitor, since "audience" has no meaning for
  // someone we can't identify as either).
  const pollVisibleToMe = (p) => {
    if (p.source !== "admin") return true;
    if (p.audience === "freelancers") return isFreelancer;
    if (p.audience === "customers") return isCustomer;
    return isCustomer || isFreelancer;
  };
  const activePolls = (d.polls || []).filter(pollVisibleToMe).slice().reverse().slice(0, 20);
  const pollsHtml = activePolls.length ? activePolls.map((p) => {
    const voterKey = arenaVoterKeyReadOnly(req, ctx);
    const canDeletePoll = isFreelancer && ctx.session.id === p.freelancerId;
    return pollCardHtml(p, voterKey, "/arena#poll-" + p.id, `${origin}/arena/poll/${p.id}`, canDeletePoll);
  }).join("") : `<p class="muted" style="text-align:center;">עוד אין סקרים - עצמאיות, זה הזמן לשאול "מה דעתך?"</p>`;

  const body = `
  <div class="arena-hero">
    <div class="arena-hero-deco" aria-hidden="true"><span>❓</span><span>📊</span><span>💡</span><span>❓</span><span>💬</span></div>
    <h1>🥊 הזירה</h1>
    <p>המקום של הקהילה - שאלות ותשובות, ייעוץ הדדי, וסקרים. כל הקולות של SheCan במקום אחד.</p>
  </div>

  <div class="arena-tabs">
    <button type="button" class="arena-tab-btn" onclick="scArenaShowTab(1,this)">
      <span class="arena-tab-icon" aria-hidden="true">🙋‍♀️❓</span>
      <span class="arena-tab-title">אתן שואלות, המומחיות עונות</span>
      <span class="arena-tab-sub">לקוחות מחפשות תשובות? הציגי שאלה מקצועית וקבלי מענה ישירות מהעצמאיות המובחרות שלנו</span>
    </button>
    ${d.settings.arenaConsultationsEnabled ? `
    <button type="button" class="arena-tab-btn" onclick="scArenaShowTab(2,this)">
      <span class="arena-tab-icon" aria-hidden="true">🤝💬</span>
      <span class="arena-tab-title">פינת ההתייעצויות</span>
      <span class="arena-tab-sub">דילמות עסקיות מהשטח – מקום שבו לקוחות ועצמאיות פותחות שולחן ומדברות על הכל</span>
    </button>` : ""}
    <button type="button" class="arena-tab-btn" onclick="scArenaShowTab(3,this)">
      <span class="arena-tab-icon" aria-hidden="true">📊💡</span>
      <span class="arena-tab-title">מה דעתך?</span>
      <span class="arena-tab-sub">סקרים קצרים ומהירים – הזדמנות להשפיע, להצביע ולגלות מה הקהילה חושבת השבוע</span>
    </button>
  </div>

  <div class="arena-section" id="arenaTab1" style="display:none;">
    <h2>אתן שואלות, המומחיות עונות</h2>
    <p class="arena-disclaimer">* SheCan אינה אחראית על תוכן התשובות שנכתבות כאן</p>
    ${askFormHtml}
    ${questionsHtml}
  </div>

  ${d.settings.arenaConsultationsEnabled ? `
  <div class="arena-section" id="arenaTab2" style="display:none;">
    <h2>פינת ההתייעצויות</h2>
    <p class="arena-disclaimer">* SheCan אינה אחראית על תוכן התשובות שנכתבות כאן</p>
    ${consultFormHtml}
    ${consultationsHtml}
  </div>` : ""}

  <div class="arena-section" id="arenaTab3" style="display:none;">
    <h2>מה דעתך?</h2>
    ${pollCreateHtml}
    ${pollsHtml}
  </div>
  `;
  sendHtml(res, 200, page({ title: "הזירה", session: ctx.session, body, query, noSidebars: true }));
});

// נוסף 2026-08-27 לפי בקשה מפורשת - מסמנת "נראה" רק כשהיא באמת פתחה את לשונית הסקרים בזירה
// (ר' ה-fetch ל-scArenaShowTab ב-layout.js), במקום שזה יקרה אוטומטית סתם מהכניסה ל-/arena.
// ראוט קליל בכוונה - שום דבר מלבד לחתום את הזמן, ותמיד עונה 204 כדי שקריאת ה-fetch בצד
// הלקוח (fire-and-forget, בלי לחכות לתשובה) לעולם לא תיכשל בצורה שתפריע לחוויה שלה.
route("POST", "/arena/mark-seen", async (req, res, params, query, ctx) => {
  const isCustomer = requireRole(ctx.session, "customer");
  const isFreelancer = requireRole(ctx.session, "freelancer");
  if (isCustomer || isFreelancer) {
    const d = db.load();
    d.arenaLastSeen = d.arenaLastSeen || {};
    d.arenaLastSeen[`${ctx.session.role}:${ctx.session.id}`] = new Date().toISOString();
    db.save();
  }
  res.writeHead(204);
  res.end();
});

route("POST", "/arena/ask", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?next=${encodeURIComponent("/arena")}`);
  const body = await readBody(req);
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const categoryId = body.get("categoryId") || "";
  const subcategoryId = body.get("subcategoryId") || "";
  const questionText = clip((body.get("questionText") || "").trim(), 500);
  if (!customer || !categoryId || !questionText) {
    return redirect(res, `/arena?tab=1&err=${encodeURIComponent("נא לבחור תחום ולכתוב שאלה.")}`);
  }
  const id = db.nextId("arenaQuestion");
  d.arenaQuestions.push({
    id, customerId: customer.id, customerName: customer.name, categoryId, subcategoryId,
    questionText, status: "pending", createdAt: new Date().toISOString(), answers: [],
  });
  db.save();
  redirect(res, `/arena?tab=1&ok=${encodeURIComponent("השאלה שלך נשלחה לאישור - לאחר האישור היא תישלח למומחיות בתחום.")}`);
});

route("POST", "/arena/consult", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?next=${encodeURIComponent("/arena")}`);
  const d = db.load();
  // הגנת שרת נוספת (מעבר להסתרת הטופס עצמו ב-GET /arena) - במקרה שהפינה כבויה כרגע דרך הטוגל
  // בניהול (ר' d.settings.arenaConsultationsEnabled) אבל מישהי בכל זאת פונה ישירות ל-route הזה.
  if (!d.settings.arenaConsultationsEnabled) return redirect(res, "/arena");
  const body = await readBody(req);
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const text = clip((body.get("consultText") || "").trim(), 500);
  if (!customer || !text) return redirect(res, `/arena?tab=2&err=${encodeURIComponent("נא לכתוב במה תרצי להתייעץ.")}`);
  const id = db.nextId("consultation");
  d.consultations.push({
    id, customerId: customer.id, customerName: customer.name, text,
    status: "pending", createdAt: new Date().toISOString(), replies: [],
  });
  db.save();
  redirect(res, `/arena?tab=2&ok=${encodeURIComponent("ההתייעצות שלך נשלחה לאישור.")}`);
});

route("POST", "/arena/consultation/:id/reply", async (req, res, params, query, ctx) => {
  const isCustomer = requireRole(ctx.session, "customer");
  const isFreelancer = requireRole(ctx.session, "freelancer");
  if (!isCustomer && !isFreelancer) return redirect(res, `/login?next=${encodeURIComponent("/arena")}`);
  const d = db.load();
  if (!d.settings.arenaConsultationsEnabled) return redirect(res, "/arena");
  const body = await readBody(req);
  const c = (d.consultations || []).find((x) => x.id === params.id && x.status === "approved" && !x.closed);
  const text = clip((body.get("text") || "").trim(), 500);
  let author = null;
  if (isFreelancer) {
    const f = d.freelancers.find((x) => x.id === ctx.session.id);
    if (f) author = { authorRole: "freelancer", authorId: f.id, authorName: f.businessName || f.name };
  } else {
    const cust = d.customers.find((x) => x.id === ctx.session.id);
    if (cust) author = { authorRole: "customer", authorId: cust.id, authorName: cust.name };
  }
  if (c && author && text) {
    c.replies = c.replies || [];
    // status:"pending" - לפי בקשה מפורשת 2026-08-30, כל תגובה בפינת ההתייעצויות (הערוץ הפתוח
    // ביותר באתר - גם לקוחות וגם עצמאיות מגיבות זו לזו) עוברת אישור ידני לפני שהיא מתפרסמת
    // (ר' GET /arena, שמסנן להצגה ציבורית רק status==="approved", ו-POST
    // /admin/consultation/:id/reply/:replyId/approve). זה שונה במכוון מתשובות זירה/חוות דעת,
    // שהוחלט להשאיר בפרסום מיידי.
    c.replies.push({ id: db.nextId("consultationReply"), ...author, text, status: "pending", createdAt: new Date().toISOString() });
    db.save();
  }
  redirect(res, `/arena?tab=2&ok=${encodeURIComponent("התגובה שלך נשלחה לאישור - היא תתפרסם לאחר בדיקה.")}#consultation-${params.id}`);
});

// The link a freelancer gets by email when a question in her field is approved - if she isn't
// logged in yet, this sends her to log in first and lands her right back here afterwards.
route("GET", "/arena/question/:id/answer", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) {
    return redirect(res, `/login?role=freelancer&next=${encodeURIComponent(`/arena/question/${params.id}/answer`)}`);
  }
  const d = db.load();
  const q = (d.arenaQuestions || []).find((x) => x.id === params.id && x.status === "approved");
  if (!q) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את השאלה הזו - ייתכן שהיא הוסרה.</p>` }));
  const catLabel = catName(d, q.categoryId) + (q.subcategoryId ? ` (${subcatName(d, q.categoryId, q.subcategoryId)})` : "");
  const alreadyAnswered = (q.answers || []).some((a) => a.freelancerId === ctx.session.id);
  const body = `
  <h1 class="section-title">שאלה מהזירה בתחום שלך</h1>
  <div class="panel" style="max-width:600px;margin:0 auto;">
    <span class="badge badge-arena">${esc(catLabel)}</span>
    <p style="margin:10px 0;font-weight:800;font-size:18px;">${esc(q.questionText)}</p>
    ${q.closed
      ? `<p class="muted">🔒 השואלת סגרה את השאלה הזו ולא ניתן לענות עליה יותר.</p>`
      : alreadyAnswered
      ? `<p class="muted">כבר ענית על השאלה הזו - תודה!</p>`
      : `<form method="post" action="/arena/question/${q.id}/answer">
          <label>התשובה שלך<textarea name="text" maxlength="800" required placeholder="שתפי את הידע והניסיון שלך..."></textarea></label>
          <button type="submit" class="btn-arena" style="margin-top:10px;">שליחת התשובה</button>
        </form>`}
    <p class="muted" style="margin-top:16px;"><a href="/arena">לצפייה בכל הזירה</a></p>
  </div>`;
  sendHtml(res, 200, page({ title: "מענה לשאלה מהזירה", session: ctx.session, body, query, noSidebars: true }));
});

route("POST", "/arena/question/:id/answer", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, `/login?role=freelancer&next=${encodeURIComponent(`/arena/question/${params.id}/answer`)}`);
  const body = await readBody(req);
  const d = db.load();
  const q = (d.arenaQuestions || []).find((x) => x.id === params.id && x.status === "approved" && !x.closed);
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const text = clip((body.get("text") || "").trim(), 800);
  if (q && f && text && !(q.answers || []).some((a) => a.freelancerId === f.id)) {
    q.answers = q.answers || [];
    q.answers.push({ id: db.nextId("arenaAnswer"), freelancerId: f.id, freelancerName: f.businessName || f.name, text, createdAt: new Date().toISOString() });
    db.save();
  }
  redirect(res, `/arena/question/${params.id}/answer?ok=${encodeURIComponent("התשובה שלך נשלחה - תודה!")}`);
});

route("POST", "/arena/poll", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, `/login?next=${encodeURIComponent("/arena")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if (!f) return redirect(res, "/arena");
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentPoll = (d.polls || []).find((p) => p.freelancerId === f.id && new Date(p.createdAt).getTime() > weekAgo);
  if (recentPoll) return redirect(res, `/arena?tab=3&err=${encodeURIComponent("את יכולה לפרסם סקר חדש רק פעם בשבוע.")}`);
  const body = await readBody(req);
  const question = clip((body.get("question") || "").trim(), 200);
  const optionTexts = [0, 1, 2, 3].map((i) => clip((body.get(`option${i}`) || "").trim(), 80)).filter(Boolean);
  if (!question || optionTexts.length < 2) {
    return redirect(res, `/arena?tab=3&err=${encodeURIComponent("נא למלא שאלה ולפחות שתי תשובות אפשריות.")}`);
  }
  const id = db.nextId("poll");
  d.polls.push({
    id, freelancerId: f.id, freelancerName: f.businessName || f.name, question,
    options: optionTexts.map((t) => ({ text: t, votes: 0 })), voters: [], voterChoices: {}, createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/arena?tab=3&ok=${encodeURIComponent("הסקר שלך פורסם!")}#poll-${id}`);
});

route("POST", "/arena/poll/:id/vote", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const d = db.load();
  const poll = (d.polls || []).find((p) => p.id === params.id);
  const redirectTo = safeNextUrl((body.get("redirectTo") || "").split("#")[0]) || "/arena";
  const hash = (body.get("redirectTo") || "").includes("#") ? "#" + body.get("redirectTo").split("#")[1] : "";
  if (!poll || poll.closed) return redirect(res, redirectTo + hash);
  // Same audience gate as the display side (see pollVisibleToMe in /arena and the matching check
  // in /arena/poll/:id) - a direct POST to this endpoint must not let someone vote on a
  // targeted admin survey she was never shown in the first place.
  if (poll.source === "admin") {
    const isCustomerHere = requireRole(ctx.session, "customer");
    const isFreelancerHere = requireRole(ctx.session, "freelancer");
    const visible = poll.audience === "freelancers" ? isFreelancerHere : poll.audience === "customers" ? isCustomerHere : (isCustomerHere || isFreelancerHere);
    if (!visible) return redirect(res, redirectTo + hash);
  }
  const optionIndex = Number(body.get("optionIndex"));
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
    return redirect(res, redirectTo + hash);
  }
  const { voterKey, newCookie } = arenaVoterIdentity(req, ctx);
  poll.voters = poll.voters || [];
  poll.voterChoices = poll.voterChoices || {};
  const alreadyVoted = poll.voters.includes(voterKey);
  const prevChoice = poll.voterChoices[voterKey];
  if (!alreadyVoted) {
    poll.voters.push(voterKey);
    poll.options[optionIndex].votes = (poll.options[optionIndex].votes || 0) + 1;
    poll.voterChoices[voterKey] = optionIndex;
    db.save();
  } else if (prevChoice !== undefined && prevChoice !== optionIndex) {
    // Switching an existing vote to a different option (per explicit request 2026-08-30) -
    // move her vote instead of adding a second one: undo the old option's count, apply the new
    // one. A voter with no recorded prevChoice (voted before this feature existed) falls
    // through here doing nothing - see the matching note in pollCardHtml above.
    if (poll.options[prevChoice]) poll.options[prevChoice].votes = Math.max(0, (poll.options[prevChoice].votes || 0) - 1);
    poll.options[optionIndex].votes = (poll.options[optionIndex].votes || 0) + 1;
    poll.voterChoices[voterKey] = optionIndex;
    db.save();
  }
  redirect(res, redirectTo + hash, newCookie);
});

// Whoever posted a question/consultation/poll can delete it herself, in addition to admin's
// existing (separate) moderation delete routes under /admin/... .
route("POST", "/arena/question/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const q = (d.arenaQuestions || []).find((x) => x.id === params.id && x.customerId === ctx.session.id);
  if (q) {
    d.arenaQuestions = d.arenaQuestions.filter((x) => x.id !== params.id);
    db.save();
  }
  redirect(res, `/arena?tab=1&ok=${encodeURIComponent("השאלה נמחקה.")}`);
});

route("POST", "/arena/consultation/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.consultations || []).find((x) => x.id === params.id && x.customerId === ctx.session.id);
  if (c) {
    d.consultations = d.consultations.filter((x) => x.id !== params.id);
    db.save();
  }
  redirect(res, `/arena?tab=2&ok=${encodeURIComponent("ההתייעצות נמחקה.")}`);
});

route("POST", "/arena/poll/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const p = (d.polls || []).find((x) => x.id === params.id && x.freelancerId === ctx.session.id);
  if (p) {
    d.polls = d.polls.filter((x) => x.id !== params.id);
    db.save();
  }
  redirect(res, `/arena?tab=3&ok=${encodeURIComponent("הסקר נמחק.")}`);
});

// Whoever posted a question/consultation/poll can close it herself, so it stops accepting new
// answers/replies/votes without deleting it - toggled, so she can reopen it again if she
// changes her mind (mirrors the toggle pattern used elsewhere in admin, e.g. toggle-active).
route("POST", "/arena/question/:id/close", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const q = (d.arenaQuestions || []).find((x) => x.id === params.id && x.customerId === ctx.session.id);
  if (q) {
    q.closed = !q.closed;
    db.save();
  }
  redirect(res, `/arena?tab=1&ok=${encodeURIComponent(q && q.closed ? "השאלה נסגרה לתשובות נוספות." : "השאלה נפתחה מחדש לתשובות.")}`);
});

route("POST", "/arena/consultation/:id/close", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.consultations || []).find((x) => x.id === params.id && x.customerId === ctx.session.id);
  if (c) {
    c.closed = !c.closed;
    db.save();
  }
  redirect(res, `/arena?tab=2&ok=${encodeURIComponent(c && c.closed ? "ההתייעצות נסגרה לתגובות נוספות." : "ההתייעצות נפתחה מחדש לתגובות.")}`);
});

route("POST", "/arena/poll/:id/close", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const p = (d.polls || []).find((x) => x.id === params.id && x.freelancerId === ctx.session.id);
  if (p) {
    p.closed = !p.closed;
    db.save();
  }
  redirect(res, `/arena?tab=3&ok=${encodeURIComponent(p && p.closed ? "הסקר נסגר להצבעות נוספות." : "הסקר נפתח מחדש להצבעות.")}`);
});

// The shareable single-poll page - works for anyone, including visitors who never logged in,
// so a freelancer can share this link outside the site (WhatsApp/Instagram) to gather votes.
route("GET", "/arena/poll/:id", async (req, res, params, query, ctx) => {
  const d = db.load();
  const poll = (d.polls || []).find((p) => p.id === params.id);
  if (!poll) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הסקר הזה.</p>` }));
  // Same audience gate as the /arena listing (see pollVisibleToMe there) - an admin survey
  // aimed at freelancers-only (or customers-only) shouldn't become viewable/votable by anyone
  // who happens to get the direct share link, even though the link itself isn't secret.
  if (poll.source === "admin") {
    const isCustomerHere = requireRole(ctx.session, "customer");
    const isFreelancerHere = requireRole(ctx.session, "freelancer");
    const visible = poll.audience === "freelancers" ? isFreelancerHere : poll.audience === "customers" ? isCustomerHere : (isCustomerHere || isFreelancerHere);
    if (!visible) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הסקר הזה.</p>` }));
    // She reached this specific poll directly (e.g. a shared link) - counts as "seen" just
    // like visiting the main /arena listing, so the nav badge (see nav() in layout.js) clears.
    const isCustomerSeen = requireRole(ctx.session, "customer");
    const isFreelancerSeen = requireRole(ctx.session, "freelancer");
    if (isCustomerSeen || isFreelancerSeen) {
      d.arenaLastSeen = d.arenaLastSeen || {};
      d.arenaLastSeen[`${ctx.session.role}:${ctx.session.id}`] = new Date().toISOString();
      db.save();
    }
  }
  const origin = getOrigin(req);
  const voterKey = arenaVoterKeyReadOnly(req, ctx);
  const canDeletePoll = requireRole(ctx.session, "freelancer") && ctx.session.id === poll.freelancerId;
  const body = `
  <div class="arena-hero" style="margin-bottom:24px;">
    <h1>מה דעתך?</h1>
    <p>סקר מהזירה של SheCan</p>
  </div>
  <div style="max-width:520px;margin:0 auto;">
    ${pollCardHtml(poll, voterKey, `/arena/poll/${poll.id}`, `${origin}/arena/poll/${poll.id}`, canDeletePoll)}
  </div>
  <p class="muted" style="text-align:center;margin-top:20px;"><a href="/arena" style="color:var(--arena-dark);font-weight:800;text-decoration:underline;">לצפייה בכל הזירה</a></p>
  `;
  sendHtml(res, 200, page({ title: "מה דעתך? | הזירה", session: ctx.session, body, query, noSidebars: true }));
});

// ----- "מודליסטיות נדרשות" - עצמאית מפרסמת בקשה לעזרה ממודליסטית/תופרת (פרטים/מיקום/מתי),
// כל גולשת (לקוחה או לא) יכולה לצפות ולפנות אליה ישירות דרך עמוד הפרופיל הקיים שלה - שום
// מנגנון פנייה חדש לא נבנה כאן בכוונה, רק קישור לפרופיל עם עוגן ל-#scMessageBox, כדי לעשות
// שימוש חוזר במערכת ההודעות/הטלפון/הוואטסאפ הקיימת. הבקשה מוסרת רק ע"י מי שפרסמה אותה
// (בדיקת בעלות freelancerId === session.id), בדיוק כמו דפוס המחיקה העצמית של הסקרים בזירה. -----
// Redesigned 2026-08-25 per explicit request: title leads with the actual need ("דרושה
// מודליסטית ל: <תחום>") instead of the poster's business name, a single compact meta line
// holds תחום/מיקום/מחיר/תאריך together (was three separate lines including a big decorative
// "✂️" photo block that added height with no real information), and the description is
// clamped to 3 lines so one long request doesn't blow out the whole grid row - the poster's
// name moved to a small "מאת" line near the contact button instead of being the headline.
// r.field is optional for backward compatibility with requests posted before this field
// existed (falls back to omitting the "ל: ..." part of the title and the 🎯 row item).
function patternmakerCard(r, d) {
  const f = d.freelancers.find((x) => x.id === r.freelancerId);
  const name = esc(r.freelancerName || (f && (f.businessName || f.name)) || "עצמאית");
  const field = esc(r.field || "");
  // "מיקום, תשלום, תאריך" - כל אחד בשורה נפרדת ומודגשת משלו (לא עוד שורה אחת מחוברת עם ·),
  // לפי בקשה מפורשת. השדה "תחום" (🎯) לא נכלל כאן - הוא כבר מופיע בכותרת הכרטיסייה למעלה.
  const detailLines = [
    `📍 ${esc(r.location)}`,
    `💰 ${esc(r.price || "ללא תשלום")}`,
    `🗓 ${esc(r.when)}`,
  ];
  // הכרטיסייה משתמשת ב-.card/.card-body המשותפים (flex column), אבל התוכן שמעל הכפתור
  // (תחום/פרטים/תיאור/שם) הוא באורך משתנה מכרטיסייה לכרטיסייה - בלי margin-top:auto על
  // הבלוק התחתון, הכפתור "נוחת" בגובה שונה בכל כרטיסייה, וזה נראה מבולגן בשורה (2026-09-02,
  // לפי בקשה מפורשת לסדר את זה). margin-top:auto דוחף אותו תמיד לתחתית הכרטיסייה, כך שכל
  // הכפתורים בשורה מיושרים באותו גובה בדיוק, ללא קשר לכמות הטקסט שמעליהם.
  return `
  <div class="card">
    <div class="card-body" style="padding:18px;">
      <h3 style="margin:0 0 8px;font-size:17px;line-height:1.3;">✂️ דרושה מודליסטית${field ? ` ל: ${field}` : ""}</h3>
      ${detailLines.map((line) => `<p style="margin:0 0 4px;font-size:14px;font-weight:700;">${line}</p>`).join("")}
      <p style="margin:8px 0 12px;font-size:14px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">${esc(r.details)}</p>
      <p style="margin:0 0 10px;font-size:16px;font-weight:800;">מאת: ${name}</p>
      <div style="margin-top:auto;">
        ${f && f.status === "approved" && f.active !== false
          ? `<a class="btn btn-small" style="text-align:center;display:block;" href="/freelancer/${f.id}#scMessageBox">לצפייה בפרופיל וליצירת קשר</a>`
          : `<p class="muted" style="font-size:12px;margin:0;">הפרופיל שפרסם/ה את הבקשה כרגע לא זמין.</p>`}
      </div>
    </div>
  </div>`;
}

route("GET", "/patternmakers", async (req, res, params, query, ctx) => {
  const d = db.load();
  const isFreelancer = requireRole(ctx.session, "freelancer");
  const me = isFreelancer ? d.freelancers.find((x) => x.id === ctx.session.id) : null;
  const requests = (d.patternmakerRequests || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const myRequests = me ? requests.filter((r) => r.freelancerId === me.id) : [];
  const body = `
  <h1 class="section-title">✂️ מודליסטיות</h1>
  <p class="muted" style="text-align:center;font-size:12.5px;line-height:1.35;max-width:560px;margin:2px auto 12px;">עצמאית שצריכה עזרה ממודליסטית או תופרת? כאן המקום לפרסם בקשה - וכל לקוחה שרואה יכולה לפנות אלייך ישירות דרך הפרופיל שלך.</p>
  ${me ? `
    <div class="panel" style="max-width:560px;margin:0 auto 24px;">
      <h3>פרסום בקשה חדשה</h3>
      <form method="post" action="/patternmakers/add">
        <label>תחום (למה בדיוק את צריכה עזרה)<input type="text" name="field" required maxlength="80" placeholder="לדוגמה: שמלות ערב, תיקונים, בגדי ים..." /></label>
        <label>מיקום<input type="text" name="location" required maxlength="100" placeholder="לדוגמה: תל אביב, או אצלי בסטודיו" /></label>
        <label>מחיר<input type="text" name="price" maxlength="100" placeholder="לדוגמה: 150 ₪ - או השאירי ריק ויוצג 'ללא תשלום'" /></label>
        <label>תאריך<input type="text" name="when" required maxlength="100" placeholder="לדוגמה: בהקדם / יום שלישי בבוקר" /></label>
        <label>תיאור<textarea name="details" required maxlength="500" placeholder="לדוגמה: צריכה עזרה בתפירת שמלות ערב, כמות קטנה..."></textarea></label>
        <button class="btn" type="submit" style="margin-top:10px;">פרסום הבקשה</button>
      </form>
    </div>
    ${myRequests.length ? `
    <div class="panel" style="max-width:560px;margin:0 auto 24px;">
      <h3>הבקשות שלך</h3>
      ${myRequests.map((r) => `
        <div style="border-top:1px solid var(--rose);padding:10px 0;">
          <p style="margin:0 0 4px;font-weight:700;">✂️ דרושה מודליסטית${r.field ? ` ל: ${esc(r.field)}` : ""}</p>
          <p style="margin:0 0 4px;">${esc(r.details)}</p>
          <p class="muted" style="margin:0 0 8px;font-size:13px;">📍 ${esc(r.location)} · 💰 ${esc(r.price || "ללא תשלום")} · 🗓 ${esc(r.when)}</p>
          <form method="post" action="/patternmakers/${r.id}/delete" onsubmit="return confirm('הבקשה כבר לא רלוונטית? היא תוסר לצמיתות.');">
            <button class="btn btn-small btn-outline" type="submit">הבקשה כבר לא רלוונטית - הסרה</button>
          </form>
        </div>
      `).join("")}
    </div>` : ""}
  ` : `<p class="muted" style="text-align:center;font-size:12.5px;"><a href="/login?role=freelancer&next=${encodeURIComponent("/patternmakers")}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי כעצמאית</a> כדי לפרסם בקשה משלך.</p>`}

  <div class="grid">
    ${requests.length ? requests.map((r) => patternmakerCard(r, d)).join("") : `<p class="muted" style="text-align:center;">עדיין אין בקשות פעילות - היי הראשונה לפרסם.</p>`}
  </div>
  `;
  sendHtml(res, 200, page({ title: "מודליסטיות", session: ctx.session, body, query }));
});

route("POST", "/patternmakers/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, `/login?role=freelancer&next=${encodeURIComponent("/patternmakers")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if (!f) return redirect(res, "/patternmakers");
  const body = await readBody(req);
  const field = clip((body.get("field") || "").trim(), 80);
  const details = clip((body.get("details") || "").trim(), 500);
  const location = clip((body.get("location") || "").trim(), 100);
  const when = clip((body.get("when") || "").trim(), 100);
  // מחיר הוא שדה חופשי ולא חובה - ברירת המחדל כשלא מולא כלום היא "ללא תשלום", לפי בקשה מפורשת.
  const price = clip((body.get("price") || "").trim(), 100) || "ללא תשלום";
  if (!field || !details || !location || !when) {
    return redirect(res, `/patternmakers?err=${encodeURIComponent("נא למלא תחום, פרטים, מיקום ותאריך.")}`);
  }
  const id = db.nextId("patternmakerRequest");
  d.patternmakerRequests = d.patternmakerRequests || [];
  d.patternmakerRequests.push({
    id, freelancerId: f.id, freelancerName: f.businessName || f.name,
    field, details, location, when, price, createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/patternmakers?ok=${encodeURIComponent("הבקשה שלך פורסמה!")}`);
});

route("POST", "/patternmakers/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const r = (d.patternmakerRequests || []).find((x) => x.id === params.id && x.freelancerId === ctx.session.id);
  if (r) {
    d.patternmakerRequests = d.patternmakerRequests.filter((x) => x.id !== params.id);
    db.save();
  }
  redirect(res, `/patternmakers?ok=${encodeURIComponent("הבקשה הוסרה.")}`);
});

// ===================== "בקשות שירות" (נוסף 2026-08-26) =====================
// ההפך מ-patternmakerRequests למעלה: כאן לקוחה מפרסמת בקשה לשירות ספציפי (למשל "מעצבת שיער
// ל-2 אחיות בראשון לציון") שממוינת לפי קטגוריה - לא לוח פתוח לכולן, אלא "ליד" ממוקד שמוצג
// רק לעצמאיות מאותה קטגוריה (ר' serviceRequestsSectionHtml, נקרא מ-GET /freelancer-dashboard),
// ורק למי שמסומנת tier==="premium" אם d.settings.serviceRequestsPremiumOnly דלוק - כל עוד
// הדגל הזה כבוי (ברירת המחדל) זה פתוח לכל עצמאית מאושרת בקטגוריה, לפי בקשה מפורשת.
function serviceRequestCard(r, d) {
  const detailLines = [
    r.eventDate ? `🗓 ${esc(r.eventDate)}` : "",
    r.budget ? `💰 ${esc(r.budget)}` : "",
    r.peopleCount ? `👥 ${esc(r.peopleCount)}` : "",
    r.cityId ? `📍 ${esc(cityName(d, r.cityId))}` : "",
  ].filter(Boolean);
  const contactRows = [
    r.phone ? `<div class="profile-detail-row"><span class="profile-detail-icon">📞</span><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></div>` : "",
    (r.hasWhatsapp && r.phone) ? `<div class="profile-detail-row"><span class="profile-detail-icon">${whatsappIconSvg}</span><a class="whatsapp-link" href="https://wa.me/${esc(waPhoneDigits(r.phone))}" target="_blank" rel="noopener">WhatsApp</a></div>` : "",
    r.email ? `<div class="profile-detail-row"><span class="profile-detail-icon">📧</span><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></div>` : "",
  ].filter(Boolean).join("");
  return `
  <div class="panel" style="background:var(--cream);">
    <h4 style="margin:0 0 6px;">${esc(r.title)}</h4>
    <p class="muted" style="margin:0 0 6px;font-size:13px;">${esc(subcatName(d, r.categoryId, r.subcategoryId) || catName(d, r.categoryId))}</p>
    ${detailLines.length ? `<p style="margin:0 0 8px;font-weight:700;font-size:14px;">${detailLines.join(" · ")}</p>` : ""}
    ${r.description ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.4;">${esc(r.description)}</p>` : ""}
    ${contactRows}
  </div>`;
}

// עמוד הלקוחה - יצירה/עריכה/מחיקה של הבקשות שלה. בכוונה בלי רשימת "כל הבקשות הפתוחות" פה
// (בשונה מ-/patternmakers שפתוח לכולן) - זו לא לוח מודעות ציבורי, רק ניהול הבקשות שהיא עצמה
// פרסמה. אפשר להגיע לכאן עם ?category=X (למשל מכפתור ב-/search) כדי למלא מראש את הקטגוריה.
route("GET", "/service-requests", async (req, res, params, query, ctx) => {
  const d = db.load();
  const isCustomer = requireRole(ctx.session, "customer");
  const customer = isCustomer ? d.customers.find((c) => c.id === ctx.session.id) : null;
  const preselectCategory = query.get("category") || "";
  const catOptions = d.categories.map((c) => `<option value="${c.id}" ${c.id === preselectCategory ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const subcatOptions = preselectCategory ? subcategoriesOf(d, preselectCategory).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("") : "";
  const myRequests = customer ? (d.serviceRequests || []).filter((r) => r.customerId === customer.id).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) : [];
  const body = `
  <h1 class="section-title">📣 בקשת שירות מעצמאיות</h1>
  <p class="muted" style="text-align:center;">לא מוצאת בדיוק את מי שאת צריכה? פרסמי בקשה עם הפרטים שלך - היא תישלח ישירות לעצמאיות בתחום הזה, והן יוכלו לפנות אלייך.</p>
  ${customer ? `
    <div class="panel" style="max-width:560px;margin:0 auto 24px;">
      <h3>פרסום בקשה חדשה</h3>
      <form method="post" action="/service-requests/add">
        <label>באיזה תחום את צריכה עזרה?<select name="category" id="scSRCategory" required onchange="scUpdateSubcats(this, document.getElementById('scSRSubcat'), '', 'לא חובה')"><option value="">בחרי תחום</option>${catOptions}</select></label>
        <label>תת-תחום (לא חובה)<select name="subcategory" id="scSRSubcat"><option value="">${preselectCategory ? "לא חובה" : "בחרי קודם תחום"}</option>${subcatOptions}</select></label>
        <label>כותרת קצרה<input type="text" name="title" required maxlength="100" placeholder="לדוגמה: מעצבת שיער ל-2 אחיות" /></label>
        <label>פרטים נוספים<textarea name="description" maxlength="500" placeholder="ספרי בקצרה מה בדיוק את צריכה"></textarea></label>
        <label>תאריך (לא חובה)<input type="text" name="eventDate" maxlength="100" placeholder="לדוגמה: 14.9.2026 או גמיש" /></label>
        <label>תקציב (לא חובה)<input type="text" name="budget" maxlength="100" placeholder="לדוגמה: עד 500 ₪" /></label>
        <label>כמות אנשים (לא חובה)<input type="text" name="peopleCount" maxlength="60" placeholder="לדוגמה: 2 אחיות" /></label>
        <label>עיר (לא חובה)${cityAutocompleteHtml({ fieldName: "city", placeholder: "מאיזו עיר?" })}</label>
        <label>טלפון ליצירת קשר<input type="text" name="phone" value="${esc(customer.phone || "")}" placeholder="050-1234567" /></label>
        <label style="display:flex;align-items:center;gap:6px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" style="width:auto;" /><span>אותו מספר זמין גם ב-WhatsApp</span></label>
        <label>אימייל ליצירת קשר<input type="email" name="email" value="${esc(customer.email)}" /></label>
        <button class="btn" style="width:100%;margin-top:16px;" type="submit">פרסום הבקשה</button>
      </form>
    </div>
    ${myRequests.length ? `
    <div class="panel" style="max-width:560px;margin:0 auto;">
      <h3>הבקשות שלך</h3>
      ${myRequests.map((r) => `
        <div style="border-top:1px solid var(--rose);padding:10px 0;">
          <p style="margin:0 0 4px;font-weight:700;">${esc(r.title)}</p>
          <p class="muted" style="margin:0 0 8px;font-size:13px;">${esc(subcatName(d, r.categoryId, r.subcategoryId) || catName(d, r.categoryId))}</p>
          <div style="display:flex;gap:10px;">
            <a class="btn btn-small btn-outline" href="/service-requests/${r.id}/edit">עריכה</a>
            <form method="post" action="/service-requests/${r.id}/delete" onsubmit="return confirm('הבקשה כבר לא רלוונטית? היא תוסר לצמיתות.');"><button class="btn btn-small btn-outline" type="submit">הסרה</button></form>
          </div>
        </div>
      `).join("")}
    </div>` : ""}
  ` : `<p class="muted" style="text-align:center;"><a href="/login?role=customer&next=${encodeURIComponent("/service-requests")}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי כלקוחה</a> כדי לפרסם בקשה משלך.</p>`}
  `;
  sendHtml(res, 200, page({ title: "בקשת שירות", session: ctx.session, body, query }));
});

route("POST", "/service-requests/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/service-requests")}`);
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  if (!customer) return redirect(res, "/service-requests");
  const body = await readBody(req);
  const categoryId = d.categories.find((c) => c.id === body.get("category")) ? body.get("category") : "";
  const title = clip((body.get("title") || "").trim(), 100);
  if (!categoryId || !title) return redirect(res, `/service-requests?err=${encodeURIComponent("נא לבחור תחום ולמלא כותרת.")}`);
  const subcategoryId = (subcategoriesOf(d, categoryId).some((s) => s.id === body.get("subcategory"))) ? body.get("subcategory") : "";
  const now = new Date().toISOString();
  d.serviceRequests = d.serviceRequests || [];
  d.serviceRequests.push({
    id: db.nextId("serviceRequest"),
    customerId: customer.id,
    categoryId, subcategoryId, title,
    description: clip((body.get("description") || "").trim(), 500),
    eventDate: clip((body.get("eventDate") || "").trim(), 100),
    budget: clip((body.get("budget") || "").trim(), 100),
    peopleCount: clip((body.get("peopleCount") || "").trim(), 60),
    cityId: body.get("city") || "",
    phone: clip((body.get("phone") || "").trim(), 30),
    hasWhatsapp: body.get("hasWhatsapp") === "1",
    email: clip((body.get("email") || "").trim(), 150) || customer.email,
    createdAt: now,
    updatedAt: now,
  });
  db.save();
  redirect(res, `/service-requests?ok=${encodeURIComponent("הבקשה שלך פורסמה!")}`);
});

route("GET", "/service-requests/:id/edit", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const r = (d.serviceRequests || []).find((x) => x.id === params.id && x.customerId === ctx.session.id);
  if (!r) return redirect(res, `/service-requests?err=${encodeURIComponent("הבקשה לא נמצאה.")}`);
  const catOptions = d.categories.map((c) => `<option value="${c.id}" ${c.id === r.categoryId ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const subcatOptions = subcategoriesOf(d, r.categoryId).map((s) => `<option value="${s.id}" ${s.id === r.subcategoryId ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  const body = `
  <h1 class="section-title">עריכת בקשה</h1>
  <div class="panel" style="max-width:560px;margin:0 auto;">
    <form method="post" action="/service-requests/${r.id}/edit">
      <label>באיזה תחום את צריכה עזרה?<select name="category" id="scSREditCategory" required onchange="scUpdateSubcats(this, document.getElementById('scSREditSubcat'), '', 'לא חובה')"><option value="">בחרי תחום</option>${catOptions}</select></label>
      <label>תת-תחום (לא חובה)<select name="subcategory" id="scSREditSubcat"><option value="">לא חובה</option>${subcatOptions}</select></label>
      <label>כותרת קצרה<input type="text" name="title" required maxlength="100" value="${esc(r.title)}" /></label>
      <label>פרטים נוספים<textarea name="description" maxlength="500">${esc(r.description || "")}</textarea></label>
      <label>תאריך (לא חובה)<input type="text" name="eventDate" maxlength="100" value="${esc(r.eventDate || "")}" /></label>
      <label>תקציב (לא חובה)<input type="text" name="budget" maxlength="100" value="${esc(r.budget || "")}" /></label>
      <label>כמות אנשים (לא חובה)<input type="text" name="peopleCount" maxlength="60" value="${esc(r.peopleCount || "")}" /></label>
      <label>עיר (לא חובה)${cityAutocompleteHtml({ fieldName: "city", selectedId: r.cityId || "", selectedName: r.cityId ? cityName(d, r.cityId) : "", placeholder: "מאיזו עיר?" })}</label>
      <label>טלפון ליצירת קשר<input type="text" name="phone" value="${esc(r.phone || "")}" /></label>
      <label style="display:flex;align-items:center;gap:6px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" ${r.hasWhatsapp ? "checked" : ""} style="width:auto;" /><span>אותו מספר זמין גם ב-WhatsApp</span></label>
      <label>אימייל ליצירת קשר<input type="email" name="email" value="${esc(r.email || "")}" /></label>
      <button class="btn" style="width:100%;margin-top:16px;" type="submit">שמירת השינויים</button>
    </form>
    <p class="muted" style="margin-top:14px;"><a href="/service-requests">← חזרה לבקשות שלי</a></p>
  </div>
  `;
  sendHtml(res, 200, page({ title: "עריכת בקשה", session: ctx.session, body, query }));
});

route("POST", "/service-requests/:id/edit", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const r = (d.serviceRequests || []).find((x) => x.id === params.id && x.customerId === ctx.session.id);
  if (!r) return redirect(res, `/service-requests?err=${encodeURIComponent("הבקשה לא נמצאה.")}`);
  const body = await readBody(req);
  const categoryId = d.categories.find((c) => c.id === body.get("category")) ? body.get("category") : r.categoryId;
  const title = clip((body.get("title") || "").trim(), 100);
  if (!title) return redirect(res, `/service-requests/${r.id}/edit?err=${encodeURIComponent("נא למלא כותרת.")}`);
  // "יתעדכן אוטומטית" לפי בקשה מפורשת - עורכים ישירות את אותה רשומה (לא יוצרים העתק), כך
  // שכל מקום שמציג אותה (ר' serviceRequestCard בלוח הבקשות של עצמאית) מציג תמיד את הגרסה
  // העדכנית בלי שום קוד סנכרון נוסף.
  r.categoryId = categoryId;
  r.subcategoryId = (subcategoriesOf(d, categoryId).some((s) => s.id === body.get("subcategory"))) ? body.get("subcategory") : "";
  r.title = title;
  r.description = clip((body.get("description") || "").trim(), 500);
  r.eventDate = clip((body.get("eventDate") || "").trim(), 100);
  r.budget = clip((body.get("budget") || "").trim(), 100);
  r.peopleCount = clip((body.get("peopleCount") || "").trim(), 60);
  r.cityId = body.get("city") || "";
  r.phone = clip((body.get("phone") || "").trim(), 30);
  r.hasWhatsapp = body.get("hasWhatsapp") === "1";
  r.email = clip((body.get("email") || "").trim(), 150);
  r.updatedAt = new Date().toISOString();
  db.save();
  redirect(res, `/service-requests?ok=${encodeURIComponent("הבקשה עודכנה!")}`);
});

route("POST", "/service-requests/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const r = (d.serviceRequests || []).find((x) => x.id === params.id && x.customerId === ctx.session.id);
  if (r) {
    d.serviceRequests = d.serviceRequests.filter((x) => x.id !== params.id);
    db.save();
  }
  redirect(res, `/service-requests?ok=${encodeURIComponent("הבקשה הוסרה.")}`);
});

// ===================== "מאגרי קהילה" (נוסף 2026-08-26) =====================
// שמונה סוגי משאבים קהילתיים שכולם חיים באותה רשימה אחת (d.communityListings), מובחנים
// לפי type - ר' ההערה על communityListings ב-db.js. tags הם רשימת תת-קטגוריות חופשית לכל
// סוג, לבחירה בטופס ההוספה ולסינון בדף הדפדוף.
const COMMUNITY_TYPE_ORDER = ["gemach", "rental", "workshop", "class", "giveaway", "sale", "dressWanted", "tutor", "product"];
// אפשרות תגובה (כוכבים + טקסט, ר' d.reviews עם type:"community") קיימת רק ב-3 מתוך 9
// הסוגים - חוגים, מורות פרטיות והמלצות מוצרים - לא בשאר. נבדק גם בטופס (מוצג רק לסוגים
// האלה) וגם ב-route עצמו (הגנה כפולה - ר' POST /community/:type/:id/review).
const COMMUNITY_REVIEWABLE_TYPES = ["class", "tutor", "product"];
// תגית "שמלות ערב" המשותפת ל-rental.tags ו-sale.tags למטה - קבוע יחיד במקום מחרוזת
// מוקלדת פעמיים, כדי שאי אפשר יהיה לטעות בין השתיים (ר' גם השימוש בה בסינון השכרות למטה).
const DRESS_TAG = "שמלות ערב (צנועות בלבד)";
// רשימות סגורות לסינון/טפסים של פרטי שמלה (צבע/אורך/קהל יעד) - רלוונטי רק להשכרת שמלות
// (ר' ההערה המורחבת ליד GET /community/:type על סינון השכרת שמלות, לפי בקשה מפורשת).
const DRESS_COLORS = ["שחור", "לבן", "אדום/בורדו", "כחול/נייבי", "ורוד", "ירוק", "זהב", "כסף", "סגול", "אפור", "בז'/חום", "רב-גוני", "אחר"];
const DRESS_LENGTHS = ["קצרה", "מידי (עד/מתחת לברך)", "ארוכה"];
const DRESS_AUDIENCES = ["נשים", "ילדות"];
const COMMUNITY_TYPES = {
  gemach: {
    label: "גמ\"חים", singular: "גמ\"ח", icon: "🤲",
    desc: "השאלת חפצים בחינם - מציוד תינוקות ועד כלי עבודה",
    tags: ["ציוד תינוקות", "כלי עבודה", "ביגוד", "שמלות כלה וערב", "ציוד רפואי", "ספרים ומשחקים", "אחר"],
  },
  rental: {
    label: "השכרות", singular: "השכרה", icon: "📦",
    desc: "השכרת ציוד לאירועים, קמפינג ועוד",
    // DRESS_TAG נוסף לפי בקשה מפורשת - קטגוריה ייעודית להשכרת שמלות ערב צנועות, באותה
    // תגית בדיוק גם ב-sale.tags למטה כדי שאותה שמלה תוכל להיות מושכרת או נמכרת (שתי
    // רשומות נפרדות, אחת בכל סוג, לפי מה שהמוכרת/המשכירה בחרה).
    tags: ["ציוד לאירועים", "קמפינג וטיולים", "ציוד לתינוקות", "ריהוט", DRESS_TAG, "אחר"],
  },
  workshop: {
    label: "סדנאות", singular: "סדנה", icon: "🎨",
    desc: "סדנאות חד-פעמיות ומעגליות בתחומים מגוונים",
    tags: ["בישול ואפייה", "אמנות ויצירה", "העצמה אישית", "הורות", "עסקים", "אחר"],
  },
  class: {
    label: "חוגים", singular: "חוג", icon: "🎯",
    desc: "חוגים קבועים לילדים ולמבוגרים",
    tags: ["ספורט ותנועה", "אמנות", "מוזיקה", "שפות", "מדעים וטכנולוגיה", "אחר"],
  },
  // "מסירות" - חפצים שכבר לא צריכים ואפשר למסור למישהי אחרת בחינם (לא הלוואה כמו גמ"ח -
  // מסירה חד-פעמית וסופית). בשונה מ-6 הסוגים האחרים, פרסום פריט כאן דורש חשבון לקוחה מחובר
  // (ר' route GET/POST /community/giveaway/add) כדי שהמפרסמת תוכל אחר כך להיכנס ל"אזור
  // האישי" שלה ולהוריד את הפריט לגמרי ברגע שהוא כבר נמסר - ר' communityListing.ownerCustomerId.
  giveaway: {
    label: "מסירות", singular: "מסירה", icon: "🎁",
    desc: "חפצים שכבר לא צריכות - נמסרים בחינם למי שיכולה להשתמש בהם",
    // הורחב משמעותית לפי בקשה מפורשת ("שיהיו הרבה יותר [קטגוריות] כמו מכשירי חשמל כלים
    // גינון וכו וכו") - פוצל כל תג רחב מדי לכמה תגים ממוקדים יותר, ונוספו קטגוריות חדשות
    // שלא היו קיימות בכלל (כלי עבודה, גינון, אלקטרוניקה, בעלי חיים, יודאיקה וכו').
    tags: ["ריהוט", "ציוד תינוקות ולידה", "ביגוד והנעלה", "מכשירי חשמל קטנים", "מכשירי חשמל גדולים", "כלי עבודה וכלים", "גינון וחוץ", "כלי בית ומטבח", "ספרים", "צעצועים ומשחקים", "ספורט ופנאי", "אלקטרוניקה ומחשבים", "ציוד לבעלי חיים", "יודאיקה וחגים", "אחר"],
  },
  // "מכירת יד 2" - בדיוק כמו "מסירות" (אותה דרישת חשבון לקוחה מחובר + הורדה עצמית ברגע
  // שהפריט כבר נמכר, ר' communityAddUrl/take-down למטה), רק עם שדה price - חפצים שרוצות
  // למכור, לא למסור בחינם. נוסף לפי בקשה מפורשת של שפיר.
  sale: {
    label: "מכירת יד 2", singular: "פריט למכירה", icon: "💰",
    desc: "חפצים שכבר לא צריכות ורוצות למכור - במחיר שהגדירה המוכרת",
    // DRESS_TAG - אותה תגית בדיוק כמו ב-rental.tags למעלה, ר' ההערה שם.
    tags: ["ריהוט", "ציוד תינוקות", "ביגוד", "מכשירי חשמל", "ספרים וצעצועים", DRESS_TAG, "אחר"],
  },
  // "דרושות שמלות" - כפתור/קטגוריה ייעודית לפי בקשה מפורשת: לקוחה שמחפשת שמלה (ערב, כלה,
  // לילדה, ואפילו סט שמלות למשפחה שלמה) מפרסמת בקשה עם פרטי קשר, ועצמאיות/לקוחות עם שמלה
  // מתאימה יכולות לפנות אליה. פתוח לכולן בלי חשבון (כמו gemach/rental/workshop/class/tutor/
  // product) - לא דורש חשבון לקוחה מחובר כמו giveaway/sale, כי אין כאן צורך "להוריד" את
  // הבקשה בעצמה מאוחר יותר. עובר דרך כל התשתית הכללית הקיימת (טופס פתוח, אישור אדמין,
  // עמוד פריט, כרטיס) בלי צורך בקוד ייעודי - בדיוק כמו שאר הסוגים הפתוחים.
  dressWanted: {
    label: "דרושות שמלות", singular: "בקשה לשמלה", icon: "🙋‍♀️",
    desc: "מחפשת שמלת ערב, שמלת כלה, שמלה לילדה או אפילו סט שמלות למשפחה? פרסמי בקשה - עצמאיות ולקוחות עם שמלה מתאימה יוכלו לפנות אלייך",
    tags: ["שמלת ערב", "שמלת כלה", "שמלה לילדה", "סט משפחתי", "אחר"],
  },
  tutor: {
    label: "מורות פרטיות", singular: "מורה פרטית", icon: "📚",
    desc: "שיעורים פרטיים בכל הגילאים והתחומים",
    tags: ["מתמטיקה", "אנגלית", "עברית", "מדעים", "מוזיקה", "שפה נוספת", "אחר"],
  },
  // "המלצות מוצרים" - שונה משאר הסוגים באופיו: לא שירות/פריט למסירה/השכרה עם פרטי קשר, אלא
  // תוכן ביקורת (UGC) - מוצר שקנו, עם דגם/מחיר/איפה קנו. לכן אין כאן עיר/כתובת/טלפון/מייל
  // ציבוריים בכלל - ר' הטיפול המותנה לפי type==="product" בטופס ההוספה ובפאנל הניהול.
  product: {
    label: "המלצות מוצרים", singular: "המלצה", icon: "🛍️",
    desc: "מוצרים שנשים קנו וממליצות עליהם - למה שווה לקנות ומאיפה",
    tags: ["אלקטרוניקה", "טיפוח ויופי", "בית ומטבח", "אופנה", "תינוקות וילדים", "אחר"],
  },
};
function communityApprovedCount(d, type) {
  return (d.communityListings || []).filter((c) => c.type === type && c.status === "approved").length;
}
// "הוספת פריט" מנתבת לטופס הנכון לפי סוג - "מסירות" ו"מכירת יד 2" עוברות תמיד דרך טופס
// ייעודי שדורש חשבון לקוחה מחובר (ר' ההערה על COMMUNITY_TYPES.giveaway), כל השאר דרך הטופס
// הפתוח הרגיל.
function communityAddUrl(type) {
  if (type === "giveaway") return "/community/giveaway/add";
  if (type === "sale") return "/community/sale/add";
  return `/community/add?type=${type}`;
}
// תגובות (כוכבים + טקסט) על פריט מאגר קהילה - קיים רק ב-3 סוגים (ר' COMMUNITY_REVIEWABLE_TYPES).
// נשמר ב-d.reviews עם type:"community" ו-targetId=מזהה הפריט - אותה תשתית וכרטיס תצוגה
// (reviewCard) בדיוק כמו ביקורות על עצמאית, כדי לא לשכפל קוד. מתפרסם מיד (status:"approved")
// כמו ביקורות עצמאיות, עם גיבוי מחיקה-לאחר-מעשה בפאנל הניהול (אותו route גנרי POST
// /admin/review/:id/delete). לקוחה יכולה להשאיר תגובה אחת בלבד לכל פריט - שליחה נוספת מעדכנת
// את הקיימת (upsert), כמו ביקורת על עצמאית.
function communityReviewsSectionHtml(c, d, ctx) {
  const listingReviews = (d.reviews || []).filter((r) => r.type === "community" && r.targetId === c.id && r.status === "approved")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const isCustomer = requireRole(ctx.session, "customer");
  const customer = isCustomer ? d.customers.find((cu) => cu.id === ctx.session.id) : null;
  const myExistingReview = customer ? (d.reviews || []).find((r) => r.type === "community" && r.targetId === c.id && r.authorCustomerId === customer.id) : null;
  return `
  <div class="panel">
    <h3>תגובות (${listingReviews.length})</h3>
    ${listingReviews.length ? listingReviews.map(reviewCard).join("") : `<p class="muted">עוד אין תגובות - רוצה להיות הראשונה?</p>`}
    <div style="margin-top:${listingReviews.length ? "18px" : "6px"};">
      ${isCustomer ? `
      <h4 style="margin:0 0 10px;text-align:center;">${myExistingReview ? "עדכון התגובה שלך" : "מה דעתך?"}</h4>
      <form method="post" action="/community/${c.type}/${c.id}/review">
        ${starInputHtml(myExistingReview ? myExistingReview.rating : 5)}
        <textarea name="text" placeholder="ספרי לנו מה דעתך..." required style="margin-top:10px;">${esc(myExistingReview ? myExistingReview.text : "")}</textarea>
        <button class="btn" style="margin-top:12px;" type="submit">${myExistingReview ? "עדכון התגובה" : "שליחה"}</button>
      </form>` : (ctx.session && ctx.session.role === "freelancer"
        ? customerOnlyPrompt(ctx, `/login?next=${encodeURIComponent(`/community/${c.type}/${c.id}`)}`, "להגיב")
        : `<p class="muted" style="text-align:center;"><a href="/login?role=customer&next=${encodeURIComponent(`/community/${c.type}/${c.id}`)}">מתחברות</a> או <a href="/signup">נרשמות בחינם</a> כדי להגיב.</p>`)}
    </div>
  </div>`;
}
// כרטיס ברשת הדפדוף - אותו מבנה CSS בדיוק כמו freelancerCard (card/card-photo/card-body/
// card-top/card-name-divider) כדי שהתצוגה תרגיש כמו חלק טבעי מהאתר, לא מסך נפרד. בלי תמונה
// אמיתית מוצג אייקון גדול של הסוג (🤲/📦 וכו') בתוך card-photo, במקום ראשי תיבות - כי אלה
// לרוב "דברים" (ציוד, שיעור) ולא "מישהי", בשונה מכרטיס עצמאית. "sale" מציג גם מחיר וגם
// עיר/כתובת יחד (בשונה מ-"product" שמציג רק מחיר/דגם/איפה נקנה, בלי עיר בכלל).
function communityCard(c, d) {
  const meta = COMMUNITY_TYPES[c.type] || {};
  const photoStyle = c.photoDataUri ? `background-image:url('${esc(c.photoDataUri)}');background-size:cover;background-position:center;` : "";
  const locationRow = c.cityId ? `<div class="card-meta-row">📍 ${esc(cityName(d, c.cityId))}${c.address ? ` - ${esc(c.address)}` : ""}</div>` : (c.address ? `<div class="card-meta-row">📍 ${esc(c.address)}</div>` : "");
  // "rental" מציג גם צבע/אורך (רלוונטי רק לפריטי שמלות ערב - ר' DRESS_TAG/COMMUNITY_TYPES.
  // rental - בשאר פריטי ההשכרה c.color/c.length פשוט ריקים ולא מוצגים) בנוסף למחיר ולמיקום.
  const metaBlock = c.type === "product"
    ? [c.price ? `<div class="card-meta-row">💰 ${esc(c.price)}</div>` : "", c.whereBought ? `<div class="card-meta-row">🛒 ${esc(c.whereBought)}</div>` : ""].join("")
    : c.type === "sale"
    ? [c.price ? `<div class="card-meta-row">💰 ${esc(c.price)}</div>` : "", locationRow].join("")
    : c.type === "rental"
    ? [c.price ? `<div class="card-meta-row">💰 ${esc(c.price)}</div>` : "", [c.color, c.length].filter(Boolean).join(" · ") ? `<div class="card-meta-row">🎨 ${esc([c.color, c.length].filter(Boolean).join(" · "))}</div>` : "", locationRow].join("")
    : locationRow;
  return `
  <a class="card" href="/community/${c.type}/${c.id}">
    <div class="card-photo" style="${photoStyle}">${c.photoDataUri ? "" : (meta.icon || "✨")}</div>
    <div class="card-body">
      <div class="card-top">
        <h3 class="card-name">${esc(c.title)}</h3>
        <div class="card-category">${esc(c.tag || meta.singular || "")}</div>
        <div class="card-name-divider"></div>
      </div>
      <div class="card-meta-block">${metaBlock}</div>
      <div class="card-info">
        ${c.description ? `<div style="margin:2px 0;">${detailLine("📝", esc(c.description), "justify-content:center;")}</div>` : ""}
        <span class="btn btn-small card-view-btn">לצפייה בפרטים</span>
      </div>
    </div>
  </a>`;
}

// התראת מייל ללקוחות שסימנו שהן רוצות לדעת על פריטים חדשים בקטגוריה הזו - רק "מסירות"
// ו"מכירת יד 2" (הסוגים היחידים עם הרשמת התראה, ר' communityNotifyTags על רשומת הלקוחה) וגם
// רק כשלפריט יש תגית (בלי תגית אין קטגוריה להתאים אליה). נשלח בפועל (לא רק push) לפי בקשה
// מפורשת - "שתוכל לקבל מיילים על כל מוצר שעולה" - ולכן קורא ל-sendEmail ישירות במקום דרך
// notify() (שהיה שולח push במקום מייל אם יש למישהי מנוי push פעיל). נקרא רק ברגע שהפריט
// הופך ל-approved (גם באישור אדמין וגם בהוספה ישירה שלה) - לא בשליחה הראשונית, כדי שאף אחת
// לא תקבל מייל על פריט שעדיין לא באמת עלה לאוויר.
async function notifyCommunitySubscribers(c, d, req) {
  if (c.type !== "giveaway" && c.type !== "sale") return;
  if (!c.tag) return;
  const meta = COMMUNITY_TYPES[c.type];
  const subscribers = (d.customers || []).filter((cu) => ((cu.communityNotifyTags || {})[c.type] || []).includes(c.tag));
  const itemUrl = `${getOrigin(req)}/community/${c.type}/${c.id}`;
  for (const cu of subscribers) {
    if (!hasRealEmail(cu)) continue;
    await sendEmail(cu.email, `${meta.icon} פריט חדש ב-SheCan בקטגוריה "${c.tag}"`,
      `<div dir="rtl" style="font-family:Arial,sans-serif;">
        <p>היי ${esc(cu.name || "")},</p>
        <p>עלה עכשיו ${meta.singular} חדש/ה בקטגוריה "${esc(c.tag)}" שסימנת שמעניינת אותך:</p>
        <p style="background:#f3ede8;padding:14px;border-radius:8px;font-size:17px;font-weight:800;">${esc(c.title)}</p>
        <p><a href="${itemUrl}" style="color:#a6265b;font-weight:800;">לצפייה בפריט</a></p>
        <p style="color:#888;font-size:13px;margin-top:20px;">קיבלת את המייל הזה כי נרשמת להתראות על "${esc(c.tag)}" ב-${esc(meta.label)}. אפשר לבטל בכל שלב בעמוד ${esc(meta.label)}.</p>
      </div>`
    ).catch(() => {});
  }
}

// עמוד ריכוז - 8 האריחים, אחד לכל סוג מאגר, עם מספר הפריטים המאושרים בכל אחד.
route("GET", "/community", async (req, res, params, query, ctx) => {
  const d = db.load();
  // "דרושות שמלות" (dressWanted) לא מקבלת ריבוע אוטומטי משלה יותר - במקום זה מוצגת ריבוע
  // משולב "שמלות להשכרה" (ר' תחת הלולאה) שמוביל לעמוד ביניים עם 2 אופציות (לפרסם שמלה
  // להשכרה / להעלות בקשה לשמלה) - ldressWanted עצמו נשאר תשתית מלאה כרגיל (טופס/אישור/עמוד
  // סוג/כרטיס) ורק הכניסה אליו מ-hub הוחלפה. ר' route GET /community/dresses למטה.
  const tilesHtml = COMMUNITY_TYPE_ORDER.filter((t) => t !== "dressWanted").map((type) => {
    const meta = COMMUNITY_TYPES[type];
    const count = communityApprovedCount(d, type);
    return `
    <a class="hub-card" href="/community/${type}">
      <span class="hub-card-icon">${meta.icon}</span>
      <div class="hub-card-title">${esc(meta.label)}</div>
      <div class="hub-card-desc">${esc(meta.desc)}</div>
      <span class="hub-card-count">${count ? `${count} ${count === 1 ? meta.singular : meta.label} ${count === 1 ? "" : "פעילים"}`.trim() : "בקרוב"}</span>
    </a>`;
  }).join("");
  // ריבוע משולב במקום "דרושות שמלות" הישן - מוביל לעמוד ביניים עם 2 האופציות שביקשה שפיר.
  const dressesCount = communityApprovedCount(d, "rental") + communityApprovedCount(d, "dressWanted");
  const dressesTileHtml = `
    <a class="hub-card" href="/community/dresses">
      <span class="hub-card-icon">👗</span>
      <div class="hub-card-title">שמלות להשכרה</div>
      <div class="hub-card-desc">לפרסם שמלה להשכרה, או להעלות בקשה לשמלה שאת מחפשת</div>
      <span class="hub-card-count">${dressesCount ? `${dressesCount} פעילים` : "בקרוב"}</span>
    </a>`;
  // "בלב אחד" (תהילים קהילתי, שמו הקודם "מתחזקות ומחזקות") לא חלק מ-COMMUNITY_TYPE_ORDER
  // הרגיל - אין לו תור אישור אדמין ולא מבנה gemach/rental/וכו' רגיל, אלא מנגנון ייעודי משלו
  // (ר' route GET /community/tehillim למטה) - לכן הריבוע שלו נבנה כאן ידנית. ממוקם בסוף הרשת
  // (לא בהתחלה) לפי בקשה מפורשת.
  const tehillimTileHtml = `
    <a class="hub-card" href="/community/tehillim">
      <span class="hub-card-icon">🕯️</span>
      <div class="hub-card-title">בלב אחד</div>
      <div class="hub-card-desc">רשימת שמות לתפילה, ותהילים קהילתי - קחי על עצמך פרק או יום, גם בלי להתחבר</div>
      <span class="hub-card-count">קהילה חיה</span>
    </a>`;
  const body = `
  <div class="hero" style="padding-top:0;">
    <h1 style="font-size:40px;">מאגרי הקהילה</h1>
    <p>כל המשאבים הקהילתיים של עצמאיות ומשפחות - במקום אחד, לפי תחום.</p>
  </div>
  <div class="hub-grid" style="margin-bottom:30px;">${dressesTileHtml}${tilesHtml}${tehillimTileHtml}</div>
  <p style="text-align:center;"><a class="btn btn-outline btn-small" href="/community/add">רוצה להוסיף פריט למאגר? לחצי כאן</a></p>
  `;
  sendHtml(res, 200, page({ title: "מאגרי קהילה", session: ctx.session, body, query }));
});

// עמוד ביניים "שמלות להשכרה" - מציג 2 אופציות ברורות (לפי בקשה מפורשת): לפרסם שמלה להשכרה
// (מובילה לטופס ההוספה הפתוח עם type=rental מוכן מראש - העסקה עצמה עוברת דרך COMMUNITY_TYPES.
// rental הרגיל, עם תגית שמלות הערב), או להעלות בקשה לשמלה שמחפשות (מובילה לטופס עם
// type=dressWanted מוכן מראש - COMMUNITY_TYPES.dressWanted הרגיל). חשוב: הראוט הזה חייב
// להירשם *לפני* GET /community/:type - אחרת "dresses" היה נתפס בטעות כ-:type.
route("GET", "/community/dresses", async (req, res, params, query, ctx) => {
  const d = db.load();
  // ברירת המחדל היא שכל מאגר שמלות הערב שפורסמו (rental, מתויגות ב-DRESS_TAG) מוצג ישר כאן
  // מתחת לשתי הקוביות - בלי צורך ללחוץ לעמוד נפרד, לפי בקשה מפורשת (2026-08-27). אותו כרטיס
  // ואותו מיון בדיוק כמו ב-GET /community/:type הרגיל, רק בלי טופס הסינון המלא - זה נשאר
  // בעמוד /community/rental הייעודי (עם צבע/אורך/מחיר/עיר), שנגיש עדיין דרך הקישור למטה למי
  // שכן רוצה לסנן מתוך מאגר גדול.
  const dressItems = (d.communityListings || [])
    .filter((c) => c.type === "rental" && c.tag === DRESS_TAG && c.status === "approved")
    .slice().sort((a, b) => new Date(b.approvedAt || b.createdAt) - new Date(a.approvedAt || a.createdAt));
  const body = `
  <h1 class="section-title" style="margin-top:0;">👗 שמלות להשכרה</h1>
  <p class="muted" style="text-align:center;margin-top:-10px;">מפרסמת שמלה להשכרה, או מחפשת שמלה? בחרי מה מתאים לך.</p>
  <div class="hub-grid" style="max-width:640px;margin:20px auto;">
    <a class="hub-card" href="/community/add?type=rental&tag=${encodeURIComponent(DRESS_TAG)}">
      <span class="hub-card-icon">📤</span>
      <div class="hub-card-title">לפרסם שמלה להשכרה</div>
      <div class="hub-card-desc">יש לך שמלת ערב בארון מהאירועים האחרונים שלך? פרסמי אותה כאן להשכרה בטוחות שזה ישתלם לך!</div>
    </a>
    <a class="hub-card" href="/community/add?type=dressWanted">
      <span class="hub-card-icon">🙋‍♀️</span>
      <div class="hub-card-title">להעלות בקשה לשמלה</div>
      <div class="hub-card-desc">מחפשת שמלה? ספרי לנו מה את צריכה</div>
    </a>
  </div>
  <p style="text-align:center;">
    <a href="/community/dressWanted" style="color:var(--rose-dark);font-weight:700;">לצפייה בבקשות לשמלה</a>
  </p>
  <h2 class="section-title" style="font-size:22px;margin-top:28px;">השמלות שיש כרגע להשכרה${dressItems.length ? ` (${dressItems.length})` : ""}</h2>
  ${dressItems.length
    ? `<div class="grid">${dressItems.map((c) => communityCard(c, d)).join("")}</div>`
    : `<p class="muted" style="text-align:center;">עדיין אין שמלות שפורסמו - את יכולה <a href="/community/add?type=rental&tag=${encodeURIComponent(DRESS_TAG)}" style="color:var(--rose-dark);font-weight:700;">להיות הראשונה</a>.</p>`}
  <p style="text-align:center;margin-top:14px;">
    <a href="/community/rental?tag=${encodeURIComponent(DRESS_TAG)}" style="color:var(--rose-dark);font-weight:700;">🔍 לחיפוש וסינון מתקדם (לפי צבע/אורך/מחיר/עיר)</a>
  </p>
  `;
  sendHtml(res, 200, page({ title: "שמלות להשכרה", session: ctx.session, body, query }));
});

// טופס הוספת פריט - פתוח לכולן, בלי צורך בהתחברות (בדומה ל"צרי קשר") - כל פריט שנשלח כאן
// עובר לתור אישור המנהלת (status:"pending", source:"self") לפני שהוא מתפרסם.
// חשוב: הראוט הזה חייב להירשם *לפני* GET /community/:type - אחרת "add" היה נתפס בטעות
// כפרמטר :type (שלא קיים בו COMMUNITY_TYPES) והראוט הזה מעולם לא היה נדרש (404 קבוע).
// "מסירות" ו"מכירת יד 2" לא חלק מהטופס הפתוח הזה - הן מנותבות לטפסים הייעודיים שלהן
// (התחברות כלקוחה נדרשת) - ר' ההערה על COMMUNITY_TYPES.giveaway.
const OPEN_COMMUNITY_TYPE_ORDER = COMMUNITY_TYPE_ORDER.filter((t) => t !== "giveaway" && t !== "sale");
route("GET", "/community/add", async (req, res, params, query, ctx) => {
  if (query.get("type") === "giveaway") return redirect(res, "/community/giveaway/add");
  if (query.get("type") === "sale") return redirect(res, "/community/sale/add");
  const d = db.load();
  const preselect = OPEN_COMMUNITY_TYPE_ORDER.includes(query.get("type")) ? query.get("type") : "gemach";
  // תגית מוכנה מראש (למשל מ"שמלות להשכרה" ב-/community/dresses שמגיעה עם
  // ?type=rental&tag=<DRESS_TAG>) - נבחרת אוטומטית ב-scCommunityUpdateTags למטה, רק אם היא
  // באמת קיימת ברשימת התגיות של הסוג שנבחר.
  const presetTag = query.get("tag") || "";
  const typeOptions = OPEN_COMMUNITY_TYPE_ORDER.map((t) => `<option value="${t}" ${preselect === t ? "selected" : ""}>${esc(COMMUNITY_TYPES[t].label)}</option>`).join("");
  const body = `
  <h1 class="section-title" style="margin-top:0;">הוספת פריט למאגרי הקהילה</h1>
  <p class="muted" style="text-align:center;margin-top:-10px;">מלאי את הפרטים - הפריט יעבור אישור של צוות SheCan לפני שהוא מתפרסם, בדיוק כמו הרשמת עצמאית חדשה.</p>
  <div class="panel narrow-panels">
    <form method="post" action="/community/add" enctype="multipart/form-data">
      <label>איזה סוג פריט את מוסיפה?<select name="type" id="scCommunityType" onchange="scCommunityOnTypeChange(this.value)">${typeOptions}</select></label>
      <label id="scCommunityTitleLabel">שם הפריט / העסק<input type="text" name="title" required /></label>
      <label>סוג מדויק<select name="tag" id="scCommunityTag" onchange="scCommunityCheckDressFields()"></select></label>
      <div id="scContactFieldsGroup">
        <label>עיר${cityAutocompleteHtml({ fieldName: "city", placeholder: "מאיזו עיר?" })}</label>
        <label>כתובת (רחוב ומספר, לא חובה)<input type="text" name="address" placeholder="למשל: הרצל 12" /></label>
      </div>
      <label>תיאור<textarea name="description" maxlength="500" placeholder="ספרי בקצרה על הפריט - קהל יעד, מה כלול וכו'"></textarea></label>
      <div id="scContactFieldsGroup2">
        <label>טלפון ליצירת קשר<input type="text" name="phone" placeholder="050-1234567" /></label>
        <label style="display:flex;align-items:center;gap:6px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" style="width:auto;" /><span>אותו מספר זמין גם ב-WhatsApp</span></label>
        <label>אימייל (לא חובה)<input type="email" name="email" /></label>
      </div>
      <div id="scProductFieldsGroup" style="display:none;">
        <label>דגם (לא חובה)<input type="text" name="model" placeholder="למשל: דגם XR200" /></label>
        <label>מחיר (לא חובה)<input type="text" name="price" placeholder="למשל: 149 ₪" /></label>
        <label>איפה קנית (לא חובה)<input type="text" name="whereBought" placeholder="למשל: שם חנות או אתר" /></label>
      </div>
      <!-- שדות נוספים רק כשבוחרות "השכרות" + תגית שמלות ערב - ר' scCommunityCheckDressFields
           למטה. price כאן בשם שדה נפרד (dressPrice, לא price) כדי לא להתנגש עם שדה המחיר של
           scProductFieldsGroup - שני השדות לעולם לא מוצגים יחד (isProduct מול type==='rental'
           הם בלעדיים זה את זה), אבל שניהם עדיין קיימים ב-DOM ונשלחים בטופס, אז שם שונה מונע
           מצב שבו readBody מחזיר את הערך הריק של השדה הלא-רלוונטי. ר' טיפול השרת ב-POST
           /community/add שמאחד את שני השמות בחזרה לשדה price אחד ברשומה. -->
      <div id="scDressFieldsGroup" style="display:none;">
        <label>מחיר להשכרה (לא חובה)<input type="text" name="dressPrice" placeholder="למשל: 150 ₪" /></label>
        <label>צבע (לא חובה)<select name="color"><option value="">בחרי צבע</option>${DRESS_COLORS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select></label>
        <label>אורך (לא חובה)<select name="length"><option value="">בחרי אורך</option>${DRESS_LENGTHS.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}</select></label>
        <label>מיועדת ל (לא חובה)<select name="audience"><option value="">בחרי</option>${DRESS_AUDIENCES.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select></label>
      </div>
      <label>תמונה<input type="file" name="photo" accept="image/*" /></label>
      <label>שמך (לצוות SheCan בלבד, לא יפורסם)<input type="text" name="contactName" /></label>
      <button class="btn" style="width:100%;margin-top:16px;" type="submit">שליחה לאישור</button>
    </form>
  </div>
  <p class="muted" style="text-align:center;">רוצה למסור או למכור חפץ שכבר לא צריכה? <a href="/community/giveaway/add" style="color:var(--rose-dark);font-weight:700;">מסירות</a> ו<a href="/community/sale/add" style="color:var(--rose-dark);font-weight:700;">מכירות יד 2</a> מתפרסמות דרך האזור האישי שלך כלקוחה - כדי שתוכלי אחר כך לסמן שהפריט כבר נמסר/נמכר.</p>
  <script>
    var scCommunityTagsByType = ${JSON.stringify(Object.fromEntries(OPEN_COMMUNITY_TYPE_ORDER.map((t) => [t, COMMUNITY_TYPES[t].tags])))};
    var scDressTag = ${JSON.stringify(DRESS_TAG)};
    var scPresetTag = ${JSON.stringify(presetTag)};
    function scCommunityUpdateTags(type) {
      var sel = document.getElementById('scCommunityTag');
      var tags = scCommunityTagsByType[type] || [];
      sel.innerHTML = tags.map(function(t){ return '<option value="' + t + '">' + t + '</option>'; }).join('');
      if (scPresetTag && tags.indexOf(scPresetTag) !== -1) { sel.value = scPresetTag; scPresetTag = ''; }
    }
    // שדות "פרטי שמלה" (מחיר/צבע/אורך/קהל יעד) מוצגים רק כשהסוג הוא "השכרות" והתגית
    // שנבחרה היא בדיוק תגית שמלות הערב - נבדק גם בשינוי סוג וגם בשינוי תגית (ר' onchange
    // על שני ה-select-ים למעלה), כי שינוי סוג מאפס את רשימת התגיות.
    function scCommunityCheckDressFields() {
      var type = document.getElementById('scCommunityType').value;
      var tag = document.getElementById('scCommunityTag').value;
      var show = (type === 'rental' && tag === scDressTag);
      document.getElementById('scDressFieldsGroup').style.display = show ? '' : 'none';
    }
    function scCommunityOnTypeChange(type) {
      scCommunityUpdateTags(type);
      var isProduct = (type === 'product');
      document.getElementById('scContactFieldsGroup').style.display = isProduct ? 'none' : '';
      document.getElementById('scContactFieldsGroup2').style.display = isProduct ? 'none' : '';
      document.getElementById('scProductFieldsGroup').style.display = isProduct ? '' : 'none';
      var titleLabel = document.getElementById('scCommunityTitleLabel');
      var titleInput = titleLabel.querySelector('input');
      titleLabel.firstChild.textContent = isProduct ? 'שם המוצר' : 'שם הפריט / העסק';
      titleInput.placeholder = isProduct ? 'למשל: שואב אבק רובוטי' : '';
      scCommunityCheckDressFields();
    }
    scCommunityOnTypeChange(document.getElementById('scCommunityType').value);
  </script>
  `;
  sendHtml(res, 200, page({ title: "הוספת פריט למאגרי קהילה", session: ctx.session, body, query }));
});

// טופס "מסירות" - אחד משני הסוגים (עם "מכירת יד 2" למטה) שדורשים חשבון לקוחה מחובר (ולא
// פתוחים לכולן כמו השאר), כי המפרסמת צריכה להיות מסוגלת אחר כך להיכנס ל"אזור האישי" שלה
// (GET /account) ולהוריד את הפריט בעצמה ברגע שהוא כבר נמסר - ר' route DELETE-like למטה
// (POST /account/community/:id/take-down).
// חשוב: הראוטים האלה חייבים להירשם *לפני* GET /community/:type/:id - אחרת "/community/
// giveaway/add" היה נתפס בטעות כ-:type="giveaway" + :id="add" (בדיוק כמו הבאג עם /community/add
// שתוקן למעלה).
route("GET", "/community/giveaway/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/community/giveaway/add")}`);
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const meta = COMMUNITY_TYPES.giveaway;
  const tagOptions = meta.tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  const body = `
  <h1 class="section-title" style="margin-top:0;">${meta.icon} מסירת חפץ</h1>
  <p class="muted" style="text-align:center;margin-top:-10px;">${esc(meta.desc)} - הפריט יעבור אישור של צוות SheCan לפני שהוא מתפרסם. ברגע שהחפץ כבר נמסר, תוכלי להוריד אותו בעצמך מה<a href="/account">אזור האישי</a> שלך.</p>
  <div class="panel narrow-panels">
    <form method="post" action="/community/giveaway/add" enctype="multipart/form-data">
      <label>מה מוסרים?<input type="text" name="title" required placeholder="למשל: עגלת תינוק" /></label>
      <label>סוג מדויק<select name="tag">${tagOptions}</select></label>
      <label>עיר${cityAutocompleteHtml({ fieldName: "city", placeholder: "מאיזו עיר?" })}</label>
      <label>כתובת (רחוב ומספר, לא חובה)<input type="text" name="address" placeholder="למשל: הרצל 12" /></label>
      <label>תיאור<textarea name="description" maxlength="500" placeholder="מצב החפץ, למה מתאים וכו'"></textarea></label>
      <label>טלפון ליצירת קשר (לא חובה)<input type="text" name="phone" placeholder="050-1234567" /></label>
      <label style="display:flex;align-items:center;gap:6px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" style="width:auto;" /><span>אותו מספר זמין גם ב-WhatsApp</span></label>
      <label>אימייל ליצירת קשר<input type="email" name="email" value="${esc(customer.email)}" /></label>
      <label>תמונה של החפץ<input type="file" name="photo" accept="image/*" /></label>
      <button class="btn" style="width:100%;margin-top:16px;" type="submit">שליחה לאישור</button>
    </form>
  </div>
  `;
  sendHtml(res, 200, page({ title: "מסירת חפץ", session: ctx.session, body, query }));
});

route("POST", "/community/giveaway/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/community/giveaway/add")}`);
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/community/giveaway/add?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי שוב.")}`);
  const title = (body.get("title") || "").trim();
  if (!title) return redirect(res, `/community/giveaway/add?err=${encodeURIComponent("צריך למלא לפחות מה מוסרים.")}`);
  const d = db.load();
  const customer = d.customers.find((cu) => cu.id === ctx.session.id);
  const c = {
    id: db.nextId("communityListing"),
    type: "giveaway", title,
    tag: body.get("tag") || "",
    cityId: body.get("city") || "",
    address: clip((body.get("address") || "").trim(), 200),
    description: clip(body.get("description"), 500),
    phone: (body.get("phone") || "").trim(),
    hasWhatsapp: body.get("hasWhatsapp") === "1",
    email: (body.get("email") || "").trim() || customer.email,
    photoDataUri: fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES),
    contactName: customer.name || "",
    ownerCustomerId: customer.id,
    source: "self",
    status: "pending",
    viewCount: 0,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  };
  d.communityListings.push(c);
  db.save();
  redirect(res, `/account?ok=${encodeURIComponent("תודה! הפריט נשלח לאישור, ויופיע כאן ברשימת המסירות שלך.")}`);
});

// טופס "מכירת יד 2" - כמו "מסירות" למעלה (חשבון לקוחה מחובר, הורדה עצמית מהאזור האישי -
// ר' ההערה שם), בתוספת שדה price יחיד. נוסף לפי בקשה מפורשת: "כמו המסירה רק עם מחיר".
route("GET", "/community/sale/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/community/sale/add")}`);
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const meta = COMMUNITY_TYPES.sale;
  const tagOptions = meta.tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  const body = `
  <h1 class="section-title" style="margin-top:0;">${meta.icon} מכירת חפץ</h1>
  <p class="muted" style="text-align:center;margin-top:-10px;">${esc(meta.desc)} - הפריט יעבור אישור של צוות SheCan לפני שהוא מתפרסם. ברגע שהחפץ כבר נמכר, תוכלי להוריד אותו בעצמך מה<a href="/account">אזור האישי</a> שלך.</p>
  <div class="panel narrow-panels">
    <form method="post" action="/community/sale/add" enctype="multipart/form-data">
      <label>מה מוכרים?<input type="text" name="title" required placeholder="למשל: עגלת תינוק" /></label>
      <label>סוג מדויק<select name="tag">${tagOptions}</select></label>
      <label>מחיר<input type="text" name="price" required placeholder="למשל: 150 ₪" /></label>
      <label>עיר${cityAutocompleteHtml({ fieldName: "city", placeholder: "מאיזו עיר?" })}</label>
      <label>כתובת (רחוב ומספר, לא חובה)<input type="text" name="address" placeholder="למשל: הרצל 12" /></label>
      <label>תיאור<textarea name="description" maxlength="500" placeholder="מצב החפץ, למה מתאים וכו'"></textarea></label>
      <label>טלפון ליצירת קשר (לא חובה)<input type="text" name="phone" placeholder="050-1234567" /></label>
      <label style="display:flex;align-items:center;gap:6px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" style="width:auto;" /><span>אותו מספר זמין גם ב-WhatsApp</span></label>
      <label>אימייל ליצירת קשר<input type="email" name="email" value="${esc(customer.email)}" /></label>
      <label>תמונה של החפץ<input type="file" name="photo" accept="image/*" /></label>
      <button class="btn" style="width:100%;margin-top:16px;" type="submit">שליחה לאישור</button>
    </form>
  </div>
  `;
  sendHtml(res, 200, page({ title: "מכירת חפץ", session: ctx.session, body, query }));
});

route("POST", "/community/sale/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/community/sale/add")}`);
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/community/sale/add?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי שוב.")}`);
  const title = (body.get("title") || "").trim();
  const price = clip((body.get("price") || "").trim(), 50);
  if (!title || !price) return redirect(res, `/community/sale/add?err=${encodeURIComponent("צריך למלא לפחות מה מוכרים ומחיר.")}`);
  const d = db.load();
  const customer = d.customers.find((cu) => cu.id === ctx.session.id);
  const c = {
    id: db.nextId("communityListing"),
    type: "sale", title, price,
    tag: body.get("tag") || "",
    cityId: body.get("city") || "",
    address: clip((body.get("address") || "").trim(), 200),
    description: clip(body.get("description"), 500),
    phone: (body.get("phone") || "").trim(),
    hasWhatsapp: body.get("hasWhatsapp") === "1",
    email: (body.get("email") || "").trim() || customer.email,
    photoDataUri: fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES),
    contactName: customer.name || "",
    ownerCustomerId: customer.id,
    source: "self",
    status: "pending",
    viewCount: 0,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  };
  d.communityListings.push(c);
  db.save();
  redirect(res, `/account?ok=${encodeURIComponent("תודה! הפריט נשלח לאישור, ויופיע כאן ברשימת המכירות שלך.")}`);
});

// דפדוף בתוך סוג מאגר אחד (למשל /community/gemach) - סינון לפי תג ועיר, בדיוק כמו חיפוש
// עצמאיות: סרגל סינון + רשת כרטיסים.
// ===================== "בלב אחד" - תהילים קהילתי (נוסף 2026-08-26, שונה שם מ"מתחזקות
// ומחזקות" ב-2026-08-26 לפי בקשה) =====================
// ריבוע נוסף בקהילת SheCan, לפי בקשה מפורשת - שונה מהותית מ-9 סוגי COMMUNITY_TYPES (לא רשימת
// פריטים עם אישור אדמין, אלא מנגנון חי: רשימת שמות לתפילה, שני "ספרי תהילים" מקבילים
// שמתחלקים ליחידות (יומי - 7 ימות השבוע; לפי פרקים - כל 150 הפרקים בנפרד, עם תווית פרק
// בגימטריה עברית - "פרק א'", "פרק ב'" וכו') שכל אחת יכולה "לקחת על עצמה" יחידה - כולל מי
// שלא מחוברת בכלל כלקוחה, לפי בקשה מפורשת "כל אחת יכולה לקחת פרק גם אם היא לא מחוברת" -
// לקרוא אותה (קישור לטקסט המדויק והמדוייק ב-Sefaria.org - מקור מהימן ומדויק לטקסט תהילים,
// ולא משוחזר כאן מהזיכרון כדי לא להסתכן בטעות בטקסט קדוש) ולסמן שקראה - כשכל יחידות הספר
// נקראו הוא "נסגר" ונפתח ספר חדש מאותו סוג אוטומטית. בנוסף: סיפורי ישועות, ואפשרות לפרסם שם
// עם סיפור קצר שלקוחות אחרות יכולות לכתוב לידו קבלה קטנה שקיבלו על עצמן. בראש העמוד מובא
// ציטוט זכרון גדול על נתינה לזולת (ר' tehillimQuoteHtml למטה).
// ניהול: כל התוכן מתפרסם מיד (בלי תור אישור, בדיוק כמו ביקורות באתר) עם כפתורי מחיקה
// שמוצגים רק לאדמין ישירות על אותו עמוד ציבורי - לפי בקשה מפורשת "לנהל תמיד את מה שקורה
// מאחורה... למחוק כל תגובה שלא מתאימה", בלי לבנות פאנל ניהול נפרד ולשכפל את כל הרינדור.
// לקיחת יחידה בלי התחברות: מזוהה כ-claimedByCustomerId===null אבל claimed===true (בשונה
// מ"לא נלקחה בכלל" שהוא claimed===false) - במצב הזה, מכיוון שאין דרך לזהות "אותה מבקרת" שוב
// בביקור הבא, כל מי שנכנסת לעמוד היחידה יכולה לסמן "קראתי" (שיטת כבוד, כמו במעגלי תהילים
// אמיתיים) - רק לקיחה של לקוחה מחוברת ספציפית שמורה למי שהתחברה בתור אותה לקוחה בדיוק.

// חלוקה שבועית מסורתית ומאומתת (7 ימים) - ולא חלוקה חודשית (30 יום), כדי להישען על מקור
// מאומת בלבד (הבחירה ל"יומי" = "יום בשבוע" ולא "יום בחודש" נעשתה כדי להימנע משחזור לא
// מאומת של גבולות הפרקים המדויקים בחלוקה החודשית המסורתית).
const TEHILLIM_WEEKLY_DIVISION = [
  { label: "יום ראשון", from: 1, to: 29 },
  { label: "יום שני", from: 30, to: 50 },
  { label: "יום שלישי", from: 51, to: 72 },
  { label: "יום רביעי", from: 73, to: 89 },
  { label: "יום חמישי", from: 90, to: 106 },
  { label: "יום שישי", from: 107, to: 119 },
  { label: "שבת", from: 120, to: 150 },
];
// ממיר מספר (1 עד 150 - טווח פרקי תהילים) לגימטריה עברית עם גרש/גרשיים תקניים (מספר בן
// אות אחת מקבל גרש בסופו כמו א', מספר בן כמה אותיות מקבל גרשיים לפני האות האחרונה כמו י"א),
// כולל הכלל המקובל שמחליף 15/16 ב-ט"ו/ט"ז במקום י"ה/י"ו כדי לא לכתוב צירוף שנחשב משם ה'.
// משמש לתווית "פרק א'", "פרק ב'" וכו' בספר התהילים המחולק לפי פרקים - ר' TEHILLIM_CHAPTERS_DIVISION.
function hebrewGematria(num) {
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  const hundreds = num >= 100 ? "ק" : "";
  const rest = num % 100;
  let restLetters;
  if (rest === 15) restLetters = "טו";
  else if (rest === 16) restLetters = "טז";
  else restLetters = tens[Math.floor(rest / 10)] + ones[rest % 10];
  const letters = hundreds + restLetters;
  if (letters.length <= 1) return letters + "'";
  return letters.slice(0, -1) + "\"" + letters.slice(-1);
}
const TEHILLIM_CHAPTERS_DIVISION = Array.from({ length: 150 }, (_, i) => ({ label: `פרק ${hebrewGematria(i + 1)}`, from: i + 1, to: i + 1 }));
// 4 אופציות קבלה קטנה, בדיוק לפי בקשה מפורשת - 3 קבועות + "אחר" עם טקסט חופשי.
const TEHILLIM_KABBALAH_OPTIONS = {
  "asher-yatzar": "קריאת \"אשר יצר\" מתוך הכתוב במשך שבוע",
  "lashon-hara": "לא מדברת לשון הרע שעה אחת ביום, למשך שבוע",
  "tzniut": "קבלה קטנה בצניעות",
  "other": "משהו אחר",
};

function sefariaChapterLink(from, to) {
  return `https://www.sefaria.org/Psalms.${from === to ? from : `${from}-${to}`}?lang=he`;
}

function createTehillimBook(division) {
  const template = division === "daily" ? TEHILLIM_WEEKLY_DIVISION : TEHILLIM_CHAPTERS_DIVISION;
  return {
    id: db.nextId("tehillimBook"),
    division,
    units: template.map((t, i) => ({ index: i, label: t.label, from: t.from, to: t.to, claimed: false, claimedByCustomerId: null, claimedAt: null, read: false, readAt: null })),
    status: "open",
    createdAt: new Date().toISOString(),
    closedAt: null,
  };
}
// מבטיח שתמיד קיים בדיוק ספר "פתוח" אחד מכל סוג - נקרא בתחילת כל route רלוונטי, לא רק
// בעליית השרת, כדי שגם ההרצה הראשונה אי-פעם (בלי אף ספר קיים) תיצור אחד לבד.
function ensureOpenTehillimBook(d, division) {
  d.tehillimBooks = d.tehillimBooks || [];
  let book = d.tehillimBooks.find((b) => b.division === division && b.status === "open");
  if (!book) {
    book = createTehillimBook(division);
    d.tehillimBooks.push(book);
  }
  return book;
}

// כפתור "שיתוף" ליחידת תהילים בודדת (יום או פרק) - לפי בקשה מפורשת "אופציה לשתף את פרקי
// התהילים עם מישהי או את הימים". מוצג על כל יחידה (לא רק כאלה שנלקחו) כדי שאפשר יהיה גם
// להזמין מישהי אחרת לקחת יחידה ספציפית, לא רק לשתף מה שכבר לקחת בעצמך. משתמש באותו
// scShareCommunityItem (layout.js) שכבר קיים לשיתוף "מסירות"/"מכירת יד 2" - navigator.share
// עם דפדפן שתומך (כולל ווטסאפ ישירות במובייל), נופל להעתקת קישור בלי תמיכה.
function tehillimShareButtonHtml(book, unit, origin) {
  const url = `${origin}/community/tehillim/${book.id}/unit/${unit.index}`;
  const title = `בואי נצטרף לתפילה - ${unit.label} ב"בלב אחד" (SheCan)`;
  return `<button type="button" class="btn btn-small btn-outline" style="font-size:11px;padding:2px 8px;" data-share-title="${esc(title)}" data-share-url="${esc(url)}" onclick="scShareCommunityItem(this)">📤 שיתוף</button>`;
}
function tehillimUnitHtml(book, unit, session, d, origin) {
  const claimedByMe = session && session.role === "customer" && unit.claimedByCustomerId === session.id;
  const claimer = unit.claimedByCustomerId ? d.customers.find((c) => c.id === unit.claimedByCustomerId) : null;
  let statusHtml;
  if (unit.read) {
    statusHtml = `<span class="muted" style="font-size:12px;">✅ נקרא${claimer ? ` ע"י ${esc(claimer.name.split(" ")[0])}` : ""}</span>`;
  } else if (unit.claimed && unit.claimedByCustomerId) {
    // נלקחה ע"י לקוחה מחוברת מזוהה - רק היא (בדיוק כמו קודם) רואה את כפתור הקריאה/סימון.
    statusHtml = claimedByMe
      ? `<a class="btn btn-small" href="/community/tehillim/${book.id}/unit/${unit.index}">לקריאה ולסימון שקראתי</a>`
      : `<span class="muted" style="font-size:12px;">נלקח ע"י ${claimer ? esc(claimer.name.split(" ")[0]) : "מישהי"}</span>`;
  } else if (unit.claimed) {
    // נלקחה בלי התחברות - אין דרך לזהות "אותה מבקרת" שוב, אז הקישור להשלמת הקריאה פתוח לכולן
    // (ר' ההערה למעלה על שיטת הכבוד באיזור הזה).
    statusHtml = `<a class="btn btn-small btn-outline" href="/community/tehillim/${book.id}/unit/${unit.index}">נלקח ע"י אורחת - לקריאה ולסימון שקראתי</a>`;
  } else {
    // פנויה - כל אחת יכולה לקחת, גם בלי התחברות כלקוחה, לפי בקשה מפורשת.
    statusHtml = `<form method="post" action="/community/tehillim/${book.id}/unit/${unit.index}/claim" style="margin:0;"><button class="btn btn-small btn-outline" type="submit">אני לוקחת על עצמי</button></form>`;
  }
  const adminRelease = (session && session.role === "admin" && unit.claimed && !unit.read)
    ? `<form method="post" action="/community/tehillim/${book.id}/unit/${unit.index}/release" style="margin:4px 0 0;" onsubmit="return confirm('לשחרר את היחידה הזו בחזרה לפנויה?');"><button class="btn btn-small btn-outline" type="submit" style="font-size:11px;">שחרור (אדמין)</button></form>`
    : "";
  return `<div class="tehillim-unit ${unit.read ? "tehillim-unit-read" : unit.claimed ? "tehillim-unit-claimed" : ""}">
    <span class="tehillim-unit-label">${esc(unit.label)}</span>
    <span class="tehillim-unit-status">${statusHtml}</span>
    ${tehillimShareButtonHtml(book, unit, origin)}
    ${adminRelease}
  </div>`;
}

function tehillimNameEntryHtml(n, d, ctx) {
  const isCustomer = requireRole(ctx.session, "customer");
  const kabbalotHtml = (n.kabbalot || []).map((k) => {
    const author = d.customers.find((c) => c.id === k.customerId);
    const label = k.type === "other" ? esc(k.customText || "") : TEHILLIM_KABBALAH_OPTIONS[k.type] || "";
    const adminOrOwnDelete = (ctx.session && (ctx.session.role === "admin" || (ctx.session.role === "customer" && ctx.session.id === k.customerId)))
      ? `<form method="post" action="/community/tehillim/kabbalah/${k.id}/delete" style="display:inline;margin-right:6px;" onsubmit="return confirm('למחוק את הקבלה הזו?');"><button class="btn btn-small btn-outline" type="submit" style="font-size:11px;padding:2px 8px;">מחיקה</button></form>`
      : "";
    return `<li style="margin:4px 0;">🕊️ ${label}${author ? ` <span class="muted">- ${esc(author.name.split(" ")[0])}</span>` : ""}${adminOrOwnDelete}</li>`;
  }).join("");
  const kabbalahFormHtml = isCustomer ? `
    <details style="margin-top:8px;">
      <summary class="muted" style="cursor:pointer;font-size:13px;">+ לכתוב קבלה קטנה לזכות השם הזה</summary>
      <form method="post" action="/community/tehillim/names/${n.id}/kabbalah" style="margin-top:8px;">
        ${Object.entries(TEHILLIM_KABBALAH_OPTIONS).map(([val, label]) => `<label style="display:flex;align-items:center;gap:6px;font-weight:600;margin-top:4px;font-size:13.5px;"><input type="radio" name="type" value="${val}" ${val === "asher-yatzar" ? "checked" : ""} style="width:auto;" /> ${esc(label)}</label>`).join("")}
        <input type="text" name="customText" maxlength="200" placeholder="אם בחרת 'משהו אחר' - כתבי כאן" style="margin-top:6px;" />
        <button class="btn btn-small" style="margin-top:8px;" type="submit">שמירת הקבלה</button>
      </form>
    </details>` : "";
  const ownerDelete = (ctx.session && (ctx.session.role === "admin" || (ctx.session.role === "customer" && ctx.session.id === n.customerId)))
    ? `<form method="post" action="/community/tehillim/names/${n.id}/delete" style="display:inline;" onsubmit="return confirm('להסיר את השם/השמות האלה מרשימת התפילה?');"><button class="btn btn-small btn-outline" type="submit" style="font-size:11px;">הסרה</button></form>`
    : "";
  return `
  <div class="panel" style="background:var(--cream);margin-bottom:10px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
      <h4 style="margin:0;">🕯️ ${n.names.map(esc).join(" · ")}</h4>
      ${ownerDelete}
    </div>
    ${n.story ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.4;">${esc(n.story)}</p>` : ""}
    ${(n.kabbalot && n.kabbalot.length) ? `<ul style="margin:8px 0 0;padding-inline-start:18px;list-style:none;">${kabbalotHtml}</ul>` : ""}
    ${kabbalahFormHtml}
  </div>`;
}

route("GET", "/community/tehillim", async (req, res, params, query, ctx) => {
  const d = db.load();
  const dailyBook = ensureOpenTehillimBook(d, "daily");
  const chaptersBook = ensureOpenTehillimBook(d, "chapters");
  db.save();
  const isCustomer = requireRole(ctx.session, "customer");
  const isAdmin = ctx.session && ctx.session.role === "admin";
  const origin = getOrigin(req);

  const allBooks = d.tehillimBooks || [];
  const closedBooksCount = allBooks.filter((b) => b.status === "closed").length;
  const chaptersReadCount = allBooks.reduce((sum, b) => sum + b.units.filter((u) => u.read).reduce((s, u) => s + (u.to - u.from + 1), 0), 0);
  const names = (d.tehillimNames || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const namesCount = names.reduce((sum, n) => sum + n.names.length, 0);
  const stories = (d.tehillimSalvationStories || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const addNameFormHtml = isCustomer ? `
  <div class="panel" style="max-width:560px;margin:0 auto 20px;">
    <h3>הוספת שם/שמות לתפילה</h3>
    <p class="muted" style="font-size:13px;">אפשר להוסיף עד 2 שמות (למשל: פלונית בת פלונית), ואפשר גם לצרף סיפור קצר - לקוחות אחרות יוכלו לכתוב לידו קבלה קטנה שקיבלו על עצמן לזכות השם.</p>
    <form method="post" action="/community/tehillim/names/add">
      <label>שם ראשון<input type="text" name="name1" required maxlength="60" placeholder="לדוגמה: שרה בת רבקה" /></label>
      <label>שם שני (לא חובה)<input type="text" name="name2" maxlength="60" /></label>
      <label>סיפור קצר (לא חובה)<textarea name="story" maxlength="500" placeholder="ספרי בקצרה מה קורה, אם את רוצה"></textarea></label>
      <button class="btn" style="width:100%;margin-top:10px;" type="submit">הוספה לרשימה</button>
    </form>
  </div>` : `<p class="muted" style="text-align:center;"><a href="/login?role=customer&next=${encodeURIComponent("/community/tehillim")}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי כלקוחה</a> כדי להוסיף שם לתפילה (לקיחת פרק פתוחה לכולן, גם בלי התחברות).</p>`;

  const addStoryFormHtml = isCustomer ? `
  <div class="panel" style="max-width:560px;margin:0 auto 14px;">
    <h3>הוספת סיפור ישועה</h3>
    <form method="post" action="/community/tehillim/salvation-stories/add">
      <textarea name="text" required maxlength="1000" placeholder="ספרי לנו בקצרה על ישועה שהיתה בזכות התהילים"></textarea>
      <button class="btn btn-small" style="margin-top:8px;" type="submit">פרסום הסיפור</button>
    </form>
  </div>` : "";

  // ציטוט זכרון בראש העמוד, בגדול - לפי בקשה מפורשת. עיצוב מכובד ומאופק (ר' .tehillim-quote*
  // ב-layout.js) בלי אייקונים קלילים, בהתחשב בהקשר ההיסטורי הכבד של הציטוט.
  const quoteHtml = `
  <div class="tehillim-quote">
    <p class="tehillim-quote-text">"הדבר הכי גדול זה לעשות טוב למישהו אחר"</p>
    <p class="tehillim-quote-attribution">האדמו"ר מפיאסצנה, בתופת של תקופת השואה ומחנות ההשמדה</p>
  </div>`;
  const body = `
  ${quoteHtml}
  <p class="muted" style="text-align:center;"><a href="/community" style="color:var(--rose-dark);font-weight:700;">מאגרי קהילה</a> › בלב אחד</p>
  <h1 class="section-title" style="margin-top:2px;">🕯️ בלב אחד</h1>
  <p class="muted" style="text-align:center;margin-top:-10px;">רשימת שמות לתפילה, ותהילים קהילתי - כל אחת יכולה לקחת על עצמה פרק או יום ולסמן שקראה, גם בלי להתחבר.</p>

  <div class="tehillim-stats-row">
    <div class="tehillim-stat"><span class="tehillim-stat-num">${closedBooksCount}</span><span class="tehillim-stat-label">ספרים נסגרו</span></div>
    <div class="tehillim-stat"><span class="tehillim-stat-num">${chaptersReadCount}</span><span class="tehillim-stat-label">פרקים נקראו</span></div>
    <div class="tehillim-stat"><span class="tehillim-stat-num">${namesCount}</span><span class="tehillim-stat-label">שמות לתפילה</span></div>
  </div>

  <div class="panel">
    <h3>📖 תהילים יומי (לפי ימות השבוע)</h3>
    <p class="muted" style="font-size:13px;">ספר מס' ${esc(String(dailyBook.id))} - כל השבעה ימים נקראים, נפתח ספר חדש אוטומטית.</p>
    ${dailyBook.units.map((u) => tehillimUnitHtml(dailyBook, u, ctx.session, d, origin)).join("")}
  </div>

  <div class="panel">
    <h3>📖 תהילים לפי פרקים (150 פרקים)</h3>
    <p class="muted" style="font-size:13px;">ספר מס' ${esc(String(chaptersBook.id))} - כל 150 הפרקים נקראים, נפתח ספר חדש אוטומטית.</p>
    <!-- רשימה ארוכה (150 יחידות) - מכווצת כברירת מחדל בתוך details/summary כדי לא להציף
         את העמוד, לפי בקשה מפורשת לצמצם אותה. -->
    <details class="tehillim-chapters-details">
      <summary>להצגת כל 150 הפרקים (לחצי לפתיחה/סגירה)</summary>
      <div class="tehillim-chapters-grid">
        ${chaptersBook.units.map((u) => tehillimUnitHtml(chaptersBook, u, ctx.session, d, origin)).join("")}
      </div>
    </details>
  </div>

  <h2 class="section-title" style="margin-top:30px;">שמות לתפילה</h2>
  ${addNameFormHtml}
  ${names.length ? names.map((n) => tehillimNameEntryHtml(n, d, ctx)).join("") : `<p class="muted" style="text-align:center;">עדיין אין שמות ברשימה.</p>`}

  <h2 class="section-title" style="margin-top:30px;">סיפורי ישועות</h2>
  ${addStoryFormHtml}
  ${stories.length ? stories.map((s) => {
    const author = d.customers.find((c) => c.id === s.customerId);
    const del = (isAdmin || (ctx.session && ctx.session.role === "customer" && ctx.session.id === s.customerId))
      ? `<form method="post" action="/community/tehillim/salvation-stories/${s.id}/delete" style="margin-top:6px;" onsubmit="return confirm('למחוק את הסיפור הזה?');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form>` : "";
    return `<div class="panel" style="background:var(--cream);margin-bottom:10px;"><p style="margin:0;font-size:14px;line-height:1.4;">${esc(s.text)}</p><p class="muted" style="margin:6px 0 0;font-size:12px;">${author ? esc(author.name.split(" ")[0]) : "אנונימית"} · ${esc(new Date(s.createdAt).toLocaleDateString("he-IL"))}</p>${del}</div>`;
  }).join("") : `<p class="muted" style="text-align:center;">עדיין אין סיפורים - היי הראשונה לשתף.</p>`}
  `;
  sendHtml(res, 200, page({ title: "בלב אחד", session: ctx.session, body, query }));
});

route("POST", "/community/tehillim/names/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/community/tehillim")}`);
  const d = db.load();
  const body = await readBody(req);
  const name1 = clip((body.get("name1") || "").trim(), 60);
  const name2 = clip((body.get("name2") || "").trim(), 60);
  if (!name1) return redirect(res, `/community/tehillim?err=${encodeURIComponent("נא למלא לפחות שם אחד.")}`);
  d.tehillimNames = d.tehillimNames || [];
  d.tehillimNames.push({
    id: db.nextId("tehillimName"),
    customerId: ctx.session.id,
    names: [name1, name2].filter(Boolean),
    story: clip((body.get("story") || "").trim(), 500),
    kabbalot: [],
    createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("השם נוסף לרשימת התפילה.")}`);
});

route("POST", "/community/tehillim/names/:id/delete", async (req, res, params, query, ctx) => {
  const d = db.load();
  const n = (d.tehillimNames || []).find((x) => x.id === params.id);
  if (!n) return redirect(res, "/community/tehillim");
  const isOwner = ctx.session && ctx.session.role === "customer" && ctx.session.id === n.customerId;
  const isAdmin = ctx.session && ctx.session.role === "admin";
  if (!isOwner && !isAdmin) return redirect(res, "/login");
  d.tehillimNames = d.tehillimNames.filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("השם הוסר.")}`);
});

route("POST", "/community/tehillim/names/:id/kabbalah", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/community/tehillim")}`);
  const d = db.load();
  const n = (d.tehillimNames || []).find((x) => x.id === params.id);
  if (!n) return redirect(res, "/community/tehillim");
  const body = await readBody(req);
  const type = TEHILLIM_KABBALAH_OPTIONS[body.get("type")] ? body.get("type") : "other";
  n.kabbalot = n.kabbalot || [];
  n.kabbalot.push({
    id: db.nextId("tehillimKabbalah"),
    customerId: ctx.session.id,
    type,
    customText: type === "other" ? clip((body.get("customText") || "").trim(), 200) : "",
    createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("הקבלה נשמרה - שיהיה לזכות!")}`);
});

route("POST", "/community/tehillim/kabbalah/:id/delete", async (req, res, params, query, ctx) => {
  const d = db.load();
  const n = (d.tehillimNames || []).find((x) => (x.kabbalot || []).some((k) => k.id === params.id));
  if (!n) return redirect(res, "/community/tehillim");
  const k = n.kabbalot.find((x) => x.id === params.id);
  const isOwner = ctx.session && ctx.session.role === "customer" && ctx.session.id === k.customerId;
  const isAdmin = ctx.session && ctx.session.role === "admin";
  if (!isOwner && !isAdmin) return redirect(res, "/login");
  n.kabbalot = n.kabbalot.filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("הקבלה הוסרה.")}`);
});

route("POST", "/community/tehillim/salvation-stories/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent("/community/tehillim")}`);
  const d = db.load();
  const body = await readBody(req);
  const text = clip((body.get("text") || "").trim(), 1000);
  if (!text) return redirect(res, "/community/tehillim");
  d.tehillimSalvationStories = d.tehillimSalvationStories || [];
  d.tehillimSalvationStories.push({ id: db.nextId("tehillimStory"), customerId: ctx.session.id, text, createdAt: new Date().toISOString() });
  db.save();
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("הסיפור פורסם - תודה ששיתפת!")}`);
});

route("POST", "/community/tehillim/salvation-stories/:id/delete", async (req, res, params, query, ctx) => {
  const d = db.load();
  const s = (d.tehillimSalvationStories || []).find((x) => x.id === params.id);
  if (!s) return redirect(res, "/community/tehillim");
  const isOwner = ctx.session && ctx.session.role === "customer" && ctx.session.id === s.customerId;
  const isAdmin = ctx.session && ctx.session.role === "admin";
  if (!isOwner && !isAdmin) return redirect(res, "/login");
  d.tehillimSalvationStories = d.tehillimSalvationStories.filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("הסיפור הוסר.")}`);
});

// לקיחת יחידה פתוחה לכולן - גם בלי התחברות כלקוחה (לפי בקשה מפורשת). אם יש session של לקוחה
// מחוברת נשמר גם claimedByCustomerId (כדי לשמור על ההתנהגות הקודמת - רק היא תוכל לסמן קראתי
// מרשימת היחידות עצמה); אורחת לא מחוברת מקבלת claimed=true בלי customerId, וכל אחת שתיכנס
// לעמוד היחידה הספציפי הזה תוכל להשלים את הסימון (ר' ההערה על "שיטת הכבוד" למעלה).
route("POST", "/community/tehillim/:bookId/unit/:unitIndex/claim", async (req, res, params, query, ctx) => {
  const d = db.load();
  const book = (d.tehillimBooks || []).find((b) => b.id === params.bookId);
  const unit = book && book.units[parseInt(params.unitIndex, 10)];
  if (book && unit && !unit.claimed && !unit.read) {
    unit.claimed = true;
    unit.claimedByCustomerId = (ctx.session && ctx.session.role === "customer") ? ctx.session.id : null;
    unit.claimedAt = new Date().toISOString();
    db.save();
  }
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("לקחת על עצמך - אפשר לקרוא ולסמן שקראת.")}`);
});

route("POST", "/community/tehillim/:bookId/unit/:unitIndex/release", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const book = (d.tehillimBooks || []).find((b) => b.id === params.bookId);
  const unit = book && book.units[parseInt(params.unitIndex, 10)];
  if (unit && !unit.read) { unit.claimed = false; unit.claimedByCustomerId = null; unit.claimedAt = null; }
  db.save();
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("היחידה שוחררה.")}`);
});

route("GET", "/community/tehillim/:bookId/unit/:unitIndex", async (req, res, params, query, ctx) => {
  const d = db.load();
  const book = (d.tehillimBooks || []).find((b) => b.id === params.bookId);
  const unit = book && book.units[parseInt(params.unitIndex, 10)];
  if (!book || !unit) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את זה.</p>` }));
  // אם נלקחה בלי התחברות (claimed=true, בלי claimedByCustomerId) - כל מי שמגיעה לעמוד היחידה
  // הספציפי הזה יכולה להשלים את הסימון (אין דרך לזהות "אותה מבקרת" שוב, ר' ההערה למעלה).
  const isClaimer = unit.claimed && (!unit.claimedByCustomerId || (ctx.session && ctx.session.role === "customer" && ctx.session.id === unit.claimedByCustomerId));
  const isAdmin = ctx.session && ctx.session.role === "admin";
  const origin = getOrigin(req);
  const body = `
  <h1 class="section-title">${esc(unit.label)}</h1>
  <div class="panel" style="max-width:520px;margin:0 auto;text-align:center;">
    <p class="muted">${unit.from === unit.to ? `פרק ${unit.from}` : `פרקים ${unit.from}-${unit.to}`}</p>
    <a class="btn" href="${sefariaChapterLink(unit.from, unit.to)}" target="_blank" rel="noopener">📖 לקריאת הפרק/ים ב-Sefaria ↗</a>
    ${unit.read
      ? `<p style="margin-top:16px;font-weight:700;">✅ כבר סומן כנקרא</p>`
      : (isClaimer || isAdmin)
        ? `<form method="post" action="/community/tehillim/${book.id}/unit/${unit.index}/read" style="margin-top:16px;"><button class="btn" type="submit">✅ סימנתי שקראתי</button></form>`
        : `<p class="muted" style="margin-top:16px;">${unit.claimed ? "היחידה הזו נלקחה על ידי מישהי אחרת." : "עדיין לא נלקחה - אפשר לקחת אותה מעמוד בלב אחד."}</p>`}
    <p style="margin-top:16px;">${tehillimShareButtonHtml(book, unit, origin)}</p>
    <p class="muted" style="margin-top:16px;"><a href="/community/tehillim">← חזרה לעמוד בלב אחד</a></p>
  </div>
  `;
  sendHtml(res, 200, page({ title: esc(unit.label), session: ctx.session, body, query }));
});

route("POST", "/community/tehillim/:bookId/unit/:unitIndex/read", async (req, res, params, query, ctx) => {
  const d = db.load();
  const book = (d.tehillimBooks || []).find((b) => b.id === params.bookId);
  const unit = book && book.units[parseInt(params.unitIndex, 10)];
  if (!book || !unit) return redirect(res, "/community/tehillim");
  const isClaimer = unit.claimed && (!unit.claimedByCustomerId || (ctx.session && ctx.session.role === "customer" && ctx.session.id === unit.claimedByCustomerId));
  const isAdmin = ctx.session && ctx.session.role === "admin";
  if (!isClaimer && !isAdmin) return redirect(res, "/community/tehillim");
  if (!unit.read) {
    unit.read = true;
    unit.readAt = new Date().toISOString();
    // כשכל היחידות של הספר נקראו - הוא "נסגר" אוטומטית ונפתח ספר חדש מאותו סוג מיד, לפי
    // בקשה מפורשת: "כל אחת שמסמנת שקראה ממשיכים הלאה ככה עד שנגמר ספר נפתח ספר חדש".
    if (book.units.every((u) => u.read)) {
      book.status = "closed";
      book.closedAt = new Date().toISOString();
      ensureOpenTehillimBook(d, book.division);
    }
    db.save();
  }
  redirect(res, `/community/tehillim?ok=${encodeURIComponent("יישר כח! סומן שקראת.")}`);
});

route("GET", "/community/:type", async (req, res, params, query, ctx) => {
  const meta = COMMUNITY_TYPES[params.type];
  if (!meta) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, הסוג הזה לא קיים.</p>` }));
  const d = db.load();
  const isCustomer = requireRole(ctx.session, "customer");
  const notifiable = params.type === "giveaway" || params.type === "sale";
  const customer = isCustomer ? d.customers.find((cu) => cu.id === ctx.session.id) : null;
  // ביקור בעמוד סוג מאגר "בר-התראה" (מסירות/מכירת יד 2) מסמן שהיא ראתה את מה שיש כרגע -
  // אותו רעיון בדיוק כמו arenaLastSeen (ר' GET /arena) - ר' communityUnseenCount ב-layout.js
  // שמשתמש בזה כדי לדעת אילו פריטים חדשים "מאז הביקור האחרון" להראות בתג ליד "קהילת SheCan".
  if (customer && notifiable) {
    d.communityLastSeen = d.communityLastSeen || {};
    d.communityLastSeen[`customer:${customer.id}`] = new Date().toISOString();
    db.save();
  }
  const tag = query.get("tag") || "";
  const cityId = query.get("city") || "";
  const q = (query.get("q") || "").trim().toLowerCase();
  // סינוני "פרטי שמלה" - רלוונטיים ומוצגים רק בעמוד ההשכרות (params.type==="rental"), לפי
  // בקשה מפורשת: "בתחום של השכרת שמלות - תהיה אפשרות לסנן לפי מחיר, צבע, אורך, ילדות או
  // נשים, מיקום". כל אחד מהם אופציונלי לגמרי - אין תלות בין הסינונים, ואפשר לשלב את כולם.
  const isRentalType = params.type === "rental";
  const color = isRentalType ? (query.get("color") || "") : "";
  const length = isRentalType ? (query.get("length") || "") : "";
  const audience = isRentalType ? (query.get("audience") || "") : "";
  const maxPrice = isRentalType ? (query.get("maxPrice") || "") : "";
  let items = (d.communityListings || []).filter((c) => c.type === params.type && c.status === "approved");
  if (tag) items = items.filter((c) => c.tag === tag);
  if (cityId) items = items.filter((c) => c.cityId === cityId);
  if (q) items = items.filter((c) => `${c.title} ${c.description || ""}`.toLowerCase().includes(q));
  if (color) items = items.filter((c) => c.color === color);
  if (length) items = items.filter((c) => c.length === length);
  if (audience) items = items.filter((c) => c.audience === audience);
  if (maxPrice) {
    const maxPriceNum = parseFloat(maxPrice);
    if (Number.isFinite(maxPriceNum)) items = items.filter((c) => c.priceNum != null && c.priceNum <= maxPriceNum);
  }
  items = items.slice().sort((a, b) => new Date(b.approvedAt || b.createdAt) - new Date(a.approvedAt || a.createdAt));
  const tagOptions = meta.tags.map((t) => `<option value="${esc(t)}" ${tag === t ? "selected" : ""}>${esc(t)}</option>`).join("");
  const hasAnyFilter = Boolean(tag || cityId || q || color || length || audience || maxPrice);
  // כפתור "דרושות שמלות" - קישור לקטגוריית הבקשות הייעודית (ר' COMMUNITY_TYPES.dressWanted),
  // מוצג בעמוד ההשכרות לפי בקשה מפורשת ("וכן תשים כפתור של דרושות שמלות").
  const dressWantedButtonHtml = isRentalType ? `<p style="text-align:center;margin:-4px 0 4px;"><a class="btn btn-outline btn-small" href="/community/dressWanted">🙋‍♀️ דרושה לך שמלה? פרסמי בקשה כאן</a></p>` : "";
  const dressFiltersHtml = isRentalType ? `
    <div class="search-row" style="margin-top:10px;">
      <select name="color"><option value="">כל הצבעים</option>${DRESS_COLORS.map((c) => `<option value="${esc(c)}" ${color === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <select name="length"><option value="">כל האורכים</option>${DRESS_LENGTHS.map((l) => `<option value="${esc(l)}" ${length === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <select name="audience"><option value="">נשים וילדות</option>${DRESS_AUDIENCES.map((a) => `<option value="${esc(a)}" ${audience === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>
      <input type="number" name="maxPrice" value="${esc(maxPrice)}" placeholder="עד מחיר ₪" style="max-width:150px;" min="0" />
    </div>
    <p class="muted" style="text-align:center;font-size:12.5px;margin:2px 0 0;">הסינונים האלה רלוונטיים בעיקר לשמלות ערב - כל אחד מהם אופציונלי, אין צורך למלא הכל.</p>
  ` : "";
  // פאנל "התראות" - רק ב-2 הסוגים הבנים-התראה, ורק ללקוחה מחוברת (בדיוק כמו פרסום פריט
  // בסוגים האלה - דורש חשבון לקוחה). צ'קבוקס לכל תגית, מסומן מראש לפי מה שכבר רשומה אליו -
  // שליחה מחליפה את כל הרשימה בבת אחת (set-replace, לא toggle בודד), פשוט וחסין יותר מטופס
  // עם כפתור נפרד לכל תגית.
  const notifyPanelHtml = notifiable ? (isCustomer ? `
  <div class="panel" style="max-width:520px;margin:0 auto 20px;">
    <h3 style="margin:0 0 8px;">🔔 התראה על פריטים חדשים</h3>
    <p class="muted" style="margin:0 0 10px;">סמני קטגוריות ותקבלי מייל בכל פעם שמתפרסם פריט חדש בהן, וגם תג ליד "קהילת SheCan" בתפריט.</p>
    <form method="post" action="/community/${params.type}/notify-prefs">
      ${meta.tags.map((t) => `<label style="display:flex;align-items:center;gap:6px;font-weight:600;margin-top:4px;"><input type="checkbox" name="tag" value="${esc(t)}" ${((customer.communityNotifyTags || {})[params.type] || []).includes(t) ? "checked" : ""} /> ${esc(t)}</label>`).join("")}
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת ההתראות שלי</button>
    </form>
  </div>` : `<p class="muted" style="text-align:center;margin-bottom:20px;"><a href="/login?role=customer&next=${encodeURIComponent(`/community/${params.type}`)}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי כלקוחה</a> כדי להירשם להתראות על פריטים חדשים בקטגוריה שמעניינת אותך.</p>`) : "";
  // כפתור "הוספת פריט" קבוע וגלוי תמיד - לפי בקשה מפורשת שהוספת פריט (בעיקר במסירות) תהיה
  // "מודגשת ונגישה". קודם לכן הקישור היחיד היה טקסט קטן בתוך הודעת "אין פריטים" - כלומר
  // נעלם לגמרי ברגע שהיו פריטים ברשימה. עכשיו זה כפתור בולט תמיד למעלה, בלי תלות בתוכן
  // הרשימה. הכותרת מדויקת לפי טיפוס (תואמת בדיוק לכותרת H1 של דף ההוספה עצמו) עבור מסירות/
  // מכירת יד 2 (שני הטיפוסים היחידים עם דף הוספה ייעודי), וגנרית לפי meta.singular בשאר.
  const addItemLabel = meta.label === "מסירות" ? "מסירת חפץ" : meta.label === "מכירת יד 2" ? "מכירת חפץ" : `הוספת ${meta.singular}`;
  const addItemButtonHtml = `<p style="text-align:center;margin:10px 0 18px;"><a href="${communityAddUrl(params.type)}" class="btn" style="font-size:16px;padding:13px 30px;box-shadow:0 3px 10px rgba(0,0,0,.12);">➕ ${esc(addItemLabel)}</a></p>`;
  const body = `
  <p class="muted" style="text-align:center;"><a href="/community" style="color:var(--rose-dark);font-weight:700;">מאגרי קהילה</a> › ${esc(meta.label)}</p>
  <h1 class="section-title" style="margin-top:2px;">${esc(meta.label)}</h1>
  <p class="muted" style="text-align:center;margin-top:-10px;">${esc(meta.desc)}</p>
  ${addItemButtonHtml}
  ${dressWantedButtonHtml}
  <form class="search-box" method="get" action="/community/${params.type}">
    <div class="search-row"><input type="text" name="q" value="${esc(query.get("q") || "")}" placeholder="חפשי לפי שם או תיאור" /></div>
    <div class="search-row" style="margin-top:10px;">
      <select name="tag"><option value="">כל הסוגים</option>${tagOptions}</select>
      ${cityAutocompleteHtml({ fieldName: "city", selectedId: cityId, selectedName: cityId ? cityName(d, cityId) : "", placeholder: "מאיזו עיר?" })}
      <button class="btn" type="submit">חפשי</button>
    </div>
    ${dressFiltersHtml}
    ${hasAnyFilter ? `<p style="text-align:center;margin-top:6px;"><a href="/community/${params.type}" style="color:var(--rose-dark);font-weight:700;">נקה סינון</a></p>` : ""}
  </form>
  ${notifyPanelHtml}
  ${items.length ? `<div class="grid">${items.map((c) => communityCard(c, d)).join("")}</div>` : `<p class="muted" style="text-align:center;">עדיין אין פריטים תואמים - ${meta.label === "מורות פרטיות" ? "" : "אולי "}את יכולה <a href="${communityAddUrl(params.type)}" style="color:var(--rose-dark);font-weight:700;">להיות הראשונה להוסיף</a>.</p>`}
  `;
  sendHtml(res, 200, page({ title: meta.label, session: ctx.session, body, query }));
});

route("POST", "/community/:type/notify-prefs", async (req, res, params, query, ctx) => {
  const meta = COMMUNITY_TYPES[params.type];
  if (!meta || (params.type !== "giveaway" && params.type !== "sale")) return redirect(res, "/community");
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent(`/community/${params.type}`)}`);
  const d = db.load();
  const customer = d.customers.find((cu) => cu.id === ctx.session.id);
  if (!customer) return redirect(res, "/community");
  const body = await readBody(req);
  // getAll (לא get) כדי לקבל את כל התגיות המסומנות, לא רק הראשונה - סט חדש מחליף את הקודם
  // לגמרי, מסונן מול רשימת התגיות התקפות של הסוג הזה כדי שערך מזויף לא ייכנס לרשומה.
  const selected = (body.getAll ? body.getAll("tag") : [body.get("tag")].filter(Boolean)).filter((t) => meta.tags.includes(t));
  customer.communityNotifyTags = customer.communityNotifyTags || {};
  customer.communityNotifyTags[params.type] = selected;
  db.save();
  redirect(res, `/community/${params.type}?ok=${encodeURIComponent("ההתראות שלך עודכנו.")}`);
});

// עמוד פריט בודד - בנוי כמו עמוד פרופיל עצמאית (כותרת/תג/עיר, ואז פרטי יצירת קשר). "מסירות"
// ו"מכירת יד 2" מקבלות גם כפתור "שיתוף קישור לחפץ" (ר' scShareCommunityItem ב-layout.js),
// לפי בקשה מפורשת - שאר הסוגים לא, כדי לא להוסיף כפתור שלא התבקש.
route("GET", "/community/:type/:id", async (req, res, params, query, ctx) => {
  const meta = COMMUNITY_TYPES[params.type];
  const d = db.load();
  const c = meta && (d.communityListings || []).find((x) => x.id === params.id && x.type === params.type && x.status === "approved");
  if (!c) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הפריט הזה.</p>` }));
  c.viewCount = (c.viewCount || 0) + 1;
  saveSiteStatsThrottled();
  // "המלצות מוצרים" מציגות דגם/מחיר/איפה קנו במקום פרטי קשר - ר' ההערה על
  // COMMUNITY_TYPES.product. "מכירת יד 2" מציגה מחיר בנוסף לפרטי קשר (זו עדיין עסקה בין שתי
  // אנשים). שאר הסוגים מציגים טלפון/WhatsApp/מייל כרגיל.
  const contactRows = c.type === "product"
    ? [
        c.model ? `<div class="profile-detail-row"><span class="profile-detail-icon">🏷️</span><span>דגם: ${esc(c.model)}</span></div>` : "",
        c.price ? `<div class="profile-detail-row"><span class="profile-detail-icon">💰</span><span>${esc(c.price)}</span></div>` : "",
        c.whereBought ? `<div class="profile-detail-row"><span class="profile-detail-icon">🛒</span><span>נקנה ב: ${esc(c.whereBought)}</span></div>` : "",
      ].filter(Boolean).join("")
    : [
        (c.type === "sale" || c.type === "rental") && c.price ? `<div class="profile-detail-row"><span class="profile-detail-icon">💰</span><span>${esc(c.price)}</span></div>` : "",
        // צבע/אורך/קהל יעד - רלוונטי רק לפריטי שמלות ערב בהשכרה (ר' DRESS_TAG), ריק ולא מוצג
        // בכל שאר פריטי המאגר.
        c.color ? `<div class="profile-detail-row"><span class="profile-detail-icon">🎨</span><span>צבע: ${esc(c.color)}</span></div>` : "",
        c.length ? `<div class="profile-detail-row"><span class="profile-detail-icon">📏</span><span>אורך: ${esc(c.length)}</span></div>` : "",
        c.audience ? `<div class="profile-detail-row"><span class="profile-detail-icon">👤</span><span>מיועדת ל${esc(c.audience)}</span></div>` : "",
        c.phone ? `<div class="profile-detail-row"><span class="profile-detail-icon">📞</span><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div>` : "",
        (c.hasWhatsapp && c.phone) ? `<div class="profile-detail-row"><span class="profile-detail-icon">${whatsappIconSvg}</span><a class="whatsapp-link" href="https://wa.me/${esc(waPhoneDigits(c.phone))}" target="_blank" rel="noopener">WhatsApp</a></div>` : "",
        c.email ? `<div class="profile-detail-row"><span class="profile-detail-icon">📧</span><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : "",
      ].filter(Boolean).join("");
  const shareUrl = `${getOrigin(req)}/community/${c.type}/${c.id}`;
  const shareButtonHtml = (c.type === "giveaway" || c.type === "sale")
    ? `<p style="text-align:center;margin-top:14px;"><button type="button" class="btn btn-small btn-outline" data-share-title="${esc(c.title)}" data-share-url="${esc(shareUrl)}" onclick="scShareCommunityItem(this)">📤 שיתוף קישור לחפץ</button></p>`
    : "";
  const body = `
  <p class="muted" style="text-align:center;"><a href="/community" style="color:var(--rose-dark);font-weight:700;">מאגרי קהילה</a> › <a href="/community/${params.type}" style="color:var(--rose-dark);font-weight:700;">${esc(meta.label)}</a> › ${esc(c.title)}</p>
  <div class="panel profile-detail profile-merged">
    <div class="profile-header-row">
      <div class="profile-header-namelogo">
        ${c.photoDataUri
          ? `<div class="profile-header-logo" style="background-image:url('${esc(c.photoDataUri)}');background-size:cover;background-position:center;"></div>`
          : `<div class="profile-header-logo">${meta.icon}</div>`}
        <div class="profile-header-info">
          <h1 class="profile-header-name">${esc(c.title)}</h1>
          ${c.tag ? `<div class="profile-header-years">🏷️ ${esc(c.tag)}</div>` : ""}
          ${c.cityId ? `<div class="profile-header-location">📍 ${esc(cityName(d, c.cityId))}${c.address ? ` - ${esc(c.address)}` : ""}</div>` : (c.address ? `<div class="profile-header-location">📍 ${esc(c.address)}</div>` : "")}
        </div>
      </div>
      ${contactRows ? `<div class="profile-header-divider"></div><div class="profile-contact-col">${contactRows}</div>` : ""}
    </div>
    ${c.description ? `<p class="profile-header-desc">${esc(c.description)}</p>` : ""}
  </div>
  ${shareButtonHtml}
  ${COMMUNITY_REVIEWABLE_TYPES.includes(params.type) ? communityReviewsSectionHtml(c, d, ctx) : ""}
  <p style="text-align:center;"><a class="btn btn-outline btn-small" href="${communityAddUrl(params.type)}">הוספת פריט דומה למאגר</a></p>
  `;
  sendHtml(res, 200, page({ title: c.title, session: ctx.session, body, query }));
});

route("POST", "/community/:type/:id/review", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, `/login?role=customer&next=${encodeURIComponent(`/community/${params.type}/${params.id}`)}`);
  // הגנה כפולה: גם הטופס וגם ה-route בודקים ש-3 הסוגים האלה בלבד ניתנים לתגובה - ר' ההערה
  // על COMMUNITY_REVIEWABLE_TYPES.
  if (!COMMUNITY_REVIEWABLE_TYPES.includes(params.type)) return redirect(res, `/community/${params.type}/${params.id}`);
  const d = db.load();
  const c = (d.communityListings || []).find((x) => x.id === params.id && x.type === params.type && x.status === "approved");
  const backUrl = `/community/${params.type}/${params.id}`;
  if (!c) return redirect(res, "/community");
  const body = await readBody(req);
  const text = (body.get("text") || "").trim();
  if (!text) return redirect(res, `${backUrl}?err=${encodeURIComponent("צריך לכתוב כמה מילים.")}`);
  const customer = d.customers.find((cu) => cu.id === ctx.session.id);
  const rating = Math.min(5, Math.max(1, Math.round(Number(body.get("rating")) || 5)));
  const existing = (d.reviews || []).find((r) => r.type === "community" && r.targetId === c.id && r.authorCustomerId === customer.id);
  if (existing) {
    existing.rating = rating;
    existing.text = text;
    existing.updatedAt = new Date().toISOString();
  } else {
    d.reviews.push({
      id: db.nextId("review"), type: "community", targetId: c.id, communityType: params.type,
      authorCustomerId: customer.id, authorName: customer.name, isAnonymous: false,
      rating, text, photoDataUri: null, status: "approved", createdAt: new Date().toISOString(),
      response: "", responseDate: null,
    });
  }
  db.save();
  redirect(res, `${backUrl}?ok=${encodeURIComponent(existing ? "התגובה שלך עודכנה!" : "תודה על התגובה!")}`);
});

route("POST", "/community/add", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/community/add?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי שוב.")}`);
  const type = COMMUNITY_TYPES[body.get("type")] ? body.get("type") : null;
  const title = (body.get("title") || "").trim();
  if (!type || !title) return redirect(res, `/community/add?err=${encodeURIComponent("צריך למלא לפחות סוג ושם.")}`);
  // "מסירות" ו"מכירת יד 2" לא עוברות דרך הטופס הפתוח הזה - הן דורשות חשבון לקוחה מחובר
  // (ר' ההערה על COMMUNITY_TYPES.giveaway למעלה), כדי שהמפרסמת תוכל אחר כך להוריד את הפריט
  // בעצמה.
  if (type === "giveaway") return redirect(res, "/community/giveaway/add");
  if (type === "sale") return redirect(res, "/community/sale/add");
  const d = db.load();
  const c = {
    id: db.nextId("communityListing"),
    type, title,
    tag: body.get("tag") || "",
    cityId: body.get("city") || "",
    address: clip((body.get("address") || "").trim(), 200),
    description: clip(body.get("description"), 500),
    phone: (body.get("phone") || "").trim(),
    hasWhatsapp: body.get("hasWhatsapp") === "1",
    email: (body.get("email") || "").trim(),
    photoDataUri: fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES),
    contactName: (body.get("contactName") || "").trim(),
    // שלושת השדות האלה רלוונטיים רק ל-type:"product" (ר' ההערה על COMMUNITY_TYPES.product) -
    // נשמרים ריקים בכל שאר הסוגים כי הטופס לא מציג אותם שם. price כולל גם fallback לשדה
    // dressPrice (ר' scDressFieldsGroup בטופס) - שני השמות מתאחדים כאן לעמודת price אחת.
    model: clip((body.get("model") || "").trim(), 100),
    price: clip((body.get("price") || body.get("dressPrice") || "").trim(), 50),
    whereBought: clip((body.get("whereBought") || "").trim(), 150),
    // צבע/אורך/קהל יעד - רלוונטי רק להשכרת שמלות ערב (ר' DRESS_TAG/scDressFieldsGroup),
    // נבדק מול רשימות סגורות כדי שערך מזויף לא ייכנס לרשומה (אותו דפוס כמו סינון tag).
    color: DRESS_COLORS.includes(body.get("color")) ? body.get("color") : "",
    length: DRESS_LENGTHS.includes(body.get("length")) ? body.get("length") : "",
    audience: DRESS_AUDIENCES.includes(body.get("audience")) ? body.get("audience") : "",
    priceNum: parsePriceNum(body.get("price") || body.get("dressPrice") || ""),
    ownerCustomerId: null,
    source: "self",
    status: "pending",
    viewCount: 0,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  };
  d.communityListings.push(c);
  db.save();
  redirect(res, `/community/add?ok=${encodeURIComponent("תודה! הפריט נשלח לאישור ויתפרסם בקרוב.")}`);
});

// ----- Admin: ניהול מאגרי הקהילה -----
// לפי בקשה מפורשת של שפיר: ניהול נפרד לגמרי לכל אחד מ-8 הסוגים (לא פאנל אחד משולב), כדי
// שיהיה אפשר לעקוב אחרי כל מאגר בנפרד - כל פאנל מכיל: ממתינים לאישור, טבלת פריטים מאושרים
// עם מחיקה, טופס הוספה ישירה שמתפרסם מיד (source:"admin", status:"approved"), ושליטה על
// מחיר התחום (d.settings.communityTypePricing[type]) - כל אלה בתוך panel אחד לכל type, עם
// data-badge שסופר את הממתינים של אותו סוג בדיוק, כמו שאר הפאנלים בעמוד הניהול.
function communityAdminPanelHtml(type, d) {
  const meta = COMMUNITY_TYPES[type];
  // "המלצות מוצרים" הוא תוכן/ביקורת, לא שירות עם פרטי קשר - ר' ההערה על COMMUNITY_TYPES.product.
  // "מכירת יד 2" הוא שירות עם פרטי קשר רגילים, פלוס שדה מחיר - ר' ההערה על COMMUNITY_TYPES.sale.
  const isProduct = type === "product";
  const isSale = type === "sale";
  const pending = (d.communityListings || []).filter((c) => c.type === type && c.status === "pending" && !isSnoozed(d, `communityListing:${c.id}`));
  const approved = (d.communityListings || []).filter((c) => c.type === type && c.status === "approved")
    .slice().sort((a, b) => new Date(b.approvedAt || b.createdAt) - new Date(a.approvedAt || a.createdAt));
  const price = (d.settings.communityTypePricing && d.settings.communityTypePricing[type]) || 0;
  const tagOptions = meta.tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  return `
  <div class="panel" data-badge="${pending.length}">
    <h3>${meta.icon} ${esc(meta.label)} - ניהול נפרד</h3>
    <p class="muted">${esc(meta.desc)}</p>

    <h4 style="margin-top:18px;">ממתינים לאישור (${pending.length})</h4>
    ${pending.length ? pending.map((c) => `
      <div class="panel" style="background:var(--cream);">
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
          ${c.photoDataUri ? `<img src="${esc(c.photoDataUri)}" alt="" style="width:90px;height:90px;object-fit:cover;border-radius:10px;flex-shrink:0;" />` : ""}
          <div style="flex:1;min-width:220px;">
            <h4 style="margin:0 0 6px;">${esc(c.title)}${c.tag ? ` <span class="muted" style="font-weight:600;">(${esc(c.tag)})</span>` : ""}</h4>
            ${isProduct ? `
            ${c.model ? `<p class="muted" style="margin:2px 0;">🏷️ דגם: ${esc(c.model)}</p>` : ""}
            ${c.price ? `<p class="muted" style="margin:2px 0;">💰 ${esc(c.price)}</p>` : ""}
            ${c.whereBought ? `<p class="muted" style="margin:2px 0;">🛒 נקנה ב: ${esc(c.whereBought)}</p>` : ""}
            ` : `
            ${(isSale || type === "rental") && c.price ? `<p class="muted" style="margin:2px 0;">💰 ${esc(c.price)}</p>` : ""}
            ${c.color ? `<p class="muted" style="margin:2px 0;">🎨 ${esc(c.color)}${c.length ? ` · ${esc(c.length)}` : ""}${c.audience ? ` · ${esc(c.audience)}` : ""}</p>` : ""}
            ${c.cityId ? `<p class="muted" style="margin:2px 0;">📍 ${esc(cityName(d, c.cityId))}${c.address ? ` - ${esc(c.address)}` : ""}</p>` : (c.address ? `<p class="muted" style="margin:2px 0;">📍 ${esc(c.address)}</p>` : "")}
            ${c.phone ? `<p class="muted" style="margin:2px 0;">📞 ${esc(c.phone)}${c.hasWhatsapp ? " (גם WhatsApp)" : ""}</p>` : ""}
            ${c.email ? `<p class="muted" style="margin:2px 0;">📧 ${esc(c.email)}</p>` : ""}
            `}
            ${c.contactName ? `<p class="muted" style="margin:2px 0;">נשלח ע"י: ${esc(c.contactName)}</p>` : ""}
          </div>
        </div>
        ${c.description ? `<p style="margin-top:10px;">${esc(c.description)}</p>` : ""}
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center;">
          <form method="post" action="/admin/community/${c.id}/approve"><button class="btn btn-small" type="submit">אישור</button></form>
          <form method="post" action="/admin/community/${c.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
          ${snoozeButtonHtml(`communityListing:${c.id}`, "communityListing", `${meta.label}: ${c.title}`)}
          ${isSale && c.ownerCustomerId ? messageCustomerButtonHtml(c.ownerCustomerId, `הפריט "${c.title}" ששלחת לאישור`, `communityListing-${c.id}`) : ""}
          ${isProduct ? emailListingSubmitterButtonHtml(c.id, c.email, `communityListing-${c.id}`) : ""}
        </div>
      </div>`).join("") : `<p class="muted">אין כרגע פריטים ממתינים לאישור.</p>`}

    <h4 style="margin-top:22px;">פריטים מאושרים (${approved.length})</h4>
    ${approved.length ? (isProduct ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם מוצר</th><th>דגם</th><th>מחיר</th><th>איפה נקנה</th><th>מקור</th><th>צפיות</th><th>מחיקה</th></tr>
      ${approved.map((c) => `<tr>
        <td>${esc(c.title)}</td><td>${esc(c.model || "-")}</td><td>${esc(c.price || "-")}</td><td>${esc(c.whereBought || "-")}</td>
        <td>${c.source === "admin" ? "הוזן ע\"י המנהלת" : "הרשמה עצמית"}</td><td>${c.viewCount || 0}</td>
        <td><form method="post" action="/admin/community/${c.id}/delete" onsubmit="return confirm('למחוק לצמיתות את ' + ${JSON.stringify(c.title || "")} + '? זו פעולה שלא ניתן לבטל.');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`).join("")}
    </table></div>` : isSale ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>סוג מדויק</th><th>מחיר</th><th>עיר</th><th>כתובת</th><th>מקור</th><th>צפיות</th><th>מחיקה</th></tr>
      ${approved.map((c) => `<tr>
        <td>${esc(c.title)}</td><td>${esc(c.tag || "-")}</td><td>${esc(c.price || "-")}</td><td>${c.cityId ? esc(cityName(d, c.cityId)) : "-"}</td><td>${esc(c.address || "-")}</td>
        <td>${c.source === "admin" ? "הוזן ע\"י המנהלת" : "הרשמה עצמית"}</td><td>${c.viewCount || 0}</td>
        <td><form method="post" action="/admin/community/${c.id}/delete" onsubmit="return confirm('למחוק לצמיתות את ' + ${JSON.stringify(c.title || "")} + '? זו פעולה שלא ניתן לבטל.');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`).join("")}
    </table></div>` : `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>סוג מדויק</th><th>עיר</th><th>כתובת</th><th>מקור</th><th>צפיות</th><th>מחיקה</th></tr>
      ${approved.map((c) => `<tr>
        <td>${esc(c.title)}</td><td>${esc(c.tag || "-")}</td><td>${c.cityId ? esc(cityName(d, c.cityId)) : "-"}</td><td>${esc(c.address || "-")}</td>
        <td>${c.source === "admin" ? "הוזן ע\"י המנהלת" : "הרשמה עצמית"}</td><td>${c.viewCount || 0}</td>
        <td><form method="post" action="/admin/community/${c.id}/delete" onsubmit="return confirm('למחוק לצמיתות את ' + ${JSON.stringify(c.title || "")} + '? זו פעולה שלא ניתן לבטל.');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`).join("")}
    </table></div>`) : `<p class="muted">עדיין אין פריטים מאושרים בסוג הזה.</p>`}

    <h4 style="margin-top:22px;">הוספה ישירה ע"י המנהלת (מתפרסמת מיד, בלי אישור)</h4>
    <form method="post" action="/admin/community-add" enctype="multipart/form-data" class="narrow-panels">
      <input type="hidden" name="type" value="${type}" />
      <label>${isProduct ? "שם המוצר" : "שם הפריט / העסק"}<input type="text" name="title" required /></label>
      <label>סוג מדויק<select name="tag"><option value="">--</option>${tagOptions}</select></label>
      ${isProduct ? `
      <label>דגם (לא חובה)<input type="text" name="model" placeholder="למשל: דגם XR200" /></label>
      <label>מחיר (לא חובה)<input type="text" name="price" placeholder="למשל: 149 ₪" /></label>
      <label>איפה נקנה (לא חובה)<input type="text" name="whereBought" placeholder="למשל: שם חנות או אתר" /></label>
      ` : `
      <label>עיר${cityAutocompleteHtml({ fieldName: "city", placeholder: "מאיזו עיר?" })}</label>
      <label>כתובת (רחוב ומספר, לא חובה)<input type="text" name="address" placeholder="למשל: הרצל 12" /></label>
      `}
      ${isSale ? `<label>מחיר<input type="text" name="price" placeholder="למשל: 150 ₪" /></label>` : ""}
      ${type === "rental" ? `
      <label>מחיר להשכרה (לא חובה)<input type="text" name="price" placeholder="למשל: 150 ₪" /></label>
      <label>צבע (רלוונטי לשמלות ערב בלבד, לא חובה)<select name="color"><option value="">--</option>${DRESS_COLORS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select></label>
      <label>אורך (לא חובה)<select name="length"><option value="">--</option>${DRESS_LENGTHS.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}</select></label>
      <label>מיועדת ל (לא חובה)<select name="audience"><option value="">--</option>${DRESS_AUDIENCES.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select></label>
      ` : ""}
      <label>תיאור<textarea name="description" maxlength="500"></textarea></label>
      ${isProduct ? "" : `
      <label>טלפון ליצירת קשר<input type="text" name="phone" placeholder="050-1234567" /></label>
      <label style="display:flex;align-items:center;gap:6px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" style="width:auto;" /><span>אותו מספר זמין גם ב-WhatsApp</span></label>
      <label>אימייל (לא חובה)<input type="email" name="email" /></label>
      `}
      <label>תמונה (לא חובה)<input type="file" name="photo" accept="image/*" /></label>
      <button class="btn btn-small" style="margin-top:6px;" type="submit">הוספה ופרסום מיידי</button>
    </form>

    <h4 style="margin-top:22px;">מחיר לתחום "${esc(meta.label)}"</h4>
    <p class="muted">קובע כמה עולה להירשם/להתפרסם במאגר הזה (0 = בחינם). המספר הזה נשמר ברקע - אפשר להשתמש בו בעתיד להצגה או לחיוב.</p>
    <form method="post" action="/admin/community-price" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <input type="hidden" name="type" value="${type}" />
      <input type="number" name="price" value="${price}" min="0" step="1" style="max-width:140px;" />
      <span class="muted">₪</span>
      <button class="btn btn-small btn-outline" type="submit">שמירת מחיר</button>
    </form>
  </div>`;
}

route("POST", "/admin/community/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.communityListings || []).find((x) => x.id === params.id);
  if (c) { c.status = "approved"; c.approvedAt = new Date().toISOString(); }
  db.save();
  if (c) notifyCommunitySubscribers(c, d, req).catch(() => {});
  redirect(res, `/admin?ok=${encodeURIComponent("הפריט אושר! הוא כבר באוויר.")}`);
});

route("POST", "/admin/community/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.communityListings || []).find((x) => x.id === params.id);
  if (c) c.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הפריט נדחה.")}`);
});

route("POST", "/admin/community/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.communityListings = (d.communityListings || []).filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הפריט נמחק.")}`);
});

// הוספה ישירה ע"י המנהלת - מתפרסמת מיד (status:"approved"), בלי לעבור תור אישור, כי המנהלת
// עצמה כבר "אישרה" אותה בכך שהיא זו שהזינה את הפרטים.
route("POST", "/admin/community-add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי שוב.")}`);
  const type = COMMUNITY_TYPES[body.get("type")] ? body.get("type") : null;
  const title = (body.get("title") || "").trim();
  if (!type || !title) return redirect(res, `/admin?err=${encodeURIComponent("צריך למלא לפחות סוג ושם.")}`);
  const d = db.load();
  const now = new Date().toISOString();
  const c = {
    id: db.nextId("communityListing"),
    type, title,
    tag: body.get("tag") || "",
    cityId: body.get("city") || "",
    address: clip((body.get("address") || "").trim(), 200),
    description: clip(body.get("description"), 500),
    phone: (body.get("phone") || "").trim(),
    hasWhatsapp: body.get("hasWhatsapp") === "1",
    email: (body.get("email") || "").trim(),
    photoDataUri: fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES),
    contactName: "",
    model: clip((body.get("model") || "").trim(), 100),
    price: clip((body.get("price") || "").trim(), 50),
    whereBought: clip((body.get("whereBought") || "").trim(), 150),
    color: DRESS_COLORS.includes(body.get("color")) ? body.get("color") : "",
    length: DRESS_LENGTHS.includes(body.get("length")) ? body.get("length") : "",
    audience: DRESS_AUDIENCES.includes(body.get("audience")) ? body.get("audience") : "",
    priceNum: parsePriceNum(body.get("price") || ""),
    ownerCustomerId: null,
    source: "admin",
    status: "approved",
    viewCount: 0,
    createdAt: now,
    approvedAt: now,
  };
  d.communityListings.push(c);
  db.save();
  notifyCommunitySubscribers(c, d, req).catch(() => {});
  redirect(res, `/admin?ok=${encodeURIComponent("הפריט נוסף ופורסם.")}`);
});

route("POST", "/admin/community-price", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const type = COMMUNITY_TYPES[body.get("type")] ? body.get("type") : null;
  if (!type) return redirect(res, "/admin");
  const d = db.load();
  const price = Math.max(0, parseInt(body.get("price"), 10) || 0);
  if (!d.settings.communityTypePricing) d.settings.communityTypePricing = {};
  d.settings.communityTypePricing[type] = price;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("המחיר נשמר.")}`);
});

// "מסירות"/"מכירת יד 2" שהיא פרסמה - היחידים מבין 8 סוגי מאגרי הקהילה שדורשים חשבון לקוחה,
// בדיוק כדי שהיא תוכל לראות ולהוריד אותם בעצמה כאן ברגע שהחפץ כבר נמסר/נמכר (ר' route POST
// /account/community/:id/take-down למטה) - לא מציגים "rejected" כאן, אין לזה תועלת.
route("POST", "/account/community/:id/take-down", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const g = (d.communityListings || []).find((c) => c.id === params.id && (c.type === "giveaway" || c.type === "sale") && c.ownerCustomerId === ctx.session.id);
  if (!g) {
    return redirect(res, `/account?err=${encodeURIComponent("לא מצאנו את הפריט הזה אצלך.")}`);
  }
  const wasSale = g.type === "sale";
  d.communityListings = d.communityListings.filter((c) => c.id !== params.id);
  db.save();
  redirect(res, `/account?ok=${encodeURIComponent(wasSale ? "הפריט הוסר - כל הכבוד על המכירה! ❤️" : "הפריט הוסר - תודה שמסרת אותו הלאה! ❤️")}`);
});

// שמירת/עדכון הערה פרטית של לקוחה על עצמאית שאהבה (favorites) - לא נבדק שה-key באמת קיים
// ברשימת ה-favorites שלה, כדי לא לאבד את ההערה במקרה שבו הלקוחה הסירה ואז החזירה לב בו-זמנית
// משני טאבים; ה-UI תמיד שולח key שמופיע כרגע ב-favCards, כך שבפועל זה תמיד favorite קיים.
// הערה ריקה מוחקת את המפתח לגמרי (ולא משאירה מחרוזת ריקה) כדי לא לנפח את d.json לשווא.
route("POST", "/account/favorite-note", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  if (!customer) return redirect(res, "/login");
  const body = await readBody(req);
  const key = (body.get("key") || "").trim();
  const note = clip((body.get("note") || "").trim(), 500);
  if (!key) return redirect(res, "/account");
  customer.favoriteNotes = customer.favoriteNotes || {};
  if (note) customer.favoriteNotes[key] = note; else delete customer.favoriteNotes[key];
  db.save();
  redirect(res, `/account?ok=${encodeURIComponent("ההערה נשמרה")}#fav-${encodeURIComponent(key)}`);
});

// ----- Central deals page - all active coupon offers in one place -----
route("GET", "/deals", async (req, res, params, query, ctx) => {
  const d = db.load();
  const withDeals = d.freelancers
    .filter((f) => f.status === "approved" && f.active !== false && (f.dealText || "").trim());
  const listingDeals = [];
  d.freelancers.forEach((f) => {
    if (f.status !== "approved" || f.active === false) return;
    (f.additionalListings || []).forEach((l) => {
      if (l.status === "approved" && (l.dealText || "").trim()) listingDeals.push({ f, l });
    });
  });
  const combined = withDeals.map((f) => ({ createdAt: f.createdAt, reviewCount: reviewCountFor(d, f.id), html: freelancerCard(f, d) }))
    .concat(listingDeals.map(({ f, l }) => ({ createdAt: l.createdAt, reviewCount: reviewCountFor(d, f.id, l.id), html: additionalListingCard(f, l, d) })))
    .sort((a, b) => (b.reviewCount - a.reviewCount) || (new Date(b.createdAt) - new Date(a.createdAt)));
  const body = `
  <div style="text-align:center;font-size:34px;line-height:1;margin-bottom:2px;">🎁</div>
  <h1 class="section-title">הטבות SheCan</h1>
  <p class="muted" style="text-align:center;">כל ההטבות הכי חמות עכשיו, מרוכזות במקום אחד.</p>
  ${combined.length ? `<div class="grid">${combined.map((c) => c.html).join("")}</div>` : `<p class="muted" style="text-align:center;">עוד אין הטבות פעילות - זה יתמלא מהר.</p>`}
  `;
  sendHtml(res, 200, page({ title: "הטבות SheCan", session: ctx.session, body, query }));
});

// Builds the whole /join form. `prefill` (only set on a POST-validation retry, see POST
// /join below) repopulates the fields she already filled in so a rejected submission - wrong
// email format, no city/online/home-visit, photos too big - doesn't force her to retype the
// entire form from scratch. Passwords and file inputs (logo/gallery/story photo) can never be
// refilled by a server-rendered page for security/browser reasons, so those two categories are
// the only things she'd still need to redo; everything else on the main form survives a retry.
function joinFormBody(d, { charging, refId, referrerFreelancer, businessNameDatalist, storyQuestionsJoin, prefill }) {
  const p = prefill || {};
  const isRetry = !!prefill;
  const catOptions = d.categories.map((c) => `<option value="${c.id}" ${p.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const subcatCheckboxesForPrefill = subcategoryCheckboxesHtml(d, p.categoryId, p.subcategoryIds);
  const filesNote = isRetry ? ` <span style="color:var(--danger);font-weight:700;">(שימי לב - יש לצרף שוב, קבצים לא נשמרים אוטומטית)</span>` : "";
  const body = `
  ${!charging ? `
  <div class="sc-modal-overlay" id="scWelcomeModal" onclick="if(event.target===this) scCloseModal();">
    <div class="sc-modal">
      <button type="button" class="sc-modal-close" onclick="scCloseModal()" aria-label="סגירה">✕</button>
      <h2>⏰ תפסת אותנו בזמן!</h2>
      <p>ההרשמה לנבחרת המייסדות של SheCan נפתחה!<br/>הצטרפי עכשיו ללא עלות, קבלי תג יוקרתי והטבת מחיר קבועה לכל החיים על שירותי הפרימיום שלנו.<br/>מספר המקומות וזמן ההרשמה בחינם - מוגבל.<br/>בואי לבנות איתנו את הבית של העצמאיות בישראל.</p>
      <button type="button" class="btn sc-modal-btn" onclick="scCloseModal()">מצטרפת!</button>
    </div>
  </div>` : ""}

  <h1 class="section-title">🗺️ שמות אותך על המפה</h1>
  <div class="panel" style="max-width:600px;margin:0 auto;text-align:center;">
    <p style="font-size:19px;font-weight:800;margin:0 0 8px;">ב-SheCan זה פשוט:</p>
    <p style="font-weight:400;font-size:15px;color:var(--gray);margin:0 0 4px;">פותחת כרטיס &gt; לקוחה פונה &gt; עסקה נסגרת.</p>
    <p style="font-weight:400;font-size:15px;color:var(--gray);margin:0 0 4px;">זה מתחיל בלקוחה אחת, וממשיך לרצף של הזמנות.</p>
    <p style="font-weight:400;font-size:15px;color:var(--gray);margin:0 0 16px;">מוכנה להקפיץ את העסק שלך לרמה הבאה? הצטרפי לנבחרת!</p>
    <p style="text-align:center;font-size:23px;font-weight:800;color:var(--rose-dark);margin:20px 0 12px;">בואי נדבר תכלס -</p>
    <p style="text-align:center;">מה תקבלי אצלנו?</p>
    <ul class="bullet-list" style="margin:0;padding-inline-start:4px;line-height:1.9;list-style:none;text-align:right;">
      <li><span class="bullet-icon">🌸</span><span><strong>חשיפה שאי אפשר לפספס:</strong> אנחנו לוקחות את היחצון והפרסום על עצמנו - עם הבלטות מיוחדות בקהילה ששמות את העסק שלך במרכז הבמה.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>כרטיסיית עסק יפהפייה:</strong> הצגה מרשימה של העסק שלך שתגרום ללקוחות לעצור ולהסתכל.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>הטבה שמושכת לקוחות:</strong> תני לחברות הקהילה שלנו הטבה מיוחדת – זה המגנט הכי חזק להבאת לקוחות חדשות אלייך.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>המלצות שנותנות אמון:</strong> לקוחות מרוצות יוכלו להשאיר לך המלצות חמות ישירות בכרטיסייה, כדי שכולן יראו את הערך שאת נותנת.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>קשר ישיר מהרגע הראשון:</strong> לקוחות יוכלו להתכתב איתך ישירות מהאזור האישי שלהן באתר, בלי מיילים מיותרים ובלי תיווכים.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>השתתפות פעילה ב"זירה":</strong> תשובות לשאלות לקוחות ופרסום סקרים אישיים – הזדמנות מעולה לבלוט כמומחית, לקבל פידבקים חשובים ולמשוך אליך לקוחות חדשות.</span></li>
    </ul>
    <p class="muted" style="margin-top:14px;font-size:13.5px;">💡 טיפ: הכרטיסיות שיש להן הכי הרבה דירוגים וחוות דעת מוצגות ראשונות באתר - אז כדאי לעודד לקוחות מרוצות להשאיר לך חוות דעת.</p>
  </div>

  <div class="flash flash-ok" style="max-width:680px;">${!charging ? "ההרשמה כעת בחינם לכל המייסדות. לאחר תקופת ההשקה, ההצטרפות תהיה כרוכה בדמי מנוי חודשיים, אך אתן – המייסדות – תיהנו מהנחה קבועה ובלעדית לכל החיים." : "ההצטרפות כרוכה בדמי מנוי חודשיים."}</div>

  <form class="panel" id="scJoinForm" method="post" action="/join" enctype="multipart/form-data" style="max-width:560px;margin:24px auto;">
    <label>🌸 שם מלא<input type="text" name="name" value="${esc(p.name || "")}" required /></label>
    <label>🌸 שם העסק<input type="text" name="businessName" id="joinBusinessName" value="${esc(p.businessName || "")}" required /></label>
    <label>🌸 מייל<input type="email" name="email" value="${esc(p.email || "")}" required /></label>
    <label>🌸 בחרי סיסמה<input type="password" name="password" required /></label>
    ${isRetry ? `<p class="muted" style="font-size:13px;">שימי לב - מסיבות אבטחה צריך להקליד את הסיסמה מחדש, שאר הפרטים שמילאת נשמרו.</p>` : ""}
    <label>🌸 מה התחום שלך?
    <select name="categoryId" id="joinCategorySelect" required onchange="scUpdateSubcatCheckboxes(this, 'scSubcatBox');scToggleOtherCategory(this, 'scOtherCategoryBox');"><option value="">בחרי תחום</option>${catOptions}<option value="__other__" ${p.categoryId === "__other__" ? "selected" : ""}>אחר - התחום שלי לא ברשימה</option></select></label>
    <label>🌸 תת-תחום (לא חובה - אפשר לסמן כמה)</label>
    <div id="scSubcatBox" style="max-height:160px;overflow-y:auto;border:1px solid #ddd3c4;border-radius:8px;padding:10px;margin:-6px 0 6px;">${subcatCheckboxesForPrefill}</div>
    <label>🌸 לא מוצאת תת-תחום מתאים? כתבי לנו המלצה ונבדוק להוסיף אותה (לא חובה)<input type="text" name="subcategorySuggestion" value="${esc(p.subcategorySuggestion || "")}" maxlength="80" placeholder="למשל: עיצוב שולחנות מתוקים" /></label>
    <p class="muted" style="margin:-6px 0 6px;font-size:12.5px;">💡 ההמלצה תישלח לבדיקה - היא לא נוספת אוטומטית, ותוכלי לבחור אותה מהרשימה אחרי שתאושר.</p>
    <div id="scOtherCategoryBox" style="display:${p.categoryId === "__other__" ? "block" : "none"};">
      <label>🌸 מה שם התחום שלך?<input type="text" name="customCategory" value="${esc(p.customCategory || "")}" placeholder="למשל: עיצוב אירועים" /></label>
      <label>🌸 תת-תחום (לא חובה)<input type="text" name="customSubcategory" value="${esc(p.customSubcategory || "")}" placeholder="למשל: עיצוב שולחנות מתוקים" /></label>
    </div>
    <label>🌸 כמה שנים את בתחום?
    <select name="yearsInField" required><option value="">בחרי</option>${yearsInFieldOptionsHtml(p.yearsInField || "")}</select></label>
    <label>🌸 מאיזו עיר?${cityAutocompleteHtml({ fieldName: "cityId", selectedId: p.cityId || "", selectedName: p.cityId ? cityName(d, p.cityId) : "", placeholder: "בחרי עיר" })}</label>
    <p class="muted" style="margin:-6px 0 6px;font-size:13px;">לא חובה לציין עיר, כל עוד מסומן למטה שאת נותנת שירות בדיגיטלית או מגיעה עד הלקוחה - אבל חובה לפחות אחד מהשלושה.</p>
    <label>🌸 טלפון<input type="tel" name="phone" value="${esc(p.phone || "")}" /></label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" ${p.hasWhatsapp ? "checked" : ""} style="width:auto;" /> יש לי וואטסאפ במספר הזה</label>
    <label>🌸 איך את נותנת את השירות? (אפשר לסמן כמה)</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:0;"><input type="checkbox" name="offersOnline" value="1" ${p.offersOnline ? "checked" : ""} style="width:auto;" /> 💻 נותנת שירות אונליין / דיגיטלית</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:6px;"><input type="checkbox" name="offersHomeVisit" value="1" ${p.offersHomeVisit ? "checked" : ""} style="width:auto;" /> 🚗 מגיעה עד הבית של הלקוחה</label>
    <label>🌸 אינסטגרם (לא חובה)<input type="text" name="instagram" value="${esc(p.instagram || "")}" /></label>
    <label>🌸 קישור לתיק עבודות (לא חובה)<input type="text" name="portfolioUrl" value="${esc(p.portfolioUrl || "")}" placeholder="https://..." /></label>
    <label>🌸 לוגו (לא חובה אבל מומלץ)${filesNote}<input type="file" name="logo" id="joinLogoInput" accept="image/*" data-sc-crop="1" /></label>
    <label>🌸 תמונות להתרשמות (עד 4, לא חובה) - יופיעו בגלריה קטנה בכרטיסייה שלך${filesNote}
    <input type="file" name="gallery1" accept="image/*" style="margin-bottom:8px;" /></label>
    <input type="file" name="gallery2" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="gallery3" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="gallery4" accept="image/*" />
    <label>🌸 תארי את השירות שאת נותנת (עד 500 תווים)<textarea name="description" maxlength="500" placeholder="כאן את מתארת את השירות שאת נותנת - מה את עושה ואיך את עוזרת ללקוחות שלך. כתבי בגוף ראשון, בצורה אישית וחמימה, כאילו את מספרת לחברה - זה מה שיזמין לקוחות לקרוא ולהתחבר אלייך.">${esc(p.description || "")}</textarea></label>
    <label>🌸 תני ללקוחות סיבה טובה לבחור בך (עד 200 תווים) *</label>
    <p class="muted" style="margin:0 0 6px;font-size:13px;">* עסק בלי הטבה ללקוחות לא יאושר לפרסום - זה בדיוק מה שמושך אליך לקוחות חדשות.</p>
    <textarea name="dealText" maxlength="200" placeholder="זו ההזדמנות שלך לבלוט! הציעי הטבה שווה (למשל: הנחה, פגישת ייעוץ מתנה, בונוס מיוחד). הטבה אטרקטיבית היא המפתח לסגירת העסקה הראשונה שלך כאן." required>${esc(p.dealText || "")}</textarea>
    <label>🌸 איזו רמה מתאימה לך?
    <select name="tier"><option value="basic" ${p.tier !== "premium" ? "selected" : ""}>בסיסית</option><option value="premium" ${p.tier === "premium" ? "selected" : ""}>מומלצת</option></select></label>

    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:14px;"><input type="checkbox" name="wantsPushNotifications" value="1" ${p.wantsPushNotifications ? "checked" : ""} style="width:auto;" /> 🔔 כן, תשלחו לי התראות</label>
    <p class="muted" style="margin:2px 0 0;font-size:12.5px;">תקבלי התראה רק כשעונים לך (בזירה או במסר), כשלקוחה מתעניינת פונה אלייך ישירות, או כשמתפרסמת שאלה חדשה בזירה בתחום שלך.</p>

    <label style="display:flex;align-items:flex-start;gap:8px;font-weight:700;margin-top:14px;background:var(--cream);border-radius:8px;padding:10px 12px;">
      <input type="checkbox" name="publicListingConsent" value="1" ${p.publicListingConsent ? "checked" : ""} required style="width:auto;margin-top:3px;" />
      <span>אני מאשרת שהפרטים, התמונות והתיאור שאעלה יוצגו בכרטיסייה הפומבית שלי באתר SheCan, ושכל מי שנכנסת/נכנס לאתר - כולל גברים, ולא רק נשים - יכולה/יכול לצפות בהם.</span>
    </label>

    <div class="muted" style="margin-top:16px;background:var(--cream);border-radius:8px;padding:12px 14px;font-size:14px;">
      ברגע שתסיימי להירשם, המערכת שלנו תייצר עבורך באופן אוטומטי קוד קופון אישי וייחודי (בסגנון SheCan1234), שתוכלי להעביר ללקוחות שלך. הקוד הזה יהיה הכרטיס המזהה שלך בקהילה.
    </div>

    <div class="panel" style="background:var(--cream);margin-top:16px;">
      <h4 style="margin-top:0;">מתעסקת בעוד תחום? הוסיפי גם אותו למאגר</h4>
      <p class="muted" style="font-size:14px;">כל תחום נוסף מקבל כרטיסייה משלו - שם עסק, לוגו, תמונות, הטבה ותיאור נפרדים. פרטי הקשר והעיר משותפים לפרופיל הראשי שלך.</p>
      ${isRetry ? `<p class="muted" style="font-size:13px;color:var(--danger);">שימי לב - אם מילאת כאן תחום נוסף, התמונות ובחירות מהרשימות (תחום, שנות ותק, רמה) צריך לבחור מחדש - מה שהקלדת בשדות הטקסט נשמר.</p>` : ""}
      ${[0, 1, 2].map((i) => `<div id="scExtraListing${i}" style="display:none;border-top:1px solid #e5ddd0;margin-top:14px;padding-top:14px;">${extraListingFormBlock(d, "extra", i)}</div>`).join("")}
      <button type="button" class="btn btn-outline btn-small" id="scAddExtraListingBtn" style="margin-top:14px;" onclick="scAddExtraListing()">➕ הוספת תחום</button>
    </div>

    <div class="panel" style="background:var(--cream);margin-top:16px;position:relative;" id="scJoinQuotePanel">
      <button type="button" onclick="var p=document.getElementById('scJoinQuotePanel');if(p)p.style.display='none';" aria-label="לא רלוונטי בשבילי" title="לא רלוונטי בשבילי" style="position:absolute;top:12px;left:14px;background:none;border:none;font-size:20px;color:var(--gray);cursor:pointer;">✕</button>
      <h4 style="margin-top:0;">יש לך משפט השראה שמייצג אותך? (לא חובה)</h4>
      <p class="muted" style="font-size:14px;">משפט ההשראה שלך יכול להופיע כ"טיפ השבועי" בדף הבית של כל האתר - במה יפה שמציגה אותך לכל מי שנכנסת. אנחנו עוברות על כל משפט לפני שהוא עולה, כדי לשמור שרק משפטי השראה אמיתיים מתפרסמים (לא פרסומות), אז זה יכול לקחת קצת זמן עד שהוא יופיע. אפשר גם לדלג ולכתוב את זה מאוחר יותר באזור האישי שלך, או פשוט לסגור את התיבה הזו עם ה-X.</p>
      <label>🌸 משפט ההשראה שלך (עד 300 תווים)<textarea name="inspirationQuote" maxlength="300" placeholder="לדוגמה: תתחילי היום, גם אם את לא מרגישה מוכנה ב-100% - ההתחלה היא כבר חצי מהדרך.">${esc(p.inspirationQuote || "")}</textarea></label>
    </div>

    <div class="panel" style="background:var(--cream);margin-top:16px;position:relative;" id="scJoinStoryPanel">
      <button type="button" onclick="var p=document.getElementById('scJoinStoryPanel');if(p)p.style.display='none';" aria-label="לא רלוונטי בשבילי" title="לא רלוונטי בשבילי" style="position:absolute;top:12px;left:14px;background:none;border:none;font-size:20px;color:var(--gray);cursor:pointer;">✕</button>
      <h4 style="margin-top:0;">רוצה כבר עכשיו לכתוב את הסיפור שלך? (לא חובה)</h4>
      <p class="muted" style="font-size:14px;">הסיפור שלך הוא ריאיון אישי קצר שמוצג בעמוד "SheCan Stories" - כרטיס ביקור רגשי שמספר מי את ואיך הגעת לאן שהגעת. כל שבוע מוצגת עצמאית אחת, לפי סדר ההרשמה שלכן לקהילה - כך שגם הסיפור שלך יקבל את הבמה שלו בזמן. אפשר גם לדלג ולמלא את זה מאוחר יותר באזור האישי שלך, או פשוט לסגור את התיבה הזו עם ה-X אם זה לא בשבילך כרגע. אם כן מתחילים לכתוב - צריך לענות על לפחות ${Math.min(STORY_MIN_ANSWERS, storyQuestionsJoin.length)} מהשאלות.</p>
      ${isRetry ? `<p class="muted" style="font-size:13px;color:var(--danger);">שימי לב - אם צירפת כאן תמונה, יש לצרף אותה מחדש - מה שכתבת בתשובות עצמן נשמר.</p>` : ""}
      <label>🌸 תמונה שלך לסיפור (לא חובה)
      <input type="file" name="storyPhoto" accept="image/*" /></label>
      ${storyQuestionsJoin.map((q, i) => `<label>🌸 ${esc(q)}<textarea name="storyAnswer${i}" maxlength="800" data-sc-story-q="1">${esc((p.storyAnswers && p.storyAnswers[i]) || "")}</textarea></label>`).join("")}
      <div class="muted" data-sc-story-count-note style="font-size:12.5px;margin-top:4px;"></div>
    </div>

    <input type="hidden" name="ref" value="${esc(refId)}" />
    <div class="referral-source-choice">
      <label style="font-weight:800;font-size:13.5px;">איך שמעת על SheCan?</label>
      ${referrerFreelancer ? `
      <p class="muted" style="font-size:13px;">הגעת דרך הקישור האישי של <strong>${esc(referrerFreelancer.businessName || referrerFreelancer.name)}</strong> - היא תזכה ב-10 נקודות כשתסיימי להירשם 🎉</p>
      ` : `
      <label><input type="radio" name="howHeardChoice" value="referral" ${p.howHeardChoice === "referral" ? "checked" : ""} onchange="document.getElementById('scHowHeardBizBox').style.display='block';" /> חברה מהקהילה / בעלת עסק אחרת</label>
      <div id="scHowHeardBizBox" style="display:${p.howHeardChoice === "referral" ? "block" : "none"};margin-inline-start:22px;">
        <input type="text" name="howHeardBusinessName" value="${esc(p.howHeardBusinessName || "")}" list="scBusinessNameList" placeholder="הקלידי לחיפוש..." />
        <datalist id="scBusinessNameList">${businessNameDatalist}</datalist>
      </div>
      <label><input type="radio" name="howHeardChoice" value="social" ${p.howHeardChoice === "social" ? "checked" : ""} onchange="document.getElementById('scHowHeardBizBox').style.display='none';" /> רשתות חברתיות / חיפוש ברשת</label>
      `}
    </div>

    <div style="display:flex;gap:12px;margin-top:16px;flex-wrap:wrap;">
      <button class="btn btn-outline" style="flex:1;min-width:180px;" type="button" onclick="scShowJoinPreview()">תצוגה מוקדמת 👀</button>
      <button class="btn" style="flex:1;min-width:180px;" type="submit">${charging ? "המשך לתשלום" : "הרשמה"}</button>
    </div>
  </form>

  <div class="sc-modal-overlay" id="scPreviewModal" style="display:none;" onclick="if(event.target===this) scClosePreview();">
    <div class="sc-modal" style="max-width:300px;padding:22px 18px;">
      <button type="button" class="sc-modal-close" onclick="scClosePreview()" aria-label="סגירה">✕</button>
      <h2 style="font-size:18px;margin-bottom:8px;">ככה תיראה הכרטיסייה שלך</h2>
      <div id="scPreviewCardHolder" style="text-align:right;margin-top:6px;font-size:14px;"></div>
      <p class="muted" style="margin-top:10px;font-size:12px;">זו תצוגה מקדימה בלבד - שום דבר עוד לא נשלח.</p>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button type="button" class="btn btn-outline btn-small" style="flex:1;" onclick="scClosePreview()">לעדכן פרטים</button>
        <button type="button" class="btn btn-small" style="flex:1;" onclick="scConfirmJoinSubmit()">מאשרת ✔️</button>
      </div>
    </div>
  </div>
  `;
  return body;
}

// A validation failure in POST /join (below) re-renders this same form instead of a redirect,
// so she can fix just the one thing that was wrong without losing everything else she typed.
function joinFormRenderContext(d, body, req) {
  const refId = (body ? body.get("ref") : "") || "";
  const referrerFreelancer = refId ? d.freelancers.find((x) => x.id === refId && x.status === "approved") : null;
  const businessNameDatalist = d.freelancers.filter((x) => x.status === "approved")
    .map((x) => `<option value="${esc(x.businessName || x.name)}"></option>`).join("");
  const storyQuestionsJoin = d.settings.storyQuestions || [];
  return { charging: d.settings.chargingEnabled, refId, referrerFreelancer, businessNameDatalist, storyQuestionsJoin };
}

// Auto-links a matching CUSTOMER account to a freshly-created freelancer, so the "מעבר למצב
// לקוחה" switch button in her dashboard (and the one-click switch offered by customerOnlyPrompt
// below) always has somewhere to switch to right away - per explicit request 2026-09-02
// ("קצת מסרבל... תעשה את זה אוטומטית שעצמאית נפתח לה חשבון אוטומטי גם כלקוחה"), after she
// pointed out that juggling two separate logins meant she'd often be stuck mid-action (wanting
// to comment/reply) with no customer account handy. Mirrors the customer record shape from
// POST /signup as closely as possible. Skipped entirely if a customer with this email already
// exists (e.g. she registered as a customer first, then later joined as a freelancer - the
// existing switch-to-freelancer flow on /account already covers that direction). See the
// matching one-time backfill block in db.js's migrate() for every freelancer who joined BEFORE
// this existed.
function ensureLinkedCustomerAccount(d, f) {
  if (!f || !f.email) return;
  if (d.customers.find((c) => c.email === f.email)) return;
  const id = db.nextId("customer");
  d.customers.push({
    id, name: f.name, email: f.email,
    passwordHash: f.passwordHash, cityId: f.cityId || "",
    favorites: [], favoriteNotes: {}, viewedDeals: [], revealedCoupons: [], pushSubscriptions: [],
    createdAt: new Date().toISOString(),
    communityNotifyTags: {},
    // אין צורך בסבב אימות מייל נפרד - היא כבר מוכיחה בעלות על המייל הזה דרך ההרשמה כעצמאית.
    emailVerified: true, emailVerifyToken: null,
    gender: "female", accountLocked: false,
    wantsPushNotifications: false,
    publicVisibilityConsentAt: f.publicListingConsentAt || new Date().toISOString(),
    referredByCustomerId: null,
    referralPopupSeen: true,
    siteVisitCount: 0,
    autoLinkedFromFreelancerId: f.id,
    youCanMember: false, youCanRequestedAt: null, youCanActivatedAt: null,
    youCanPolicyAgreedAt: null, youCanCancelledAt: null,
  });
}

route("GET", "/join", async (req, res, params, query, ctx) => {
  const d = db.load();
  // A visit via another business's referral link (/join?ref=<freelancerId>) is only trusted
  // here as a query param - see joinFormRenderContext for the equivalent lookup from a POST body.
  const ctxData = joinFormRenderContext(d, { get: (k) => (k === "ref" ? query.get("ref") : "") }, req);
  const body = joinFormBody(d, { ...ctxData, prefill: null });
  sendHtml(res, 200, page({ title: "הצטרפות כעצמאית", session: ctx.session, body, query }));
});

route("POST", "/join", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  // On any validation failure below, re-render the same form (200, not a redirect) with
  // everything she already typed filled back in - see joinFormBody's `prefill` handling.
  const rerenderWithError = (d, errMsg) => {
    const ctxData = joinFormRenderContext(d, body, req);
    const prefill = {
      name: body.get("name"), businessName: body.get("businessName"), email: body.get("email"),
      categoryId: body.get("categoryId"), subcategoryIds: body.getAll("subcategoryId"),
      customCategory: body.get("customCategory"), customSubcategory: body.get("customSubcategory"),
      subcategorySuggestion: body.get("subcategorySuggestion"),
      inspirationQuote: body.get("inspirationQuote"),
      yearsInField: body.get("yearsInField"), cityId: body.get("cityId"), phone: body.get("phone"),
      hasWhatsapp: body.get("hasWhatsapp") === "1", offersOnline: body.get("offersOnline") === "1",
      offersHomeVisit: body.get("offersHomeVisit") === "1", instagram: body.get("instagram"),
      portfolioUrl: body.get("portfolioUrl"), description: body.get("description"), dealText: body.get("dealText"),
      tier: body.get("tier"), wantsPushNotifications: body.get("wantsPushNotifications") === "1",
      publicListingConsent: body.get("publicListingConsent") === "1",
      howHeardChoice: body.get("howHeardChoice"), howHeardBusinessName: body.get("howHeardBusinessName"),
      // Preserve whatever she'd already typed into the inspiration-story questions too, so a
      // validation failure elsewhere on the form (or the story-minimum check below) doesn't make
      // her retype it - see joinFormBody's textarea rendering, which reads this back out.
      storyAnswers: (d.settings.storyQuestions || []).map((_, i) => body.get(`storyAnswer${i}`) || ""),
    };
    const formBody = joinFormBody(d, { ...ctxData, prefill });
    const errQuery = new URLSearchParams({ err: errMsg });
    return sendHtml(res, 200, page({ title: "הצטרפות כעצמאית", session: ctx.session, body: formBody, query: errQuery }));
  };
  if (body.tooBig) {
    const d = db.load();
    return rerenderWithError(d, "התמונות ביחד גדולות מדי - נסי עם פחות תמונות או תמונות קטנות יותר, ותצרפי אותן שוב.");
  }
  const d = db.load();
  if (d.freelancers.find((f) => f.email === body.get("email"))) {
    return rerenderWithError(d, "כבר יש חשבון עם האימייל הזה - נסי להתחבר במקום.");
  }
  // חובה לאשר במפורש שהפרטים יהיו גלויים לכלל הציבור (לא רק לנשים) - לפי בקשה מפורשת
  // 2026-08-30. יש גם required בטופס עצמו (חוסם שליחה בדפדפן), אבל זה נבדק שוב כאן בצד השרת
  // כרשת ביטחון - בדיוק כמו כל שדה required אחר בטופס הזה - כי required ב-HTML לבד אפשר לעקוף.
  if (body.get("publicListingConsent") !== "1") {
    return rerenderWithError(d, "צריך לאשר את תיבת הסימון שהפרטים שלך יהיו גלויים לכלל הציבור (כולל גברים) כדי להירשם.");
  }
  // City is optional now, but she must give customers SOME way to reach her - either a city,
  // or an online/digital service, or a home-visit service. At least one of the three.
  if (!body.get("cityId") && body.get("offersOnline") !== "1" && body.get("offersHomeVisit") !== "1") {
    return rerenderWithError(d, "צריך לציין עיר, או לסמן שאת נותנת שירות בדיגיטלית / מגיעה עד הלקוחה - לפחות אחד מהשלושה.");
  }
  // The inspiration-story panel here is fully optional and skippable (0 answers is fine) - but
  // if she starts writing at all, a couple of one-line answers don't make for much of a story,
  // so we require a real minimum. Validated here, BEFORE the freelancer account is created below,
  // so a failure just re-renders the form instead of leaving a half-created signup behind.
  const joinStoryMin = Math.min(STORY_MIN_ANSWERS, (d.settings.storyQuestions || []).length);
  const joinStoryAnswersCount = (d.settings.storyQuestions || [])
    .filter((q, i) => (body.get(`storyAnswer${i}`) || "").trim()).length;
  if (joinStoryAnswersCount > 0 && joinStoryAnswersCount < joinStoryMin) {
    return rerenderWithError(d, `סיפור ההשראה - אם מתחילים לכתוב אותו צריך לענות על לפחות ${joinStoryMin} שאלות (ענית כרגע על ${joinStoryAnswersCount}). אפשר גם להשאיר את כל השאלות ריקות כרגע ולדלג - תמיד אפשר לכתוב את זה מאוחר יותר באזור האישי.`);
  }
  const id = db.nextId("freelancer");
  const charging = d.settings.chargingEnabled;
  const dealCode = generateCouponCode();
  // The ref link (if present and valid) always wins over the manual dropdown, since it's the
  // authoritative "she actually clicked this business's link" signal - the manual field only
  // matters when there was no ref link at all.
  const joinRefId = body.get("ref") || "";
  const refFreelancer = joinRefId && joinRefId !== id ? d.freelancers.find((x) => x.id === joinRefId && x.status === "approved") : null;
  const manualReferrer = !refFreelancer && body.get("howHeardChoice") === "referral"
    ? findFreelancerByBusinessNameLoose(d, body.get("howHeardBusinessName"))
    : null;
  const referredByFreelancerId = refFreelancer ? refFreelancer.id : (manualReferrer ? manualReferrer.id : null);
  const galleryPhotos = ["gallery1", "gallery2", "gallery3", "gallery4"]
    .map((field) => fileToDataUri(body.files[field], MAX_UPLOAD_BYTES))
    .filter(Boolean);
  const { categoryId, subcategoryId, subcategoryIds, wasCustomSubcategory } = resolveCategorySelection(d, body);
  recordSubcategorySuggestion(d, body, categoryId, id, body.get("businessName") || body.get("name") || "");
  const additionalListings = [0, 1, 2].map((i) => readExtraListingFromBody(d, body, "extra", i)).filter(Boolean);
  db.load().freelancers.push({
    id, name: body.get("name"), businessName: body.get("businessName"), email: body.get("email"),
    passwordHash: auth.hashPassword(body.get("password")), categoryId,
    // subcategoryId נשאר "תת-התחום הראשי" (הראשון שסימנה) לתאימות לאחור בכל מקום שמציג תת-תחום
    // בודד; subcategoryIds הוא המערך המלא - ר' resolveCategorySelection.
    subcategoryId, subcategoryIds,
    // Set only when she just introduced a genuinely new subcategory (see resolveCategorySelection)
    // - surfaces a one-time review highlight on the admin pending-approvals screen (/admin GET),
    // cleared once Sapir renames/confirms it there (POST /admin/freelancer/:id/subcategory-note/*).
    customSubcategoryPending: !!wasCustomSubcategory,
    additionalCategoryIds: body.getAll("additionalCategoryIds") || [],
    additionalListings,
    cityId: body.get("cityId"), phone: body.get("phone"), hasWhatsapp: body.get("hasWhatsapp") === "1",
    offersOnline: body.get("offersOnline") === "1", offersHomeVisit: body.get("offersHomeVisit") === "1",
    active: true,
    instagram: body.get("instagram"), portfolioUrl: (body.get("portfolioUrl") || "").trim(),
    photoDataUri: null,
    logoDataUri: fileToDataUri(body.files.logo, MAX_UPLOAD_BYTES),
    galleryPhotos,
    description: clip(body.get("description"), 500), dealText: clip(body.get("dealText"), 200), dealCode,
    yearsInField: body.get("yearsInField") || "",
    wantsPushNotifications: body.get("wantsPushNotifications") === "1",
    // נשמר לתיעוד - חובה לאשר (ר' publicListingConsent למעלה) שהכרטיסייה הפומבית שלה גלויה
    // לכלל הציבור (כולל גברים), לא רק לנשים. שמירת התאריך נותנת הוכחה בדיעבד שהאישור אכן ניתן.
    publicListingConsentAt: new Date().toISOString(),
    inspirationQuote: "", weeklyTipPublished: false, weeklyQuoteLikeCount: 0,
    // משפט השראה שנכתב בהרשמה (אופציונלי, ניתן לדילוג) נשמר כאן כטיוטה בלבד וממתין לאישור
    // מנהלת (POST /admin/inspiration-quote/:id/approve) לפני שהוא הופך לחי ב-inspirationQuote
    // ויכול להופיע בסבב "הטיפ השבועי" בדף הבית - בדיוק כמו המלצת תת-התחום למעלה.
    inspirationQuotePending: clip((body.get("inspirationQuote") || "").trim(), 300),
    tier: body.get("tier") === "premium" ? "premium" : "basic",
    tierUpgradeRequestedAt: null,
    joinType: charging ? "regular" : "founding",
    paymentStatus: charging ? "pending_payment" : "free",
    isLeadingBusiness: false, isAdvertised: false, adPaymentStatus: "none",
    viewCount: 0, couponRevealCount: 0, pushSubscriptions: [],
    referredByFreelancerId, welcomePopupSeen: false,
    status: "pending", createdAt: new Date().toISOString(),
    siteVisitCount: 0,
  });
  // מקשר לה מיד גם חשבון לקוחה תואם (ר' ensureLinkedCustomerAccount למעלה) - לפני ה-save היחיד
  // כאן, כדי לא להוסיף כתיבה נפרדת לדיסק.
  ensureLinkedCustomerAccount(d, d.freelancers.find((x) => x.id === id));
  db.save();

  // Send her the QR code + coupon code for her new profile right away, so she has them
  // in hand for networking even before an admin gets to approve the profile itself.
  const newProfileUrl = `${getOrigin(req)}/freelancer/${id}`;
  const newQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(newProfileUrl)}`;
  const welcomeEmailResult = await sendEmail(body.get("email"), "ברוכה הבאה ל-SheCan - הקוד האישי שלך מוכן",
    `<div dir="rtl" style="font-family:Arial,sans-serif;">
      <p>היי ${esc(body.get("name") || "")},</p>
      <p>תודה שהצטרפת ל-SheCan! קיבלנו את הפרופיל שלך ונעבור עליו בקרוב לאישור.</p>
      <p>בינתיים, הנה קוד הקופון האישי שלך שכבר אפשר להתחיל לשתף:</p>
      <p style="background:#f3ede8;padding:14px;border-radius:8px;font-size:20px;font-weight:800;text-align:center;">${esc(dealCode)}</p>
      <p>וגם קוד QR לכרטיסייה שלך, לנטוורקינג בשטח:</p>
      <p style="text-align:center;"><img src="${newQrUrl}" alt="QR לכרטיסייה שלך" width="200" height="200" /></p>
      <p>ברגע שהפרופיל יאושר, הקישור הזה יהיה פעיל לכולן: ${esc(newProfileUrl)}</p>
    </div>`
  ).catch(() => ({ ok: false, reason: "send_failed" }));

  // Notify Sapir automatically about every new freelancer signup, so she finds out the moment
  // one is waiting on her rather than only when she happens to open /admin - same push-first,
  // email-fallback pattern already used for a new story submission (see /freelancer-dashboard/story
  // above). Per explicit request.
  {
    const notifyAdmin = d.admins[0];
    const notifyTo = d.settings.contactEmail || notifyAdmin.email;
    const welcomeFailedNote = welcomeEmailResult.ok ? "" : " שימי לב - מייל הברוכה הבאה שלה נכשל בשליחה.";
    sendPushToUser(notifyAdmin, { title: "עצמאית חדשה נרשמה!", body: `${body.get("businessName") || body.get("name")} נרשמה וממתינה לאישור.${welcomeFailedNote}`, url: "/admin" })
      .then((pushed) => { if (!pushed) sendEmail(notifyTo, `עצמאית חדשה נרשמה - ${body.get("businessName") || body.get("name")}`,
        `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>${esc(body.get("businessName") || body.get("name") || "")} (${esc(body.get("name") || "")}) נרשמה כעצמאית חדשה וממתינה לאישור שלך.</p><p>אפשר לעבור עליה ולאשר אותה בפאנל הניהול.</p>${welcomeEmailResult.ok ? "" : `<p>שימי לב - מייל הברוכה הבאה שנשלח אליה (עם קוד הקופון וה-QR) נכשל. כדאי לבדוק את שירות המייל, ואפשר גם לשלוח לה פרטי התחברות מחדש דרך פאנל הניהול לאחר שהיא תאושר.</p>`}</div>`
      ).catch(() => {}); })
      .catch(() => {});
  }

  // She could also write her inspiration-story answers right here at signup instead of
  // having to come back to the dashboard later - same pending/approval flow either way.
  const joinStoryQuestions = d.settings.storyQuestions || [];
  const joinStoryAnswers = joinStoryQuestions
    .map((q, i) => ({ question: q, answer: clip((body.get(`storyAnswer${i}`) || "").trim(), 800) }))
    .filter((qa) => qa.answer);
  if (joinStoryAnswers.length) {
    const storyId = db.nextId("story");
    d.stories = d.stories || [];
    d.stories.push({
      id: storyId, title: "", freelancerId: id, content: "", answers: joinStoryAnswers,
      photoDataUri: fileToDataUri(body.files.storyPhoto, MAX_UPLOAD_BYTES), status: "pending", createdAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(), approvedAt: null, comments: [],
    });
    db.save();
    // Push goes to the admin ACCOUNT (the only place a subscription can be attached to); the
    // email fallback still respects a custom contactEmail override if she's set one.
    const admin = d.admins[0];
    const notifyTo = d.settings.contactEmail || admin.email;
    sendPushToUser(admin, { title: "סיפור חדש ממתין לאישור", body: `${body.get("businessName")} שלחה סיפור השראה חדש בהרשמה.`, url: "/admin" })
      .then((pushed) => { if (!pushed) sendEmail(notifyTo, `סיפור חדש ממתין לאישור - ${body.get("businessName")}`,
        `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>${esc(body.get("businessName"))} שלחה סיפור השראה חדש בהרשמה.</p><p>אפשר לעבור עליו ולאשר אותו בפאנל הניהול.</p></div>`
      ).catch(() => {}); })
      .catch(() => {});
  }

  redirect(res, `/login?ok=${encodeURIComponent("קיבלנו! נעבור על הפרופיל שלך ונאשר אותו בקרוב - ואז תוכלי להתחבר. טיפ: כעצמאית יש לך גם אופציה להירשם בנפרד כלקוחה - רק שימי לב שאי אפשר להתחבר בו-זמנית לשני הפרופילים, צריך להחליף ביניהם.")}`);
});

// ----- Login / Signup / Logout -----
// Only accepts a relative, same-site path (never a full URL) as a post-login redirect
// target, so a customer clicking "log in" from, say, a freelancer's message box lands back
// on that exact page instead of always being dumped on her generic account dashboard - while
// still ruling out "//evil.com"-style open-redirect tricks.
function safeNextUrl(next) {
  if (!next || typeof next !== "string") return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

// A validation failure in POST /login (below) re-renders this same form instead of a redirect,
// so whatever she already typed (role + email - never the password, for security) stays filled
// in and she can just fix the one thing that was wrong - same pattern as joinFormBody/join.
function loginFormBody({ next, roleParam, emailPrefill }) {
  return `
  <h1 class="section-title">שמחות לראות אותך שוב</h1>
  <form class="panel" method="post" action="/login" style="max-width:420px;margin:0 auto;">
    ${next ? `<input type="hidden" name="next" value="${esc(next)}" />` : ""}
    <label>מי את?
    <select name="role">
      <option value="customer" ${roleParam === "customer" ? "selected" : ""}>לקוחה</option>
      <option value="freelancer" ${roleParam === "freelancer" ? "selected" : ""}>עצמאית</option>
      <option value="admin" ${roleParam === "admin" ? "selected" : ""}>מנהלת</option>
    </select></label>
    <label>מייל<input type="email" name="email" value="${esc(emailPrefill || "")}" required /></label>
    <label>סיסמה<input type="password" name="password" required /></label>
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">כניסה</button>
  </form>
  <p class="muted" style="text-align:center;margin-top:14px;"><a href="/forgot-password">שכחת סיסמה?</a></p>
  <p class="muted" style="text-align:center;margin-top:6px;">עוד לא איתנו? <a href="/signup">עדיין לא נרשמתי</a> או <a href="/join">יש לי עסק</a></p>
  `;
}

route("GET", "/login", async (req, res, params, query, ctx) => {
  const next = safeNextUrl(query.get("next"));
  const roleParam = query.get("role");
  const body = loginFormBody({ next, roleParam, emailPrefill: query.get("email") || "" });
  sendHtml(res, 200, page({ title: "כניסה", session: ctx.session, body, query }));
});

route("POST", "/login", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const role = body.get("role");
  const email = body.get("email");
  const password = body.get("password");
  const next = safeNextUrl(body.get("next"));
  const d = db.load();
  let user, list;
  if (role === "customer") list = d.customers;
  else if (role === "freelancer") list = d.freelancers;
  else list = d.admins;
  user = list.find((u) => u.email === email);
  const rerenderLoginError = (errMsg) => {
    const formBody = loginFormBody({ next, roleParam: role, emailPrefill: email });
    const errQuery = new URLSearchParams({ err: errMsg });
    return sendHtml(res, 200, page({ title: "כניסה", session: ctx.session, body: formBody, query: errQuery }));
  };
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return rerenderLoginError("משהו לא הסתדר - בדקי את האימייל והסיסמה ונסי שוב.");
  }
  if (role === "freelancer" && user.status !== "approved") {
    return rerenderLoginError("עוד רגע סבלנות - הפרופיל שלך ממתין לאישור, ונעדכן אותך ברגע שהוא יאושר.");
  }
  if (role === "customer" && user.accountLocked) {
    return rerenderLoginError("החשבון שלך עדיין ממתין לבדיקה ידנית ולא ניתן להתחבר איתו כרגע. אפשר לפנות אלינו דרך כפתור התמיכה 💬 שמופיע בכל עמוד באתר.");
  }
  const sid = auth.createSession(role, user.id);
  const loginCookies = role === "admin" ? sessionCookie(sid) : [sessionCookie(sid), identityCookie(role, user.id)];
  redirect(res, next || (role === "admin" ? "/admin" : role === "freelancer" ? "/freelancer-dashboard" : "/account"), loginCookies);
});

// ----- Forgot / reset password -----
route("GET", "/forgot-password", async (req, res, params, query, ctx) => {
  const body = `
  <h1 class="section-title">שכחת סיסמה?</h1>
  <p class="muted" style="text-align:center;">לא נורא - נשלח לך קישור לאיפוס לאימייל שלך.</p>
  <form class="panel" method="post" action="/forgot-password" style="max-width:420px;margin:24px auto;">
    <label>מי את?
    <select name="role">
      <option value="customer">לקוחה</option>
      <option value="freelancer">עצמאית</option>
    </select></label>
    <label>מייל<input type="email" name="email" required /></label>
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">שליחת קישור לאיפוס</button>
  </form>
  `;
  sendHtml(res, 200, page({ title: "שכחתי סיסמה", session: ctx.session, body, query }));
});

route("POST", "/forgot-password", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const role = body.get("role") === "freelancer" ? "freelancer" : "customer";
  const email = (body.get("email") || "").trim();
  const d = db.load();
  const list = role === "freelancer" ? d.freelancers : d.customers;
  const user = list.find((u) => u.email === email);
  // Always show the same message, whether or not the email exists - avoids leaking
  // which addresses are registered.
  const genericMsg = "אם האימייל הזה קיים אצלנו, שלחנו אליו קישור לאיפוס סיסמה. תבדקי גם בספאם ❤️";
  if (user) {
    const token = auth.createResetToken(role, user.id);
    const link = `${getOrigin(req)}/reset-password?token=${token}`;
    // The result is now actually checked (same pattern already used for the approval and
    // welcome emails) - per explicit request after a freelancer reported never receiving her
    // reset email. Since the message shown to her stays generic on purpose (to avoid leaking
    // which addresses are registered), a send failure can't be surfaced to her directly - so
    // instead it's pushed straight to Sapir, the same push-first/email-fallback pattern used
    // for new-signup notifications, so she finds out and can fix/resend without waiting for
    // the freelancer to complain.
    const resetEmailResult = await sendEmail(email, "איפוס סיסמה ל-SheCan",
      `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(user.name || "")},</p><p>קיבלנו בקשה לאפס את הסיסמה שלך ל-SheCan. הקישור הבא בתוקף לשעה אחת:</p><p><a href="${link}">${link}</a></p><p>אם לא ביקשת את זה, אפשר פשוט להתעלם מהמייל.</p></div>`
    ).catch(() => ({ ok: false, reason: "send_failed" }));
    if (!resetEmailResult.ok) {
      const notifyAdmin = d.admins[0];
      const notifyTo = d.settings.contactEmail || notifyAdmin.email;
      const roleLabel = role === "freelancer" ? "עצמאית" : "לקוחה";
      sendPushToUser(notifyAdmin, { title: "מייל איפוס סיסמה נכשל", body: `${roleLabel} ${user.name || email} ניסתה לאפס סיסמה אבל המייל לא נשלח.`, url: "/admin" })
        .then((pushed) => { if (!pushed) sendEmail(notifyTo, "מייל איפוס סיסמה נכשל בשליחה",
          `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>${esc(roleLabel)} ${esc(user.name || "")} (${esc(email)}) ניסתה לאפס סיסמה, אבל שליחת המייל נכשלה.</p><p>כדאי לבדוק את הגדרות שירות המייל, ולוודא שכתובת המייל הרשומה שלה נכונה.</p></div>`
        ).catch(() => {}); })
        .catch(() => {});
    }
  }
  redirect(res, `/login?ok=${encodeURIComponent(genericMsg)}`);
});

route("GET", "/reset-password", async (req, res, params, query, ctx) => {
  const token = query.get("token") || "";
  const body = `
  <h1 class="section-title">בחירת סיסמה חדשה</h1>
  <form class="panel" method="post" action="/reset-password" style="max-width:420px;margin:24px auto;">
    <input type="hidden" name="token" value="${esc(token)}" />
    <label>סיסמה חדשה<input type="password" name="password" required /></label>
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">עדכון הסיסמה</button>
  </form>
  `;
  sendHtml(res, 200, page({ title: "איפוס סיסמה", session: ctx.session, body, query }));
});

route("POST", "/reset-password", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const token = body.get("token") || "";
  const newPassword = body.get("password") || "";
  const consumed = auth.consumeResetToken(token);
  if (!consumed || newPassword.length < 4) {
    return redirect(res, `/login?err=${encodeURIComponent("הקישור לא תקף או שפג תוקפו - אפשר לבקש קישור חדש דרך \"שכחת סיסמה\".")}`);
  }
  const d = db.load();
  const list = consumed.role === "freelancer" ? d.freelancers : d.customers;
  const user = list.find((u) => u.id === consumed.id);
  if (!user) return redirect(res, `/login?err=${encodeURIComponent("משהו השתבש - נסי שוב.")}`);
  user.passwordHash = auth.hashPassword(newPassword);
  db.save();
  redirect(res, `/login?ok=${encodeURIComponent("הסיסמה עודכנה! את יכולה להתחבר עכשיו עם הסיסמה החדשה.")}`);
});

route("GET", "/verify-email", async (req, res, params, query, ctx) => {
  const token = query.get("token") || "";
  const d = db.load();
  const customer = d.customers.find((c) => c.emailVerifyToken && c.emailVerifyToken === token);
  if (!customer) {
    return redirect(res, `/login?err=${encodeURIComponent("קישור האימות לא תקף - ייתכן שכבר אימתת את המייל, או שהקישור פג תוקף.")}`);
  }
  customer.emailVerified = true;
  customer.emailVerifyToken = null;
  db.save();
  const target = ctx.session && ctx.session.role === "customer" && ctx.session.id === customer.id ? "/account" : "/login";
  redirect(res, `${target}?ok=${encodeURIComponent("כתובת המייל שלך אומתה בהצלחה! 🎉")}`);
});

// A validation failure in POST /signup (below) re-renders this same form instead of a
// redirect, so whatever she already typed (name/email/notifications - never the password)
// stays filled in - same pattern as loginFormBody/joinFormBody above.
function signupFormBody(d, { refId, referrer, prefill }) {
  const p = prefill || {};
  return `
  <h1 class="section-title">ההרשמה לוקחת דקה!</h1>
  <div style="max-width:520px;margin:0 auto;text-align:center;font-size:15px;color:var(--gray);">
    ${referrer ? `<p class="muted" style="color:var(--rose-dark);font-weight:700;">${esc(referrer.name.split(" ")[0])} הזמינה אותך להצטרף ל-SheCan ❤️</p>` : ""}
    <p>ברגע שתצטרפי, יפתח בפניך עולם שלם:</p>
    <ul class="bullet-list" style="margin:0;padding:0;list-style:none;line-height:1.9;text-align:right;">
      <li><span class="bullet-icon">🌸</span><span><strong>קודי קופון:</strong> צפייה בכל קודי הקופון וההטבות של העסקים שלנו.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>המועדפות שלך:</strong> שמירת העסקים שתפסו לך את העין במיוחד.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>פרגון באהבה:</strong> אפשרות לכתוב המלצות חמות לעסקים שעשו לך חשק לפרגן.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>קשר ישיר:</strong> התכתבות ישירות עם העצמאיות, בלי תיווכים ובלי רעש מיותר.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>השראה של SheCan:</strong> גישה חופשית למגזין הדיגיטלי היוקרתי שלנו.</span></li>
      <li><span class="bullet-icon">🌸</span><span><strong>הזירה שלך:</strong> אפשרות לכתוב שאלה למומחיות בתחום שמעניין אותך, או להתייעץ עם הקהילה על כל דבר באתר.</span></li>
    </ul>
    <p style="margin-bottom:0;">מחכות לך בפנים!</p>
  </div>

  <form class="panel" method="post" action="/signup" style="max-width:420px;margin:24px auto 0;">
    <input type="hidden" name="ref" value="${esc(refId)}" />
    <label>שם מלא<input type="text" name="name" value="${esc(p.name || "")}" required /></label>
    <label>מייל<input type="email" name="email" value="${esc(p.email || "")}" required /></label>
    <label>בחרי סיסמה<input type="password" name="password" required /></label>
    <label>מגדר
    <select name="gender" required>
      <option value="">בחרי...</option>
      <option value="female" ${p.gender === "female" ? "selected" : ""}>אישה</option>
      <option value="male" ${p.gender === "male" ? "selected" : ""}>גבר</option>
    </select></label>
    ${prefill ? `<p class="muted" style="font-size:13px;">שימי לב - מסיבות אבטחה צריך להקליד את הסיסמה מחדש, שאר הפרטים שמילאת נשמרו.</p>` : ""}
    ${!referrer ? `<label>הוזמנת ע"י חברה? המייל שלה כאן יזכה אותה בהפניה (לא חובה)
    <input type="email" name="referrerEmail" value="${esc(p.referrerEmail || "")}" placeholder="למשל friend@example.com" /></label>` : ""}
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:6px;"><input type="checkbox" name="wantsPushNotifications" value="1" ${p.wantsPushNotifications ? "checked" : ""} style="width:auto;" /> 🔔 כן, תשלחו לי התראות</label>
    <p class="muted" style="margin:2px 0 0;font-size:12.5px;">תקבלי התראה רק כשעונים לשאלה או להתייעצות שלך בזירה, או כשעצמאית עונה להודעה שכתבת לה.</p>
    <label style="display:flex;align-items:flex-start;gap:8px;font-weight:700;margin-top:14px;background:var(--cream);border-radius:8px;padding:10px 12px;">
      <input type="checkbox" name="publicVisibilityConsent" value="1" ${p.publicVisibilityConsent ? "checked" : ""} required style="width:auto;margin-top:3px;" />
      <span>אני מאשרת שאם אכתוב חוות דעת (אלא אם אבחר "אנונימית") או שאלה/פנייה בזירה, השם שלי עשוי להיות גלוי לכלל הציבור הגולש באתר - כולל גברים, ולא רק נשים.</span>
    </label>
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">צרפי אותי</button>
  </form>
  `;
}

route("GET", "/signup", async (req, res, params, query, ctx) => {
  const d = db.load();
  // A visit via a friend's referral link (/signup?ref=<customerId>) - kept through the form
  // as a hidden field so POST /signup can credit the right person, and only trusted if it
  // actually resolves to a real customer (garbage/old ids are silently ignored).
  const refId = query.get("ref") || "";
  const referrer = refId ? d.customers.find((c) => c.id === refId) : null;
  const body = signupFormBody(d, { refId, referrer, prefill: null });
  sendHtml(res, 200, page({ title: "הרשמה", session: ctx.session, body, query }));
});

route("POST", "/signup", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const d = db.load();
  // שני מקרי כשל אפשריים כאן משתפים אותה צורת re-render (200 + prefill) כדי שלא תצטרך להקליד
  // הכל מחדש - קודם אימייל כפול, אחר כך (חדש, 2026-08-30) אישור הפרסום הפומבי, שנבדק גם כאן
  // בצד השרת ולא רק כ-required בטופס עצמו, בדיוק כמו כל שדה required אחר בכל טופס באתר.
  const rerenderSignupWithError = (errMsg) => {
    const refId = body.get("ref") || "";
    const referrer = refId ? d.customers.find((c) => c.id === refId) : null;
    const prefill = {
      name: body.get("name"), email: body.get("email"),
      gender: body.get("gender") || "",
      wantsPushNotifications: body.get("wantsPushNotifications") === "1",
      publicVisibilityConsent: body.get("publicVisibilityConsent") === "1",
      referrerEmail: body.get("referrerEmail") || "",
    };
    const formBody = signupFormBody(d, { refId, referrer, prefill });
    const errQuery = new URLSearchParams({ err: errMsg });
    return sendHtml(res, 200, page({ title: "הרשמה", session: ctx.session, body: formBody, query: errQuery }));
  };
  if (d.customers.find((c) => c.email === body.get("email"))) {
    return rerenderSignupWithError("כבר יש חשבון עם האימייל הזה - נסי להתחבר במקום.");
  }
  if (body.get("publicVisibilityConsent") !== "1") {
    return rerenderSignupWithError("צריך לאשר את תיבת הסימון שהשם שלך עשוי להיות גלוי לכלל הציבור (כולל גברים) כדי להירשם.");
  }
  const gender = body.get("gender");
  if (gender !== "female" && gender !== "male") {
    return rerenderSignupWithError("צריך לבחור מגדר כדי להירשם.");
  }
  const id = db.nextId("customer");
  const emailVerifyToken = crypto.randomBytes(24).toString("hex");
  const email = body.get("email");
  const name = body.get("name");
  // חשבון של גבר ננעל אוטומטית ולא נכנס לאתר בכלל - לפי בקשה מפורשת 2026-08-31 ("וגבר אל
  // תאשר אל תשלח לו שום דבר ותחסום את המייל אוטומטית אלא אם כן אני פותחת אותו מאזור הניהול").
  // לא נשלח מייל אימות, לא נפתחת סשן/התחברות, ומוצג לו מסך "ננעל" עם קישור לפנייה לתמיכה
  // בלבד (ר' הפאנל "חשבונות שממתינים לאישור ידני" בניהול, ו-POST /admin/customer/:id/unlock).
  if (gender === "male") {
    db.load().customers.push({
      id, name, email,
      passwordHash: auth.hashPassword(body.get("password")), cityId: "",
      favorites: [], favoriteNotes: {}, viewedDeals: [], revealedCoupons: [], pushSubscriptions: [], createdAt: new Date().toISOString(),
      communityNotifyTags: {},
      emailVerified: false, emailVerifyToken: crypto.randomBytes(24).toString("hex"),
      wantsPushNotifications: false,
      publicVisibilityConsentAt: new Date().toISOString(),
      gender: "male", accountLocked: true, accountLockedAt: new Date().toISOString(),
      referredByCustomerId: null,
      referralPopupSeen: true,
      siteVisitCount: 0,
      youCanMember: false, youCanRequestedAt: null, youCanActivatedAt: null,
      youCanPolicyAgreedAt: null, youCanCancelledAt: null,
    });
    db.save();
    const lockedBody = `
    <h1 class="section-title">ההרשמה התקבלה</h1>
    <div class="panel" style="max-width:460px;margin:24px auto;text-align:center;">
      <p>החשבון שלך נקלט, אבל עדיין לא פעיל - הוא ממתין לבדיקה ידנית של הנהלת האתר לפני שאפשר להתחבר איתו.</p>
      <p class="muted">אם זה דחוף, אפשר לפנות אלינו דרך כפתור התמיכה 💬 שמופיע בכל עמוד באתר.</p>
      <p style="margin-top:16px;"><a href="/">חזרה לעמוד הבית</a></p>
    </div>`;
    return sendHtml(res, 200, page({ title: "ההרשמה התקבלה", session: ctx.session, body: lockedBody }));
  }
  // Only credited if it actually resolves to a real, different customer - guards against a
  // stale/tampered ref value crediting a deleted account or, worse, someone referring herself.
  const refId = body.get("ref") || "";
  let referrer = refId && refId !== id ? d.customers.find((c) => c.id === refId) : null;
  // גיבוי ידני כשהקישור האישי לא שרד עד לשליחת הטופס (למשל נשלח דרך אפליקציה שמקצצת פרמטרים
  // בקישור, או שהיא פשוט הקלידה את הכתובת ידנית אחרי ששמעה בעל פה) - לפי בקשה מפורשת 2026-08-30,
  // אחרי שהתברר שלקוחה טענה שהפנתה חברות אבל הן לא נספרו. בניגוד לעצמאיות (שיש להן רשימת בחירה
  // מתוך "איך שמעת עלינו") - כאן מזהים לפי מייל, כי לשם פרטי אין זיהוי ייחודי בין לקוחות. הקישור
  // האישי תמיד מנצח אם הוא כן הצליח (בדיוק כמו אצל עצמאיות) - זה רק גיבוי כשהוא נכשל.
  if (!referrer) {
    const referrerEmail = (body.get("referrerEmail") || "").trim().toLowerCase();
    if (referrerEmail) {
      const manualReferrer = d.customers.find((c) => (c.email || "").toLowerCase() === referrerEmail);
      if (manualReferrer && manualReferrer.id !== id) referrer = manualReferrer;
    }
  }
  db.load().customers.push({
    id, name, email,
    passwordHash: auth.hashPassword(body.get("password")), cityId: "",
    favorites: [], favoriteNotes: {}, viewedDeals: [], revealedCoupons: [], pushSubscriptions: [], createdAt: new Date().toISOString(),
    communityNotifyTags: {},
    emailVerified: false, emailVerifyToken,
    gender: "female", accountLocked: false,
    wantsPushNotifications: body.get("wantsPushNotifications") === "1",
    // נשמר לתיעוד - חובה לאשר (ר' publicVisibilityConsent למעלה) שתוכן ציבורי שהיא עשויה
    // לכתוב (חוות דעת/זירה) גלוי לכלל הציבור, לא רק לנשים. התאריך נותן הוכחה בדיעבד שהאישור ניתן.
    publicVisibilityConsentAt: new Date().toISOString(),
    referredByCustomerId: referrer ? referrer.id : null,
    referralPopupSeen: false,
    siteVisitCount: 0,
    youCanMember: false, youCanRequestedAt: null, youCanActivatedAt: null,
    youCanPolicyAgreedAt: null, youCanCancelledAt: null,
  });
  db.save();
  const sid = auth.createSession("customer", id);
  // Email verification is a one-time link, not time-limited like a password reset - stored
  // directly on the customer record (rather than auth.js's in-memory reset-token map) so it
  // survives server restarts and works whenever she gets around to checking her inbox.
  const link = `${getOrigin(req)}/verify-email?token=${emailVerifyToken}`;
  await sendEmail(email, "אימות כתובת המייל שלך ב-SheCan",
    `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(name || "")},</p><p>תודה שהצטרפת ל-SheCan! רק נשאר לאמת את כתובת המייל שלך - לחצי על הקישור הבא:</p><p><a href="${link}">${link}</a></p><p>אם לא נרשמת אצלנו, אפשר פשוט להתעלם מהמייל.</p></div>`);
  redirect(res, "/account", [sessionCookie(sid), identityCookie("customer", id)]);
});

route("GET", "/logout", async (req, res, params, query, ctx) => {
  if (ctx.sid) auth.destroySession(ctx.sid);
  redirect(res, "/", clearCookie);
});

// ----- Customer account -----
route("GET", "/account", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  // הודעות מהנהלת SheCan אליה - אותו דפוס בדיוק כמו myAdminMessages ב-/freelancer-dashboard,
  // רק ממאגר נפרד (d.customerAdminMessages, ר' POST /admin/message-customer) כדי לא לערבב
  // עם הודעות לעצמאיות. מסומנות כ"נקראו" ברגע שהיא נכנסת לכאן ורואה אותן.
  const myAdminMessages = (d.customerAdminMessages || []).filter((m) => m.customerId === customer.id).slice().reverse();
  let anyAdminMsgMarkedRead = false;
  myAdminMessages.forEach((m) => { if (!m.read) { m.read = true; anyAdminMsgMarkedRead = true; } });
  if (anyAdminMsgMarkedRead) db.save();
  // Each favorite key is either a bare freelancer id (her main profile) or
  // "freelancerId:listingId" (one specific additional listing) - resolved into its own card
  // and link so two listings belonging to the same freelancer never get merged into one.
  // כל כרטיס עטוף ב-div חיצוני (לא בתוך ה-<a> של הכרטיס עצמו, כדי לא ליצור קישור/HTML לא
  // תקין) עם טופס הערה פרטית מתחתיו - "הערות" שהלקוחה יכולה לכתוב לעצמה על עצמאית שאהבה
  // (למשל מחיר שסוכם או פרטים אחרי שיחה), נשמר ב-customer.favoriteNotes (מפתח = אותו favKey
  // בדיוק כמו ב-favorites). ר' POST /account/favorite-note למטה.
  const favCards = customer.favorites.map((key) => {
    const [fid, lid] = String(key).split(":");
    const f = d.freelancers.find((x) => x.id === fid);
    if (!f || f.status !== "approved" || f.active === false) return null;
    let cardHtml;
    if (lid) {
      const l = (f.additionalListings || []).find((x) => String(x.id) === lid);
      cardHtml = (l && l.status === "approved") ? additionalListingCard(f, l, d) : null;
    } else {
      cardHtml = freelancerCard(f, d);
    }
    if (!cardHtml) return null;
    const note = (customer.favoriteNotes || {})[key] || "";
    return `
    <div class="fav-card-wrap" id="fav-${esc(key)}">
      ${cardHtml}
      <form method="post" action="/account/favorite-note" class="fav-note-form">
        <input type="hidden" name="key" value="${esc(key)}" />
        <textarea name="note" maxlength="500" class="fav-note-textarea" placeholder="הערה פרטית לעצמך (מחיר שסוכם, פרטים מהשיחה...)">${esc(note)}</textarea>
        <button type="submit" class="btn btn-small btn-outline">שמירת הערה</button>
      </form>
    </div>`;
  }).filter(Boolean);
  // "מסירות"/"מכירת יד 2" שהיא פרסמה במאגרי קהילה - היחידים מבין 8 סוגי המאגר שדורשים
  // חשבון לקוחה מחובר, בדיוק כדי שהיא תוכל לראות ולהוריד אותם בעצמה כאן ברגע שהחפץ כבר
  // נמסר/נמכר (ר' route POST /account/community/:id/take-down) - לא מציגים "rejected" כאן,
  // אין לזה תועלת.
  const myGiveaways = (d.communityListings || [])
    .filter((c) => c.type === "giveaway" && c.ownerCustomerId === customer.id && c.status !== "rejected")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const myForSale = (d.communityListings || [])
    .filter((c) => c.type === "sale" && c.ownerCustomerId === customer.id && c.status !== "rejected")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const myReviews = d.reviews.filter((r) => r.authorCustomerId === customer.id);
  const matchingFreelancerAccount = d.freelancers.find((f) => f.email === customer.email);
  const revealedCoupons = (customer.revealedCoupons || [])
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((rc) => ({ ...rc, freelancer: d.freelancers.find((f) => f.id === rc.freelancerId) }))
    .filter((rc) => rc.freelancer);

  const myChats = (d.chatMessages || []).filter((m) => m.customerId === customer.id);
  const chatByFreelancer = {};
  myChats.forEach((m) => { (chatByFreelancer[m.freelancerId] = chatByFreelancer[m.freelancerId] || []).push(m); });
  let anyMarkedRead = false;
  myChats.forEach((m) => { if (m.fromRole === "freelancer" && !m.read) { m.read = true; anyMarkedRead = true; } });
  if (anyMarkedRead) db.save();
  const conversations = Object.keys(chatByFreelancer)
    .map((fid) => ({ freelancer: d.freelancers.find((f) => f.id === fid), thread: chatByFreelancer[fid].sort((a, b) => new Date(a.date) - new Date(b.date)) }))
    .filter((c) => c.freelancer);

  const referralLink = `${getOrigin(req)}/signup?ref=${customer.id}`;
  const referralPromoHtml = d.settings.customerReferralContestActive ? `
  <div class="panel referral-promo-panel">
    <h3 style="margin-top:0;">פינוק שווה על חשבוננו נשמע לך טוב?</h3>
    <p class="muted">העבירי את הקישור האישי שלך לכמה שיותר חברות - כל אחת שתירשם דרכו תזכה אותך אוטומטית בעוד 10 נקודות, ומי שהביאה הכי הרבה תזכה בפרס השווה!!</p>
    <p>${esc(customer.name.split(" ")[0])}, אל דאגה - יש לנו 4 מקומות, איזה מהם שלך?</p>
    <ul class="referral-prize-list">
      <li><span>🥇</span><span>מקום 1: מסאז' מפנק</span></li>
      <li><span>🥈</span><span>מקום 2: מארז קינוחים מושחת וטעים</span></li>
      <li><span>🥉</span><span>מקום 3: איפור ערב מתנה לפעם הבאה שתצטרכי</span></li>
      <li><span>🎁</span><span>מקום 4: מגש פירות מפנק וצבעוני</span></li>
    </ul>
    <div class="referral-link-row">
      <input type="text" id="scCustomerRefLink" value="${esc(referralLink)}" readonly />
      <button type="button" class="btn btn-small" onclick="scCopyLink('scCustomerRefLink')">העתקת קישור</button>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px;">*הרישום והתחרות פעילים עד ה-${esc(d.settings.customerReferralContestEndDate)}, והזוכות יוכרזו ב-${esc(d.settings.customerReferralAnnounceDate)}!</p>
    ${d.settings.customerReferralPromoNote ? `<p style="font-weight:700;margin-top:8px;">📢 ${esc(d.settings.customerReferralPromoNote)}</p>` : ""}
  </div>
  ${referralStatusHtml({
    entities: d.customers, refField: "referredByCustomerId", selfId: customer.id,
    nameOf: (c) => c.name, firstNameOf: (c) => c.name.split(" ")[0],
    endDateLabel: d.settings.customerReferralContestEndDate, noun: "חברות", rivalNoun: "לקוחות",
  })}` : "";

  // The same "פינוק שווה" message shows as a one-time popup the very first time she lands
  // here (right after registering, since POST /signup redirects straight to /account) -
  // with a working copy-link button, since by now she actually has a real personal link -
  // instead of the old no-link teaser that used to sit on the signup page itself. Marked
  // seen immediately so it never pops up again on later visits, even if she just closes it.
  let referralPopupHtml = "";
  if (d.settings.customerReferralContestActive && !customer.referralPopupSeen) {
    referralPopupHtml = `
    <div class="sc-modal-overlay" onclick="if(event.target===this) this.remove();">
      <div class="sc-modal" style="max-width:420px;">
        <button type="button" class="sc-modal-close" onclick="this.closest('.sc-modal-overlay').remove()" aria-label="סגירה">✕</button>
        <h2 style="font-size:21px;">פינוק שווה על חשבוננו נשמע לך טוב?</h2>
        <p style="text-align:right;font-size:14.5px;">העבירי את הקישור האישי שלך לכמה שיותר חברות - כל אחת שתירשם דרכו תזכה אותך אוטומטית בעוד 10 נקודות, ומי שהביאה הכי הרבה תזכה בפרס השווה!!</p>
        <p style="text-align:right;font-size:14.5px;">${esc(customer.name.split(" ")[0])}, אל דאגה - יש לנו 4 מקומות, איזה מהם שלך?</p>
        <ul class="referral-prize-list">
          <li><span>🥇</span><span>מקום 1: מסאז' מפנק</span></li>
          <li><span>🥈</span><span>מקום 2: מארז קינוחים מושחת וטעים</span></li>
          <li><span>🥉</span><span>מקום 3: איפור ערב מתנה לפעם הבאה שתצטרכי</span></li>
          <li><span>🎁</span><span>מקום 4: מגש פירות מפנק וצבעוני</span></li>
        </ul>
        <div class="referral-link-row">
          <input type="text" id="scCustomerRefLinkPopup" value="${esc(referralLink)}" readonly />
          <button type="button" class="btn btn-small" onclick="scCopyLink('scCustomerRefLinkPopup')">העתקת קישור</button>
        </div>
        <p class="muted" style="font-size:11.5px;margin-top:10px;">*הרישום והתחרות פעילים עד ה-${esc(d.settings.customerReferralContestEndDate)}, והזוכות יוכרזו ב-${esc(d.settings.customerReferralAnnounceDate)}!</p>
        <button type="button" class="btn sc-modal-btn" onclick="this.closest('.sc-modal-overlay').remove()">הבנתי, תודה</button>
      </div>
    </div>`;
    customer.referralPopupSeen = true;
    db.save();
  }

  // תזכורת "סימון עסקה שנסגרה" - הכיוון ההפוך מזה של העצמאית (ר' /freelancer-dashboard,
  // "תזכורת חשובה 💛"): כאן זו הלקוחה שמדווחת ביוזמתה על עסקה שסגרה עם עצמאית שהכירה דרך
  // SheCan (ר' הפאנל #account-deal-close-section למטה + POST /account/deal/close) - מדובר
  // בדיווח סופי ומיידי, בלי שלב אישור נוסף, כי אנחנו סומכות עליה שהיא מדווחת רק על סגירה
  // אמיתית. מוצג פעם אחת בכל כניסה (התחברות) לאזור האישי - לא בכל טעינת עמוד - ולכן מסומן
  // על אובייקט הסשן עצמו (זיכרון בלבד, לא נשמר ב-db). לא מוצג יחד עם הפופאפ של ההגרלה למעלה.
  let dealReportReminderPopupHtml = "";
  if (!referralPopupHtml && !ctx.session.dealReminderShown) {
    dealReportReminderPopupHtml = `
    <div class="sc-modal-overlay" onclick="if(event.target===this) this.remove();">
      <div class="sc-modal" style="max-width:420px;">
        <button type="button" class="sc-modal-close" onclick="this.closest('.sc-modal-overlay').remove()" aria-label="סגירה">✕</button>
        <h2 style="font-size:22px;">תזכורת חשובה 💛</h2>
        <p style="text-align:right;font-size:14.5px;margin-top:10px;">אם סגרת עסקה עם בעלת עסק שהכרת דרך SheCan - נשמח שתעדכני אותנו. חשוב לנו לדעת כמה לקוחות באמת סוגרות עסקאות, ואנחנו סומכות עלייך שתעדכני אותנו רק על סגירה אמיתית.</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;">
          <a href="#account-deal-close-section" class="btn sc-modal-btn" onclick="this.closest('.sc-modal-overlay').remove()">לסימון עסקה שנסגרה</a>
          <button type="button" class="btn btn-outline sc-modal-btn" onclick="this.closest('.sc-modal-overlay').remove()">אזכיר לי בפעם הבאה</button>
        </div>
      </div>
    </div>`;
    ctx.session.dealReminderShown = true;
  }

  // רשימת עצמאיות מאושרות להשלמה אוטומטית בפאנל "סימון עסקה שנסגרה" למטה - אותו דפוס בדיוק
  // כמו businessNameDatalist בטופס ההרשמה (/join), ומיושב לעצמאית בפועל בצד השרת באותה שיטה
  // (findFreelancerByBusinessNameLoose, ר' POST /account/deal/close).
  const approvedFreelancerNameDatalist = d.freelancers.filter((x) => x.status === "approved")
    .map((x) => `<option value="${esc(x.businessName || x.name)}"></option>`).join("");
  const myReportedDeals = (d.deals || []).filter((x) => x.customerId === customer.id)
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((x) => ({ ...x, freelancer: d.freelancers.find((f) => f.id === x.freelancerId) }));

  const body = `
  ${referralPopupHtml}
  ${dealReportReminderPopupHtml}
  <h1 class="section-title">היי ${esc(customer.name)} <span style="color:var(--danger);">♥</span></h1>

  <div class="panel" id="account-profile-section" style="max-width:520px;margin:0 auto;scroll-margin-top:90px;">
    <h3>הפרטים שלך</h3>
    <form method="post" action="/account/update-name">
      <label>השם שלך
      <input type="text" name="name" maxlength="80" required value="${esc(customer.name)}" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת השם</button>
    </form>
  </div>

  ${myAdminMessages.length ? `
  <div class="panel" style="max-width:680px;margin:0 auto;">
    <h3>הודעות מהנהלת SheCan 📣</h3>
    <div class="chat-thread" style="text-align:right;">${myAdminMessages.map((m) => `<div class="chat-msg from-admin">${m.context ? `<div style="font-size:12px;font-weight:700;opacity:.85;margin-bottom:4px;">לגבי: ${esc(m.context)}</div>` : ""}${esc(m.text)}<span class="chat-meta">${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`).join("")}</div>
  </div>` : ""}

  ${referralPromoHtml}

  ${!customer.emailVerified ? `
  <div class="flash flash-err" style="max-width:680px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between;">
    <span>📩 עדיין לא אימתת את כתובת המייל שלך - בדקי את תיבת הדואר (וגם את הספאם).</span>
    <form method="post" action="/account/resend-verification" style="margin:0;">
      <button class="btn btn-small btn-outline" type="submit">שליחת קישור אימות מחדש</button>
    </form>
  </div>` : ""}

  ${matchingFreelancerAccount && matchingFreelancerAccount.status === "approved" ? `
  <div class="panel" style="text-align:center;">
    <h3>עוברת למצב עצמאית</h3>
    <p class="muted">יש לך גם חשבון עצמאית עם המייל הזה. אפשר לעבור אליו בלחיצה אחת - את תמיד תוכלי לחזור למצב לקוחה מהתפריט למעלה.</p>
    <form method="post" action="/account/switch-to-freelancer">
      <button class="btn btn-small" type="submit">מעבר למצב עצמאית</button>
    </form>
  </div>` : ""}

  <div class="panel">
    <h3 style="display:flex;align-items:center;justify-content:center;gap:8px;"><span>❤️</span><span>העצמאיות שאהבת</span></h3>
    ${favCards.length ? `<div class="grid">${favCards.join("")}</div>` : `<p class="muted">עוד לא שמרת אף אחת - תסתכלי קצת סביב ותמצאי מישהי שמדברת אלייך.</p>`}
  </div>

  <div class="panel">
    <h3 style="display:flex;align-items:center;justify-content:center;gap:8px;"><span>🎁</span><span>המסירות שלך</span></h3>
    ${myGiveaways.length ? myGiveaways.map((g) => `
      <div class="panel" style="background:var(--cream);display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
        <div style="display:flex;gap:14px;align-items:center;flex:1;min-width:220px;">
          ${g.photoDataUri ? `<img src="${esc(g.photoDataUri)}" alt="" style="width:60px;height:60px;object-fit:cover;border-radius:10px;flex-shrink:0;" />` : `<span style="font-size:32px;">🎁</span>`}
          <div>
            <strong>${esc(g.title)}</strong>
            <div class="muted" style="font-size:13px;">${g.status === "pending" ? "ממתין לאישור" : g.status === "approved" ? "פורסם ומוצג באתר" : ""}</div>
          </div>
        </div>
        <form method="post" action="/account/community/${g.id}/take-down" onsubmit="return confirm('החפץ כבר נמסר ואפשר להוריד את הפרסום? זו פעולה שלא ניתן לבטל.');">
          <button class="btn btn-small btn-outline" type="submit">כבר נמסר - הסרה</button>
        </form>
      </div>`).join("") : `<p class="muted">עוד לא פרסמת חפץ למסירה - <a href="/community/giveaway/add" style="color:var(--rose-dark);font-weight:700;">אפשר להוסיף כאן</a>.</p>`}
  </div>

  <div class="panel">
    <h3 style="display:flex;align-items:center;justify-content:center;gap:8px;"><span>💰</span><span>המכירות שלך</span></h3>
    ${myForSale.length ? myForSale.map((g) => `
      <div class="panel" style="background:var(--cream);display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
        <div style="display:flex;gap:14px;align-items:center;flex:1;min-width:220px;">
          ${g.photoDataUri ? `<img src="${esc(g.photoDataUri)}" alt="" style="width:60px;height:60px;object-fit:cover;border-radius:10px;flex-shrink:0;" />` : `<span style="font-size:32px;">💰</span>`}
          <div>
            <strong>${esc(g.title)}</strong>${g.price ? ` <span class="muted">- ${esc(g.price)}</span>` : ""}
            <div class="muted" style="font-size:13px;">${g.status === "pending" ? "ממתין לאישור" : g.status === "approved" ? "פורסם ומוצג באתר" : ""}</div>
          </div>
        </div>
        <form method="post" action="/account/community/${g.id}/take-down" onsubmit="return confirm('החפץ כבר נמכר ואפשר להוריד את הפרסום? זו פעולה שלא ניתן לבטל.');">
          <button class="btn btn-small btn-outline" type="submit">כבר נמכר - הסרה</button>
        </form>
      </div>`).join("") : `<p class="muted">עוד לא פרסמת חפץ למכירה - <a href="/community/sale/add" style="color:var(--rose-dark);font-weight:700;">אפשר להוסיף כאן</a>.</p>`}
  </div>

  ${d.settings.youCanEnabled ? `
  <div class="panel" style="text-align:center;">
    <h3>🎟️ מועדון YouCan</h3>
    ${customer.youCanMember
      ? `<p class="muted">את חברה פעילה${customer.youCanActivatedAt ? ` מ-${esc(new Date(customer.youCanActivatedAt).toLocaleDateString("he-IL"))}` : ""} - אפשר לממש כמה קודי קופון שתרצי, בלי הגבלה.</p>
         <a class="btn btn-small" style="margin-top:8px;" href="/youcan/join">ניהול החברות שלי</a>`
      : customer.youCanRequestedAt
      ? `<p class="muted">בקשת ההצטרפות שלך ממתינה לאישור ידני.</p>`
      : `<p class="muted">מעבר ל-${esc(String(d.settings.youCanMonthlyPrice || 13))} ש"ח לחודש אפשר לממש כמה קודי קופון שרוצים, בכל העסקים באתר.</p>
         <a class="btn btn-small" style="margin-top:8px;" href="/youcan/join">להצטרפות למועדון</a>`}
  </div>` : ""}

  <div class="panel">
    <h3>הקופונים שכבר צפית בהם 🎁</h3>
    ${revealedCoupons.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>עסק</th><th>קוד קופון</th><th>תאריך</th></tr>
      ${revealedCoupons.map((rc) => `<tr>
        <td><a href="/freelancer/${rc.freelancer.id}">${esc(rc.freelancer.businessName || rc.freelancer.name)}</a></td>
        <td>${esc(rc.dealCode || "-")}</td>
        <td>${esc(new Date(rc.date).toLocaleDateString("he-IL"))}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עוד לא צפית באף קוד קופון - כשתלחצי על "לצפייה בקוד קופון" בכרטיסייה של עצמאית, הוא יופיע כאן.</p>`}
  </div>

  <div class="panel" id="account-deal-close-section" style="scroll-margin-top:90px;">
    <h3>💰 סגרת עסקה עם עצמאית מ-SheCan?</h3>
    <p class="muted">חשוב לנו לדעת כמה לקוחות באמת סוגרות עסקאות עם עצמאיות שהכירו כאן - כתבי כאן את שם העסק, ותודי לנו! אנחנו סומכות עלייך שתעדכני אותנו רק על סגירה אמיתית, בלי צורך באישור נוסף מהעצמאית.</p>
    <form method="post" action="/account/deal/close">
      <label>שם העסק
      <input type="text" name="businessName" list="scAccountDealFreelancers" required placeholder="הקלידי לחיפוש..." /></label>
      <datalist id="scAccountDealFreelancers">${approvedFreelancerNameDatalist}</datalist>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">כן, סגרתי עסקה 🎉</button>
    </form>
    ${myReportedDeals.length ? `<div class="table-scroll" style="margin-top:16px;"><table class="table-simple"><tr><th>עסק</th><th>תאריך</th></tr>
      ${myReportedDeals.map((dl) => `<tr><td>${dl.freelancer ? esc(dl.freelancer.businessName || dl.freelancer.name) : "עסק שהוסר"}</td><td>${esc(new Date(dl.createdAt).toLocaleDateString("he-IL"))}</td></tr>`).join("")}
    </table></div>` : ""}
  </div>

  <div class="panel">
    <h3>מה שכתבת</h3>
    ${myReviews.length ? myReviews.map((r) => {
      if (r.type !== "freelancer") {
        return `<div class="review">${starRow(r.rating)} <span class="badge ${r.status === "approved" ? "" : "badge-outline"}">${r.status === "approved" ? "פורסם" : r.status === "pending" ? "ממתין לאישור" : "נדחה"}</span> <span class="muted">המלצה על SheCan</span><p class="muted" style="margin:8px 0 0;">${esc(r.text)}</p></div>`;
      }
      const targetLabel = reviewTargetLabel(d, r);
      return `<div class="review"><div class="review-header"><span class="review-name">${esc(targetLabel)}</span></div>${reviewFormHtml(targetLabel, `/freelancer/${r.targetId}/review`, r.listingId || "", r)}</div>`;
    }).join("") : `<p class="muted">עוד לא כתבת כלום - מוזמנת לשתף חוויה מאחת העצמאיות שהכרת כאן.</p>`}
  </div>

  <div class="panel">
    <h3>ההודעות שלך 💬</h3>
    ${conversations.length ? conversations.map((c) => `
      <div style="margin-bottom:22px;">
        <a href="/freelancer/${c.freelancer.id}"><strong>${esc(c.freelancer.businessName || c.freelancer.name)}</strong></a>
        <div class="chat-thread" style="margin-top:8px;">
          ${c.thread.map((m) => `<div class="chat-msg from-${m.fromRole}">${esc(m.text)}<span class="chat-meta">${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`).join("")}
        </div>
        <form method="post" action="/freelancer/${c.freelancer.id}/message">
          <textarea name="text" placeholder="כתבי הודעה..." style="min-height:70px;" required></textarea>
          <button class="btn btn-small" style="margin-top:8px;" type="submit">שליחה</button>
        </form>
      </div>
    `).join("") : `<p class="muted">עוד לא כתבת לאף עצמאית - אפשר לשלוח הודעה ישירה מתוך הכרטיסייה שלה.</p>`}
  </div>
  `;
  sendHtml(res, 200, page({ title: "האזור שלי", session: ctx.session, body, query, noSidebars: true }));
});

// ----- Freelancer dashboard -----
route("GET", "/freelancer-dashboard", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const reviews = d.reviews.filter((r) => r.type === "freelancer" && r.targetId === f.id && r.status === "approved");
  const catOptions = d.categories.map((c) => `<option value="${c.id}" ${c.id === f.categoryId ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const subcatCheckboxes = subcategoryCheckboxesHtml(d, f.categoryId, f.subcategoryIds && f.subcategoryIds.length ? f.subcategoryIds : (f.subcategoryId ? [f.subcategoryId] : []));
  const statusLabel = paymentStatusLabel(f.paymentStatus);
  const matchingCustomer = d.customers.find((c) => c.email === f.email);
  const profileUrl = `${getOrigin(req)}/freelancer/${f.id}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(profileUrl)}`;

  const myChats = (d.chatMessages || []).filter((m) => m.freelancerId === f.id);
  const chatByCustomer = {};
  myChats.forEach((m) => { (chatByCustomer[m.customerId] = chatByCustomer[m.customerId] || []).push(m); });
  let anyMarkedRead = false;
  myChats.forEach((m) => { if (m.fromRole === "customer" && !m.read) { m.read = true; anyMarkedRead = true; } });
  if (anyMarkedRead) db.save();
  const conversations = Object.keys(chatByCustomer)
    .map((cid) => ({ customer: d.customers.find((c) => c.id === cid), thread: chatByCustomer[cid].sort((a, b) => new Date(a.date) - new Date(b.date)) }))
    .filter((c) => c.customer)
    .sort((a, b) => new Date(b.thread[b.thread.length - 1].date) - new Date(a.thread[a.thread.length - 1].date));

  const myStory = (d.stories || []).find((s) => s.freelancerId === f.id && s.status !== "rejected");
  const storyQuestions = d.settings.storyQuestions || [];
  const storyUrl = myStory ? `${getOrigin(req)}/stories/${myStory.id}` : "";

  // סטטוסים 24 שעות (2026-09-02) - מנקה קודם כל סטטוס שלה שכבר פג (ר' pruneFreelancerStatuses),
  // ורק אז סופרת/מציגה את מה שבאמת עדיין פעיל.
  if (pruneFreelancerStatuses(d)) db.save();
  const myActiveStatuses = (d.freelancerStatuses || []).filter((s) => s.freelancerId === f.id)
    .slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Customers she can start a "deal closed" confirmation with - anyone who's ever revealed her
  // coupon while logged in (the only place we reliably link a real customer identity to this
  // specific freelancer). Shown as a datalist so she can also just type any other registered
  // customer's email directly if the deal happened without a coupon reveal.
  const couponCustomers = d.customers.filter((c) => (c.revealedCoupons || []).some((r) => r.freelancerId === f.id));
  const myDeals = (d.deals || []).filter((x) => x.freelancerId === f.id).slice().reverse();

  const myAdminMessages = (d.adminMessages || []).filter((m) => m.freelancerId === f.id).slice().reverse();
  let anyAdminMsgMarkedRead = false;
  myAdminMessages.forEach((m) => { if (!m.read) { m.read = true; anyAdminMsgMarkedRead = true; } });
  if (anyAdminMsgMarkedRead) db.save();

  // The first time an approved freelancer's dashboard renders after she gets approved, pop
  // up a "מזל טוב, את בפנים!!" welcome, followed by the "צרפי חברות" referral upsell (with
  // its own working link) when that contest is active. Marked seen right away so it only
  // ever shows once, even if she just closes it without clicking anything.
  let welcomePopupHtml = "";
  if (f.status === "approved" && !f.welcomePopupSeen) {
    const freelancerRefLinkPopup = `${getOrigin(req)}/join?ref=${f.id}`;
    welcomePopupHtml = `
    <div class="sc-modal-overlay" onclick="if(event.target===this) this.remove();">
      <div class="sc-modal" style="max-width:420px;">
        <button type="button" class="sc-modal-close" onclick="this.closest('.sc-modal-overlay').remove()" aria-label="סגירה">✕</button>
        <h2 style="font-size:22px;">מזל טוב ${esc(f.name.split(" ")[0])}, העסק שלך בפנים!! 🎉</h2>
        ${d.settings.freelancerReferralContestActive ? `
        <p style="text-align:right;font-size:14.5px;margin-top:10px;"><strong>מעוניינת לקבל אצלנו חשיפה מטורפת?</strong></p>
        <p style="text-align:right;font-size:14px;">שלחי את הקישור האישי שלך לעצמאיות שאת מכירה, וכל אחת שמצטרפת דרכך מזכה אותך ב-10 נקודות. זאת שתצבור את מירב הנקודות תזכה בחשיפה מובלטת בדף הבית שלנו למשך חודש שלם! מוכנה לזה?</p>
        <div class="referral-link-row">
          <input type="text" id="scFreelancerRefLinkPopup" value="${esc(freelancerRefLinkPopup)}" readonly />
          <button type="button" class="btn btn-small" onclick="scCopyLink('scFreelancerRefLinkPopup')">העתקת קישור</button>
        </div>
        <p class="muted" style="font-size:11.5px;margin-top:10px;">*התחרות פעילה עד ה-${esc(d.settings.freelancerReferralContestEndDate)} ופרסום העסק המוביל יחל ב-${esc(d.settings.freelancerReferralAnnounceDate)}.</p>
        ` : ""}
        <button type="button" class="btn sc-modal-btn" onclick="this.closest('.sc-modal-overlay').remove()">הבנתי, תודה</button>
      </div>
    </div>`;
    f.welcomePopupSeen = true;
    db.save();
  }

  // תזכורת "סימון עסקה שנסגרה" (ר' הפאנל #deal-close-section למטה + POST
  // /freelancer-dashboard/deal/close) - חשוב לנו לדעת כמה לקוחות שהגיעו דרך SheCan באמת סוגרות
  // עם כל עצמאית, ואנחנו סומכות עליה שהיא מסמנת רק סגירה אמיתית. מוצג פעם אחת בכל כניסה
  // (התחברות) לאזור האישי - לא בכל טעינת עמוד בודדת בתוך אותה התחברות, כדי לא להציק - ולכן
  // מסומן על אובייקט הסשן עצמו (זיכרון בלבד, לא נשמר ב-db) ולא כשדה קבוע על העצמאית. לא
  // מוצג יחד עם פופאפ הברוכה-הבאה למעלה, כדי שלא יוצגו שני פופאפים בבת אחת.
  let dealReminderPopupHtml = "";
  if (!welcomePopupHtml && f.status === "approved" && !ctx.session.dealReminderShown) {
    dealReminderPopupHtml = `
    <div class="sc-modal-overlay" onclick="if(event.target===this) this.remove();">
      <div class="sc-modal" style="max-width:420px;">
        <button type="button" class="sc-modal-close" onclick="this.closest('.sc-modal-overlay').remove()" aria-label="סגירה">✕</button>
        <h2 style="font-size:22px;">תזכורת חשובה 💛</h2>
        <p style="text-align:right;font-size:14.5px;margin-top:10px;">אם לקוחה שהגיעה אלייך דרך SheCan סגרה איתך עסקה בפועל - נשמח שתסמני את זה אצלנו. חשוב לנו לדעת כמה לקוחות באמת סוגרות, ואנחנו סומכות עלייך שתעדכני אותנו רק על סגירה אמיתית.</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;">
          <a href="#deal-close-section" class="btn sc-modal-btn" onclick="this.closest('.sc-modal-overlay').remove()">לסימון עסקה שנסגרה</a>
          <button type="button" class="btn btn-outline sc-modal-btn" onclick="this.closest('.sc-modal-overlay').remove()">אזכיר לי בפעם הבאה</button>
        </div>
      </div>
    </div>`;
    ctx.session.dealReminderShown = true;
  }

  // "בקשות שירות" ממתינות בתחום שלה (ר' ההערה המורחבת ליד serviceRequestCard) - כל עוד
  // d.settings.serviceRequestsPremiumOnly כבוי, כל עצמאית מאושרת בתחום רואה את הפרטים
  // המלאים; כשהדגל דלוק, רק tier==="premium" רואה פרטים - השאר רואות רק "טיזר" עם המספר,
  // כדי לתת סיבה טובה לשדרג (בלי לחשוף פרטי לקוחה בחינם).
  const matchingServiceRequests = (d.serviceRequests || []).filter((r) => r.categoryId === f.categoryId && freelancerSubcatMatchesBroad(f, r.subcategoryId))
    .slice().sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  const canSeeServiceRequests = !d.settings.serviceRequestsPremiumOnly || f.tier === "premium";
  const serviceRequestsSectionHtml = matchingServiceRequests.length ? `
  <div class="panel">
    <h3>📣 בקשות שירות בתחום שלך (${matchingServiceRequests.length})</h3>
    ${canSeeServiceRequests
      ? `<p class="muted">לקוחות שמחפשות בדיוק את מה שאת נותנת - אפשר לפנות אליהן ישירות.</p>${matchingServiceRequests.map((r) => serviceRequestCard(r, d)).join("")}`
      : `<p class="muted">יש ${matchingServiceRequests.length} בקשות פתוחות בתחום שלך כרגע - זמין רק למנויות "מומלצת". אפשר לפנות להנהלת SheCan כדי לשדרג.</p>`}
  </div>` : "";
  const body = `
  ${welcomePopupHtml}
  ${dealReminderPopupHtml}
  <h1 class="section-title">היי ${esc(f.name.split(" ")[0])}, בואי נעדכן קצת</h1>

  <p class="muted" style="text-align:center;max-width:640px;margin:0 auto 20px;">כעצמאית יש לך גם אופציה להירשם גם כלקוחה - שימי לב שאי אפשר להתחבר בו-זמנית לשני הפרופילים.</p>

  <div class="narrow-panels">
  <div class="panel">
    ${f.joinType === "founding" ? `<span class="founding-badge">מייסדת ✦</span> ` : ""}
    ${f.isLeadingBusiness ? `<span class="badge badge-leading">👑 נותנת חסות</span> ` : ""}
    ${f.isAdvertised ? `<span class="badge badge-ad">📣 מודעה פעילה</span> ` : ""}
    <span class="muted">סטטוס: ${f.status !== "approved" ? "עדיין ממתינה לאישור" : f.active === false ? "מושהית זמנית - לא מוצגת באתר" : "את באוויר!"} · תשלום: ${statusLabel} · רמה: ${f.tier === "premium" ? "מומלצת" : "בסיסית"}</span>
    ${f.tier !== "premium" ? (
      f.tierUpgradeRequestedAt
        ? `<p class="muted" style="margin-top:8px;font-size:13px;">🔔 בקשת השדרוג שלך לרמת "מומלצת" נשלחה - ניצור איתך קשר לגבי התשלום.</p>`
        : `<form method="post" action="/freelancer-dashboard/request-tier-upgrade" style="margin-top:8px;">
             <button class="btn btn-small btn-outline" type="submit">⭐ שדרוג לרמת "מומלצת"</button>
           </form>`
    ) : ""}
  </div>

  ${myAdminMessages.length ? `
  <div class="panel">
    <h3>הודעות מהנהלת SheCan 📣</h3>
    <div class="chat-thread" style="text-align:right;">${myAdminMessages.map((m) => `<div class="chat-msg from-admin">${m.context ? `<div style="font-size:12px;font-weight:700;opacity:.85;margin-bottom:4px;">לגבי: ${esc(m.context)}</div>` : ""}${esc(m.text)}<span class="chat-meta">${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`).join("")}</div>
  </div>` : ""}

  ${serviceRequestsSectionHtml}

  <div class="panel">
    <h3>💡 איך להופיע ראשונה?</h3>
    <p class="muted">האתר מציג קודם את הכרטיסיות עם הכי הרבה דירוגים וחוות דעת - אז כדאי לעודד כל לקוחה מרוצה להשאיר לך חוות דעת בכרטיסייה שלך. ככל שיהיו לך יותר חוות דעת מאושרות, כך תופיעי גבוה יותר בתוצאות.</p>
  </div>

  <div class="panel">
    <h3>עוברת למצב לקוחה</h3>
    ${matchingCustomer ? `
      <p class="muted">יש לך גם חשבון לקוחה עם המייל הזה. אפשר לעבור אליו בלחיצה אחת - את תמיד תוכלי לחזור למצב עצמאית מהתפריט למעלה.</p>
      <form method="post" action="/freelancer-dashboard/switch-to-customer">
        <button class="btn btn-small" type="submit">מעבר למצב לקוחה</button>
      </form>
    ` : `<p class="muted">עדיין אין לך חשבון לקוחה עם המייל הזה. אפשר <a href="/signup" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">להירשם כלקוחה</a> ואז לחזור לכאן כדי לעבור בין המצבים בלחיצה אחת.</p>`}
  </div>

  <div class="panel" style="text-align:center;">
    <h3>כרטיס ביקור דיגיטלי</h3>
    <p class="muted">בנטוורקינג, פשוט תראי ללקוחה את הקוד או תשלחי לה את הקישור - הכל כבר מרוכז שם: ההטבה, ההמלצות והדרך ליצור קשר.</p>
    <img src="${qrUrl}" alt="QR לכרטיסייה שלך" style="width:160px;height:160px;margin:10px auto;display:block;" />
    <div style="display:flex;gap:8px;max-width:420px;margin:10px auto 0;">
      <input type="text" id="scProfileLink" value="${esc(profileUrl)}" readonly style="flex:1;" />
      <button type="button" class="btn btn-small" onclick="scCopyProfileLink()">העתקת קישור</button>
    </div>
  </div>

  ${d.settings.freelancerReferralContestActive ? `
  <div class="panel referral-promo-panel">
    <h3 style="margin-top:0;">צרפי חברות וקבלי את המקום הראשון!</h3>
    <p class="muted">רוצה לקבל חשיפה מטורפת בדף הבית לחודש? העתיקי את הקישור האישי שלך, שלחי לחברות עצמאיות, וכל מי שתירשם דרכו תעזור לך לטפס לראש העמוד בתור "העסק המוביל" של החודש למשך חודש שלם!!</p>
    <p class="muted">בהרשמת עצמאית דרך הקישור שלך - העסק שלך יופיע אוטומטית בשדה "איך שמעת על SheCan" ותזכי ב-10 נקודות בדרך למקום הראשון. העסק שיקבל הכי הרבה נקודות יזכה במקום הראשון.</p>
    <div class="referral-link-row">
      <input type="text" id="scFreelancerRefLink" value="${getOrigin(req)}/join?ref=${f.id}" readonly />
      <button type="button" class="btn btn-small" onclick="scCopyLink('scFreelancerRefLink')">העתקת קישור</button>
    </div>
    <p class="muted" style="font-size:11.5px;margin-top:10px;">*התחרות פעילה עד ה-${esc(d.settings.freelancerReferralContestEndDate)} ופרסום העסק המוביל יחל ב-${esc(d.settings.freelancerReferralAnnounceDate)}.</p>
    ${d.settings.freelancerReferralPromoNote ? `<p style="font-weight:700;margin-top:8px;">📢 ${esc(d.settings.freelancerReferralPromoNote)}</p>` : ""}
  </div>
  ${referralStatusHtml({
    entities: d.freelancers, refField: "referredByFreelancerId", selfId: f.id,
    nameOf: (x) => x.businessName || x.name, firstNameOf: (x) => (x.name || "").split(" ")[0],
    endDateLabel: d.settings.freelancerReferralContestEndDate, noun: "חברות", rivalNoun: "עצמאיות",
  })}` : ""}

  <div class="panel" style="text-align:center;">
    <h3>הסיפור שלך</h3>
    ${!myStory ? `
      <p class="muted">עני בכמה מילים על השאלות הבאות ונבנה מזה את סיפור ההשראה שלך - הוא יעבור אלינו לאישור, ואחרי שהוא יאושר תקבלי קישור לשתף אותו. לא חייבת לענות על כולן - אבל צריך לענות על לפחות ${Math.min(STORY_MIN_ANSWERS, storyQuestions.length)} מהשאלות כדי לשלוח.</p>
      <form method="post" action="/freelancer-dashboard/story" enctype="multipart/form-data" style="text-align:right;">
        ${storyQuestions.map((q, i) => `<label>${esc(q)}<textarea name="answer${i}" maxlength="800" data-sc-story-q="1"></textarea></label>`).join("")}
        <div class="muted" data-sc-story-count-note style="font-size:12.5px;margin-top:4px;"></div>
        <label>תמונה לסיפור (לא חובה)<input type="file" name="photo" accept="image/*" /></label>
        <button class="btn" style="margin-top:14px;" type="submit">שליחת הסיפור שלי</button>
      </form>
    ` : myStory.status === "approved" ? `
      <p class="muted">הסיפור שלך באוויר! אפשר לשתף את הקישור עם הלקוחות שלך.</p>
      <div style="display:flex;gap:8px;max-width:420px;margin:10px auto 0;">
        <input type="text" id="scStoryLink" value="${esc(storyUrl)}" readonly style="flex:1;" />
        <button type="button" class="btn btn-small" onclick="scCopyStoryLink()">העתקת קישור</button>
      </div>
      <a class="btn btn-outline btn-small" style="margin-top:10px;display:inline-block;" href="/stories/${myStory.id}">צפייה בסיפור</a>
    ` : `
      <p class="muted">שלחת את הסיפור שלך - הוא ממתין לאישור, ותקבלי מייל ברגע שהוא יעלה לאוויר. כל עוד הוא לא פורסם, את יכולה לערוך אותו כאן. צריך להשאיר לפחות ${Math.min(STORY_MIN_ANSWERS, storyQuestions.length)} תשובות מלאות.</p>
      <form method="post" action="/freelancer-dashboard/story/edit" enctype="multipart/form-data" style="text-align:right;margin-top:10px;">
        ${storyQuestions.map((q, i) => {
          const existing = (myStory.answers || []).find((a) => a.question === q);
          return `<label>${esc(q)}<textarea name="answer${i}" maxlength="800" data-sc-story-q="1">${esc(existing ? existing.answer : "")}</textarea></label>`;
        }).join("")}
        <div class="muted" data-sc-story-count-note style="font-size:12.5px;margin-top:4px;"></div>
        <label>תמונה לסיפור (להחלפה, לא חובה)<input type="file" name="photo" accept="image/*" /></label>
        <button class="btn" style="margin-top:14px;" type="submit">עדכון הסיפור שלי</button>
      </form>
    `}
  </div>

  ${d.settings.freelancerStatusesEnabled ? `
  <div class="panel" style="text-align:center;">
    <h3>הסטטוסים שלך (${myActiveStatuses.length}/3)</h3>
    ${f.tier !== "premium" ? `
      <p class="muted">התכונה הזו פתוחה לעצמאיות ברמת "מומלצת" בלבד - אפשר לפנות אלינו דרך כפתור התמיכה 💬 אם תרצי לשדרג.</p>
    ` : `
      <p class="muted">תמונה או סרטון שנעלמים אוטומטית אחרי 24 שעות - מוצגים בעיגול ללקוחות באתר, עד 3 סטטוסים פעילים בו-זמנית.</p>
      ${myActiveStatuses.length ? `
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:14px 0;">
        ${myActiveStatuses.map((s) => `
        <div style="text-align:center;">
          ${s.type === "video"
            ? `<video src="${esc(s.url)}" style="width:80px;height:80px;object-fit:cover;border-radius:50%;" muted></video>`
            : `<img src="${esc(s.url)}" alt="" style="width:80px;height:80px;object-fit:cover;border-radius:50%;" />`}
          <div class="muted" style="font-size:11px;margin-top:4px;">💗 ${s.heartCount || 0}</div>
          <form method="post" action="/freelancer-dashboard/status/${s.id}/delete" onsubmit="return confirm('למחוק את הסטטוס הזה?');" style="margin-top:4px;">
            <button type="submit" class="btn btn-small btn-outline" style="padding:2px 8px;font-size:11px;">מחיקה</button>
          </form>
        </div>`).join("")}
      </div>` : ""}
      ${myActiveStatuses.length < 3 ? `
      <form method="post" action="/freelancer-dashboard/status" enctype="multipart/form-data" style="max-width:360px;margin:0 auto;">
        <label>העלאת תמונה או סרטון חדש<input type="file" name="media" accept="image/*,video/mp4,video/webm,video/quicktime" required /></label>
        <button class="btn btn-small" style="margin-top:10px;" type="submit">העלאה</button>
      </form>` : `<p class="muted">הגעת למגבלה של 3 סטטוסים פעילים - אפשר למחוק אחד כדי לפנות מקום, או לחכות שאחד יפוג.</p>`}
    `}
  </div>` : ""}

  <form class="panel" method="post" action="/freelancer-dashboard" enctype="multipart/form-data">
    <h3>הפרופיל שלך</h3>
    ${avatarUri(f) ? `<div style="margin-bottom:10px;">${photoOrInitials(avatarUri(f), f.businessName, "profile-photo")}</div>` : ""}
    <label>תמונת פרופיל ${f.photoDataUri ? "(להחלפה)" : "(לא חובה)"}<input type="file" name="photo" accept="image/*" /></label>
    <label>לוגו העסק ${f.logoDataUri ? "(להחלפה)" : "(לא חובה)"}<input type="file" name="logo" id="dashLogoInput" accept="image/*" data-sc-crop="1" /></label>
    <label>שם העסק<input type="text" name="businessName" id="dashBusinessName" value="${esc(f.businessName)}" required /></label>
    <label>תחום
    <select name="categoryId" id="dashCategorySelect" onchange="scUpdateSubcatCheckboxes(this, 'scSubcatBox');scToggleOtherCategory(this, 'scOtherCategoryBoxDash');">${catOptions}<option value="__other__">אחר - התחום שלי לא ברשימה</option></select></label>
    <label>תת-תחום (לא חובה - אפשר לסמן כמה)</label>
    <div id="scSubcatBox" style="max-height:160px;overflow-y:auto;border:1px solid #ddd3c4;border-radius:8px;padding:10px;margin:-6px 0 6px;">${subcatCheckboxes}</div>
    <label>לא מוצאת תת-תחום מתאים? כתבי לנו המלצה ונבדוק להוסיף אותה (לא חובה)<input type="text" name="subcategorySuggestion" maxlength="80" placeholder="למשל: עיצוב שולחנות מתוקים" /></label>
    <p class="muted" style="margin:-6px 0 6px;font-size:12.5px;">💡 ההמלצה תישלח לבדיקה - היא לא נוספת אוטומטית, ותוכלי לבחור אותה מהרשימה אחרי שתאושר.</p>
    <div id="scOtherCategoryBoxDash" style="display:none;">
      <label>מה שם התחום שלך?<input type="text" name="customCategory" placeholder="למשל: עיצוב אירועים" /></label>
      <label>תת-תחום (לא חובה)<input type="text" name="customSubcategory" placeholder="למשל: עיצוב שולחנות מתוקים" /></label>
    </div>
    <label>עיר${cityAutocompleteHtml({ fieldName: "cityId", selectedId: f.cityId, selectedName: f.cityId ? cityName(d, f.cityId) : "" })}</label>
    <label>טלפון<input type="tel" name="phone" value="${esc(f.phone || "")}" /></label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" ${f.hasWhatsapp ? "checked" : ""} style="width:auto;" /> יש לי וואטסאפ במספר הזה</label>
    <label>איך את נותנת את השירות? (אפשר לסמן כמה)</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:0;"><input type="checkbox" name="offersOnline" value="1" ${f.offersOnline ? "checked" : ""} style="width:auto;" /> 💻 נותנת שירות אונליין / דיגיטלית</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:6px;"><input type="checkbox" name="offersHomeVisit" value="1" ${f.offersHomeVisit ? "checked" : ""} style="width:auto;" /> 🚗 מגיעה עד הבית של הלקוחה</label>
    <label>אינסטגרם<input type="text" name="instagram" value="${esc(f.instagram || "")}" /></label>
    <label>קישור לתיק עבודות (לא חובה)<input type="text" name="portfolioUrl" value="${esc(f.portfolioUrl || "")}" placeholder="https://..." /></label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="availableNow" value="1" ${f.availableNow ? "checked" : ""} style="width:auto;" /> 🟢 זמינה כרגע לעבודה - הראי את זה בכרטיסייה שלי</label>
    <label>קצת עלייך (עד 500 תווים)<textarea name="description" maxlength="500">${esc(f.description || "")}</textarea></label>
    <label>ההטבה שלך (עד 200 תווים) *<textarea name="dealText" maxlength="200">${esc(f.dealText || "")}</textarea></label>
    <p class="muted" style="margin-top:-4px;font-size:13px;">* עסק בלי הטבה ללקוחות לא יופיע באתר.</p>
    <label>כמה שנים את בתחום?
    <select name="yearsInField"><option value="">בחרי</option>${yearsInFieldOptionsHtml(f.yearsInField || "")}</select></label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="wantsPushNotifications" value="1" ${f.wantsPushNotifications ? "checked" : ""} style="width:auto;" /> 🔔 כן, תשלחו לי התראות</label>
    <p class="muted" style="margin-top:-4px;font-size:12.5px;">התראה רק כשעונים לך, כשלקוחה פונה אלייך ישירות, או כשמתפרסמת שאלה חדשה בתחום שלך בזירה.</p>
    ${f.weeklyTipPublished ? `
    <label>משפט ההשראה שלך: (עד 300 תווים)
    <p class="muted" style="margin:4px 0 0;">${esc(f.inspirationQuote || "")}</p>
    </label>
    <p class="muted" style="margin-top:-4px;font-size:12.5px;">המשפט הזה כבר הופיע כטיפ השבועי בדף הבית, ולכן אי אפשר לערוך אותו יותר.</p>
    ` : (f.inspirationQuotePending || "").trim() ? `
    <label>משפט ההשראה שלך: (עד 300 תווים)
    <textarea name="inspirationQuote" maxlength="300">${esc(f.inspirationQuotePending || "")}</textarea></label>
    <p class="muted" style="margin-top:-4px;font-size:12.5px;">🕓 המשפט הזה ממתין לבדיקה ואישור שלנו לפני שהוא יכול להופיע כטיפ השבועי בדף הבית - זה כדי לשמור שרק משפטי השראה אמיתיים מתפרסמים. אפשר עדיין לערוך ולשלוח מחדש כל עוד הוא לא אושר.</p>
    ` : `
    <label>משפט ההשראה שלך: (עד 300 תווים)
    <textarea name="inspirationQuote" maxlength="300" placeholder="גם אם לא הכנת משפט - תמיד תוכלי להיכנס לעדכון ולהוסיף משפט השראה משלך">${esc(f.inspirationQuote || "")}</textarea></label>
    <p class="muted" style="margin-top:-4px;font-size:12.5px;">לא חובה. אחרי ששולחים, המשפט עובר בדיקה שלנו לפני שהוא יכול להופיע כטיפ השבועי בדף הבית - ואפשר לערוך אותו בחופשיות כל עוד הוא עוד לא עלה בתור.</p>
    `}
    ${(f.galleryPhotos && f.galleryPhotos.length) ? `<label>תמונות ההתרשמות שלך היום</label><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">${f.galleryPhotos.map((src) => `<img src="${src}" alt="" style="width:80px;height:80px;object-fit:cover;border-radius:8px;" />`).join("")}</div>` : ""}
    <label>תמונות להתרשמות חדשות (עד 4 - יחליפו את הקיימות אם תעלי, לא חובה)
    <input type="file" name="gallery1" accept="image/*" style="margin-bottom:8px;" /></label>
    <input type="file" name="gallery2" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="gallery3" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="gallery4" accept="image/*" />
    <button class="btn" style="margin-top:14px;" type="submit">שמירה</button>
  </form>

  <div class="panel">
    <h3>עוד תחומים שיש לך 🌟</h3>
    <p class="muted">עושה גם עוד דברים (איפור, עיצוב שיער, בלונים...)? אפשר להוסיף עד 3 תחומים נוספים - לכל אחד השם, התמונות וההטבה שלו, וכל תחום חדש עובר אישור נפרד לפני שהוא עולה לאוויר.</p>
    ${(f.additionalListings || []).map((l) => `
      <div class="panel" style="background:var(--cream);">
        <h4 style="margin:0 0 6px;">${esc(l.businessName)} <span class="muted" style="font-weight:600;">(${l.status === "approved" ? "מאושר ✓ - באוויר" : l.status === "pending" ? "ממתין לאישור" : "נדחה"})</span></h4>
        <form method="post" action="/freelancer-dashboard/listing/${l.id}" enctype="multipart/form-data" style="text-align:right;">
          ${extraListingFormBlock(d, `editListing${l.id}`, "", l)}
          <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת עדכון</button>
        </form>
      </div>
    `).join("")}
    ${(f.additionalListings || []).length < 3 ? `
      <div class="panel" style="background:var(--cream);">
        <h4 style="margin:0 0 6px;">➕ הוספת תחום חדש</h4>
        <form method="post" action="/freelancer-dashboard/listing/add" enctype="multipart/form-data" style="text-align:right;">
          ${extraListingFormBlock(d, "newListing", "", null)}
          <button class="btn btn-small" style="margin-top:10px;" type="submit">הוספת התחום</button>
        </form>
      </div>
    ` : `<p class="muted">הגעת למקסימום של 3 תחומים נוספים.</p>`}
  </div>

  <div class="panel">
    <h3>ההודעות שלך 💬</h3>
    ${conversations.length ? conversations.map((c) => `
      <div style="margin-bottom:22px;">
        <strong>${esc(c.customer.name)}</strong>
        <div class="chat-thread" style="margin-top:8px;">
          ${c.thread.map((m) => {
            const targetLabel = m.fromRole === "customer" ? chatMessageTargetLabel(d, f, m) : null;
            return `<div class="chat-msg from-${m.fromRole}">${targetLabel ? `<span class="chat-target-label">📁 לגבי: ${esc(targetLabel)}</span>` : ""}${esc(m.text)}<span class="chat-meta">${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`;
          }).join("")}
        </div>
        <form method="post" action="/freelancer-dashboard/message/${c.customer.id}/reply">
          <textarea name="text" placeholder="כתבי תשובה..." style="min-height:70px;" required></textarea>
          <button class="btn btn-small" style="margin-top:8px;" type="submit">שליחה</button>
        </form>
      </div>
    `).join("") : `<p class="muted">עוד לא קיבלת הודעות - הן יופיעו כאן ברגע שלקוחה תכתוב לך מהכרטיסייה שלך.</p>`}
  </div>

  <div class="panel" id="deal-close-section" style="scroll-margin-top:90px;">
    <h3>💰 סימון עסקה שנסגרה</h3>
    <p class="muted">כשעסקה עם לקוחה נסגרת באמת, כתבי כאן את המייל שלה - נשלח לה בקשת אישור (במייל/בהתראה), וברגע שהיא תאשר זה יופיע כאן כ"אושרה". כדי שזה יעבוד, חשוב שהיא תהיה רשומה באתר עם המייל הזה.</p>
    <form method="post" action="/freelancer-dashboard/deal/close">
      <label>אימייל הלקוחה
      <input type="email" name="customerEmail" list="scDealCustomers" required placeholder="example@mail.com" /></label>
      <datalist id="scDealCustomers">
        ${couponCustomers.map((c) => `<option value="${esc(c.email)}">${esc(c.name)}</option>`).join("")}
      </datalist>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שליחת בקשת אישור ללקוחה</button>
    </form>
    ${myDeals.length ? `<div class="table-scroll" style="margin-top:16px;"><table class="table-simple"><tr><th>לקוחה</th><th>סטטוס</th><th>תאריך</th></tr>
      ${myDeals.map((dl) => `<tr><td>${esc(dl.customerName)}</td><td>${dealStatusLabel(dl.status)}</td><td>${esc(new Date(dl.createdAt).toLocaleDateString("he-IL"))}</td></tr>`).join("")}
    </table></div>` : ""}
  </div>

  <div class="panel">
    <h3>מה אומרות עלייך</h3>
    ${reviews.length ? reviews.map((r) => `
      ${r.listingId ? `<p class="muted" style="margin:0 0 -6px;font-size:13px;">על התחום: ${esc(reviewTargetLabel(d, r))}</p>` : ""}
      ${reviewCard(r)}
      ${!r.response ? `
        <form method="post" action="/freelancer-dashboard/review/${r.id}/respond" style="margin:-8px 0 18px;">
          <textarea name="response" placeholder="תודה על ההמלצה! אפשר להגיב כאן בחום..." style="min-height:60px;" required></textarea>
          <button class="btn btn-small" style="margin-top:6px;" type="submit">שליחת תגובה</button>
        </form>
      ` : ""}
    `).join("") : `<p class="muted">עוד אין ביקורות - הן יופיעו כאן ברגע שלקוחות מרוצות יכתבו לך כמה מילים.</p>`}
  </div>
  </div>
  `;
  sendHtml(res, 200, page({ title: "האזור שלי", session: ctx.session, body, query, noSidebars: true }));
});

// בקשת שדרוג עצמית לרמת "מומלצת" (2026-09-02, לפי בקשה מפורשת) - לא שדרוג אוטומטי (אין
// עדיין סליקה מחוברת לתשלומי עצמאיות, בדיוק כמו מועדון YouCan), רק סימון תאריך בקשה שמופיע
// לניהול בתור המתנה (ר' tierUpgradePending ב-GET /admin) - מנהלת מאשרת ידנית אחרי שסידרה
// תשלום מולה, דרך אותו כפתור "הפכי למומלצת" שכבר קיים בטבלת העצמאיות בניהול.
route("POST", "/freelancer-dashboard/request-tier-upgrade", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if (f && f.tier !== "premium" && !f.tierUpgradeRequestedAt) {
    f.tierUpgradeRequestedAt = new Date().toISOString();
    db.save();
    return redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("בקשת השדרוג נשלחה - ניצור איתך קשר לגבי התשלום.")}`);
  }
  redirect(res, "/freelancer-dashboard");
});

route("POST", "/freelancer-dashboard/switch-to-customer", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const customer = f && d.customers.find((c) => c.email === f.email);
  if (!customer) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("עדיין אין לך חשבון לקוחה עם המייל הזה.")}`);
  const sid = auth.createSession("customer", customer.id);
  // תמיכה ב-`next` (נוסף 2026-09-02, ר' customerOnlyPrompt) - כשהמעבר יזום מתוך פעולה שנחסמה
  // (כתיבת המלצה, שליחת הודעה, תגובה וכו') היא חוזרת ישר לאותו עמוד/עוגן כדי לסיים את הפעולה,
  // במקום תמיד לנחות ב-/account. כשאין `next` (המעבר הרגיל מכפתור "מעבר למצב לקוחה" באזור
  // האישי) ההתנהגות הקודמת נשארת בדיוק אותו דבר.
  const body = await readBody(req);
  const next = safeNextUrl(body.get("next"));
  redirect(res, next || "/account", [sessionCookie(sid), identityCookie("customer", customer.id)]);
});

// Lets a customer rename herself (see the "הפרטים שלך" panel in /account, added per explicit
// request 2026-08-30) - just her display name, shown everywhere her account already shows it
// (greeting, reviews, chat with freelancers, etc.) since those all read customer.name live.
route("POST", "/account/update-name", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  if (!customer) return redirect(res, "/login");
  const body = await readBody(req);
  const newName = clip((body.get("name") || "").trim(), 80);
  if (!newName) {
    return redirect(res, `/account?err=${encodeURIComponent("נא להזין שם.")}#account-profile-section`);
  }
  customer.name = newName;
  db.save();
  redirect(res, `/account?ok=${encodeURIComponent("השם עודכן בהצלחה!")}#account-profile-section`);
});

// Mirror of the above, for a customer who's also a registered (approved) freelancer - lets
// her flip between her two hats from whichever personal area she happens to be in, without
// having to log out and back in.
route("POST", "/account/switch-to-freelancer", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const f = customer && d.freelancers.find((x) => x.email === customer.email && x.status === "approved");
  if (!f) return redirect(res, `/account?err=${encodeURIComponent("עדיין אין לך חשבון עצמאית מאושר עם המייל הזה.")}`);
  const sid = auth.createSession("freelancer", f.id);
  // תמיכה ב-`next` (2026-09-02, מראה ל-switch-to-customer למעלה) - כשהמעבר יזום מתוך פעולה
  // שדורשת חשבון עצמאית (למשל מענה לשאלה בזירה, ר' GET /arena) היא חוזרת ישר לאותו עמוד כדי
  // לסיים את הפעולה, במקום תמיד לנחות ב-/freelancer-dashboard. בלי `next` (הכפתור הרגיל
  // "מעבר למצב עצמאית" ב-/account, או הכפתור שמופיע בתפריט העליון כשיש לה הודעות ממתינות
  // כעצמאית) ההתנהגות הקודמת נשארת אותו דבר - היא נוחתת בדשבורד שלה.
  const body = await readBody(req);
  const next = safeNextUrl(body.get("next"));
  redirect(res, next || "/freelancer-dashboard", [sessionCookie(sid), identityCookie("freelancer", f.id)]);
});

// ----- מועדון YouCan (2026-09-02) -----
// דף ההצטרפות/תשלום. כרגע (בלי סליקה מחוברת - youCanPaymentUrl ריק) זה תהליך ידני: היא רואה
// הוראות תשלום (youCanPaymentInstructions, טקסט חופשי שממלאים בפאנל הניהול) ושולחת "בקשת
// הצטרפות" שממתינה לאישור ידני שלה בניהול, ברגע שהתשלום מגיע בפועל - בדיוק כמו pending_payment
// → active שכבר קיים היום אצל עצמאיות שמשלמות דמי הצטרפות. ברגע שיהיה חיבור סליקה אמיתי, מספיק
// למלא את youCanPaymentUrl בפאנל הניהול - הכפתור יוביל ישר לשם במקום לעמוד הפנימי הזה, בלי שום
// שינוי קוד נוסף.
route("GET", "/youcan/join", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) {
    return redirect(res, `/login?next=${encodeURIComponent(`/youcan/join${query.get("next") ? `?next=${encodeURIComponent(query.get("next"))}` : ""}`)}`);
  }
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  if (!customer) return redirect(res, "/login");
  const next = safeNextUrl(query.get("next"));
  const price = d.settings.youCanMonthlyPrice || 13;
  // מדיניות ביטול/חידוש (2026-09-02, לפי בקשה מפורשת): ביטול נכנס לתוקף מיידית, וחידוש בעתיד
  // דורש הצטרפות ותשלום מחדש - אין חידוש אוטומטי. הטקסט מוצג גם בטופס ההצטרפות (עם אישור
  // בצ'קבוקס חובה, נשמר ב-customer.youCanPolicyAgreedAt) וגם כאן לחברה פעילה, ליד כפתור הביטול.
  const policyText = "ביטול חברות במועדון נכנס לתוקף באופן מיידי. כדי לחדש את החברות בעתיד יהיה צורך להצטרף מחדש ולשלם מחדש - החברות אינה מתחדשת אוטומטית לאחר ביטול.";
  let innerHtml;
  if (customer.youCanMember) {
    innerHtml = `
      <p>את כבר חברה במועדון YouCan${customer.youCanActivatedAt ? ` מ-${esc(new Date(customer.youCanActivatedAt).toLocaleDateString("he-IL"))}` : ""} - אפשר לממש כמה קודי קופון שתרצי, בלי הגבלה. 🎉</p>
      ${next ? `<p style="margin-top:14px;"><a class="btn btn-small" href="${esc(next)}">חזרה לעמוד שהיית בו</a></p>` : ""}
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #ddd3c4;">
        <p class="muted" style="font-size:13px;">${esc(policyText)}</p>
        <form method="post" action="/youcan/cancel" onsubmit="return confirm('לבטל את החברות במועדון YouCan? הביטול מיידי, ולחידוש בעתיד יהיה צורך להצטרף ולשלם מחדש.');">
          <button class="btn btn-small btn-outline" type="submit">ביטול חברות</button>
        </form>
      </div>`;
  } else if (customer.youCanRequestedAt) {
    innerHtml = `<p>קיבלנו את בקשת ההצטרפות שלך והיא ממתינה לאישור ידני - נעדכן אותך ברגע שהמועדון יופעל אצלך. תודה! 💛</p>`;
  } else if (d.settings.youCanPaymentUrl) {
    innerHtml = `
      <p class="muted">${esc(price)} ש"ח לחודש, ומימוש בלתי מוגבל של קודי קופון בכל העסקים באתר.</p>
      <p class="muted" style="font-size:13px;margin-top:10px;">${esc(policyText)}</p>
      <p style="margin-top:14px;"><a class="btn" href="${esc(d.settings.youCanPaymentUrl)}" target="_blank" rel="noopener">מעבר לתשלום מאובטח</a></p>`;
  } else {
    innerHtml = `
      <p class="muted">${esc(price)} ש"ח לחודש, ומימוש בלתי מוגבל של קודי קופון בכל העסקים באתר.</p>
      ${d.settings.youCanPaymentInstructions ? `<div class="panel" style="margin-top:12px;white-space:pre-wrap;">${esc(d.settings.youCanPaymentInstructions)}</div>` : `<p class="muted" style="margin-top:12px;">פרטי התשלום עוד לא הוגדרו - אפשר לפנות אלינו דרך כפתור התמיכה 💬.</p>`}
      <form method="post" action="/youcan/join/request" style="margin-top:14px;text-align:right;">
        ${next ? `<input type="hidden" name="next" value="${esc(next)}" />` : ""}
        <label style="display:flex;align-items:flex-start;gap:8px;font-weight:400;font-size:13.5px;"><input type="checkbox" name="agreePolicy" value="1" required style="width:auto;margin-top:3px;flex-shrink:0;" /><span>קראתי ואני מאשרת את מדיניות המועדון: ${esc(policyText)}</span></label>
        <button class="btn" style="margin-top:12px;" type="submit">שילמתי - שליחת בקשת הצטרפות</button>
      </form>`;
  }
  const body = `
  <h1 class="section-title">מועדון YouCan 🎟️</h1>
  <div class="panel" style="max-width:520px;margin:0 auto;text-align:center;">
    ${innerHtml}
  </div>`;
  sendHtml(res, 200, page({ title: "מועדון YouCan", session: ctx.session, body, query }));
});

route("POST", "/youcan/join/request", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  const next = safeNextUrl(body.get("next"));
  // אישור מדיניות הביטול/חידוש חובה (ר' policyText ב-GET /youcan/join למעלה) - בלי הצ'קבוקס
  // מסומן, לא שולחים בקשה בכלל וחוזרים לאותו עמוד כדי שהיא תסמן ותשלח שוב.
  if (body.get("agreePolicy") !== "1") {
    return redirect(res, `/youcan/join${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  }
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  if (customer && !customer.youCanMember && !customer.youCanRequestedAt) {
    customer.youCanRequestedAt = new Date().toISOString();
    customer.youCanPolicyAgreedAt = new Date().toISOString();
    db.save();
  }
  redirect(res, `/youcan/join${next ? `?next=${encodeURIComponent(next)}` : ""}`);
});

// ביטול עצמי של הלקוחה למועדון (2026-09-02, לפי בקשה מפורשת) - נכנס לתוקף מיידית ובלי אישור
// נוסף מהניהול, בדיוק כמו POST /admin/customer/:id/revoke-youcan, רק ביוזמת הלקוחה עצמה על
// חשבונה שלה. youCanRequestedAt מתאפס כדי שאם תרצה להצטרף מחדש בעתיד היא תעבור שוב את כל
// התהליך (כולל תשלום מחדש) ולא "תישאר ממתינה" ממה שכבר בוטל.
route("POST", "/youcan/cancel", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  if (customer && customer.youCanMember) {
    customer.youCanMember = false;
    customer.youCanRequestedAt = null;
    customer.youCanCancelledAt = new Date().toISOString();
    db.save();
    return redirect(res, `/account?ok=${encodeURIComponent("חברות המועדון בוטלה. לחידוש בעתיד יהיה צורך להצטרף ולשלם מחדש.")}`);
  }
  redirect(res, "/account");
});

route("POST", "/account/resend-verification", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  if (!customer) return redirect(res, "/account");
  if (customer.emailVerified) return redirect(res, `/account?ok=${encodeURIComponent("המייל שלך כבר מאומת.")}`);
  if (!customer.emailVerifyToken) customer.emailVerifyToken = crypto.randomBytes(24).toString("hex");
  db.save();
  const link = `${getOrigin(req)}/verify-email?token=${customer.emailVerifyToken}`;
  await sendEmail(customer.email, "אימות כתובת המייל שלך ב-SheCan",
    `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(customer.name || "")},</p><p>הנה קישור אימות חדש לכתובת המייל שלך ב-SheCan:</p><p><a href="${link}">${link}</a></p></div>`);
  redirect(res, `/account?ok=${encodeURIComponent("שלחנו קישור אימות חדש למייל שלך.")}`);
});

// דיווח לקוחה, ביוזמתה, שסגרה עסקה עם עצמאית שהכירה דרך SheCan (ר' הפאנל
// #account-deal-close-section ב-GET /account למעלה) - הכיוון ההפוך מ-POST
// /freelancer-dashboard/deal/close: שם העצמאית מדווחת וממתינה לאישור הלקוחה; כאן הלקוחה עצמה
// מדווחת, ונרשם ישר כ-"confirmed" בלי שלב אישור נוסף - כי היא הצד שסומכים עליו כאן. נכנס לאותו
// מאגר d.deals ונספר באותם מקומות בדיוק (סטטיסטיקות ציבוריות, ייצוא אדמין, טבלת העצמאית עצמה)
// כמו עסקה שאושרה דרך הזרימה ההפוכה - initiatedBy רק לצורך שקיפות/מעקב, לא משפיע על שום ספירה.
route("POST", "/account/deal/close", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  const businessName = (body.get("businessName") || "").trim();
  const d = db.load();
  const customer = d.customers.find((c) => c.id === ctx.session.id);
  const freelancer = findFreelancerByBusinessNameLoose(d, businessName);
  if (!freelancer || freelancer.status !== "approved") {
    return redirect(res, `/account?err=${encodeURIComponent("לא מצאנו עסק אצלנו עם השם הזה - כדאי לבדוק את האיות, או לבחור מהרשימה שנפתחת בזמן ההקלדה.")}#account-deal-close-section`);
  }
  d.deals = d.deals || [];
  const id = db.nextId("deal");
  const now = new Date().toISOString();
  d.deals.push({
    id, freelancerId: freelancer.id, customerId: customer.id, customerName: customer.name,
    status: "confirmed", initiatedBy: "customer", confirmToken: null,
    createdAt: now, customerConfirmedAt: now,
  });
  db.save();
  notify(freelancer, {
    pushTitle: "עסקה נסגרה! 💰", pushBody: `${customer.name || "לקוחה"} סימנה ב-SheCan שסגרתן עסקה יחד.`, url: "/freelancer-dashboard",
    emailSubject: `עסקה נסגרה עם ${customer.name || "לקוחה"} - SheCan`,
    emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(freelancer.name || "")},</p><p><strong>${esc(customer.name || "לקוחה")}</strong> סימנה ב-SheCan שסגרתן עסקה יחד. איזה כיף! 🎉</p></div>`,
  }).catch(() => {});
  redirect(res, `/account?ok=${encodeURIComponent("תודה שעדכנת אותנו! 💛")}#account-deal-close-section`);
});

route("POST", "/freelancer-dashboard/status", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if (!d.settings.freelancerStatusesEnabled) return redirect(res, "/freelancer-dashboard");
  if (!f || f.tier !== "premium") {
    return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התכונה הזו פתוחה לעצמאיות ברמת \"מומלצת\" בלבד.")}`);
  }
  if (pruneFreelancerStatuses(d)) db.save();
  const activeCount = (d.freelancerStatuses || []).filter((s) => s.freelancerId === f.id).length;
  if (activeCount >= 3) {
    return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("הגעת למגבלה של 3 סטטוסים פעילים - מחקי אחד או חכי שיפוג.")}`);
  }
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("הקובץ גדול מדי.")}`);
  const saved = saveStatusFile(body.files.media);
  if (!saved) {
    return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("לא הצלחנו להעלות את הקובץ - צריך תמונה או סרטון (mp4/webm/mov), עד 8MB לתמונה ו-30MB לסרטון.")}`);
  }
  const now = new Date();
  d.freelancerStatuses = d.freelancerStatuses || [];
  d.freelancerStatuses.push({
    id: db.nextId("freelancerStatus"), freelancerId: f.id, type: saved.type, url: saved.url,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    heartCount: 0,
  });
  db.save();
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("הסטטוס עלה לאוויר! הוא ייעלם אוטומטית בעוד 24 שעות.")}`);
});

route("POST", "/freelancer-dashboard/status/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const s = (d.freelancerStatuses || []).find((x) => x.id === params.id && x.freelancerId === ctx.session.id);
  if (s) {
    const filename = (s.url || "").split("/").pop();
    if (filename) { try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch (e) {} }
    d.freelancerStatuses = d.freelancerStatuses.filter((x) => x.id !== s.id);
    db.save();
  }
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("הסטטוס נמחק.")}`);
});

// פתוח לכל מבקרת באתר (בדיוק כמו "לייק" למשפט השבועי) - הספירה בצד שרת, מניעת לייק כפול
// נעשית בצד לקוח בלבד (localStorage, ר' scHeartStatus ב-layout.js) - fire-and-forget, לא צריך
// להחזיר כלום מעבר ל-204.
route("POST", "/status/:id/heart", async (req, res, params, query, ctx) => {
  const d = db.load();
  const s = (d.freelancerStatuses || []).find((x) => x.id === params.id);
  if (s) {
    s.heartCount = (s.heartCount || 0) + 1;
    db.save();
  }
  res.writeHead(204);
  res.end();
});

route("POST", "/freelancer-dashboard/story", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if ((d.stories || []).find((s) => s.freelancerId === f.id && s.status !== "rejected")) {
    return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("כבר שלחת סיפור - אי אפשר לשלוח עוד אחד.")}`);
  }
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const storyQuestions = d.settings.storyQuestions || [];
  const answers = storyQuestions
    .map((q, i) => ({ question: q, answer: clip((body.get(`answer${i}`) || "").trim(), 800) }))
    .filter((qa) => qa.answer);
  const storyMin = Math.min(STORY_MIN_ANSWERS, storyQuestions.length);
  if (answers.length < storyMin) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent(`צריך לענות על לפחות ${storyMin} שאלות כדי לשלוח את הסיפור (ענית כרגע על ${answers.length}).`)}`);
  const id = db.nextId("story");
  d.stories = d.stories || [];
  d.stories.push({
    id, title: "", freelancerId: f.id, content: "", answers,
    photoDataUri: fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES),
    status: "pending", createdAt: new Date().toISOString(), submittedAt: new Date().toISOString(),
    approvedAt: null, comments: [],
  });
  db.save();

  // Notify Sapir automatically so she knows a new story is waiting for her review.
  const admin = d.admins[0];
  const notifyTo = d.settings.contactEmail || admin.email;
  sendPushToUser(admin, { title: "סיפור חדש ממתין לאישור", body: `${f.businessName || f.name} שלחה סיפור השראה חדש.`, url: "/admin" })
    .then((pushed) => { if (!pushed) sendEmail(notifyTo, `סיפור חדש ממתין לאישור - ${f.businessName || f.name}`,
      `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>${esc(f.businessName || f.name)} שלחה סיפור השראה חדש.</p><p>אפשר לעבור עליו ולאשר אותו בפאנל הניהול.</p></div>`
    ).catch(() => {}); })
    .catch(() => {});

  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("הסיפור שלך נשלח לאישור - תקבלי מייל ברגע שהוא יעלה לאוויר!")}`);
});

// She can keep editing her own story freely as long as it's still "pending" (not yet
// approved/published) - once it's live, this route no longer finds a matching story to edit,
// so it's a server-side lock too, not just a hidden form.
route("POST", "/freelancer-dashboard/story/edit", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const story = (d.stories || []).find((s) => s.freelancerId === f.id && s.status === "pending");
  if (!story) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("אין לך כרגע סיפור ממתין לעריכה - אם הוא כבר פורסם, אי אפשר לערוך אותו יותר.")}`);
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const storyQuestions = d.settings.storyQuestions || [];
  const answers = storyQuestions
    .map((q, i) => ({ question: q, answer: clip((body.get(`answer${i}`) || "").trim(), 800) }))
    .filter((qa) => qa.answer);
  const storyEditMin = Math.min(STORY_MIN_ANSWERS, storyQuestions.length);
  if (answers.length < storyEditMin) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent(`צריך להשאיר לפחות ${storyEditMin} תשובות מלאות (יש כרגע ${answers.length}).`)}`);
  story.answers = answers;
  const newPhoto = fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES);
  if (newPhoto) story.photoDataUri = newPhoto;
  db.save();
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("הסיפור שלך עודכן.")}`);
});

route("POST", "/freelancer-dashboard/review/:id/respond", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const body = await readBody(req);
  const response = (body.get("response") || "").trim();
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const r = d.reviews.find((x) => x.id === params.id && x.type === "freelancer" && x.targetId === f.id);
  if (r && response) {
    r.response = response;
    r.responseDate = new Date().toISOString();
    db.save();
  }
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("התגובה שלך פורסמה!")}`);
});

route("POST", "/freelancer-dashboard/message/:customerId/reply", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const body = await readBody(req);
  const text = (body.get("text") || "").trim();
  if (!text) return redirect(res, "/freelancer-dashboard");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const customer = d.customers.find((c) => c.id === params.customerId);
  if (!customer) return redirect(res, "/freelancer-dashboard");
  const id = db.nextId("chat");
  d.chatMessages = d.chatMessages || [];
  d.chatMessages.push({
    id, freelancerId: f.id, customerId: customer.id, fromRole: "freelancer",
    text, date: new Date().toISOString(), read: false,
  });
  db.save();
  notify(customer, {
    pushTitle: `${f.businessName || f.name} ענתה לך ב-SheCan`, pushBody: text, url: "/account",
    emailSubject: `${f.businessName || f.name} ענתה לך ב-SheCan`,
    emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(customer.name || "")},</p><p>${esc(f.businessName || f.name)} ענתה לך ב-SheCan:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(text)}</p></div>`,
  }).catch(() => {});
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("התשובה נשלחה!")}`);
});

// ===================== "עסקה נסגרה" - אישור דו-צדדי =====================
// Per explicit request: a freelancer marking a deal "closed" isn't enough on its own (too easy
// to click carelessly, or to game) - the customer has to confirm it too before it counts. A
// deal always starts as "pending_customer" the moment the freelancer submits it, and only
// becomes "confirmed" once the customer clicks through her own email/push link and says yes
// (or "declined" if she says no). The freelancer can only start a deal against a customer who
// already has a real SheCan account (identified by email) - that's the only way we have any
// address to reach her at for the confirmation step.
function dealStatusLabel(status) {
  if (status === "confirmed") return "✅ אושרה ע\"י הלקוחה";
  if (status === "declined") return "❌ הלקוחה סימנה שלא";
  return "⏳ ממתינה לאישור הלקוחה";
}

route("POST", "/freelancer-dashboard/deal/close", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const body = await readBody(req);
  const email = (body.get("customerEmail") || "").trim().toLowerCase();
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const customer = d.customers.find((c) => (c.email || "").toLowerCase() === email);
  if (!customer) {
    return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("לא מצאנו לקוחה רשומה עם המייל הזה - חשוב לוודא שהיא נרשמה לאתר עם המייל הזה.")}`);
  }
  d.deals = d.deals || [];
  const id = db.nextId("deal");
  const confirmToken = crypto.randomBytes(24).toString("hex");
  d.deals.push({
    id, freelancerId: f.id, customerId: customer.id, customerName: customer.name,
    status: "pending_customer", confirmToken,
    createdAt: new Date().toISOString(), customerConfirmedAt: null,
  });
  db.save();
  const link = `${getOrigin(req)}/deal-confirm/${confirmToken}`;
  notify(customer, {
    pushTitle: "אישור עסקה ב-SheCan", pushBody: `${f.businessName || f.name} סימנה שסגרתן עסקה - נשמח שתאשרי`, url: `/deal-confirm/${confirmToken}`,
    emailSubject: `אישור עסקה עם ${f.businessName || f.name} ב-SheCan`,
    emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(customer.name || "")},</p><p><strong>${esc(f.businessName || f.name)}</strong> סימנה ב-SheCan שסגרתן עסקה יחד. נשמח שתאשרי את זה בלחיצה אחת:</p><p><a href="${link}" style="background:#C98A9A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block;">לאישור העסקה</a></p><p class="muted">אם זה לא מדויק, אפשר גם לסמן "לא" בעמוד הזה - שום דבר לא יאושר בלי שתעשי זאת בעצמך.</p></div>`,
  }).catch(() => {});
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("בקשת האישור נשלחה ללקוחה - ברגע שהיא תאשר זה יתעדכן כאן.")}`);
});

route("GET", "/deal-confirm/:token", async (req, res, params, query, ctx) => {
  const d = db.load();
  const deal = (d.deals || []).find((x) => x.confirmToken === params.token);
  if (!deal) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<div class="panel" style="text-align:center;"><p>הקישור הזה לא תקין.</p></div>` }));
  const f = d.freelancers.find((x) => x.id === deal.freelancerId);
  const fName = esc(f ? (f.businessName || f.name) : "העצמאית");
  let body;
  if (deal.status !== "pending_customer") {
    body = `<div class="panel" style="max-width:480px;margin:0 auto;text-align:center;">
      <p>${deal.status === "confirmed" ? `כבר אישרת שסגרת עסקה עם ${fName} - תודה! 💛` : "כבר טיפלת בבקשת האישור הזו בעבר."}</p>
    </div>`;
  } else {
    body = `
    <div class="panel" style="max-width:480px;margin:0 auto;text-align:center;">
      <h2 class="section-title" style="margin-top:0;">אישור עסקה</h2>
      <p>${fName} סימנה ב-SheCan שסגרתן עסקה יחד. זה נכון?</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;">
        <form method="post" action="/deal-confirm/${deal.confirmToken}/yes"><button class="btn" type="submit">כן, נכון 🎉</button></form>
        <form method="post" action="/deal-confirm/${deal.confirmToken}/no"><button class="btn btn-outline" type="submit">לא</button></form>
      </div>
    </div>`;
  }
  sendHtml(res, 200, page({ title: "אישור עסקה", session: ctx.session, body }));
});

route("POST", "/deal-confirm/:token/yes", async (req, res, params, query, ctx) => {
  const d = db.load();
  const deal = (d.deals || []).find((x) => x.confirmToken === params.token);
  if (deal && deal.status === "pending_customer") {
    deal.status = "confirmed";
    deal.customerConfirmedAt = new Date().toISOString();
    db.save();
    const f = d.freelancers.find((x) => x.id === deal.freelancerId);
    if (f) {
      notify(f, {
        pushTitle: "עסקה אושרה! 🎉", pushBody: `${deal.customerName} אישרה שסגרתן עסקה`, url: "/freelancer-dashboard",
        emailSubject: "עסקה אושרה ב-SheCan",
        emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(f.name || "")},</p><p><strong>${esc(deal.customerName)}</strong> אישרה שסגרתן עסקה יחד. מעולה! 🎉</p></div>`,
      }).catch(() => {});
    }
  }
  redirect(res, `/deal-confirm/${params.token}`);
});

route("POST", "/deal-confirm/:token/no", async (req, res, params, query, ctx) => {
  const d = db.load();
  const deal = (d.deals || []).find((x) => x.confirmToken === params.token);
  if (deal && deal.status === "pending_customer") {
    deal.status = "declined";
    deal.customerConfirmedAt = new Date().toISOString();
    db.save();
  }
  redirect(res, `/deal-confirm/${params.token}`);
});

route("POST", "/freelancer-dashboard", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התמונות ביחד גדולות מדי - נסי עם פחות תמונות או תמונות קטנות יותר.")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  // City is optional as long as she offers an online/digital service or comes to the
  // customer's home - at least one of the three, same rule as at signup.
  if (!body.get("cityId") && body.get("offersOnline") !== "1" && body.get("offersHomeVisit") !== "1") {
    return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("צריך לציין עיר, או לסמן שאת נותנת שירות בדיגיטלית / מגיעה עד הלקוחה - לפחות אחד מהשלושה.")}`);
  }
  f.businessName = body.get("businessName");
  const resolvedCat = resolveCategorySelection(d, body);
  f.categoryId = resolvedCat.categoryId;
  f.subcategoryId = resolvedCat.subcategoryId;
  f.subcategoryIds = resolvedCat.subcategoryIds;
  recordSubcategorySuggestion(d, body, resolvedCat.categoryId, f.id, f.businessName || f.name || "");
  // Only ever sets the flag to true here - never clears it - so an edit that doesn't touch the
  // subcategory can't accidentally wipe out a still-unreviewed flag from earlier. Clearing only
  // happens explicitly via the admin rename/dismiss actions (see customSubcategoryNoteHtml).
  if (resolvedCat.wasCustomSubcategory) f.customSubcategoryPending = true;
  f.cityId = body.get("cityId");
  f.phone = body.get("phone");
  f.hasWhatsapp = body.get("hasWhatsapp") === "1";
  f.offersOnline = body.get("offersOnline") === "1";
  f.offersHomeVisit = body.get("offersHomeVisit") === "1";
  f.instagram = body.get("instagram");
  f.portfolioUrl = (body.get("portfolioUrl") || "").trim();
  f.availableNow = body.get("availableNow") === "1";
  f.description = clip(body.get("description"), 500);
  f.dealText = clip(body.get("dealText"), 200);
  const newYearsInField = body.get("yearsInField");
  if (newYearsInField) f.yearsInField = newYearsInField;
  f.wantsPushNotifications = body.get("wantsPushNotifications") === "1";
  // Locked (server-side, not just hidden in the form) once it's actually been shown as the
  // published weekly tip - see getWeeklyFeature, which sets weeklyTipPublished the moment her
  // turn in the rotation comes up. Otherwise, a new/changed quote goes into inspirationQuotePending
  // and waits for admin approval (POST /admin/inspiration-quote/:id/approve) before it can ever
  // become the live f.inspirationQuote - so only reviewed quotes reach the homepage rotation.
  if (!f.weeklyTipPublished) {
    const newQuote = clip((body.get("inspirationQuote") || "").trim(), 300);
    if (!newQuote) f.inspirationQuotePending = "";
    else if (newQuote !== f.inspirationQuote) f.inspirationQuotePending = newQuote;
  }
  const newPhoto = fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES);
  if (newPhoto) f.photoDataUri = newPhoto;
  const newLogo = fileToDataUri(body.files.logo, MAX_UPLOAD_BYTES);
  if (newLogo) f.logoDataUri = newLogo;
  const newGallery = ["gallery1", "gallery2", "gallery3", "gallery4"]
    .map((field) => fileToDataUri(body.files[field], MAX_UPLOAD_BYTES))
    .filter(Boolean);
  if (newGallery.length) f.galleryPhotos = newGallery;
  db.save();
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("עודכן! ככה בדיוק הלקוחות שלך יראו את זה עכשיו.")}`);
});

route("POST", "/freelancer-dashboard/listing/add", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התמונות ביחד גדולות מדי - נסי עם פחות תמונות או תמונות קטנות יותר.")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if (!f) return redirect(res, "/login");
  f.additionalListings = f.additionalListings || [];
  if (f.additionalListings.length >= 3) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("אפשר עד 3 תחומים נוספים.")}`);
  const listing = readExtraListingFromBody(d, body, "newListing", "");
  if (!listing) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("צריך למלא לפחות שם עסק ותחום כדי להוסיף תחום חדש.")}`);
  f.additionalListings.push(listing);
  db.save();
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("התחום נוסף! הוא ממתין לאישור לפני שיעלה לאוויר.")}`);
});

route("POST", "/freelancer-dashboard/listing/:id", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התמונות ביחד גדולות מדי - נסי עם פחות תמונות או תמונות קטנות יותר.")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if (!f) return redirect(res, "/login");
  const listing = (f.additionalListings || []).find((l) => String(l.id) === params.id);
  if (!listing) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התחום לא נמצא.")}`);
  applyExtraListingUpdate(d, body, `editListing${listing.id}`, listing);
  db.save();
  redirect(res, `/freelancer-dashboard?ok=${encodeURIComponent("התחום עודכן!")}`);
});

// ----- Admin: daily trend charts (site visits / customer signups / freelancer signups) -----
// Rounds `max` up to a "nice" axis ceiling (1/2/5 * 10^n) for chart y-axis gridlines - e.g.
// 17->20, 143->150, 6->10 - so tick labels are round numbers instead of awkward exact maxima.
// Falls back to 1 for an all-zero series so the axis never collapses to a zero range.
function niceAxisMax(max) {
  if (!max || max <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const normalized = max / magnitude;
  let niceNormalized;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;
  return niceNormalized * magnitude;
}

// Builds one small daily-trend line chart (inline SVG, no client-side JS/library needed) for
// ONE metric over `days` (an array of "YYYY-MM-DD" strings, oldest first) - hairline
// gridlines, a 2px colored line, an end-dot showing today's value, and a native <title>
// tooltip on every point (hover shows the exact date + value - works with zero JS). Each
// metric gets its OWN chart with its OWN y-axis (see adminTrendChartsHtml below, which stacks
// three of these) rather than sharing one axis across metrics - site visits and daily signups
// differ by orders of magnitude, and a shared/dual axis would flatten the smaller series into
// an unreadable flat line near zero.
function sparklineChartSvg(days, values, color) {
  // Font sizes here are deliberately larger than a desktop-only chart would need - the SVG
  // scales down to fit narrow phone screens (width:100% + viewBox, see the wrapping <svg> tag
  // below), so text sized for a ~700px desktop panel would shrink to near-illegible on a
  // ~340px-wide mobile admin panel. These sizes were chosen by checking a real mobile
  // screenshot, not just the desktop view.
  const W = 720, H = 140, padL = 40, padR = 12, padT = 16, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = niceAxisMax(Math.max.apply(null, values.concat([0])));
  const n = days.length;
  const xAt = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v) => padT + plotH - (v / maxVal) * plotH;
  const points = values.map((v, i) => ({ x: xAt(i), y: yAt(v), v, day: days[i] }));
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  // The bottom (0) and top (maxVal) gridlines always get a label - the middle one only gets a
  // label when it rounds to something different from both (otherwise, on a small-range chart
  // like an all-zero series, "1" would render twice at two different heights, which reads as
  // a mistake rather than two meaningfully different values).
  const topVal = Math.round(maxVal);
  const midVal = Math.round(0.5 * maxVal);
  const showMidLabel = midVal !== 0 && midVal !== topVal;
  const gridLines = [
    { frac: 0, val: 0, show: true },
    { frac: 0.5, val: midVal, show: showMidLabel },
    { frac: 1, val: topVal, show: true },
  ].map((g) => {
    const y = padT + plotH - g.frac * plotH;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#e1e0d9" stroke-width="1" />
      ${g.show ? `<text x="${padL - 7}" y="${(y + 4.5).toFixed(1)}" text-anchor="end" font-size="13" fill="#898781">${g.val}</text>` : ""}`;
  }).join("");
  const dmy = (key) => key.slice(5).split("-").reverse().join(".");
  const dots = points.map((p, i) => {
    const isLast = i === n - 1;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="8" fill="transparent"><title>${esc(dmy(p.day))}: ${p.v}</title></circle>
      ${isLast ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${color}" stroke="#fcfcfb" stroke-width="2" />` : ""}`;
  }).join("");
  const lastPoint = points[n - 1];
  const endLabel = lastPoint ? `<text x="${(lastPoint.x - 12).toFixed(1)}" y="${(lastPoint.y - 12).toFixed(1)}" text-anchor="end" font-size="15" font-weight="700" fill="#0b0b0b">${lastPoint.v}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;" role="img" aria-label="גרף מגמה יומית">
    ${gridLines}
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    ${dots}
    ${endLabel}
    <text x="${padL}" y="${H - 5}" font-size="13" fill="#898781">${esc(dmy(days[0] || ""))}</text>
    <text x="${W - padR}" y="${H - 5}" text-anchor="end" font-size="13" fill="#898781">${esc(dmy(days[n - 1] || ""))}</text>
  </svg>`;
}

// The panel itself: three stacked charts (site visits, customer signups, freelancer signups),
// each a different fixed color so they're always identifiable at a glance, each with its own
// "▲/▼ מאתמול" delta line above it. Site-visit numbers come from siteStats.dailyRealVisits
// (the bot-filtered estimate - see trackSiteVisit() near the bottom of this file), which only
// has real data from whenever that tracking first started; days before that show 0, not a gap.
// Signup numbers are computed fresh from every customer/freelancer's own createdAt, so those
// two lines are accurate all the way back, with no such starting point.
// DAYS defaults to 7 (לפי בקשה מפורשת: "בשבוע האחרון... אם אני רוצה להרחיב אז בחודש האחרון") -
// ר' טוגל "שבוע אחרון / חודש אחרון" בתוך הפאנל עצמו, שמעביר ?trendRange=7|30 ל-GET /admin.
function adminTrendChartsHtml(d, rangeDays) {
  const DAYS = rangeDays === 30 ? 30 : 7;
  const dailyVisits = (d.siteStats && d.siteStats.dailyRealVisits) || {};
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    days.push(israelDayKeyOffset(i));
  }
  const customersByDay = {};
  d.customers.forEach((c) => {
    if (!c.createdAt) return;
    const key = israelDateKey(c.createdAt);
    customersByDay[key] = (customersByDay[key] || 0) + 1;
  });
  const freelancersByDay = {};
  d.freelancers.forEach((f) => {
    if (!f.createdAt) return;
    const key = israelDateKey(f.createdAt);
    freelancersByDay[key] = (freelancersByDay[key] || 0) + 1;
  });
  const series = [
    { label: "כניסות לאתר ליום (אמיתיות, לא כולל בוטים)", color: "#2a78d6", values: days.map((k) => dailyVisits[k] || 0) },
    { label: "לקוחות שנרשמו ליום", color: "#eb6834", values: days.map((k) => customersByDay[k] || 0) },
    { label: "עצמאיות שנרשמו ליום", color: "#1baf7a", values: days.map((k) => freelancersByDay[k] || 0) },
  ];
  const rows = series.map((s) => {
    const today = s.values[s.values.length - 1] || 0;
    const yesterday = s.values[s.values.length - 2] || 0;
    const diff = today - yesterday;
    const deltaHtml = diff > 0
      ? `<span style="color:#006300;font-weight:700;">▲ ${diff}+ מאתמול</span>`
      : diff < 0
        ? `<span class="muted" style="font-weight:700;">▼ ${Math.abs(diff)}- מאתמול</span>`
        : `<span class="muted">ללא שינוי מאתמול</span>`;
    return `
    <div style="margin-bottom:22px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${s.color};flex-shrink:0;"></span>
          <strong>${esc(s.label)}</strong>
        </div>
        <div style="font-size:13px;">${deltaHtml}</div>
      </div>
      ${sparklineChartSvg(days, s.values, s.color)}
    </div>`;
  }).join("");
  const rangeToggleHtml = `
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:14px;">
      <a href="/admin?trendRange=7#trend-charts" class="btn btn-small ${DAYS === 7 ? "" : "btn-outline"}">שבוע אחרון</a>
      <a href="/admin?trendRange=30#trend-charts" class="btn btn-small ${DAYS === 30 ? "" : "btn-outline"}">חודש אחרון</a>
    </div>`;
  // טבלת מספרים מתחת לגרף (נוסף 2026-08-27, לפי בקשה מפורשת: "ממש במספרים... מספר על כל יום
  // בנפרד") - הגרף למעלה נשאר כמו שהיה (מגמה כללית + hover לערך מדויק בנקודה), אבל היא רצתה
  // גם לראות את המספרים המדויקים ישר על המסך בלי לרחף עם העכבר על כל נקודה בנפרד - במיוחד
  // בנייד, שבו aין ממש "hover". אותם המספרים בדיוק כמו בגרף (days/dailyVisits/וכו' למעלה),
  // רק בתצוגת טבלה - היום ראשון (הכי חדש) ולא הכי ישן, כדי שהיא לא תצטרך לגלול לסוף כדי לראות
  // את אתמול/היום.
  const dmy = (key) => key.slice(5).split("-").reverse().join(".");
  const todayKeyForTable = israelDayKeyOffset(0);
  const tableRows = days.slice().reverse().map((day) => `
    <tr>
      <td>${esc(dmy(day))}${day === todayKeyForTable ? " (היום)" : ""}</td>
      <td>${dailyVisits[day] || 0}</td>
      <td>${freelancersByDay[day] || 0}</td>
      <td>${customersByDay[day] || 0}</td>
    </tr>`).join("");
  const numbersTableHtml = `
  <div class="table-scroll" style="margin-top:8px;">
    <table class="table-simple">
      <tr><th>תאריך</th><th>כניסות לאתר</th><th>עצמאיות נרשמו</th><th>לקוחות נרשמו</th></tr>
      ${tableRows}
    </table>
  </div>`;
  return `
  <div class="panel" id="trend-charts">
    <h3>מגמות יומיות 📈</h3>
    <p class="muted">${DAYS} הימים האחרונים. כל מדד בגרף נפרד ובסקאלה שלו (כדי שמספרים קטנים כמו הרשמות לא "ייעלמו" ליד מספר הכניסות שגדול הרבה יותר) - כך רואים בכל יום אם היתה עליה או ירידה. אפשר לרחף עם העכבר מעל כל נקודה בגרף כדי לראות את התאריך והמספר המדויק - ולמי שרוצה את המספרים המדויקים של כל יום בלי לרחף, יש טבלה מתחת לגרפים.</p>
    ${rangeToggleHtml}
    ${rows}
    <h4 style="margin:18px 0 8px;">המספרים המדויקים, יום אחרי יום 🔢</h4>
    ${numbersTableHtml}
  </div>`;
}

// ===================== "המשך טיפול" - הזזת פריט מתור האישורים לצד (נוסף 2026-08-26) =====================
// לפי בקשה מפורשת: "תן לי אופציה על כל מה שאני צריכה לאשר - שאוכל להעביר לאזור של המשך טיפול
// ולהמשיך לטפל בזה כשאני בוחרת, ואז זה יורד מהאזור של האישורים כדי לנקות כל פעם את השולחן".
// מנגנון גנרי אחד (לא שדה חדש על כל סוג רשומה בנפרד) - d.adminSnoozed הוא רשימת "מפתחות"
// שסומנו כ"המשך טיפול", כל אחד: { key, itemType, itemLabel, snoozedAt }. key מזהה את הפריט
// המקורי (למשל "freelancer:42" או "communityListing:17") - isSnoozed בודקת אם מפתח נמצא
// ברשימה, ומשמשת לסנן החוצה כל אחד מתורי האישור הקיימים (עצמאיות חדשות/ביקורות/סיפורים/
// שאלות זירה/התייעצויות/תחומים נוספים/פריטי מאגרי קהילה מכל סוג) - כך שפריט שסומן פשוט נעלם
// מהתור עד שמחזירים אותו, בלי לגעת בכלל ב-status המקורי של הרשומה (עדיין "pending" באמת -
// זו רק "מסננת תצוגה" נוספת, לא שינוי מצב). itemLabel נשמר בזמן הסימון כדי שפאנל "המשך טיפול"
// יוכל להציג תיאור קצר בלי לשחזר את הרשומה המקורית לפי סוג בכל פעם.
function isSnoozed(d, key) {
  return (d.adminSnoozed || []).some((s) => s.key === key);
}
// כפתור קטן שמתלווה לכל פריט בכל תור אישור - שולח ל-POST /admin/snooze עם המפתח/סוג/תיאור.
function snoozeButtonHtml(key, itemType, itemLabel) {
  return `<form method="post" action="/admin/snooze" style="display:inline;"><input type="hidden" name="key" value="${esc(key)}" /><input type="hidden" name="itemType" value="${esc(itemType)}" /><input type="hidden" name="itemLabel" value="${esc(itemLabel)}" /><button class="btn btn-small btn-outline" type="submit" title="להעביר להמשך טיפול - ייעלם מהתור עד שתחזירי אותו">🕒 להמשך טיפול</button></form>`;
}
// כפתור "שליחת הודעה" שמתלווה לכל פריט בכל תור אישור ששייך לעצמאית ספציפית (ר' POST
// /admin/message-freelancer למטה) - לחיצה פותחת טופס קטן עם תיבת טקסט, בלי לצאת מעמוד הניהול
// ובלי לחפש את העצמאית בפאנל "שליחת הודעה" הכללי. contextLabel (למשל 'משפט ההשראה ששלחה
// לאישור') נשלח כשדה חבוי ומוזרק לכותרת ההתראה/המייל שהיא תקבל, כדי שברור לה מיד על מה
// מדובר. uniqueKey חייב להיות ייחודי בתוך העמוד (כי אותה עצמאית יכולה להופיע במספר תורים
// שונים בו-זמנית) - נבנה תמיד משם התור + מזהה הפריט הספציפי.
function messageFreelancerButtonHtml(freelancerId, contextLabel, uniqueKey) {
  const boxId = `scMsgBox-${esc(uniqueKey)}`;
  return `<span class="sc-msg-inline">
    <button type="button" class="btn btn-small btn-outline" onclick="var b=document.getElementById('${boxId}');b.style.display=(b.style.display==='none'?'block':'none');">💬 שליחת הודעה</button>
    <form method="post" action="/admin/message-freelancer" id="${boxId}" style="display:none;margin-top:8px;max-width:360px;">
      <input type="hidden" name="freelancerId" value="${esc(freelancerId)}" />
      <input type="hidden" name="context" value="${esc(contextLabel)}" />
      <textarea name="text" maxlength="1000" required placeholder="כתבי כאן את ההודעה שלך..." style="min-height:60px;"></textarea>
      <button class="btn btn-small" style="margin-top:6px;" type="submit">שליחה</button>
    </form>
  </span>`;
}
// גרסה מקבילה עבור לקוחה עם חשבון רשום (ר' POST /admin/message-customer למטה) - כרגע משמש
// רק בתור "מכירת יד 2", כי זה הסוג היחיד מבין מאגרי הקהילה עם contactCustomerId אמיתי מלבד
// giveaway. נכנס למאגר נפרד d.customerAdminMessages (לא d.adminMessages, ששייך לעצמאיות
// בלבד) כדי לא לערבב בין השניים בשום מקום שכבר משתמש ב-d.adminMessages היום.
function messageCustomerButtonHtml(customerId, contextLabel, uniqueKey) {
  const boxId = `scMsgBoxC-${esc(uniqueKey)}`;
  return `<span class="sc-msg-inline">
    <button type="button" class="btn btn-small btn-outline" onclick="var b=document.getElementById('${boxId}');b.style.display=(b.style.display==='none'?'block':'none');">💬 שליחת הודעה</button>
    <form method="post" action="/admin/message-customer" id="${boxId}" style="display:none;margin-top:8px;max-width:360px;">
      <input type="hidden" name="customerId" value="${esc(customerId)}" />
      <input type="hidden" name="context" value="${esc(contextLabel)}" />
      <textarea name="text" maxlength="1000" required placeholder="כתבי כאן את ההודעה שלך..." style="min-height:60px;"></textarea>
      <button class="btn btn-small" style="margin-top:6px;" type="submit">שליחה</button>
    </form>
  </span>`;
}
// עבור סוגי מאגר קהילה שנשלחים ללא חשבון מחובר (למשל "המלצות מוצרים" - ר' COMMUNITY_TYPES.product
// ב-server.js) אין customerId בכלל לשלוח אליו הודעה/התראה באתר - כל מה שיש זה שדה מייל חופשי
// ואופציונלי שהיא מילאה בטופס עצמו (c.email). אז זה לא "הודעה" עם תיבת דואר באתר כמו למעלה,
// אלא מייל ישיר בלבד (ר' POST /admin/community/:id/email-submitter) - בלי עותק ב-DB, כי אין
// למי להציג אותו. אם לא מילאה מייל בכלל, אין שום דרך ליצור איתה קשר מכאן ולכן הכפתור לא מוצג.
function emailListingSubmitterButtonHtml(listingId, submitterEmail, uniqueKey) {
  if (!submitterEmail) return `<p class="muted" style="font-size:12px;margin:6px 0 0;">אין כתובת מייל שהוזנה - אי אפשר ליצור איתה קשר מכאן.</p>`;
  const boxId = `scMailBox-${esc(uniqueKey)}`;
  return `<span class="sc-msg-inline">
    <button type="button" class="btn btn-small btn-outline" onclick="var b=document.getElementById('${boxId}');b.style.display=(b.style.display==='none'?'block':'none');">✉️ שליחת מייל</button>
    <form method="post" action="/admin/community/${esc(listingId)}/email-submitter" id="${boxId}" style="display:none;margin-top:8px;max-width:360px;">
      <textarea name="text" maxlength="1000" required placeholder="כתבי כאן את ההודעה שלך..." style="min-height:60px;"></textarea>
      <button class="btn btn-small" style="margin-top:6px;" type="submit">שליחת מייל ל-${esc(submitterEmail)}</button>
    </form>
  </span>`;
}
route("POST", "/admin/snooze", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const key = (body.get("key") || "").trim();
  const itemType = (body.get("itemType") || "").trim();
  const itemLabel = clip((body.get("itemLabel") || "").trim(), 200);
  if (!key) return redirect(res, "/admin");
  d.adminSnoozed = d.adminSnoozed || [];
  if (!d.adminSnoozed.some((s) => s.key === key)) {
    d.adminSnoozed.push({ key, itemType, itemLabel, snoozedAt: new Date().toISOString() });
    db.save();
  }
  redirect(res, `/admin?ok=${encodeURIComponent("הועבר להמשך טיפול - התור נקי יותר עכשיו.")}#followup`);
});
route("POST", "/admin/unsnooze", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const key = (body.get("key") || "").trim();
  d.adminSnoozed = (d.adminSnoozed || []).filter((s) => s.key !== key);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הוחזר לתור האישורים הרגיל.")}#pending-approvals`);
});

// אישור המלצה לתת-תחום חדש (ר' recordSubcategorySuggestion למעלה) - יוצר בפועל תת-תחום אמיתי
// דרך findOrCreateSubcategory (מופיע מאותו רגע בכל התפריטים באתר), ואם העצמאית ששלחה את
// ההמלצה עדיין בלי תת-תחום נבחר - קושר אותו אליה אוטומטית כטובה קטנה (לא דורס תת-תחום שהיא
// כבר בחרה בינתיים).
route("POST", "/admin/subcategory-suggestion/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const s = (d.subcategorySuggestions || []).find((x) => x.id === params.id);
  if (!s) return redirect(res, "/admin");
  const result = findOrCreateSubcategory(d, s.categoryId, s.name);
  if (result) {
    s.status = "approved";
    const f = d.freelancers.find((x) => x.id === s.freelancerId);
    if (f && f.categoryId === s.categoryId && !(f.subcategoryIds && f.subcategoryIds.length) && !f.subcategoryId) {
      f.subcategoryId = result.sub.id;
      f.subcategoryIds = [result.sub.id];
    }
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("תת-התחום אושר ונוסף לרשימה!")}#subcategory-suggestions`);
});
route("POST", "/admin/subcategory-suggestion/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const s = (d.subcategorySuggestions || []).find((x) => x.id === params.id);
  if (s) s.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("ההמלצה נדחתה.")}#subcategory-suggestions`);
});
route("POST", "/admin/inspiration-quote/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f && (f.inspirationQuotePending || "").trim()) {
    f.inspirationQuote = f.inspirationQuotePending.trim();
    f.inspirationQuotePending = "";
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("משפט ההשראה אושר ויכול להופיע כטיפ השבועי!")}#inspiration-quotes`);
});
route("POST", "/admin/inspiration-quote/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) f.inspirationQuotePending = "";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("המשפט נדחה.")}#inspiration-quotes`);
});

// ----- Admin -----
route("GET", "/admin", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  // בכל טעינה של עמוד הניהול בודקים אם יש שיחת תמיכה שממתינה למענה כבר יותר מחצי שעה בלי
  // תזכורת - ר' checkAndSendUnansweredReminders למעלה.
  checkAndSendUnansweredReminders(d);
  const admin = d.admins.find((a) => a.id === ctx.session.id) || d.admins[0];
  // טוגל "שבוע אחרון / חודש אחרון" בפאנל "מגמות יומיות" (ר' adminTrendChartsHtml) - כל ערך
  // אחר מלבד "30" (כולל חסר) נופל חזרה לברירת המחדל 7, לפי בקשה מפורשת.
  const trendRangeDays = query.get("trendRange") === "30" ? 30 : 7;
  const pendingFreelancers = d.freelancers.filter((f) => f.status === "pending" && !isSnoozed(d, `freelancer:${f.id}`));
  const activeFreelancers = d.freelancers.filter((f) => f.status === "approved");
  const pendingReviews = d.reviews.filter((r) => r.status === "pending" && !isSnoozed(d, `review:${r.id}`));
  // Reviews on a freelancer (or one of her listings) auto-publish now, so there's no
  // pre-publish queue for them - instead admin gets to see everything that's already live
  // and delete anything inappropriate after the fact.
  const publishedFreelancerReviews = d.reviews.filter((r) => r.type === "freelancer" && r.status === "approved")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // Site reviews ("מה אומרות עלינו") auto-publish the same way once approved - give admin the
  // same after-the-fact delete backstop here as for freelancer reviews.
  const publishedSiteReviews = d.reviews.filter((r) => r.type === "site" && r.status === "approved")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // תגובות על מאגרי קהילה (חוגים/מורות פרטיות/המלצות מוצרים - ר' COMMUNITY_REVIEWABLE_TYPES)
  // מתפרסמות מיד באותו אופן - אותו גיבוי מחיקה-לאחר-מעשה.
  const publishedCommunityReviews = d.reviews.filter((r) => r.type === "community" && r.status === "approved")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const communityAdminPanelsHtml = COMMUNITY_TYPE_ORDER.map((type) => communityAdminPanelHtml(type, d)).join("");
  const pendingStories = (d.stories || []).filter((s) => s.status === "pending" && !isSnoozed(d, `story:${s.id}`));
  // Used both for the delete table and the "story of the week" manual-pick dropdown below.
  const approvedStoriesForAdmin = (d.stories || []).filter((s) => s.status === "approved").map((s) => {
    const sf = d.freelancers.find((x) => x.id === s.freelancerId);
    return { id: s.id, title: s.title || (sf ? `הסיפור של ${sf.businessName || sf.name}` : "סיפור השראה") };
  });
  const pendingArenaQuestions = (d.arenaQuestions || []).filter((q) => q.status === "pending" && !isSnoozed(d, `arenaQuestion:${q.id}`));
  const pendingConsultations = (d.consultations || []).filter((c) => c.status === "pending" && !isSnoozed(d, `consultation:${c.id}`));
  // תגובות ל"פינת ההתייעצויות" (בניגוד לתשובות ממוקדות בזירה, ובניגוד לחוות דעת) טעונות אישור
  // ידני לפני שהן מתפרסמות - לפי בקשה מפורשת 2026-08-30, כחלק מהתאמת האתר למדיניות נטפרי: זה
  // הערוץ ה"פתוח" ביותר באתר (גם לקוחות וגם עצמאיות יכולות להגיב שם זו לזו), ולכן דווקא הוא
  // מקבל פיקוח מלא מראש - בניגוד לתשובות זירה/חוות דעת שנשארות בפרסום מיידי (הוחלט במפורש
  // להשאיר אותן כך). ר' POST /arena/consultation/:id/reply (status:"pending" בפוש) ו-GET /arena
  // (מסנן להצגה ציבורית רק status==="approved"). רשימה שטוחה של כל התגובות הממתינות מכל
  // ההתייעצויות המאושרות (תגובה תמיד שייכת להתייעצות שכבר אושרה - ר' התנאי ב-route עצמו).
  const pendingConsultationReplies = [];
  (d.consultations || []).forEach((c) => {
    (c.replies || []).forEach((r) => {
      if (r.status === "pending") pendingConsultationReplies.push({ consultation: c, reply: r });
    });
  });
  // Live (already-approved) arena questions/consultations don't need re-approval, but admin
  // should always be able to delete anything in the arena, not just items still in the
  // moderation queue - these feed a permanent management panel below.
  const liveArenaQuestions = (d.arenaQuestions || []).filter((q) => q.status === "approved").slice().reverse();
  const liveConsultations = (d.consultations || []).filter((c) => c.status === "approved").slice().reverse();
  const allPolls = (d.polls || []).slice().reverse();
  // Pending additional listings can belong to ANY freelancer, not just ones whose main
  // profile is still pending - an already-approved freelancer can add a new listing later
  // that itself needs its own review, so this scans every freelancer's additionalListings.
  // "המשך טיפול" - כל הפריטים שהוזזו הצידה מכל תור אישור (ר' isSnoozed/snoozeButtonHtml
  // למעלה) - ממוינים מהישן לחדש כדי שמה שמחכה הכי הרבה זמן יעלה קודם.
  const snoozedItems = (d.adminSnoozed || []).slice().sort((a, b) => new Date(a.snoozedAt) - new Date(b.snoozedAt));
  // "המלצות לתת-תחום חדש" (ר' recordSubcategorySuggestion למעלה) - עצמאיות ממליצות, לא יוצרות
  // תת-תחום חי בעצמן יותר - כל המלצה תלויה מחכה כאן לאישור/דחייה מפורש.
  const pendingSubcategorySuggestions = (d.subcategorySuggestions || []).filter((s) => s.status === "pending" && !isSnoozed(d, `subcategorySuggestion:${s.id}`));
  // "משפטי השראה" שנכתבו בהרשמה או באזור האישי (ר' inspirationQuotePending למעלה) - כל אחד
  // ממתין כאן לאישור/דחייה מפורש לפני שהוא יכול להפוך לחי ולהיכנס לסבב הטיפ השבועי.
  const pendingInspirationQuotes = d.freelancers.filter((f) => (f.inspirationQuotePending || "").trim() && !isSnoozed(d, `inspirationQuote:${f.id}`));
  const pendingListings = [];
  const approvedListings = [];
  d.freelancers.forEach((f) => {
    (f.additionalListings || []).forEach((l) => {
      if (l.status === "pending" && !isSnoozed(d, `listing:${f.id}:${l.id}`)) pendingListings.push({ f, l });
      else if (l.status === "approved") approvedListings.push({ f, l });
    });
  });

  // Leaderboard for the freelancer "צרפי חברה" referral race - same referralCounts helper
  // that already drives each freelancer's own personal status panel in her dashboard
  // (referralStatusHtml), just surfaced here as a full ranked list for admin visibility. Only
  // freelancers who actually referred someone are included, sorted highest-first, so this
  // reads as "who's leading" rather than a long list of mostly zeros.
  const freelancerReferralCounts = referralCounts(d.freelancers, "referredByFreelancerId");
  const freelancerReferralRanking = d.freelancers
    .map((f) => ({
      id: f.id, name: f.businessName || f.name, count: freelancerReferralCounts[f.id] || 0,
      referred: d.freelancers.filter((x) => x.referredByFreelancerId === f.id).map((x) => x.businessName || x.name),
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  // Same idea as freelancerReferralRanking just above, for the customers' "הביאי חברה" race
  // (referredByCustomerId) - added per explicit request 2026-08-30 so admin can see "who's
  // leading and by how much" for BOTH races in one place, not just the freelancer one.
  const customerReferralCounts = referralCounts(d.customers, "referredByCustomerId");
  const customerReferralRanking = d.customers
    .map((c) => ({
      id: c.id, name: c.name || c.email, count: customerReferralCounts[c.id] || 0,
      referred: d.customers.filter((x) => x.referredByCustomerId === c.id).map((x) => x.name || x.email),
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  // "עסקה נסגרה" two-sided confirmations (see /freelancer-dashboard/deal/close and
  // /deal-confirm/:token) - only status "confirmed" counts as a real closed deal here, since
  // that's the whole point of the two-sided flow: a freelancer marking it isn't enough on its
  // own until the customer also confirms.
  const confirmedDealsCount = (d.deals || []).filter((x) => x.status === "confirmed").length;
  const pendingDealsCount = (d.deals || []).filter((x) => x.status === "pending_customer").length;
  const dealsByFreelancer = {};
  (d.deals || []).forEach((x) => { if (x.status === "confirmed") dealsByFreelancer[x.freelancerId] = (dealsByFreelancer[x.freelancerId] || 0) + 1; });
  // תצוגה מפורטת של כל עסקה בנפרד (לא רק ספירה) - מי דיווחה ראשונה (עצמאית או לקוחה), על איזה
  // עסק ולקוחה, ומה הסטטוס הנוכחי - כדי לענות בדיוק על "אילו עסקאות נסגרו ומי דיווחה עליהן".
  const allDealsDetailed = (d.deals || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((x) => {
    const f = d.freelancers.find((y) => y.id === x.freelancerId);
    return {
      ...x,
      freelancerName: f ? (f.businessName || f.name) : "עצמאית שנמחקה",
      reportedBy: x.initiatedBy === "customer" ? "לקוחה" : "עצמאית",
    };
  });

  const revealEvents = (d.couponRevealEvents || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const revealsByCategory = {};
  revealEvents.forEach((ev) => {
    const f = d.freelancers.find((x) => x.id === ev.freelancerId);
    const cat = f ? catName(d, f.categoryId) : "לא ידוע";
    revealsByCategory[cat] = (revealsByCategory[cat] || 0) + 1;
  });
  const unreadMessages = (d.contactMessages || []).filter((m) => !m.read).length;
  // Groups the flat supportMessages list (individual chat messages, see db.js) into one row per
  // conversation (by voterKey) - last message preview + how many of HER unread asker messages
  // are waiting, sorted most-recently-active first, so the newest/most urgent threads sit on top.
  // שיחה שסומנה "המשך טיפול" (isSnoozed עם מפתח support:<key>) נעלמת מכאן לגמרי - בדיוק כמו כל
  // פריט אחר שהועבר להמשך טיפול - ומופיעה רק בפאנל "#followup". שיחה "סגורה" (isSupportClosed)
  // כן נשארת ברשימה (מסומנת closed:true) כדי שההיסטוריה עדיין נגישה, אבל לא נספרת כ"ממתינה
  // למענה" (ר' openSupportMessages למטה).
  const supportThreads = (() => {
    const byKey = {};
    (d.supportMessages || []).forEach((m) => { (byKey[m.voterKey] = byKey[m.voterKey] || []).push(m); });
    return Object.keys(byKey)
      .filter((key) => !isSnoozed(d, `support:${key}`))
      .map((key) => {
        const msgs = byKey[key].slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        const last = msgs[msgs.length - 1];
        const unread = msgs.filter((m) => m.from === "asker" && !m.read).length;
        const closed = isSupportClosed(d, key);
        return { key, name: last.name, email: last.email, lastText: last.text, lastFrom: last.from, lastAt: last.createdAt, unread, closed };
      }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  })();
  const openSupportMessages = supportThreads.filter((t) => !t.closed && t.unread > 0).length;

  // תצוגת ניהול לכל ההתכתבויות הפרטיות בין לקוחות לעצמאיות (d.chatMessages) - קבוצה לפי
  // צמד (freelancerId, customerId), עם תצוגה מרוכזת בלבד (ר"מ, בלי אפשרות עריכה/מחיקה) -
  // כדי לאפשר פיקוח על תוכן שהיום לא נראה לאף אחד חוץ מהצדדים עצמם.
  const chatThreads = (() => {
    const byPair = {};
    (d.chatMessages || []).forEach((m) => {
      const key = `${m.freelancerId}::${m.customerId}`;
      (byPair[key] = byPair[key] || []).push(m);
    });
    return Object.keys(byPair).map((key) => {
      const msgs = byPair[key].slice().sort((a, b) => new Date(a.date) - new Date(b.date));
      const last = msgs[msgs.length - 1];
      const f = d.freelancers.find((x) => x.id === last.freelancerId);
      const c = d.customers.find((x) => x.id === last.customerId);
      return {
        freelancerId: last.freelancerId, customerId: last.customerId,
        freelancerName: f ? (f.businessName || f.name) : "עצמאית שנמחקה",
        customerName: c ? c.name : "לקוחה שנמחקה",
        count: msgs.length, lastText: last.text, lastFrom: last.fromRole, lastAt: last.date,
      };
    }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  })();

  // חשבונות לקוחות שננעלו אוטומטית בהרשמה כי סימנו "גבר" (ר' POST /signup) - לא מקבלים שום
  // מייל/גישה עד שאת בוחרת לפתוח אותם ידנית כאן.
  const lockedCustomers = d.customers.filter((c) => c.accountLocked);

  // מועדון YouCan (2026-09-02) - בקשות הצטרפות שממתינות לאישור ידני (שילמה ידנית, ר' GET
  // /youcan/join) וחברות פעילות כרגע.
  const youCanPending = d.customers.filter((c) => c.youCanRequestedAt && !c.youCanMember)
    .slice().sort((a, b) => new Date(a.youCanRequestedAt) - new Date(b.youCanRequestedAt));
  const youCanMembers = d.customers.filter((c) => c.youCanMember);

  // בקשות שדרוג לרמת "מומלצת" (2026-09-02) - ר' POST /freelancer-dashboard/request-tier-upgrade.
  const tierUpgradeRequests = d.freelancers.filter((f) => f.tierUpgradeRequestedAt && f.tier !== "premium")
    .slice().sort((a, b) => new Date(a.tierUpgradeRequestedAt) - new Date(b.tierUpgradeRequestedAt));

  // סטטוסים 24 שעות (2026-09-02) - מנקה קודם כל סטטוס שכבר פג באתר כולו, ורק אז בונה את
  // רשימת הפעילים לתצוגת הפיקוח בניהול.
  if (pruneFreelancerStatuses(d)) db.save();
  const allActiveStatuses = (d.freelancerStatuses || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Site-visit numbers for the "מספרים כלליים" panel - counted by trackSiteVisit() on every
  // real page load (see near the bottom of the file). Last-7-days breakdown built from
  // siteStats.dailyVisits so Sapir can see a trend, not just one flat lifetime total.
  const siteStats = d.siteStats || { totalVisits: 0, dailyVisits: {}, realVisits: 0, dailyRealVisits: {} };
  const siteStatsDailyReal = siteStats.dailyRealVisits || {};
  const siteStatsDailyRealEntries = siteStats.dailyRealUniqueEntries || {};
  const todayKey = israelDayKeyOffset(0);
  const todayVisits = siteStats.dailyVisits[todayKey] || 0;
  const todayRealVisits = siteStatsDailyReal[todayKey] || 0;
  const todayRealEntries = siteStatsDailyRealEntries[todayKey] || 0;
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const key = israelDayKeyOffset(i);
    last7Days.push({ key, count: siteStats.dailyVisits[key] || 0, realCount: siteStatsDailyReal[key] || 0, entryCount: siteStatsDailyRealEntries[key] || 0 });
  }
  // "מאיפה הן מגיעות" table - all-time real (non-bot) entries broken down by source, sorted by
  // volume so the busiest channels are on top. See detectSource()/sourceLabel() near
  // trackSiteVisit() at the bottom of this file for how a key is decided and translated.
  const sourceCounts = siteStats.sourceCounts || {};
  const totalAttributedEntries = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
  const sourceRows = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: sourceLabel(key), count, pct: totalAttributedEntries ? Math.round((count / totalAttributedEntries) * 100) : 0 }));
  // Per-registered-user breakdown ("מי נכנסה וכמה פעמים") - only covers customers/freelancers
  // who logged in at least once since this was added (see identityCookie()/trackSiteVisit()) -
  // older visits weren't attributed to anyone, so this starts from zero and grows from here.
  const userVisits = []
    .concat(d.customers.map((c) => ({ name: c.name || c.email, roleLabel: "לקוחה", count: c.siteVisitCount || 0 })))
    .concat(d.freelancers.map((f) => ({ name: f.businessName || f.name, roleLabel: "עצמאית", count: f.siteVisitCount || 0 })))
    .filter((u) => u.count > 0)
    .sort((a, b) => b.count - a.count);
  const USER_VISITS_SHOW_MAX = 100;
  const userVisitsShown = userVisits.slice(0, USER_VISITS_SHOW_MAX);

  // "מאגר הלקוחות" - טבלת כל הלקוחות הרשומות כולל כתובת המייל שלהן, לפי בקשה מפורשת
  // 2026-08-30 - ממוינת מהחדשה לוותיקה. הטבלה בעמוד עצמו מוגבלת (כמו userVisits למעלה) כדי
  // לא להכביד על טעינת העמוד עם כמות גדולה של לקוחות, אבל קובץ ה-CSV להורדה (GET
  // /admin/export/customers.csv, למטה) כולל את כולן בלי הגבלה.
  const allCustomersForDirectory = d.customers.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const CUSTOMERS_DIRECTORY_SHOW_MAX = 300;
  const customersDirectoryShown = allCustomersForDirectory.slice(0, CUSTOMERS_DIRECTORY_SHOW_MAX);

  // "שירות תמיכה ללקוחות" - סטטוס פתוח/כבוי (ר' isAdminOnline/POST /admin/support/toggle
  // למעלה) - פאנל קבוע שאפשר להפעיל/לכבות ממנו בכל רגע, ובנוסף פופאפ ששואל אותה במפורש בכל
  // כניסה לעמוד הזה כל עוד השירות עדיין כבוי (לא נשאל שוב ברגע שהיא הדליקה אותו), לפי בקשה
  // מפורשת 2026-08-30 - "רק כשהוא דלוק יופיע ללקוחות שאני מחוברת".
  const adminSupportOnlineNow = !!d.settings.adminSupportOnline;
  const supportTogglePanelHtml = `
  <div class="panel" id="admin-support-toggle-panel">
    <h3>שירות תמיכה ללקוחות 💬</h3>
    <p class="muted">כשהשירות פעיל, לקוחות ועצמאיות שנכנסות ל"לתמיכה לחצי" רואות שאת מחוברת עכשיו ומקבלות ממך תשובה מיידית בצ'אט. כשהוא כבוי, הן משאירות הודעה ומקבלות תשובה בהמשך - גם באתר וגם במייל.</p>
    <p id="scSupportToggleStatus" style="font-weight:800;${adminSupportOnlineNow ? "color:var(--rose-dark);" : ""}">${adminSupportOnlineNow ? "🟢 השירות פעיל עכשיו" : "⚪ השירות כבוי כרגע"}</p>
    <button type="button" id="scSupportToggleBtn" class="btn btn-small${adminSupportOnlineNow ? " btn-outline" : ""}" onclick="scToggleAdminSupport(${adminSupportOnlineNow ? "false" : "true"})">${adminSupportOnlineNow ? "כיבוי שירות התמיכה" : "הפעלת שירות התמיכה"}</button>
  </div>
  ${!adminSupportOnlineNow ? `
  <div class="sc-modal-overlay" id="scSupportPromptModal" onclick="if(event.target===this) this.remove();">
    <div class="sc-modal" style="max-width:420px;">
      <button type="button" class="sc-modal-close" onclick="this.closest('.sc-modal-overlay').remove()" aria-label="סגירה">✕</button>
      <h2 style="font-size:21px;">להפעיל את שירות התמיכה ללקוחות? 💬</h2>
      <p style="text-align:right;font-size:14.5px;">כשהשירות פעיל, לקוחות ועצמאיות שנכנסות ל"לתמיכה לחצי" רואות שאת מחוברת עכשיו ויכולות לקבל ממך תשובה מיידית. אפשר תמיד לכבות מאוחר יותר מהפאנל למטה.</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;">
        <button type="button" class="btn sc-modal-btn" onclick="scToggleAdminSupport(true); this.closest('.sc-modal-overlay').remove();">כן, הפעילי 🟢</button>
        <button type="button" class="btn btn-outline sc-modal-btn" onclick="this.closest('.sc-modal-overlay').remove()">לא כרגע</button>
      </div>
    </div>
  </div>` : ""}
  <script>
  function scToggleAdminSupport(on){
    fetch('/admin/support/toggle', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'on=' + (on ? '1' : '0') })
      .then(function(r){ return r.json(); })
      .then(function(data){
        var statusEl = document.getElementById('scSupportToggleStatus');
        var btnEl = document.getElementById('scSupportToggleBtn');
        if (statusEl) {
          statusEl.textContent = data.online ? '🟢 השירות פעיל עכשיו' : '⚪ השירות כבוי כרגע';
          statusEl.style.color = data.online ? 'var(--rose-dark)' : '';
        }
        if (btnEl) {
          btnEl.textContent = data.online ? 'כיבוי שירות התמיכה' : 'הפעלת שירות התמיכה';
          btnEl.setAttribute('onclick', 'scToggleAdminSupport(' + (data.online ? 'false' : 'true') + ')');
          btnEl.className = data.online ? 'btn btn-small btn-outline' : 'btn btn-small';
        }
      }).catch(function(){ alert('שגיאה - נסי שוב.'); });
  }
  </script>`;

  const body = `
  <h1 class="section-title">הבמה שלך 👑</h1>
  <p class="muted" style="text-align:center;margin-top:-14px;">💡 לוחצים על כותרת של כל אזור כדי לפתוח או לסגור אותו.</p>
  <div class="sc-admin-page">
  ${supportTogglePanelHtml}
  <div class="panel">
    <h3>מספרים כלליים</h3>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:14px;">
      <!-- כל הריבועים שדורשים ממנה פעולה/אישור קובצו יחד בתחילת השורה, ממוינים לפי סדר
           דחיפות מפורש (עצמאיות ← סיפורים ← משפטי השראה ← תמיכה ← המלצות תת-תחום ← המשך
           טיפול) - לפי בקשה מפורשת 2026-08-30, כדי שהכי דחוף תמיד יהיה הכי בולט/ראשון בלי
           לגלול או לחפש בין המספרים המידעיים (לקוחות רשומות, כניסות לאתר וכו') שמופיעים
           אחריהם. צבע מודגש (#FBEAEA, גוון אדמדם עדין) מבדיל אותם ויזואלית מהריבועים
           האינפורמטיביים הרגילים. -->
      <a href="#pending-approvals" style="flex:1;min-width:160px;background:#FBEAEA;border:1.5px solid #E0435B;border-radius:10px;padding:16px;text-align:center;text-decoration:none;color:inherit;display:block;" title="מעבר לרשימת הממתינות לאישור">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${pendingFreelancers.length}</div>
        <div class="muted" style="margin-top:4px;">👩‍💼 עצמאיות ממתינות לאישור ↓</div>
      </a>
      <a href="#pending-stories" style="flex:1;min-width:160px;background:#FBEAEA;border:1.5px solid #E0435B;border-radius:10px;padding:16px;text-align:center;text-decoration:none;color:inherit;display:block;" title="מעבר לסיפורים הממתינים לאישור">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${pendingStories.length}</div>
        <div class="muted" style="margin-top:4px;">📖 סיפורים ממתינים ↓</div>
      </a>
      <a href="#inspiration-quotes" style="flex:1;min-width:160px;background:#FBEAEA;border:1.5px solid #E0435B;border-radius:10px;padding:16px;text-align:center;text-decoration:none;color:inherit;display:block;" title="מעבר למשפטי השראה הממתינים לאישור">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${pendingInspirationQuotes.length}</div>
        <div class="muted" style="margin-top:4px;">💬 משפטי השראה ↓</div>
      </a>
      <a href="#support-threads" style="flex:1;min-width:160px;background:#FBEAEA;border:1.5px solid #E0435B;border-radius:10px;padding:16px;text-align:center;text-decoration:none;color:inherit;display:block;" title="מעבר לשיחות התמיכה הממתינות למענה">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${openSupportMessages}</div>
        <div class="muted" style="margin-top:4px;">💬 תמיכה ממתינה למענה ↓</div>
      </a>
      <a href="#subcategory-suggestions" style="flex:1;min-width:160px;background:#FBEAEA;border:1.5px solid #E0435B;border-radius:10px;padding:16px;text-align:center;text-decoration:none;color:inherit;display:block;" title="מעבר להמלצות לתת-תחום חדש">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${pendingSubcategorySuggestions.length}</div>
        <div class="muted" style="margin-top:4px;">🆕 המלצות תת-תחום ↓</div>
      </a>
      <a href="#followup" style="flex:1;min-width:160px;background:#FBEAEA;border:1.5px solid #E0435B;border-radius:10px;padding:16px;text-align:center;text-decoration:none;color:inherit;display:block;" title="מעבר לרשימת המשך הטיפול">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${snoozedItems.length}</div>
        <div class="muted" style="margin-top:4px;">🕒 בהמשך טיפול ↓</div>
      </a>
      <div style="flex:1;min-width:160px;background:var(--cream);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${d.customers.length}</div>
        <div class="muted" style="margin-top:4px;">לקוחות רשומות</div>
      </div>
      <div style="flex:1;min-width:160px;background:var(--cream);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${d.freelancers.length}</div>
        <div class="muted" style="margin-top:4px;">עצמאיות סה"כ</div>
      </div>
      <div style="flex:1;min-width:160px;background:var(--cream);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${activeFreelancers.length}</div>
        <div class="muted" style="margin-top:4px;">עצמאיות מאושרות ופעילות</div>
      </div>
      <div style="flex:1;min-width:160px;background:var(--cream);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${siteStats.totalVisits || 0}</div>
        <div class="muted" style="margin-top:4px;">כניסות לאתר (סה"כ, כולל בוטים)</div>
      </div>
      <div style="flex:1;min-width:160px;background:var(--cream);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${todayVisits}</div>
        <div class="muted" style="margin-top:4px;">כניסות היום (סה"כ, כולל בוטים)</div>
      </div>
      <div style="flex:1;min-width:160px;background:#EFEAE0;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${siteStats.realVisits || 0}</div>
        <div class="muted" style="margin-top:4px;">כניסות אמיתיות (סה"כ, משוערות)</div>
      </div>
      <div style="flex:1;min-width:160px;background:#EFEAE0;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${todayRealVisits}</div>
        <div class="muted" style="margin-top:4px;">כניסות אמיתיות היום (משוערות)</div>
      </div>
      <div style="flex:1;min-width:160px;background:#E7EDF5;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${siteStats.realUniqueEntries || 0}</div>
        <div class="muted" style="margin-top:4px;">כניסות טהורות לאתר (סה"כ, ביקורים אמיתיים בלבד)</div>
      </div>
      <div style="flex:1;min-width:160px;background:#E7EDF5;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${todayRealEntries}</div>
        <div class="muted" style="margin-top:4px;">כניסות טהורות היום</div>
      </div>
      <div style="flex:1;min-width:160px;background:var(--cream);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${confirmedDealsCount}</div>
        <div class="muted" style="margin-top:4px;">עסקאות שנסגרו (אושרו ע"י הלקוחה)</div>
      </div>
      ${pendingDealsCount ? `
      <div style="flex:1;min-width:160px;background:var(--cream);border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:34px;font-weight:800;color:var(--rose-dark);">${pendingDealsCount}</div>
        <div class="muted" style="margin-top:4px;">עסקאות שממתינות לאישור הלקוחה</div>
      </div>` : ""}
    </div>
    <p class="muted" style="margin-top:16px;margin-bottom:0;">🩶 = כל כניסה שנספרת (כולל בוטים וסורקים, וכולל כל טעינת עמוד בנפרד) &nbsp;|&nbsp; 🌸 = הערכת כניסות אמיתיות בלבד (אחרי סינון בוטים, עדיין כל טעינת עמוד) &nbsp;|&nbsp; 🔵 = "כניסות טהורות" - ביקור שלם נספר פעם אחת בלבד (עד 30 דקות ברצף נחשבות אותה כניסה), אחרי סינון בוטים - זה המספר הכי קרוב ל"כמה פעמים מישהי נכנסה לאתר", לעומת 🩶/🌸 שסופרים כל טעינת עמוד בנפרד.</p>
    <p class="muted" style="margin-top:6px;margin-bottom:6px;">כניסות ב-7 הימים האחרונים:</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${last7Days.map((day) => `<div style="flex:1;min-width:80px;background:var(--white);border:1px solid var(--rose);border-radius:8px;padding:8px 4px;text-align:center;">
        <div style="font-size:16px;font-weight:700;color:var(--rose-dark);">🩶 ${day.count}</div>
        <div style="font-size:14px;font-weight:700;color:#8A6B2E;margin-top:2px;">🌸 ${day.realCount}</div>
        <div style="font-size:14px;font-weight:700;color:#3E5C8A;margin-top:2px;">🔵 ${day.entryCount}</div>
        <div class="muted" style="font-size:11px;margin-top:4px;">${day.key.slice(5)}</div>
      </div>`).join("")}
    </div>
  </div>

  <div class="panel">
    <h3>מאיפה הן מגיעות 🧭</h3>
    <p class="muted">פירוט מקור לפי "כניסות טהורות" אמיתיות בלבד (🔵 מהפאנל למעלה) - כל שורה היא ביקור שלם אחד, לא טעינת עמוד. "ישירה / לא ידועה" כולל גם הקלדת הכתובת ישירות, וגם המון מקרים אמיתיים של ווטסאפ/מייל שהאפליקציה לא שולחת עליהם שום מידע לדפדפן - כדי לקבל מספרים מדויקים לערוצים האלה, השתמשי בקישורים המתויגים בפאנל הבא. מבוסס רק על ביקורים מרגע העדכון הזה (2026-08-25) והלאה - היסטוריה ישנה יותר לא סווגה.</p>
    ${sourceRows.length ? `
    <table style="width:100%;border-collapse:collapse;margin-top:10px;">
      <thead><tr style="text-align:right;"><th style="padding:6px 4px;border-bottom:1px solid var(--rose);">מקור</th><th style="padding:6px 4px;border-bottom:1px solid var(--rose);">כניסות</th><th style="padding:6px 4px;border-bottom:1px solid var(--rose);">אחוז</th></tr></thead>
      <tbody>
        ${sourceRows.map((r) => `<tr><td style="padding:6px 4px;border-bottom:1px solid #eee;">${esc(r.label)}</td><td style="padding:6px 4px;border-bottom:1px solid #eee;">${r.count}</td><td style="padding:6px 4px;border-bottom:1px solid #eee;">${r.pct}%</td></tr>`).join("")}
      </tbody>
    </table>
    <p class="muted" style="margin-top:8px;font-size:12px;">שימי לב: כל אחוז מעוגל בנפרד, אז לפעמים סכום העמודה יוצא 99% או 101% במקום 100% בדיוק - זה טבעי ולא טעות בספירה עצמה.</p>` : `<p class="muted" style="margin-top:10px;">עדיין אין נתוני מקור - יופיעו כאן ברגע שיהיו כניסות חדשות לאתר.</p>`}
  </div>

  <div class="panel">
    <h3>קישור לשיתוף עם מעקב מקור 🔗</h3>
    <p class="muted">בוחרים איפה משתפות את הקישור, ואופציונלית לאיזה עמוד באתר (ברירת מחדל - עמוד הבית), ולוחצות "יצירת קישור". הקישור שייווצר יעבוד בדיוק כמו קישור רגיל, אבל כשיילחצו עליו זה יירשם במדויק בטבלה למעלה - כך שאין תלות בזיהוי אוטומטי (שלא תמיד עובד לווטסאפ/מייל).</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;">
      <label style="flex:1;min-width:160px;">איפה משתפות?
        <select id="scShareSrc">
          <option value="whatsapp">ווטסאפ</option>
          <option value="mail">מייל</option>
          <option value="instagram">אינסטגרם</option>
          <option value="facebook">פייסבוק</option>
          <option value="chat">צ'אט / הודעה אחר</option>
          <option value="sms">SMS</option>
        </select>
      </label>
      <label style="flex:2;min-width:220px;">לאיזה עמוד (אופציונלי - ריק = עמוד הבית)
        <input type="text" id="scSharePath" placeholder="לדוגמה: /freelancer/12345 או /join" />
      </label>
      <button type="button" class="btn btn-small" onclick="scBuildShareLink()">יצירת קישור</button>
    </div>
    <div id="scShareLinkResult" style="margin-top:12px;display:none;">
      <input type="text" id="scShareLinkOutput" readonly style="width:100%;direction:ltr;text-align:left;" onclick="this.select();" />
      <button type="button" class="btn btn-small btn-outline" style="margin-top:6px;" onclick="scCopyShareLink()">העתקת קישור</button>
      <span id="scShareLinkCopied" class="muted" style="margin-inline-start:8px;display:none;">הועתק! ✓</span>
    </div>
    <script>
      function scBuildShareLink() {
        var src = document.getElementById('scShareSrc').value;
        var rawPath = document.getElementById('scSharePath').value.trim();
        var path = rawPath || '/';
        if (path.charAt(0) !== '/') path = '/' + path;
        var sep = path.indexOf('?') === -1 ? '?' : '&';
        var url = window.location.origin + path + sep + 'src=' + encodeURIComponent(src);
        document.getElementById('scShareLinkOutput').value = url;
        document.getElementById('scShareLinkResult').style.display = 'block';
        document.getElementById('scShareLinkCopied').style.display = 'none';
      }
      function scCopyShareLink() {
        var input = document.getElementById('scShareLinkOutput');
        input.select();
        try {
          navigator.clipboard.writeText(input.value).then(function () {
            document.getElementById('scShareLinkCopied').style.display = 'inline';
          });
        } catch (e) {
          document.execCommand('copy');
          document.getElementById('scShareLinkCopied').style.display = 'inline';
        }
      }
    </script>
  </div>

  ${adminTrendChartsHtml(d, trendRangeDays)}

  <div class="panel">
    <h3>גיבוי נתונים</h3>
    <p class="muted">מורידה קובץ אחד שמכיל את כל הנתונים באתר - כל העצמאיות, הלקוחות, הביקורות, הסיפורים וכל התמונות (כולל לוגואים) - בדיוק כפי שהם שמורים כרגע. שווה לשמור עותק כזה מדי פעם (בגוגל דרייב למשל) בנוסף לגיבוי האוטומטי שיש כבר ב-Render.</p>
    <p><a class="btn btn-small" href="/admin/backup/download">⬇️ הורדת גיבוי מלא</a></p>
  </div>

  <div class="panel">
    <h3>כניסות לפי משתמשת (${userVisits.length})</h3>
    <p class="muted">נספרות רק כניסות של לקוחות ועצמאיות שהתחברו לפחות פעם אחת מאז שהתכונה הזו נוספה - זה כולל גם כניסות בלי להיות מחוברת באותו רגע, כל עוד היא נכנסה מאותו דפדפן שבו התחברה בעבר. הרשימה לא כוללת מבקרות שמעולם לא נרשמו/התחברו.</p>
    ${userVisitsShown.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>סוג</th><th>כניסות</th></tr>
      ${userVisitsShown.map((u) => `<tr><td>${esc(u.name)}</td><td>${u.roleLabel}</td><td>${u.count}</td></tr>`).join("")}
    </table></div>
    ${userVisits.length > USER_VISITS_SHOW_MAX ? `<p class="muted" style="margin-top:8px;">מוצגות ${USER_VISITS_SHOW_MAX} המובילות מתוך ${userVisits.length} - השאר נשמרות בנתונים אבל לא מוצגות כאן.</p>` : ""}` : `<p class="muted">עדיין אין נתוני כניסות למשתמשות רשומות - זה ייאסף מכאן והלאה, בכל פעם שלקוחה או עצמאית מתחברות.</p>`}
  </div>

  <div class="panel">
    <h3>מאגר הלקוחות (${d.customers.length}) 📇</h3>
    <p class="muted">כל הלקוחות שנרשמו באתר, כולל כתובת המייל שלהן - ממוין מהחדשה לוותיקה.${d.customers.length > CUSTOMERS_DIRECTORY_SHOW_MAX ? ` מוצגות כאן ${CUSTOMERS_DIRECTORY_SHOW_MAX} האחרונות - להורדת הרשימה המלאה יש את קובץ ה-CSV למטה.` : ""}</p>
    <p><a class="btn btn-small" href="/admin/export/customers.csv">⬇️ הורדת כל הלקוחות כקובץ אקסל (CSV)</a></p>
    ${customersDirectoryShown.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>אימייל</th><th>עיר</th><th>מייל מאומת</th><th>תאריך הצטרפות</th></tr>
      ${customersDirectoryShown.map((c) => `<tr>
        <td>${esc(c.name || "-")}</td>
        <td>${esc(c.email || "-")}</td>
        <td>${esc(cityName(d, c.cityId))}</td>
        <td>${c.emailVerified ? "כן ✓" : "לא"}</td>
        <td>${c.createdAt ? esc(new Date(c.createdAt).toLocaleDateString("he-IL")) : "-"}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין אין לקוחות רשומות.</p>`}
  </div>

  <div class="panel">
    <h3>שליחת הודעה לעצמאית</h3>
    <p class="muted">ההודעה תופיע גם באזור האישי שלה באתר וגם תישלח למייל שלה - כדי שבטוח תגיע אליה.</p>
    <form method="post" action="/admin/message-freelancer" style="max-width:480px;">
      <label>עצמאית
      <select name="freelancerId" required>
        <option value="">בחירת עצמאית...</option>
        ${d.freelancers.slice().sort((a, b) => (a.businessName || a.name || "").localeCompare(b.businessName || b.name || "", "he")).map((f) => `<option value="${f.id}">${esc(f.businessName || f.name)}${f.status !== "approved" ? " (ממתינה לאישור)" : ""}</option>`).join("")}
      </select></label>
      <label>ההודעה
      <textarea name="text" maxlength="1000" required></textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שליחת הודעה</button>
    </form>
    ${(d.adminMessages || []).length ? `<div class="table-scroll" style="margin-top:16px;"><table class="table-simple"><tr><th>לעצמאית</th><th>לגבי</th><th>הודעה</th><th>תאריך</th></tr>
      ${d.adminMessages.slice().reverse().slice(0, 20).map((m) => {
        const mf = d.freelancers.find((x) => x.id === m.freelancerId);
        return `<tr><td>${esc(mf ? (mf.businessName || mf.name) : "-")}</td><td>${esc(m.context || "-")}</td><td>${esc(m.text)}</td><td>${esc(new Date(m.date).toLocaleDateString("he-IL"))}</td></tr>`;
      }).join("")}
    </table></div>` : ""}
  </div>

  <div class="panel">
    <h3>כתובת המייל שלך להתחברות</h3>
    <p class="muted">זו הכתובת שאיתה את מתחברת לפאנל הניהול (כרגע: ${esc(admin.email)}). היא לא מוצגת ללקוחות - לשינוי המייל שהלקוחות רואות ליצירת קשר, זה בפאנל "קבוצת הווטסאפ והמייל ליצירת קשר" למטה.</p>
    <form method="post" action="/admin/change-email">
      <label>סיסמה נוכחית (לאימות)<input type="password" name="currentPassword" required /></label>
      <label>כתובת מייל חדשה להתחברות<input type="email" name="newEmail" required /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון כתובת מייל</button>
    </form>
  </div>

  <div class="panel">
    <h3>סיסמת ניהול</h3>
    <p class="muted">אם עדיין לא שינית את סיסמת ברירת המחדל שהאתר נוצר איתה - זה הזמן. תמלאי את הסיסמה הנוכחית ואת החדשה.</p>
    <form method="post" action="/admin/change-password">
      <label>סיסמה נוכחית<input type="password" name="currentPassword" required /></label>
      <label>סיסמה חדשה (לפחות 6 תווים)<input type="password" name="newPassword" minlength="6" required /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון סיסמה</button>
    </form>
  </div>

  <div class="panel" id="followup" style="scroll-margin-top:90px;background:var(--cream);" data-badge="${snoozedItems.length}">
    <h3>🕒 המשך טיפול (${snoozedItems.length})</h3>
    <p class="muted">כל מה שהעברת הצידה מתורי האישור למטה - נשאר כאן עד שתחזירי אותו בעצמך, כדי שהתורים למטה יישארו נקיים.</p>
    ${snoozedItems.length ? snoozedItems.map((s) => `
      <div class="panel" style="background:var(--white);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:700;">${esc(s.itemLabel || s.key)}</div>
          <div class="muted" style="font-size:12px;">הועבר להמשך טיפול ב-${esc(new Date(s.snoozedAt).toLocaleDateString("he-IL"))}</div>
        </div>
        <form method="post" action="/admin/unsnooze"><input type="hidden" name="key" value="${esc(s.key)}" /><button class="btn btn-small" type="submit">↩️ החזרה לתור האישורים</button></form>
      </div>`).join("") : `<p class="muted">אין כרגע כלום בהמשך טיפול - השולחן נקי.</p>`}
  </div>

  <div class="panel" id="subcategory-suggestions" style="scroll-margin-top:90px;" data-badge="${pendingSubcategorySuggestions.length}">
    <h3>🆕 המלצות לתת-תחום חדש (${pendingSubcategorySuggestions.length})</h3>
    <p class="muted">עצמאיות שלא מצאו תת-תחום מתאים ברשימה יכולות רק להמליץ - זה לא נוסף אוטומטית, ורק אישור כאן יוצר אותו בפועל ומוסיף אותו לכל התפריטים באתר.</p>
    ${pendingSubcategorySuggestions.length ? pendingSubcategorySuggestions.map((s) => `
      <div class="panel" style="background:var(--cream);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:700;">"${esc(s.name)}" <span class="muted" style="font-weight:600;">(בתחום ${esc(catName(d, s.categoryId))})</span></div>
          <div class="muted" style="font-size:12px;">המלצה מאת: ${esc(s.freelancerLabel || "-")} · ${esc(new Date(s.createdAt).toLocaleDateString("he-IL"))}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <form method="post" action="/admin/subcategory-suggestion/${s.id}/approve"><button class="btn btn-small" type="submit">✓ אישור והוספה</button></form>
          <form method="post" action="/admin/subcategory-suggestion/${s.id}/reject"><button class="btn btn-small btn-outline" type="submit">✕ דחייה</button></form>
          ${snoozeButtonHtml(`subcategorySuggestion:${s.id}`, "subcategorySuggestion", `המלצה לתת-תחום: "${s.name}"`)}
          ${messageFreelancerButtonHtml(s.freelancerId, `ההמלצה שלך לתת-תחום חדש "${s.name}"`, `subcatSugg-${s.id}`)}
        </div>
      </div>`).join("") : `<p class="muted">אין כרגע המלצות ממתינות.</p>`}
  </div>

  <div class="panel" id="inspiration-quotes" style="scroll-margin-top:90px;" data-badge="${pendingInspirationQuotes.length}">
    <h3>💬 משפטי השראה ממתינים לאישור (${pendingInspirationQuotes.length})</h3>
    <p class="muted">משפט השראה שכתבה עצמאית (בהרשמה או באזור האישי) מחכה כאן לאישור לפני שהוא יכול להופיע כטיפ השבועי בדף הבית - כדי לשמור שרק משפטי השראה אמיתיים מתפרסמים ולא פרסומות.</p>
    ${pendingInspirationQuotes.length ? pendingInspirationQuotes.map((f) => `
      <div class="panel" style="background:var(--cream);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:700;">${esc(f.businessName || f.name || "")}</div>
          <div class="muted" style="font-size:14px;margin-top:4px;">"${esc(f.inspirationQuotePending)}"</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <form method="post" action="/admin/inspiration-quote/${f.id}/approve"><button class="btn btn-small" type="submit">✓ אישור</button></form>
          <form method="post" action="/admin/inspiration-quote/${f.id}/reject"><button class="btn btn-small btn-outline" type="submit">✕ דחייה</button></form>
          ${snoozeButtonHtml(`inspirationQuote:${f.id}`, "inspirationQuote", `משפט השראה של ${f.businessName || f.name || ""}`)}
          ${messageFreelancerButtonHtml(f.id, "משפט ההשראה ששלחת לאישור", `inspQuote-${f.id}`)}
        </div>
      </div>`).join("") : `<p class="muted">אין כרגע משפטים ממתינים.</p>`}
  </div>

  <div class="panel" id="pending-approvals" style="scroll-margin-top:90px;" data-badge="${pendingFreelancers.length}">
    <h3>מחכות לאישור שלך (${pendingFreelancers.length})</h3>
    ${pendingFreelancers.length ? pendingFreelancers.map((f) => `
      <div class="panel" style="background:var(--cream);">
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
          ${f.logoDataUri ? `<img src="${f.logoDataUri}" alt="" style="width:90px;height:90px;object-fit:cover;border-radius:10px;flex-shrink:0;" />` : ""}
          <div style="flex:1;min-width:220px;">
            <h4 style="margin:0 0 6px;">${esc(f.businessName)} <span class="muted" style="font-weight:600;">(${esc(f.name)})</span></h4>
            <p class="muted" style="margin:2px 0;">${esc(catName(d, f.categoryId))}${subcatNames(d, f.categoryId, f.subcategoryIds) ? ` · ${esc(subcatNames(d, f.categoryId, f.subcategoryIds))}` : ""} · ${esc(cityName(d, f.cityId))}</p>
            <p class="muted" style="margin:2px 0;">✉️ ${esc(f.email)} ${f.phone ? `· ☎ ${esc(f.phone)}` : ""} ${f.hasWhatsapp ? "· 💬 יש וואטסאפ" : ""}</p>
            <p class="muted" style="margin:2px 0;">רמה: ${f.tier === "premium" ? "מומלצת" : "בסיסית"} ${f.offersOnline ? "· 💻 אונליין" : ""} ${f.offersHomeVisit ? "· 🚗 מגיעה עד הבית" : ""}</p>
            ${f.instagram ? `<p class="muted" style="margin:2px 0;">📸 ${esc(f.instagram)}</p>` : ""}
            ${f.portfolioUrl ? `<p class="muted" style="margin:2px 0;">🔗 <a href="${esc(f.portfolioUrl)}" target="_blank" rel="noopener">תיק עבודות</a></p>` : ""}
          </div>
        </div>
        ${f.description ? `<p style="margin-top:10px;"><strong>על העסק:</strong> ${esc(f.description)}</p>` : ""}
        ${f.dealText ? `<p style="margin-top:6px;"><strong>ההטבה:</strong> ${esc(f.dealText)}</p>` : ""}
        ${(f.galleryPhotos && f.galleryPhotos.length) ? `<div class="gallery-scroll" style="margin-top:10px;">${f.galleryPhotos.map((src) => `<img src="${src}" alt="" class="gallery-thumb" style="object-fit:cover;" />`).join("")}</div>` : ""}
        ${customSubcategoryNoteHtml(f, d)}
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
          <form method="post" action="/admin/freelancer/${f.id}/approve"><button class="btn btn-small" type="submit">אישור</button></form>
          <form method="post" action="/admin/freelancer/${f.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
          ${snoozeButtonHtml(`freelancer:${f.id}`, "freelancer", `עצמאית: ${f.businessName || f.name}`)}
          ${messageFreelancerButtonHtml(f.id, "ההצטרפות שלך ל-SheCan שממתינה לאישור", `newFreelancer-${f.id}`)}
        </div>
      </div>`).join("") : `<p class="muted">אין כרגע אף אחת שמחכה - הכל מעודכן.</p>`}
  </div>

  <div class="panel" data-badge="${pendingReviews.length}">
    <h3>ביקורות שמחכות לעין שלך (${pendingReviews.length})</h3>
    ${pendingReviews.length ? pendingReviews.map((r) => `
      <div class="review">
        ${starRow(r.rating)} <strong>${esc(r.authorName)}</strong> <span class="muted">(${r.type === "site" ? "המלצה על SheCan" : "ביקורת על עצמאית: " + esc((d.freelancers.find(f=>f.id===r.targetId)||{}).businessName || "")})</span>
        <p class="muted" style="margin:8px 0;">${esc(r.text)}</p>
        <form style="display:inline" method="post" action="/admin/review/${r.id}/approve"><button class="btn btn-small" type="submit">אישור</button></form>
        <form style="display:inline" method="post" action="/admin/review/${r.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
        ${snoozeButtonHtml(`review:${r.id}`, "review", `ביקורת מאת: ${r.authorName}`)}
      </div>
    `).join("") : `<p class="muted">שקט וניקיון - אין ביקורות ממתינות כרגע.</p>`}
  </div>

  <div class="panel">
    <h3>חוות דעת על עצמאיות (${publishedFreelancerReviews.length})</h3>
    <p class="muted">אלה עולות אוטומטית לכרטיסייה ברגע שלקוחה כותבת אותן - אין צורך לאשר, רק למחוק אם משהו לא ראוי.</p>
    ${publishedFreelancerReviews.length ? publishedFreelancerReviews.map((r) => `
      <div class="review">
        ${starRow(r.rating)} <strong>${esc(r.authorName)}</strong>${r.isAnonymous ? ` <span class="muted">(מבקשת להישאר אנונימית בפומבי)</span>` : ""} <span class="muted">על: ${esc(reviewTargetLabel(d, r))}</span>
        <p class="muted" style="margin:8px 0;">${esc(r.text)}</p>
        <form method="post" action="/admin/review/${r.id}/delete" style="display:inline"><button class="btn btn-small btn-outline" type="submit">מחיקת ההמלצה</button></form>
      </div>
    `).join("") : `<p class="muted">עוד אין חוות דעת שפורסמו.</p>`}
  </div>

  <div class="panel">
    <h3>מה אומרות עלינו - ביקורות שפורסמו (${publishedSiteReviews.length})</h3>
    <p class="muted">ביקורות אלה מופיעות בעמוד "מה אומרות עלינו" ובדף הבית - ניתן למחוק כל ביקורת לא ראויה.</p>
    ${publishedSiteReviews.length ? publishedSiteReviews.map((r) => `
      <div class="review">
        ${starRow(r.rating)} <strong>${esc(r.authorName)}</strong>
        <p class="muted" style="margin:8px 0;">${esc(r.text)}</p>
        <form method="post" action="/admin/review/${r.id}/delete" style="display:inline" onsubmit="return confirm('למחוק את הביקורת הזו?');"><button class="btn btn-small btn-outline" type="submit">מחיקת הביקורת</button></form>
      </div>
    `).join("") : `<p class="muted">עוד אין ביקורות שפורסמו.</p>`}
  </div>

  <div class="panel">
    <h3>תגובות על מאגרי קהילה - חוגים/מורות פרטיות/המלצות מוצרים (${publishedCommunityReviews.length})</h3>
    <p class="muted">אלה עולות אוטומטית ברגע שלקוחה כותבת אותן - אין צורך לאשר, רק למחוק אם משהו לא ראוי.</p>
    ${publishedCommunityReviews.length ? publishedCommunityReviews.map((r) => {
      const target = (d.communityListings || []).find((c) => c.id === r.targetId);
      const targetMeta = target ? COMMUNITY_TYPES[target.type] : null;
      const targetLabel = target ? `${esc(target.title)} (${esc(targetMeta ? targetMeta.label : target.type)})` : "פריט שנמחק";
      return `
      <div class="review">
        ${starRow(r.rating)} <strong>${esc(r.authorName)}</strong> <span class="muted">על: ${targetLabel}</span>
        <p class="muted" style="margin:8px 0;">${esc(r.text)}</p>
        <form method="post" action="/admin/review/${r.id}/delete" style="display:inline" onsubmit="return confirm('למחוק את התגובה הזו?');"><button class="btn btn-small btn-outline" type="submit">מחיקת התגובה</button></form>
      </div>
      `;
    }).join("") : `<p class="muted">עוד אין תגובות שפורסמו.</p>`}
  </div>

  <div class="panel" id="pending-stories" style="scroll-margin-top:90px;" data-badge="${pendingStories.length}">
    <h3>סיפורים ממתינים לאישור (${pendingStories.length})</h3>
    ${pendingStories.length ? pendingStories.map((s) => {
      const sf = d.freelancers.find((x) => x.id === s.freelancerId);
      return `
      <div class="panel" style="background:var(--cream);">
        <div style="display:flex;gap:14px;align-items:flex-start;">
          ${s.photoDataUri ? `<img src="${s.photoDataUri}" alt="" style="width:70px;height:70px;object-fit:cover;border-radius:10px;flex-shrink:0;" />` : ""}
          <h4 style="margin:0 0 6px;">${esc(sf ? (sf.businessName || sf.name) : "לא ידוע")}</h4>
        </div>
        ${(s.answers || []).map((qa) => `<p class="muted" style="margin:6px 0 0;font-weight:700;">${esc(qa.question)}</p><p style="margin:2px 0 0;">${esc(qa.answer)}</p>`).join("")}
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
          <form method="post" action="/admin/story/${s.id}/approve"><button class="btn btn-small" type="submit">אישור ופרסום</button></form>
          <form method="post" action="/admin/story/${s.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
          ${snoozeButtonHtml(`story:${s.id}`, "story", `סיפור: ${sf ? (sf.businessName || sf.name) : "לא ידוע"}`)}
          ${sf ? messageFreelancerButtonHtml(sf.id, "סיפור ההשראה ששלחת לאישור", `story-${s.id}`) : ""}
        </div>
      </div>`;
    }).join("") : `<p class="muted">אין כרגע סיפורים שממתינים לאישור.</p>`}
  </div>

  <div class="panel" data-badge="${pendingArenaQuestions.length}">
    <h3>🥊 הזירה - שאלות ממתינות לאישור (${pendingArenaQuestions.length})</h3>
    ${pendingArenaQuestions.length ? pendingArenaQuestions.map((q) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">${esc(catName(d, q.categoryId))}${q.subcategoryId ? ` (${esc(subcatName(d, q.categoryId, q.subcategoryId))})` : ""} · מאת ${esc(q.customerName)}</p>
        <p style="margin:0;font-weight:700;">${esc(q.questionText)}</p>
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
          <form method="post" action="/admin/arena-question/${q.id}/approve"><button class="btn btn-small" type="submit">אישור ושליחה למומחיות</button></form>
          <form method="post" action="/admin/arena-question/${q.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
          ${snoozeButtonHtml(`arenaQuestion:${q.id}`, "arenaQuestion", `שאלת זירה: ${clip(q.questionText, 60)}`)}
        </div>
      </div>
    `).join("") : `<p class="muted">אין כרגע שאלות שממתינות לאישור.</p>`}
  </div>

  <div class="panel" data-badge="${pendingConsultations.length}">
    <h3>🥊 הזירה - התייעצויות ממתינות לאישור (${pendingConsultations.length})</h3>
    ${pendingConsultations.length ? pendingConsultations.map((c) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">מאת ${esc(c.customerName)}</p>
        <p style="margin:0;font-weight:700;">${esc(c.text)}</p>
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
          <form method="post" action="/admin/consultation/${c.id}/approve"><button class="btn btn-small" type="submit">אישור ופרסום</button></form>
          <form method="post" action="/admin/consultation/${c.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
          ${snoozeButtonHtml(`consultation:${c.id}`, "consultation", `התייעצות: ${clip(c.text, 60)}`)}
        </div>
      </div>
    `).join("") : `<p class="muted">אין כרגע התייעצויות שממתינות לאישור.</p>`}
  </div>

  <div class="panel" data-badge="${pendingConsultationReplies.length}">
    <h3>🥊 הזירה - תגובות להתייעצויות שממתינות לאישור (${pendingConsultationReplies.length})</h3>
    <p class="muted">כל תגובה בפינת ההתייעצויות (מלקוחה או מעצמאית) עוברת אישור ידני לפני שהיא מתפרסמת - זה הערוץ הכי "פתוח" באתר, אז הוא היחיד שמקבל פיקוח מראש.</p>
    ${pendingConsultationReplies.length ? pendingConsultationReplies.map(({ consultation: c, reply: r }) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">בתגובה להתייעצות: "${esc(clip(c.text, 80))}"</p>
        <p style="margin:0;font-weight:700;">${esc(r.authorName)} <span class="muted" style="font-size:12px;font-weight:400;">(${r.authorRole === "freelancer" ? "עצמאית" : "לקוחה"})</span>: ${esc(r.text)}</p>
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
          <form method="post" action="/admin/consultation/${c.id}/reply/${r.id}/approve"><button class="btn btn-small" type="submit">אישור ופרסום</button></form>
          <form method="post" action="/admin/consultation/${c.id}/reply/${r.id}/delete"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
        </div>
      </div>
    `).join("") : `<p class="muted">אין כרגע תגובות שממתינות לאישור.</p>`}
  </div>

  <div class="panel">
    <h3>🥊 הזירה - שאלות ותשובות שפורסמו (${liveArenaQuestions.length})</h3>
    <p class="muted">אפשר למחוק כל שאלה או תשובה בודדת בכל שלב, גם אחרי שהיא כבר פורסמה.</p>
    ${liveArenaQuestions.length ? liveArenaQuestions.map((q) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">${esc(catName(d, q.categoryId))}${q.subcategoryId ? ` (${esc(subcatName(d, q.categoryId, q.subcategoryId))})` : ""} · מאת ${esc(q.customerName)}</p>
        <p style="margin:0;font-weight:700;">${esc(q.questionText)}</p>
        ${(q.answers || []).length ? (q.answers || []).map((a) => `
        <div style="background:var(--white);border-radius:8px;padding:8px 12px;margin-top:8px;">
          <p style="margin:0;"><strong>${esc(a.freelancerName)}:</strong> ${esc(a.text)}</p>
          <form method="post" action="/admin/arena-question/${q.id}/answer/${a.id}/delete" style="margin-top:6px;"><button type="submit" class="btn btn-small btn-outline">מחיקת התשובה הזו</button></form>
        </div>
        `).join("") : `<p class="muted" style="margin-top:6px;">עוד אין תשובות.</p>`}
        <form method="post" action="/admin/arena-question/${q.id}/delete" style="margin-top:10px;"><button class="btn btn-small btn-outline" type="submit">מחיקת השאלה כולה</button></form>
      </div>
    `).join("") : `<p class="muted">אין כרגע שאלות שפורסמו.</p>`}
  </div>

  <div class="panel">
    <h3>🥊 הזירה - התייעצויות שפורסמו (${liveConsultations.length})</h3>
    <p class="muted">אפשר למחוק כל התייעצות או תגובה בודדת בכל שלב, גם אחרי שהיא כבר פורסמה.</p>
    ${liveConsultations.length ? liveConsultations.map((c) => {
      // רק תגובות מאושרות מוצגות כאן ("שפורסמו") - תגובות שממתינות לאישור מנוהלות בפאנל הייעודי
      // "תגובות להתייעצויות שממתינות לאישור" למעלה, כדי לא לכפול תצוגה מבלבלת של אותה תגובה
      // בשני מקומות עם כפתורים שונים.
      const approvedReplies = (c.replies || []).filter((r) => r.status === "approved");
      return `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">מאת ${esc(c.customerName)}</p>
        <p style="margin:0;font-weight:700;">${esc(c.text)}</p>
        ${approvedReplies.length ? approvedReplies.map((r) => `
        <div style="background:var(--white);border-radius:8px;padding:8px 12px;margin-top:8px;">
          <p style="margin:0;"><strong>${esc(r.authorName)}</strong> <span class="muted" style="font-size:12px;">(${r.authorRole === "freelancer" ? "עצמאית" : "לקוחה"})</span>: ${esc(r.text)}</p>
          <form method="post" action="/admin/consultation/${c.id}/reply/${r.id}/delete" style="margin-top:6px;"><button type="submit" class="btn btn-small btn-outline">מחיקת התגובה הזו</button></form>
        </div>
        `).join("") : `<p class="muted" style="margin-top:6px;">עוד אין תגובות מאושרות.</p>`}
        <form method="post" action="/admin/consultation/${c.id}/delete" style="margin-top:10px;"><button class="btn btn-small btn-outline" type="submit">מחיקת ההתייעצות כולה</button></form>
      </div>
    `;
    }).join("") : `<p class="muted">אין כרגע התייעצויות שפורסמו.</p>`}
  </div>

  <div class="panel">
    <h3>📋 יצירת סקר מהמערכת</h3>
    <p class="muted">סקר שאת יוצרת ומפרסמת בעצמך בזירה (בנפרד מהסקרים ב"מה דעתך?" שנוצרים על ידי עצמאיות) - את בוחרת למי הוא מיועד, ורק הקהל הזה יראה אותו ויוכל להצביע.</p>
    <form method="post" action="/admin/survey">
      <label>שאלת הסקר<input type="text" name="question" maxlength="200" required placeholder="לדוגמה: אילו נושאים תרצו שנעלה בקבוצת התמיכה הבאה?" /></label>
      <label>תשובה 1<input type="text" name="option0" maxlength="80" required /></label>
      <label>תשובה 2<input type="text" name="option1" maxlength="80" required /></label>
      <label>תשובה 3 (לא חובה)<input type="text" name="option2" maxlength="80" /></label>
      <label>תשובה 4 (לא חובה)<input type="text" name="option3" maxlength="80" /></label>
      <label>למי הסקר מיועד?
        <select name="audience">
          <option value="both">גם לעצמאיות וגם ללקוחות</option>
          <option value="freelancers">לעצמאיות בלבד</option>
          <option value="customers">ללקוחות בלבד</option>
        </select>
      </label>
      <button type="submit" class="btn" style="margin-top:10px;">פרסום הסקר בזירה</button>
    </form>
  </div>

  <div class="panel">
    <h3>🥊 הזירה - סקרים פעילים (${allPolls.length})</h3>
    <p class="muted">הסקרים עולים לאוויר מיד עם הפרסום - אין צורך לאשר, רק למחוק אם משהו לא ראוי.</p>
    ${allPolls.length ? allPolls.map((p) => {
      const audienceLabel = p.audience === "freelancers" ? "עצמאיות בלבד" : p.audience === "customers" ? "לקוחות בלבד" : "עצמאיות ולקוחות";
      const byLine = p.source === "admin"
        ? `📋 סקר מהמערכת (${esc(audienceLabel)}) · ${new Date(p.createdAt).toLocaleDateString("he-IL")}`
        : `מאת ${esc(p.freelancerName)} · ${new Date(p.createdAt).toLocaleDateString("he-IL")}`;
      return `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">${byLine}</p>
        <p style="margin:0;font-weight:700;">${esc(p.question)}</p>
        <p class="muted" style="margin:6px 0 0;">${(p.options || []).map((o) => `${esc(o.text)}: ${o.votes || 0}`).join(" · ")}</p>
        <form method="post" action="/admin/poll/${p.id}/delete" style="margin-top:10px;"><button class="btn btn-small btn-outline" type="submit">מחיקת הסקר</button></form>
      </div>
    `; }).join("") : `<p class="muted">אין כרגע סקרים.</p>`}
  </div>

  <div class="panel" data-badge="${pendingListings.length}">
    <h3>תחומים נוספים שממתינים לאישור (${pendingListings.length})</h3>
    ${pendingListings.length ? pendingListings.map(({ f, l }) => `
      <div class="panel" style="background:var(--cream);">
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
          ${l.logoDataUri ? `<img src="${l.logoDataUri}" alt="" style="width:90px;height:90px;object-fit:cover;border-radius:10px;flex-shrink:0;" />` : ""}
          <div style="flex:1;min-width:220px;">
            <h4 style="margin:0 0 6px;">${esc(l.businessName)} <span class="muted" style="font-weight:600;">(תחום נוסף של ${esc(f.businessName || f.name)})</span></h4>
            <p class="muted" style="margin:2px 0;">${esc(catName(d, l.categoryId))}${l.subcategoryId ? ` · ${esc(subcatName(d, l.categoryId, l.subcategoryId))}` : ""} · ${esc(cityName(d, f.cityId))}</p>
            <p class="muted" style="margin:2px 0;">רמה: ${l.tier === "premium" ? "מומלצת" : "בסיסית"} ${l.offersOnline ? "· 💻 אונליין" : ""} ${l.offersHomeVisit ? "· 🚗 מגיעה עד הבית" : ""}</p>
            ${l.portfolioUrl ? `<p class="muted" style="margin:2px 0;">🔗 <a href="${esc(l.portfolioUrl)}" target="_blank" rel="noopener">תיק עבודות</a></p>` : ""}
          </div>
        </div>
        ${l.description ? `<p style="margin-top:10px;"><strong>על התחום הזה:</strong> ${esc(l.description)}</p>` : ""}
        ${l.dealText ? `<p style="margin-top:6px;"><strong>ההטבה:</strong> ${esc(l.dealText)}</p>` : ""}
        ${(l.galleryPhotos && l.galleryPhotos.length) ? `<div class="gallery-scroll" style="margin-top:10px;">${l.galleryPhotos.map((src) => `<img src="${src}" alt="" class="gallery-thumb" style="object-fit:cover;" />`).join("")}</div>` : ""}
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
          <form method="post" action="/admin/listing/${f.id}/${l.id}/approve"><button class="btn btn-small" type="submit">אישור</button></form>
          <form method="post" action="/admin/listing/${f.id}/${l.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
          ${snoozeButtonHtml(`listing:${f.id}:${l.id}`, "listing", `תחום נוסף: ${l.businessName} (${f.businessName || f.name})`)}
          ${messageFreelancerButtonHtml(f.id, `התחום הנוסף "${l.businessName}" ששלחת לאישור`, `listing-${f.id}-${l.id}`)}
        </div>
      </div>`).join("") : `<p class="muted">אין כרגע תחומים נוספים שממתינים לאישור.</p>`}
  </div>

  <div class="panel">
    <h3>🤲 מאגרי קהילה - ניהול</h3>
    <p class="muted">שמונה מאגרים נפרדים: גמ"חים, השכרות, סדנאות, חוגים, מסירות, מכירת יד 2, מורות פרטיות והמלצות מוצרים. לכל מאגר יש כאן ניהול נפרד משלו - אישור/דחייה, טבלת פריטים מאושרים עם מחיקה, הוספה ישירה שלך שמתפרסמת מיד, ושליטה על המחיר של התחום.</p>
  </div>
  ${communityAdminPanelsHtml}

  <div class="panel">
    <h3>לוגו האתר</h3>
    <p class="muted">${d.settings.siteLogoDataUri ? "יש לך כרגע לוגו מותאם אישית שמופיע בראש כל עמוד." : "כרגע מופיע בראש העמוד הוורדמארק הטקסטואלי 'SheCan'. אפשר להעלות תמונה משלך במקומו."}</p>
    ${d.settings.siteLogoDataUri ? `<div style="margin:10px 0;"><img src="${d.settings.siteLogoDataUri}" alt="לוגו נוכחי" style="height:60px;" /></div>` : ""}
    <form method="post" action="/admin/logo" enctype="multipart/form-data">
      <label>העלאת לוגו חדש (תמונה)<input type="file" name="logo" accept="image/*" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">העלאה</button>
    </form>
    ${d.settings.siteLogoDataUri ? `<form method="post" action="/admin/logo/remove" style="margin-top:8px;"><button class="btn btn-small btn-outline" type="submit">הסרת הלוגו וחזרה לוורדמארק הטקסט</button></form>` : ""}
    ${d.settings.siteLogoDataUri ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eee;">
      <p class="muted">אפשר גם להציג לוגו קטן ליד התגית "הטבת SheCan" שמופיעה על כל כרטיסייה.</p>
      <form method="post" action="/admin/toggle-deal-badge-logo">
        <button class="btn btn-small" type="submit">${d.settings.showLogoOnDealBadge ? "הסרת הלוגו מתגית ההטבה" : "הצגת הלוגו ליד תגית ההטבה"}</button>
      </form>
    </div>` : ""}
  </div>

  <div class="panel">
    <h3>לוגו ברירת מחדל לעסקים</h3>
    <p class="muted">התמונה הזו מוצגת אוטומטית (במקום ראשי תיבות) לכל עסק שעדיין לא העלה תמונת פרופיל או לוגו משלו - בכרטיסיות המודעה/עסק מוביל בצד העמוד, בכרטיסיית העסק בגריד, ובעמוד הפרופיל המלא. עסק שמעלה תמונה או לוגו משלו ממשיך להציג את שלו כרגיל, זו רק ברירת מחדל.</p>
    ${d.settings.defaultBusinessLogoDataUri ? `<div style="margin:10px 0;"><img src="${d.settings.defaultBusinessLogoDataUri}" alt="לוגו ברירת מחדל נוכחי" style="width:80px;height:80px;object-fit:contain;border-radius:12px;background:var(--cream);" /></div>` : `<p class="muted">כרגע אין לוגו ברירת מחדל - עסק בלי תמונה/לוגו משלו מציג ראשי תיבות.</p>`}
    <form method="post" action="/admin/default-business-logo" enctype="multipart/form-data">
      <label>העלאת לוגו ברירת מחדל חדש${d.settings.defaultBusinessLogoDataUri ? " (להחלפה)" : ""}<input type="file" name="defaultBusinessLogo" accept="image/*" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">העלאה</button>
    </form>
    ${d.settings.defaultBusinessLogoDataUri ? `<form method="post" action="/admin/default-business-logo/remove" style="margin-top:8px;"><button class="btn btn-small btn-outline" type="submit">הסרה - חזרה לראשי תיבות</button></form>` : ""}
  </div>

  <div class="panel">
    <h3>באנר עליון קבוע</h3>
    <p class="muted">תמונה ברוחב מלא שתופיע בראש כל עמוד באתר, מעל סרגל הניווט - מקום נחמד ללוגו גדול או לתמונת מיתוג.</p>
    ${d.settings.topBannerDataUri ? `<div style="margin:10px 0;"><img src="${d.settings.topBannerDataUri}" alt="באנר נוכחי" style="max-width:100%;max-height:120px;" /></div>` : `<p class="muted">כרגע אין באנר - סרגל הניווט מופיע לבד בראש העמוד.</p>`}
    <form method="post" action="/admin/top-banner" enctype="multipart/form-data">
      <label>העלאת באנר חדש (תמונה)<input type="file" name="banner" accept="image/*" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">העלאה</button>
    </form>
    ${d.settings.topBannerDataUri ? `<form method="post" action="/admin/top-banner/remove" style="margin-top:8px;"><button class="btn btn-small btn-outline" type="submit">הסרת הבאנר</button></form>` : ""}
  </div>

  <div class="panel">
    <h3>תמונת רקע לאתר</h3>
    <p class="muted">תמונה שתופיע כרקע לכל האתר, מתחת לסרגל העליון - כדאי לבחור תמונה עדינה ולא עמוסה כדי שהטקסט יישאר קריא.</p>
    ${d.settings.siteBackgroundImageDataUri ? `<div style="margin:10px 0;"><img src="${d.settings.siteBackgroundImageDataUri}" alt="רקע נוכחי" style="max-width:100%;max-height:160px;border-radius:8px;" /></div>` : `<p class="muted">כרגע אין תמונת רקע - האתר מוצג על רקע אחיד.</p>`}
    <form method="post" action="/admin/background" enctype="multipart/form-data">
      <label>העלאת תמונת רקע חדשה<input type="file" name="background" accept="image/*" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">העלאה</button>
    </form>
    ${d.settings.siteBackgroundImageDataUri ? `<form method="post" action="/admin/background/remove" style="margin-top:8px;"><button class="btn btn-small btn-outline" type="submit">הסרת תמונת הרקע</button></form>` : ""}
  </div>

  <div class="panel">
    <h3>עמודי תוכן</h3>
    <p class="muted">אפשר לערוך כאן את הטקסט שמוצג בעמודים <a href="/about" target="_blank">מי אנחנו</a>, <a href="/terms" target="_blank">תקנון</a> ו-<a href="/privacy" target="_blank">מדיניות פרטיות</a> - ישירות מכאן, בלי לגעת בקוד. שורה ריקה = פסקה חדשה, "## " בתחילת שורה = כותרת משנה, **טקסט** = הדגשה.</p>
    <form method="post" action="/admin/about-text">
      <label>מי אנחנו
      <textarea name="aboutText" style="min-height:120px;">${esc(d.settings.aboutText)}</textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת "מי אנחנו"</button>
    </form>
    <form method="post" action="/admin/terms-text" style="margin-top:18px;">
      <label>תקנון
      <textarea name="termsText" style="min-height:160px;">${esc(d.settings.termsText)}</textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת התקנון</button>
    </form>
    <form method="post" action="/admin/privacy-text" style="margin-top:18px;">
      <label>מדיניות פרטיות
      <textarea name="privacyPolicyText" style="min-height:260px;">${esc(d.settings.privacyPolicyText)}</textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת מדיניות הפרטיות</button>
    </form>
    <form method="post" action="/admin/accessibility-text" style="margin-top:18px;">
      <label>הצהרת נגישות
      <textarea name="accessibilityStatementText" style="min-height:260px;">${esc(d.settings.accessibilityStatementText)}</textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת הצהרת הנגישות</button>
    </form>
  </div>

  <div class="panel" id="ai-support-assistant">
    <h3>🤖 עוזרת AI באתר</h3>
    <p class="muted">
      ${AI_CONFIGURED
        ? "מפתח ה-AI מוגדר. כפתור \"הצע לי תשובה\" בשיחות תמיכה פעיל תמיד כשיש מפתח - זו פעולה ידנית שאת לוחצת עליה רק כשרוצים, ולא עולה הרבה. חיפוש ה-AI בעמוד החיפוש הוא סיפור אחר - כל חיפוש עולה כסף בפועל, אז הוא כבוי כברירת מחדל ומופעל רק דרך המתג למטה."
        : "כדי שהכפתור \"הצע לי תשובה\" בשיחות התמיכה וחיפוש ה-AI בעמוד החיפוש (כשתדליקי אותו) יתחילו לעבוד, צריך להגדיר ב-Render משתנה סביבה בשם ANTHROPIC_API_KEY (בדיוק כמו RESEND_API_KEY ו-VAPID_PUBLIC_KEY/PRIVATE_KEY שכבר מוגדרים אצלך). אפשר לקבל מפתח כזה בקישור <a href=\"https://console.anthropic.com\" target=\"_blank\" rel=\"noopener\">console.anthropic.com</a> - נרשמים, נכנסים ל-Settings ← API Keys, יוצרים מפתח חדש ומעתיקים אותו ל-Render (Environment ← Add Environment Variable)."}
    </p>
    <div style="margin:14px 0;padding:10px 12px;background:#f7f2ee;border-radius:8px;">
      <p style="margin:0 0 8px;font-weight:700;">חיפוש חכם מבוסס AI בעמוד החיפוש: ${d.settings.aiSearchEnabled ? "🟢 פעיל" : "🔴 כבוי"}</p>
      <p class="muted" style="margin:0 0 8px;font-size:13px;">${d.settings.aiSearchEnabled
        ? "כרגע דלוק - כל חיפוש בתיבת \"חיפוש חכם\" שולח קריאה בתשלום ל-AI. אם תכבי, החיפוש חוזר מיד לגרסה החכמה-אבל-חינמית שעבדה עד עכשיו, בלי שום עלות."
        : "כרגע כבוי לפי בקשתך, כדי לא להצטבר עלות לא צפויה - עמוד החיפוש ממשיך לעבוד רגיל עם הגרסה החכמה-אבל-חינמית (בלי קריאות AI ובלי עלות). אפשר להדליק בכל רגע בכפתור הזה."}</p>
      <form method="post" action="/admin/ai-search-toggle">
        <input type="hidden" name="enable" value="${d.settings.aiSearchEnabled ? "0" : "1"}" />
        <button class="btn btn-small ${d.settings.aiSearchEnabled ? "btn-outline" : ""}" type="submit">${d.settings.aiSearchEnabled ? "כיבוי חיפוש ה-AI" : "הפעלת חיפוש ה-AI"}</button>
      </form>
    </div>
    <form method="post" action="/admin/support-knowledge-base">
      <label>מסמך מדיניות / שאלות נפוצות (זה מה שה-AI יסתמך עליו כדי להציע תשובות)
      <textarea name="supportKnowledgeBase" maxlength="12000" style="min-height:220px;" placeholder="לדוגמה: איך נרשמים לאתר, מה זה 'עצמאית מומלצת', מדיניות ביטולים, איך מדווחים על תוכן פוגעני, פרטי יצירת קשר...">${esc(d.settings.supportKnowledgeBase || "")}</textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירת המסמך</button>
    </form>
  </div>

  <div class="panel">
    <h3>טיפ שבועי מהמומחית</h3>
    <p class="muted">הטיפ מתחלף אוטומטית כל יום ראשון בשעה 08:00, לפי סדר ההרשמה של העצמאיות שמילאו משפט השראה משלהן.</p>
    <form method="post" action="/admin/weekly-message">
      <label>מה כותבים בדף הבית השבוע (ברירת מחדל, כשאין משפט אישי)
      <textarea name="weeklyMessage">${esc(d.settings.weeklyMessage)}</textarea></label>
      <label>עצמאית השבוע - בחירה ידנית (אופציונלי, תופסת שבוע אחד בלבד - אחריו התור האוטומטי ממשיך מאיפה שעצר)
      <select name="freelancerOfWeekId">
        <option value="">ללא - התור האוטומטי</option>
        ${activeFreelancers.map((f) => `<option value="${f.id}" ${d.settings.freelancerOfWeekId === f.id ? "selected" : ""}>${esc(f.businessName || f.name)}</option>`).join("")}
      </select></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון</button>
    </form>
  </div>

  <div class="panel">
    <h3>קבוצת הווטסאפ והמייל ליצירת קשר</h3>
    <p class="muted">אם תמלאי כאן קישור ו/או מייל, יופיע בדף הבית כפתור לקהילה שלך.</p>
    <form method="post" action="/admin/community-links">
      <label>קישור הצטרפות לקבוצת הווטסאפ
      <input type="text" name="communityWhatsappLink" value="${esc(d.settings.communityWhatsappLink || "")}" placeholder="https://chat.whatsapp.com/..." /></label>
      <label>מייל ליצירת קשר
      <input type="text" name="contactEmail" value="${esc(d.settings.contactEmail || "")}" placeholder="hello@shecan.co.il" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון</button>
    </form>
  </div>

  <div class="panel">
    <h3>תחרות הפניות - לקוחות ("הביאי חברה")</h3>
    <p class="muted">שולט על הבלוק שמופיע בטופס ההרשמה של הלקוחות ובאזור האישי שלהן.</p>
    <form method="post" action="/admin/referral-settings">
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="customerReferralContestActive" value="1" style="width:auto;" ${d.settings.customerReferralContestActive ? "checked" : ""} /> התחרות פעילה ומוצגת באתר</label>
      <label>תאריך סיום ההרשמה לתחרות (טקסט חופשי, למשל 15.9)
      <input type="text" name="customerReferralContestEndDate" value="${esc(d.settings.customerReferralContestEndDate || "")}" /></label>
      <label>תאריך הכרזת הזוכות
      <input type="text" name="customerReferralAnnounceDate" value="${esc(d.settings.customerReferralAnnounceDate || "")}" /></label>
      <label>הערה למבצע (אופציונלי - מוצגת ללקוחות ליד המבצע, למשל "המבצע הוארך!")
      <input type="text" name="customerReferralPromoNote" maxlength="200" value="${esc(d.settings.customerReferralPromoNote || "")}" placeholder="השאירי ריק אם אין הערה" /></label>

      <h4 style="margin-top:22px;">תחרות הפניות - עצמאיות ("צרפי חברה")</h4>
      <p class="muted" style="margin-top:-6px;">שולט על הבלוק שמופיע באזור האישי של העצמאיות.</p>
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="freelancerReferralContestActive" value="1" style="width:auto;" ${d.settings.freelancerReferralContestActive ? "checked" : ""} /> התחרות פעילה ומוצגת באתר</label>
      <label>תאריך סיום התחרות (טקסט חופשי, למשל 17.9)
      <input type="text" name="freelancerReferralContestEndDate" value="${esc(d.settings.freelancerReferralContestEndDate || "")}" /></label>
      <label>תאריך פרסום העסק המוביל
      <input type="text" name="freelancerReferralAnnounceDate" value="${esc(d.settings.freelancerReferralAnnounceDate || "")}" /></label>
      <label>הערה למבצע (אופציונלי - מוצגת לעצמאיות ליד המבצע, למשל "המבצע הוארך!")
      <input type="text" name="freelancerReferralPromoNote" maxlength="200" value="${esc(d.settings.freelancerReferralPromoNote || "")}" placeholder="השאירי ריק אם אין הערה" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון</button>
    </form>
  </div>

  <div class="panel" id="freelancer-referral-race" style="scroll-margin-top:90px;">
    <h3>מרוץ ההפניות של העצמאיות - מי מובילה 🏆</h3>
    <p class="muted">כל עצמאית שהצטרפה דרך קישור אישי של עצמאית אחרת (או שבחרה את שמה ידנית ב"איך שמעת עלינו" בטופס ההרשמה) - ממוין מהכי הרבה הפניות להכי פחות, כולל השמות של מי שנכנסה דרך הקישור של כל אחת.</p>
    ${leaderGapSummaryHtml(freelancerReferralRanking, "הפניות")}
    ${freelancerReferralRanking.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>מקום</th><th>עצמאית</th><th>כמות הפניות</th><th>מי נכנסה דרכה</th></tr>
      ${freelancerReferralRanking.map((r, i) => `<tr>
        <td>${i + 1}${i === 0 ? " 👑" : ""}</td><td>${esc(r.name)}</td><td>${r.count}</td>
        <td>${esc(r.referred.join(", "))}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין אין הפניות בפועל - אף עצמאית לא נרשמה עדיין דרך הקישור האישי של עצמאית אחרת.</p>`}
    <!-- עדכון מהיר של תאריך הסיום/הכרזה וההערה של המבצע - ישירות מהפאנל הזה, בלי לצאת אליו, לפי
         בקשה מפורשת 2026-08-30 ("תן לי אופציה לרשום ליד המבצע... כי אני רוצה להאריך את המבצע").
         נתיב נפרד (לא הטופס הכללי של /admin/referral-settings) כדי שלא יאפס בטעות את שאר השדות
         (כולל תחרות הלקוחות) שלא מופיעים בטופס המצומצם הזה. -->
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eee2d8;">
      <p class="muted" style="margin:0 0 8px;">עדכון מהיר של המבצע (מוצג לעצמאיות באזור האישי שלהן)${d.settings.freelancerReferralPromoNote ? ` - הערה נוכחית: "${esc(d.settings.freelancerReferralPromoNote)}"` : ""}</p>
      <form method="post" action="/admin/referral-settings/quick-update" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <input type="hidden" name="which" value="freelancer" />
        <label style="flex:1;min-width:130px;">תאריך סיום
        <input type="text" name="endDate" value="${esc(d.settings.freelancerReferralContestEndDate || "")}" /></label>
        <label style="flex:1;min-width:130px;">תאריך הכרזה
        <input type="text" name="announceDate" value="${esc(d.settings.freelancerReferralAnnounceDate || "")}" /></label>
        <label style="flex:2;min-width:200px;">הערה למבצע (אופציונלי)
        <input type="text" name="note" maxlength="200" value="${esc(d.settings.freelancerReferralPromoNote || "")}" placeholder="למשל: המבצע הוארך!" /></label>
        <button class="btn btn-small" type="submit">עדכון המבצע</button>
      </form>
    </div>
    <!-- הכרזת מנצחת ופרסום אמיתי בדף הבית - לפי בקשה מפורשת 2026-08-30 ("רוצה שההבטחה בפועל
         תתקיים בלי מאמץ נוסף ממך"). זה שונה מ"עצמאית השבוע" הרגיל (freelancerOfWeekId, בפאנל
         "התוכן השבועי" למעלה) - זה פין שמחזיק מעצמו עד תאריך שהיא בוחרת (למשל חודש שלם), לא
         רק מחזור שבועי אחד. ר' getWeeklyFeature למעלה בקובץ ל-override עצמו. -->
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eee2d8;">
      <h4 style="margin:0 0 6px;">🏆 הכרזת מנצחת ופרסום בדף הבית</h4>
      ${(() => {
        const currentWinner = d.settings.freelancerReferralWinnerId && d.settings.freelancerReferralWinnerUntil && israelDayKeyOffset(0) <= d.settings.freelancerReferralWinnerUntil
          ? d.freelancers.find((x) => x.id === d.settings.freelancerReferralWinnerId) : null;
        return currentWinner
          ? `<p class="muted">מוצגת כרגע כ"העסק המוביל" בדף הבית: <strong>${esc(currentWinner.businessName || currentWinner.name)}</strong>, עד ה-${esc(d.settings.freelancerReferralWinnerUntil)}.</p>
             <form method="post" action="/admin/referral-settings/clear-winner" style="margin-bottom:10px;"><button class="btn btn-small btn-outline" type="submit">ביטול הפרסום</button></form>`
          : `<p class="muted">אין כרגע מנצחת מוכרזת - כשתבחרי אחת, היא תוצג בדף הבית (בלוק "טיפ שבועי") עד התאריך שתקבעי, בלי תלות ברוטציה השבועית הרגילה.</p>`;
      })()}
      <form method="post" action="/admin/referral-settings/set-winner" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <label style="flex:2;min-width:200px;">המנצחת
          <select name="freelancerId" required>
            <option value="">בחרי עצמאית</option>
            ${d.freelancers.filter((f) => f.status === "approved").sort((a, b) => (a.businessName || a.name || "").localeCompare(b.businessName || b.name || "", "he")).map((f) => `<option value="${f.id}" ${freelancerReferralRanking[0] && freelancerReferralRanking[0].id === f.id ? "selected" : ""}>${esc(f.businessName || f.name)}${freelancerReferralRanking[0] && freelancerReferralRanking[0].id === f.id ? " (מובילה כרגע)" : ""}</option>`).join("")}
          </select>
        </label>
        <label style="flex:1;min-width:150px;">מוצגת עד תאריך
          <input type="date" name="until" value="${esc(israelDateKey(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)))}" required />
        </label>
        <button class="btn btn-small" type="submit">פרסום כמנצחת</button>
      </form>
    </div>
    <!-- תיקון שיוך הפניה ידני - מקביל לזה שנוסף לפאנל הלקוחות למטה, לאותה סיבה בדיוק (הקישור
         האישי לא תמיד שורד עד ההרשמה, ואצל עצמאית גם התאמת שם ידנית ב"איך שמעת עלינו" יכולה
         להיכשל אם השם לא הוקלד בדיוק כמו שם העסק). -->
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eee2d8;">
      <h4 style="margin:0 0 6px;">תיקון שיוך הפניה ידני</h4>
      <p class="muted" style="margin:0 0 8px;">אם עצמאית טוענת שהפנתה חברה אבל זה לא נספר - אפשר לשייך את זה ידנית כאן, לפי מייל. השארת "מייל מי שהזמינה" ריק תנקה שיוך קיים.</p>
      <form method="post" action="/admin/freelancer/fix-referral" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <label style="flex:1;min-width:200px;">מייל העצמאית שנרשמה
        <input type="email" name="freelancerEmail" required placeholder="שנרשמה@example.com" /></label>
        <label style="flex:1;min-width:200px;">מייל מי שהזמינה (ריק = ניקוי שיוך)
        <input type="email" name="referrerEmail" placeholder="שהזמינה@example.com" /></label>
        <button class="btn btn-small" type="submit">עדכון שיוך</button>
      </form>
    </div>
  </div>

  <div class="panel" id="customer-referral-race" style="scroll-margin-top:90px;">
    <h3>מרוץ ההפניות של הלקוחות - מי מובילה 🏆</h3>
    <p class="muted">כל לקוחה שנרשמה דרך הקישור האישי של לקוחה אחרת ("הביאי חברה") - ממוין מהכי הרבה הפניות להכי פחות, כולל השמות של מי שנרשמה דרך הקישור של כל אחת.</p>
    ${leaderGapSummaryHtml(customerReferralRanking, "חברות")}
    ${customerReferralRanking.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>מקום</th><th>לקוחה</th><th>כמות הפניות</th><th>מי נרשמה דרכה</th></tr>
      ${customerReferralRanking.map((r, i) => `<tr>
        <td>${i + 1}${i === 0 ? " 👑" : ""}</td><td>${esc(r.name)}</td><td>${r.count}</td>
        <td>${esc(r.referred.join(", "))}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין אין הפניות בפועל - אף לקוחה לא נרשמה עדיין דרך הקישור האישי של לקוחה אחרת.</p>`}
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eee2d8;">
      <p class="muted" style="margin:0 0 8px;">עדכון מהיר של המבצע (מוצג ללקוחות באזור האישי שלהן)${d.settings.customerReferralPromoNote ? ` - הערה נוכחית: "${esc(d.settings.customerReferralPromoNote)}"` : ""}</p>
      <form method="post" action="/admin/referral-settings/quick-update" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <input type="hidden" name="which" value="customer" />
        <label style="flex:1;min-width:130px;">תאריך סיום
        <input type="text" name="endDate" value="${esc(d.settings.customerReferralContestEndDate || "")}" /></label>
        <label style="flex:1;min-width:130px;">תאריך הכרזה
        <input type="text" name="announceDate" value="${esc(d.settings.customerReferralAnnounceDate || "")}" /></label>
        <label style="flex:2;min-width:200px;">הערה למבצע (אופציונלי)
        <input type="text" name="note" maxlength="200" value="${esc(d.settings.customerReferralPromoNote || "")}" placeholder="למשל: המבצע הוארך!" /></label>
        <button class="btn btn-small" type="submit">עדכון המבצע</button>
      </form>
    </div>
    <!-- תיקון שיוך הפניה ידני - לפי בקשה מפורשת 2026-08-30 (לקוחה טענה שהפנתה חברות שלא נספרו).
         הסיבה הסבירה: שיוך הפניה של לקוחה תלוי לגמרי בקישור האישי ששרד עד לשליחת הטופס - בניגוד
         לעצמאיות, ללקוחות אין רשימת "איך שמעת עלינו" עם בחירה ידנית (ר' /signup, שעכשיו כן קיבל
         גיבוי ידני לפי מייל להרשמות עתידיות) - אז זה הכלי לתקן רטרואקטיבית מי שכבר נרשמה בלי
         שהקישור עבד. השארת שדה "מייל מי שהזמינה" ריק מנקה שיוך שגוי קיים. -->
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #eee2d8;">
      <h4 style="margin:0 0 6px;">תיקון שיוך הפניה ידני</h4>
      <p class="muted" style="margin:0 0 8px;">אם לקוחה טוענת שהפנתה חברה אבל זה לא נספר (בדרך כלל כי הקישור האישי לא שרד עד ההרשמה) - אפשר לשייך את זה ידנית כאן, לפי מייל. השארת "מייל מי שהזמינה" ריק תנקה שיוך קיים.</p>
      <form method="post" action="/admin/customer/fix-referral" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <label style="flex:1;min-width:200px;">מייל הלקוחה שנרשמה
        <input type="email" name="customerEmail" required placeholder="שנרשמה@example.com" /></label>
        <label style="flex:1;min-width:200px;">מייל מי שהזמינה (ריק = ניקוי שיוך)
        <input type="email" name="referrerEmail" placeholder="שהזמינה@example.com" /></label>
        <button class="btn btn-small" type="submit">עדכון שיוך</button>
      </form>
    </div>
  </div>

  <div class="panel">
    <h3>המגזין שלנו</h3>
    <p class="muted">"צפיות" נספר רק לגיליונות עם קישור פנימי (למשל /magazine/view/issue-1) - כלומר כניסה בפועל לצפייה בגיליון, לא רק כניסה לעמוד "מגזין SheCan" עצמו. גיליון עם קישור חיצוני (Canva/Google Drive וכו') מציג "-" כי אין לנו דרך לספור צפיות שם.</p>
    ${(d.magazines || []).length ? `<div class="table-scroll"><table class="table-simple"><tr><th>כותרת</th><th>קישור</th><th>צפיות</th><th>פעולות</th></tr>
      ${d.magazines.map((m) => {
        const slug = magazineSlugFromUrl(m.url);
        const views = slug ? ((d.magazineViewCounts || {})[slug] || 0) : "-";
        return `<tr>
        <td>${esc(m.title)}</td><td><a href="${esc(m.url)}" target="_blank" rel="noopener">לצפייה</a></td><td>${views}</td>
        <td><form method="post" action="/admin/magazine/${m.id}/delete"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`;
      }).join("")}
    </table></div>` : `<p class="muted">עדיין לא הוספת גיליונות.</p>`}
    <form method="post" action="/admin/magazine" style="margin-top:14px;max-width:420px;">
      <label>כותרת הגיליון
      <input type="text" name="title" placeholder="גיליון 1" required /></label>
      <label>קישור לצפייה (Canva / Google Drive וכו')
      <input type="text" name="url" placeholder="https://..." required /></label>
      <label>תיאור קצר (אופציונלי)
      <input type="text" name="description" placeholder="על מה מדברים בגיליון הזה" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">הוספת גיליון</button>
    </form>
  </div>

  <div class="panel">
    <h3>שאלות לסיפור ההשראה</h3>
    <p class="muted">אלו השאלות שכל עצמאית עונה עליהן באזור האישי שלה כדי לבנות את הסיפור שלה.</p>
    ${(d.settings.storyQuestions || []).length ? `<div class="table-scroll"><table class="table-simple"><tr><th>שאלה</th><th>פעולות</th></tr>
      ${d.settings.storyQuestions.map((q, i) => `<tr>
        <td>${esc(q)}</td>
        <td><form method="post" action="/admin/story-question/${i}/delete"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">אין כרגע שאלות מוגדרות.</p>`}
    <form method="post" action="/admin/story-question" style="margin-top:14px;max-width:480px;">
      <label>שאלה חדשה
      <input type="text" name="question" placeholder="מה היית רוצה לספר לנו?" required /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">הוספת שאלה</button>
    </form>
  </div>

  <div class="panel">
    <h3>סיפורי השראה שפורסמו</h3>
    <p class="muted">הסיפור המוצג ב<a href="/stories">עמוד הסיפורים</a> מתחלף אוטומטית כל ${d.settings.storyRotationDays || 7} ימים בשעה 20:00, לפי סדר ההרשמה של העצמאיות.</p>
    <form method="post" action="/admin/story-rotation-days" style="margin-bottom:14px;max-width:280px;">
      <label>כל כמה ימים הסיפור מתחלף (ברירת מחדל: 7)
      <input type="number" name="days" min="1" max="60" value="${d.settings.storyRotationDays || 7}" required /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון תדירות</button>
    </form>
    ${approvedStoriesForAdmin.length ? `
    <form method="post" action="/admin/story-of-week" style="margin-bottom:14px;max-width:480px;">
      <label>סיפור השבוע - בחירה ידנית (אופציונלי, תופסת שבוע אחד בלבד - אחריו התור האוטומטי ממשיך מאיפה שעצר)
      <select name="storyOfWeekId">
        <option value="">ללא - התור האוטומטי</option>
        ${approvedStoriesForAdmin.map((s) => `<option value="${s.id}" ${d.settings.storyOfWeekId === s.id ? "selected" : ""}>${esc(s.title)}</option>`).join("")}
      </select></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון</button>
    </form>` : ""}
    <p class="muted" style="margin-top:-4px;margin-bottom:14px;">כל הסיפורים שנכתבו אי פעם (מאושרים, ממתינים ונדחים) - לא רק אלו שבאוויר עכשיו.</p>
    ${d.stories.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>כותרת</th><th>על מי</th><th>סטטוס</th><th>הוצג ב'סיפורים קודמים'?</th><th>צפיות</th><th>תאריך</th><th>פעולות</th></tr>
      ${d.stories.slice().reverse().map((s) => {
        const sf = d.freelancers.find((x) => x.id === s.freelancerId);
        const title = s.title || (sf ? `הסיפור של ${sf.businessName || sf.name}` : "סיפור השראה");
        const statusLabel = s.status === "approved" ? "מאושר ✓" : s.status === "pending" ? "ממתין לאישור" : "נדחה";
        const titleCell = s.status === "approved" ? `<a href="/stories/${s.id}">${esc(title)}</a>` : esc(title);
        // "הוצג?" עוזר לזהות ולתקן במקום סיפור שסומן בטעות כ"כבר הוצג" (למשל מהבאג החד-פעמי
        // של תחילת פיצ'ר תדירות-הסיבוב) - כפתור "בטל סימון" מנקה את זה ומחזיר אותו לתור.
        const featuredCell = s.status !== "approved" ? "-"
          : s.featuredAt ? `כן (${esc(new Date(s.featuredAt).toLocaleDateString("he-IL"))})`
          : "עוד לא";
        const unfeatureBtn = (s.status === "approved" && s.featuredAt)
          ? `<form method="post" action="/admin/story/${s.id}/unfeature" style="display:inline;margin-inline-start:4px;" onsubmit="return confirm('לבטל את הסימון של הסיפור הזה כ\\'כבר הוצג\\'? הוא ייעלם מ\\'סיפורים קודמים\\' עד שיגיע תורו האמיתי.');"><button class="btn btn-small btn-outline" type="submit">ביטול סימון</button></form>`
          : "";
        return `<tr>
          <td>${titleCell}</td><td>${esc(sf ? (sf.businessName || sf.name) : "-")}</td><td>${statusLabel}</td><td>${featuredCell}</td><td>${s.viewCount || 0}</td><td>${esc(new Date(s.createdAt).toLocaleDateString("he-IL"))}</td>
          <td><form method="post" action="/admin/story/${s.id}/delete" style="display:inline;"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form>${unfeatureBtn}</td>
        </tr>`;
      }).join("")}
    </table></div>` : `<p class="muted">עדיין אין סיפורים.</p>`}
    <form method="post" action="/admin/story" enctype="multipart/form-data" style="margin-top:14px;max-width:480px;">
      <label>הוספת סיפור ידנית (למשל סיפור שאת כותבת בעצמך)</label>
      <label>כותרת
      <input type="text" name="title" placeholder="השבוע מכירות את..." required /></label>
      <label>על איזו עצמאית מדובר (אופציונלי)
      <select name="freelancerId">
        <option value="">ללא קישור לעצמאית ספציפית</option>
        ${activeFreelancers.map((f) => `<option value="${f.id}">${esc(f.businessName || f.name)}</option>`).join("")}
      </select></label>
      <label>תמונה (אופציונלי)
      <input type="file" name="photo" accept="image/*" /></label>
      <label>תוכן הסיפור
      <textarea name="content" style="min-height:160px;" required></textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">פרסום הסיפור</button>
    </form>
  </div>

  <div class="panel">
    <h3>תשלום מעצמאיות</h3>
    <p class="muted">איפה אנחנו עומדות: ${d.settings.chargingEnabled ? "כרגע גובים תשלום מכל מי שמצטרפת" : "עדיין בתקופת ההשקה החינמית - כל מי שמצטרפת עכשיו נשארת \"מייסדת\""}</p>
    <form method="post" action="/admin/charging-toggle">
      <button class="btn btn-small" type="submit">${d.settings.chargingEnabled ? "לחזור למצב חינמי" : "הגיע הזמן - הפעילי תשלום"}</button>
    </form>
  </div>

  <div class="panel">
    <h3>נראות לגוגל ולמנועי חיפוש</h3>
    <p class="muted">${d.settings.searchEngineVisible ? "האתר פתוח עכשיו למנועי חיפוש - גוגל יכול לסרוק ולהציג אותו בתוצאות חיפוש." : "האתר כרגע חסום למנועי חיפוש (למשל גוגל) - הוא באוויר וכל מי שיש לה את הקישור יכולה להיכנס, אבל הוא לא יופיע בתוצאות חיפוש ולא ייסרק. מומלץ להשאיר כך עד שתהיי בטוחה שהאתר מוכן להשקה אמיתית."}</p>
    <form method="post" action="/admin/toggle-search-visibility">
      <button class="btn btn-small" type="submit">${d.settings.searchEngineVisible ? "לחסום שוב ממנועי חיפוש" : "אני מוכנה - לפתוח לגוגל"}</button>
    </form>
  </div>

  <div class="panel">
    <h3>מספרים ציבוריים בעמוד הבית</h3>
    <p class="muted">${d.settings.showPublicStats ? "מוצג עכשיו לכולן, בעמוד הבית, מתחת ל\"יש לך עסק? בואי נכיר\": כמה עצמאיות באתר, כמה לקוחות רשומות, וכמה עסקאות נסגרו." : "כרגע לא מוצג לאף אחת - אפשר להדליק את זה מתי שתרצי, זה מיד יופיע בעמוד הבית לכולן."}</p>
    <p class="muted" style="font-size:12px;">כרגע: ${activeFreelancers.length} עצמאיות, ${d.customers.length} לקוחות, ${confirmedDealsCount} עסקאות שנסגרו.</p>
    <form method="post" action="/admin/toggle-public-stats">
      <button class="btn btn-small" type="submit">${d.settings.showPublicStats ? "הסתרה מעמוד הבית" : "הצגה לכולן בעמוד הבית"}</button>
    </form>
  </div>

  <div class="panel" id="arena-consultations">
    <h3>פינת ההתייעצויות בזירה</h3>
    <p class="muted">${d.settings.arenaConsultationsEnabled ? "פינת ההתייעצויות מוצגת עכשיו בזירה - לקוחות ועצמאיות יכולות לפתוח ולהגיב להתייעצויות חופשיות (כל תגובה עדיין עוברת אישור ידני לפני פרסום, כרגיל)." : "פינת ההתייעצויות מוסתרת כרגע מהזירה - הלשונית לא מופיעה, ואי אפשר לפתוח או להגיב להתייעצויות. שום תוכן קיים לא נמחק - הכל יחזור לאיתנו ברגע שתדליקי את זה מחדש."}</p>
    <form method="post" action="/admin/toggle-arena-consultations">
      <button class="btn btn-small" type="submit">${d.settings.arenaConsultationsEnabled ? "הסתרה מהזירה" : "הצגה מחדש בזירה"}</button>
    </form>
  </div>

  <div class="panel">
    <h3>מספר צפיות ודירוג מדויק בפרופיל</h3>
    <p class="muted">${d.settings.showProfileViewCount ? "מוצג עכשיו לכולם, בעמוד הפרופיל הפומבי של כל עצמאית: כמה צפיות היו בפרופיל שלה (👁️), והציון המספרי המדויק של הדירוג שלה (למשל \"4.7\") ליד הכוכבים." : "כרגע לא מוצג באף פרופיל - רק כוכבי הדירוג הוויזואליים מוצגים (בלי מספר מדויק), ובלי מספר צפיות. אפשר להדליק את זה מתי שתרצי."}</p>
    <form method="post" action="/admin/toggle-profile-viewcount">
      <button class="btn btn-small" type="submit">${d.settings.showProfileViewCount ? "הסתרה מהפרופילים" : "הצגה בכל הפרופילים"}</button>
    </form>
  </div>

  <div class="panel" data-badge="${(d.serviceRequests || []).length}">
    <h3>📣 בקשות שירות מלקוחות (${(d.serviceRequests || []).length})</h3>
    <p class="muted">${d.settings.serviceRequestsPremiumOnly ? "כרגע מוצגות לעצמאיות רק אם היא מסומנת 'מומלצת' (ר' עמודת 'רמה' בטבלת העצמאיות למטה)." : "כרגע פתוח לכל עצמאית מאושרת בתחום המתאים - אף אחת לא נדרשת להיות 'מומלצת' כדי לראות."}</p>
    <form method="post" action="/admin/toggle-service-requests-premium">
      <button class="btn btn-small" type="submit">${d.settings.serviceRequestsPremiumOnly ? "פתיחה לכולן" : "הגבלה ל'מומלצת' בלבד"}</button>
    </form>
    ${(d.serviceRequests || []).length ? `<div class="table-scroll" style="margin-top:14px;"><table class="table-simple"><tr><th>כותרת</th><th>תחום</th><th>לקוחה</th><th>פורסם</th><th>מחיקה</th></tr>
      ${(d.serviceRequests || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((r) => {
        const cu = d.customers.find((c) => c.id === r.customerId);
        return `<tr>
        <td>${esc(r.title)}</td><td>${esc(subcatName(d, r.categoryId, r.subcategoryId) || catName(d, r.categoryId))}</td><td>${cu ? esc(cu.name) : "-"}</td><td>${esc(new Date(r.createdAt).toLocaleDateString("he-IL"))}</td>
        <td><form method="post" action="/admin/service-request/${r.id}/delete" onsubmit="return confirm('למחוק את הבקשה ' + ${JSON.stringify(r.title || "")} + '?');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`;
      }).join("")}
    </table></div>` : ""}
  </div>

  <div class="panel">
    <h3>העצמאיות שכבר איתנו (${activeFreelancers.length})</h3>
    <p class="muted">"נותנת חסות" - הבלטה מיוחדת וקבועה (למשל לעצמאיות שתרמו הטבה להגרלה). "מודעה" - הבלטה בתשלום שאת מוכרת וסוגרת איתן ישירות. "צפיות" - כמה פעמים נכנסו לעמוד שלה. "צפיות בקופון" - כמה פעמים לחצו "לצפייה בקוד קופון". "עסקאות שנסגרו" - כמה פעמים היא סימנה עסקה כנסגרה והלקוחה גם אישרה זאת בעצמה.</p>
    <p class="muted"><a href="/admin/export/freelancers.csv">⬇️ הורדת כל הנתונים כקובץ אקסל (CSV)</a></p>
    <input type="text" id="scAdminFreelancerSearch" placeholder="🔍 חיפוש עצמאית לפי שם עסק..." oninput="scFilterAdminFreelancers(this.value)" style="max-width:320px;margin-bottom:10px;" />
    ${activeFreelancers.length ? `<div class="table-scroll"><table class="table-simple" id="scActiveFreelancersTable"><tr><th>עסק</th><th>אימייל רשום</th><th>סוג הצטרפות</th><th>סטטוס תשלום</th><th>רמה</th><th>קוד קופון</th><th>צפיות</th><th>צפיות בקופון</th><th>עסקאות שנסגרו</th><th>תמונות</th><th>פרטי התחברות</th><th>נותנת חסות</th><th>מודעה</th><th>תשלום מודעה</th><th>סטטוס באתר</th><th>מחיקה</th></tr>
      ${activeFreelancers.map((f) => `<tr>
        <td>${esc(f.businessName)}</td>
        <td><form method="post" action="/admin/freelancer/${f.id}/update-email" style="display:flex;gap:4px;align-items:center;white-space:nowrap;">
          <input type="email" name="email" value="${hasRealEmail(f) ? esc(f.email) : ""}" placeholder="${hasRealEmail(f) ? "" : "אין מייל אמיתי"}" style="width:150px;font-size:12px;padding:4px 6px;" />
          <button class="btn btn-small btn-outline" type="submit" style="padding:4px 8px;font-size:12px;white-space:nowrap;">שמירה</button>
        </form></td>
        <td>${f.joinType === "founding" ? "מייסדת" : "רגילה"}</td><td>${esc(paymentStatusLabel(f.paymentStatus))}</td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-tier"><button class="btn btn-small ${f.tier === "premium" ? "" : "btn-outline"}" type="submit">${f.tier === "premium" ? "⭐ מומלצת" : "הפכי למומלצת"}</button></form></td>
        <td>${esc(f.dealCode || "-")}</td><td>${f.viewCount || 0}</td><td>${f.couponRevealCount || 0}</td><td>${dealsByFreelancer[f.id] || 0}</td>
        <td><a class="btn btn-small ${(f.logoDataUri || (f.galleryPhotos && f.galleryPhotos.length)) ? "" : "btn-outline"}" href="/admin/freelancer/${f.id}/photos">📷 תמונות</a></td>
        <td><form method="post" action="/admin/freelancer/${f.id}/resend-credentials" onsubmit="return confirm('זה ייצור סיסמה זמנית חדשה ל' + ${JSON.stringify(f.businessName || f.name)} + ' וישלח אותה במייל (הסיסמה הישנה שלה תפסיק לעבוד). להמשיך?');"><button class="btn btn-small btn-outline" type="submit">📧 שליחת פרטי התחברות</button></form></td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-leading"><button class="btn btn-small ${f.isLeadingBusiness ? "" : "btn-outline"}" type="submit">${f.isLeadingBusiness ? "👑 נותנת חסות" : "הפכי לנותנת חסות"}</button></form></td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-ad"><button class="btn btn-small ${f.isAdvertised ? "" : "btn-outline"}" type="submit">${f.isAdvertised ? "📣 פעילה" : "הפעילי מודעה"}</button></form></td>
        <td>${f.isAdvertised ? `<form method="post" action="/admin/freelancer/${f.id}/mark-ad-paid"><button class="btn btn-small ${f.adPaymentStatus === "paid" ? "" : "btn-outline"}" type="submit">${esc(adPaymentStatusLabel(f.adPaymentStatus))}</button></form>` : `<span class="muted">-</span>`}</td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-active"><button class="btn btn-small ${f.active === false ? "btn-outline" : ""}" type="submit">${f.active === false ? "⏸️ לא פעילה" : "🟢 פעילה"}</button></form></td>
        <td><form method="post" action="/admin/freelancer/${f.id}/delete" onsubmit="return confirm('למחוק לצמיתות את ' + ${JSON.stringify(f.businessName || f.name)} + '? זו פעולה שלא ניתן לבטל.');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>
      ${f.customSubcategoryPending ? `<tr><td colspan="15" style="padding:0;">${customSubcategoryNoteHtml(f, d)}</td></tr>` : ""}`).join("")}
    </table></div>` : `<p class="muted">עדיין אין עצמאיות פעילות - זה יתמלא מהר ❤️</p>`}
  </div>

  <div class="panel">
    <h3>מודעות לתחומים נוספים (${approvedListings.length})</h3>
    <p class="muted">אפשר להפעיל מודעה על תחום נוסף ספציפי בנפרד מהפרופיל הראשי שלה - שימושי אם היא רוצה לפרסם רק עסק אחד מבין כמה שיש לה.</p>
    ${approvedListings.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>תחום נוסף</th><th>שייך ל</th><th>מודעה</th><th>תשלום מודעה</th></tr>
      ${approvedListings.map(({ f, l }) => `<tr>
        <td>${esc(l.businessName)}</td><td>${esc(f.businessName || f.name)}</td>
        <td><form method="post" action="/admin/listing/${f.id}/${l.id}/toggle-ad"><button class="btn btn-small ${l.isAdvertised ? "" : "btn-outline"}" type="submit">${l.isAdvertised ? "📣 פעילה" : "הפעילי מודעה"}</button></form></td>
        <td>${l.isAdvertised ? `<form method="post" action="/admin/listing/${f.id}/${l.id}/mark-ad-paid"><button class="btn btn-small ${l.adPaymentStatus === "paid" ? "" : "btn-outline"}" type="submit">${esc(adPaymentStatusLabel(l.adPaymentStatus))}</button></form>` : `<span class="muted">-</span>`}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין אין תחומים נוספים מאושרים.</p>`}
  </div>

  <div class="panel">
    <h3>סטטיסטיקת צפיות בקופונים (${revealEvents.length} סה"כ)</h3>
    <p class="muted">כמה פעמים לחצו על "לצפייה בקוד קופון" בכל האתר, לפי תחום, ופירוט אחרון לפי עצמאית ותאריך.</p>
    ${Object.keys(revealsByCategory).length ? `<div class="table-scroll"><table class="table-simple"><tr><th>תחום</th><th>צפיות בקופון</th></tr>
      ${Object.entries(revealsByCategory).sort((a, b) => b[1] - a[1]).map(([cat, count]) => `<tr><td>${esc(cat)}</td><td>${count}</td></tr>`).join("")}
    </table></div>` : `<p class="muted">עוד אין נתונים - יופיע כאן ברגע שמישהי תלחץ לצפייה בקוד קופון.</p>`}
    ${revealEvents.length ? `<h4 style="margin-top:18px;">האחרונות</h4><div class="table-scroll"><table class="table-simple"><tr><th>עצמאית</th><th>תחום</th><th>תאריך</th></tr>
      ${revealEvents.slice(0, 50).map((ev) => {
        const f = d.freelancers.find((x) => x.id === ev.freelancerId);
        return `<tr><td>${esc(f ? (f.businessName || f.name) : "לא ידוע")}</td><td>${esc(f ? catName(d, f.categoryId) : "-")}</td><td>${esc(new Date(ev.date).toLocaleString("he-IL"))}</td></tr>`;
      }).join("")}
    </table></div>` : ""}
  </div>

  <div class="panel" id="deals-detail" style="scroll-margin-top:90px;" data-badge="${confirmedDealsCount}">
    <h3>💰 עסקאות שדווחו - מי דיווחה ומה הסטטוס (${confirmedDealsCount} סגורות ומאושרות, ${pendingDealsCount} ממתינות)</h3>
    <p class="muted">כל עסקה שדווחה באתר, בנפרד - מי דיווחה ראשונה (העצמאית, שממתינה לאישור הלקוחה; או הלקוחה עצמה, שנספרת מיד כ"אושרה"), עם מי, ומה הסטטוס הנוכחי. רק עסקאות עם הסטטוס "✅ אושרה ע&quot;י הלקוחה" נספרות בסטטיסטיקות (כאן ובכל מקום אחר באתר).</p>
    ${allDealsDetailed.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>עסק</th><th>לקוחה</th><th>מי דיווחה</th><th>סטטוס</th><th>תאריך דיווח</th><th>תאריך אישור/דחיה</th></tr>
      ${allDealsDetailed.map((x) => `<tr>
        <td>${esc(x.freelancerName)}</td><td>${esc(x.customerName || "-")}</td><td>${esc(x.reportedBy)}</td>
        <td>${esc(dealStatusLabel(x.status))}</td>
        <td>${esc(new Date(x.createdAt).toLocaleString("he-IL"))}</td>
        <td>${x.customerConfirmedAt ? esc(new Date(x.customerConfirmedAt).toLocaleString("he-IL")) : "-"}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין לא דווחה אף עסקה באתר.</p>`}
  </div>

  <div class="panel" data-badge="${unreadMessages}">
    <h3>הודעות מ"צרי קשר" (${unreadMessages} חדשות)</h3>
    ${(d.contactMessages || []).length ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>אימייל</th><th>הודעה</th><th>תאריך</th><th>פעולות</th></tr>
      ${(d.contactMessages || []).slice().reverse().map((m) => `<tr>
        <td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${esc(m.message)}</td><td>${esc(new Date(m.createdAt).toLocaleDateString("he-IL"))}</td>
        <td>
          <a class="btn btn-small" href="mailto:${esc(m.email)}?subject=${encodeURIComponent("תגובה מ-SheCan")}">מענה במייל</a>
          ${!m.read ? `<form style="display:inline" method="post" action="/admin/message/${m.id}/read"><button class="btn btn-small btn-outline" type="submit">סימון כנקרא</button></form>` : ""}
          <form style="display:inline" method="post" action="/admin/message/${m.id}/delete" onsubmit="return confirm('למחוק את ההודעה הזו?');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form>
        </td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין לא התקבלו הודעות.</p>`}
  </div>

  <div class="panel" id="support-threads" style="scroll-margin-top:90px;" data-badge="${openSupportMessages}">
    <h3>לתמיכה לחצי 💬 (${openSupportMessages} ממתינות לתשובה)</h3>
    <p class="muted">שיחות שנפתחו דרך הכפתור הצף שמופיע בכל עמוד באתר - גם מלקוחות/עצמאיות מחוברות וגם מגולשות אנונימיות. השואלת תמיד רואה את הכפתור, אבל רואה שאת "מחוברת עכשיו" רק כשהדלקת את שירות התמיכה (ר' הפאנל "שירות תמיכה ללקוחות" למעלה) - ואז מקבלת תשובה חיה בלי רענון; כשהשירות כבוי, היא משאירה הודעה ומקבלת תשובה גם באתר וגם במייל.</p>
    ${supportThreads.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>מייל</th><th>הודעה אחרונה</th><th>תאריך</th><th></th></tr>
      ${supportThreads.map((t) => `<tr${t.unread && !t.closed ? ` style="font-weight:800;"` : ""}${t.closed ? ` style="opacity:.6;"` : ""}>
        <td>${esc(t.name)}${t.closed ? ` <span class="muted" style="font-weight:400;">🔒 סגורה</span>` : ""}</td><td>${esc(t.email)}</td>
        <td>${t.lastFrom === "admin" ? "את: " : ""}${esc((t.lastText || "").slice(0, 60))}${(t.lastText || "").length > 60 ? "…" : ""}</td>
        <td>${esc(new Date(t.lastAt).toLocaleString("he-IL"))}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <a class="btn btn-small" href="/admin/support/thread/${encodeURIComponent(encodeSupportKey(t.key))}">${t.unread && !t.closed ? `פתיחת שיחה (${t.unread} חדשות)` : "פתיחת שיחה"}</a>
          ${!t.closed ? `${snoozeButtonHtml(`support:${t.key}`, "support", `שיחת תמיכה עם ${t.name}`)}
          <form method="post" action="/admin/support/thread/${encodeURIComponent(encodeSupportKey(t.key))}/close" style="display:inline;"><button class="btn btn-small btn-outline" type="submit" title="השיחה נגמרה - להסתיר מ&quot;ממתינות למענה&quot;">✖ סגירה</button></form>`
          : `<form method="post" action="/admin/support/thread/${encodeURIComponent(encodeSupportKey(t.key))}/reopen" style="display:inline;"><button class="btn btn-small btn-outline" type="submit">פתיחה מחדש</button></form>`}
        </td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין לא נפתחו שיחות.</p>`}
  </div>

  <div class="panel" id="chat-monitoring" style="scroll-margin-top:90px;">
    <h3>💬 התכתבויות פרטיות בין לקוחות לעצמאיות (${chatThreads.length} שיחות)</h3>
    <p class="muted">תצוגת קריאה בלבד של כל ההודעות הפרטיות שנשלחות דרך כפתור "שליחת הודעה" בעמוד של עצמאית ודרך "האזור האישי" שלה - כדי שיהיה פיקוח מלא גם על הערוץ הזה, בדיוק כמו על שאר התוכן באתר.</p>
    ${chatThreads.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>עצמאית</th><th>לקוחה</th><th>הודעות</th><th>הודעה אחרונה</th><th>תאריך</th><th></th></tr>
      ${chatThreads.map((t) => `<tr>
        <td>${esc(t.freelancerName)}</td><td>${esc(t.customerName)}</td><td>${t.count}</td>
        <td>${t.lastFrom === "freelancer" ? "היא: " : "לקוחה: "}${esc((t.lastText || "").slice(0, 60))}${(t.lastText || "").length > 60 ? "…" : ""}</td>
        <td>${esc(new Date(t.lastAt).toLocaleString("he-IL"))}</td>
        <td><a class="btn btn-small" href="/admin/chat/${t.freelancerId}/${t.customerId}">צפייה בשיחה המלאה</a></td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין לא נשלחו הודעות פרטיות באתר.</p>`}
  </div>

  <div class="panel" id="youcan-club" style="scroll-margin-top:90px;" data-badge="${youCanPending.length}">
    <h3>🎟️ מועדון YouCan (${youCanMembers.length} חברות פעילות)</h3>
    <p class="muted">${d.settings.youCanEnabled ? "המועדון פעיל - לקוחה שאינה חברה רואה הסבר וקישור הצטרפות במקום קוד הקופון עצמו. שאר האתר נשאר פתוח בדיוק כמו תמיד." : "המועדון כבוי כרגע - כל לקוחה רואה ולוחצת על קוד הקופון בדיוק כמו היום, בלי שום הגבלה."}</p>
    <form method="post" action="/admin/toggle-youcan">
      <button class="btn btn-small" type="submit">${d.settings.youCanEnabled ? "כיבוי המועדון" : "הפעלת המועדון"}</button>
    </form>
    <form method="post" action="/admin/youcan/settings" style="margin-top:14px;">
      <label>מחיר חודשי (ש"ח)
      <input type="number" name="youCanMonthlyPrice" min="0" step="1" value="${esc(String(d.settings.youCanMonthlyPrice || 13))}" /></label>
      <label>קישור לדף סליקה חיצוני (רק ברגע שיש - השאירי ריק בינתיים, זה עובר אוטומטית לתשלום ידני)
      <input type="text" name="youCanPaymentUrl" value="${esc(d.settings.youCanPaymentUrl || "")}" placeholder="https://..." /></label>
      <label>הוראות תשלום ידניות (ביט/העברה בנקאית - מוצג בדף ההצטרפות כל עוד אין קישור סליקה)
      <textarea name="youCanPaymentInstructions" placeholder="לדוגמה: ביט למספר 05X-XXXXXXX, ואז ללחוץ על 'שילמתי'.">${esc(d.settings.youCanPaymentInstructions || "")}</textarea></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירה</button>
    </form>
    ${youCanPending.length ? `
    <h4 style="margin-top:18px;">ממתינות לאישור תשלום (${youCanPending.length})</h4>
    <div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>מייל</th><th>תאריך בקשה</th><th>פעולה</th></tr>
      ${youCanPending.map((c) => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(new Date(c.youCanRequestedAt).toLocaleDateString("he-IL"))}</td>
        <td><form method="post" action="/admin/customer/${c.id}/approve-youcan"><button class="btn btn-small" type="submit">אישור והפעלה</button></form></td>
      </tr>`).join("")}
    </table></div>` : ""}
    ${youCanMembers.length ? `
    <h4 style="margin-top:18px;">חברות פעילות (${youCanMembers.length})</h4>
    <div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>מייל</th><th>הופעלה ב-</th><th>פעולה</th></tr>
      ${youCanMembers.map((c) => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${c.youCanActivatedAt ? esc(new Date(c.youCanActivatedAt).toLocaleDateString("he-IL")) : "-"}</td>
        <td><form method="post" action="/admin/customer/${c.id}/revoke-youcan" onsubmit="return confirm('לבטל את החברות של ${esc(c.name)} במועדון?');"><button class="btn btn-small btn-outline" type="submit">ביטול חברות</button></form></td>
      </tr>`).join("")}
    </table></div>` : ""}
  </div>

  <div class="panel" id="tier-upgrade-requests" style="scroll-margin-top:90px;" data-badge="${tierUpgradeRequests.length}">
    <h3>⭐ בקשות שדרוג לרמת "מומלצת" (${tierUpgradeRequests.length})</h3>
    <p class="muted">עצמאיות ברמת "בסיסית" שלחו בקשה לשדרג מהאזור האישי שלהן - סדרי איתן תשלום, ואז אשרי כאן (זה גם מסמן את הבקשה כטופלה).</p>
    ${tierUpgradeRequests.length ? `
    <div class="table-scroll"><table class="table-simple"><tr><th>עסק</th><th>מייל</th><th>תאריך בקשה</th><th>פעולה</th></tr>
      ${tierUpgradeRequests.map((f) => `<tr>
        <td>${esc(f.businessName || f.name)}</td><td>${esc(f.email)}</td><td>${esc(new Date(f.tierUpgradeRequestedAt).toLocaleDateString("he-IL"))}</td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-tier"><button class="btn btn-small" type="submit">אישור שדרוג ל"מומלצת"</button></form></td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">אין בקשות ממתינות כרגע.</p>`}
  </div>

  <div class="panel" id="freelancer-statuses" style="scroll-margin-top:90px;" data-badge="${allActiveStatuses.length}">
    <h3>📸 סטטוסים 24 שעות (${allActiveStatuses.length} פעילים עכשיו)</h3>
    <p class="muted">${d.settings.freelancerStatusesEnabled ? "פעיל - עצמאיות ברמת \"מומלצת\" יכולות להעלות סטטוס (עד 3 בו-זמנית, נעלם אוטומטית אחרי 24 שעות), ולקוחות רואות אותו בעיגולים בפס הקבוע באתר." : "כבוי כרגע - שום עיגול לא מוצג באתר, ואי אפשר להעלות סטטוס חדש."}</p>
    <form method="post" action="/admin/toggle-freelancer-statuses">
      <button class="btn btn-small" type="submit">${d.settings.freelancerStatusesEnabled ? "כיבוי הפיצ'ר" : "הפעלת הפיצ'ר"}</button>
    </form>
    <form method="post" action="/admin/freelancer-statuses-position" style="margin-top:14px;">
      <label>מיקום פס הסטטוסים באתר
      <select name="position">
        <option value="bottom" ${d.settings.freelancerStatusesPosition !== "side" ? "selected" : ""}>פס קבוע בתחתית</option>
        <option value="side" ${d.settings.freelancerStatusesPosition === "side" ? "selected" : ""}>עמודה קבועה בצד ימין</option>
      </select></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירה</button>
    </form>
    ${allActiveStatuses.length ? `
    <h4 style="margin-top:18px;">כל הסטטוסים הפעילים כרגע</h4>
    <div class="table-scroll"><table class="table-simple"><tr><th>תצוגה</th><th>עסק</th><th>סוג</th><th>הועלה</th><th>💗</th><th>פעולה</th></tr>
      ${allActiveStatuses.map((s) => {
        const owner = d.freelancers.find((x) => x.id === s.freelancerId);
        return `<tr>
        <td>${s.type === "video" ? `<video src="${esc(s.url)}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;" muted></video>` : `<img src="${esc(s.url)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:6px;" />`}</td>
        <td>${esc(owner ? (owner.businessName || owner.name) : "עצמאית שנמחקה")}</td>
        <td>${s.type === "video" ? "סרטון" : "תמונה"}</td>
        <td>${esc(new Date(s.createdAt).toLocaleString("he-IL"))}</td>
        <td>${s.heartCount || 0}</td>
        <td><form method="post" action="/admin/status/${s.id}/delete"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`;
      }).join("")}
    </table></div>` : ""}
  </div>

  <div class="panel" id="locked-accounts" style="scroll-margin-top:90px;" data-badge="${lockedCustomers.length}">
    <h3>🔒 חשבונות שננעלו אוטומטית (${lockedCustomers.length})</h3>
    <p class="muted">חשבון לקוח נחסם אוטומטית בהרשמה אם סומן "גבר" - הוא לא קיבל שום מייל ולא יכול להתחבר, עד שתאשרי ותפתחי אותו כאן ידנית.</p>
    ${lockedCustomers.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>מייל</th><th>תאריך הרשמה</th><th>פעולה</th></tr>
      ${lockedCustomers.map((c) => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(new Date(c.createdAt).toLocaleDateString("he-IL"))}</td>
        <td><form method="post" action="/admin/customer/${c.id}/unlock"><button class="btn btn-small" type="submit">אישור ופתיחה</button></form></td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">אין כרגע חשבונות נעולים.</p>`}
  </div>

  <div class="panel">
    <h3>מחיר מודעה</h3>
    <p class="muted">מחיר ייחוס למודעה בצד העמוד (לשימוש שלך כשאת סוגרת עם עצמאית על פרסום - אין כרגע גבייה אוטומטית באתר, את מסמנת ידנית בטבלה למעלה מתי מודעה שולמה).</p>
    <form method="post" action="/admin/ad-price">
      <label>מחיר (₪ לחודש)
      <input type="number" name="adPrice" min="0" step="1" value="${esc(String(d.settings.adPrice ?? ""))}" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שמירה</button>
    </form>
  </div>

  <div class="panel">
    <h3>ייבוא עצמאיות בכמות (מאקסל)</h3>
    <p class="muted">יש לך רשימה של הרבה עצמאיות באקסל? סדרי את העמודות בסדר הזה: שם איש קשר, שם העסק, תחום (בדיוק כפי שכתוב ברשימת התחומים למטה), תת-תחום (אופציונלי, בדיוק כפי שכתוב ברשימת תתי-התחומים של אותו תחום), עיר (בדיוק כפי שכתוב ברשימת הערים - אפשר להשאיר ריק אם אין), טלפון, תיאור קצר, טקסט ההטבה, אינסטגרם (אופציונלי), קישור - וואטסאפ או אתר/תיק עבודות (אופציונלי), אימייל (אופציונלי, אבל בלעדיו לא יישלח מייל עם פרטי התחברות). אחר כך סמני את השורות באקסל (בלי כותרות), העתיקי (Ctrl+C) והדביקי (Ctrl+V) כאן למטה - זה יעבוד ישירות, שורה לכל עצמאית. כל מי שתיובא תיכנס ישר כמאושרת עם קוד קופון אוטומטי.</p>
    <form method="post" action="/admin/bulk-import">
      <textarea name="rows" style="min-height:180px;" placeholder="הדביקי כאן ישירות מאקסל..."></textarea>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">ייבוא הרשימה</button>
    </form>
  </div>

  <div class="panel" id="categories-management" style="scroll-margin-top:90px;">
    <h3>התחומים ותתי-התחומים באתר</h3>
    <p class="muted">אפשר לשנות שם לתחום/תת-תחום או למחוק אותו - אבל אי אפשר למחוק תחום או תת-תחום שעדיין משויכים אליו עסקים/בקשות/שאלות בפועל (כדי לא להשאיר עסק בלי שיוך). אם המחיקה חסומה, אפשר לשייך את מה שמשתמש בזה לתחום/תת-תחום אחר קודם, בפאנל "שיוך מחדש" למטה - ורק אז למחוק.</p>
    ${d.categories.map((c) => {
      const catUsage = categoryUsageCount(d, c.id);
      return `
      <div style="border:1px solid #eee2d8;border-radius:12px;padding:14px;margin-top:14px;">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between;">
          <form method="post" action="/admin/category/${c.id}/rename" style="display:flex;gap:8px;align-items:center;flex:1;min-width:220px;margin:0;">
            <input type="text" name="name" value="${esc(c.name)}" required style="flex:1;" />
            <button class="btn btn-small" type="submit">שינוי שם</button>
          </form>
          <form method="post" action="/admin/category/${c.id}/delete" style="margin:0;" onsubmit="return confirm('למחוק את התחום ' + ${JSON.stringify(c.name)} + '?');">
            <button class="btn btn-small btn-outline" type="submit" ${catUsage ? `disabled title="בשימוש ע&quot;י ${catUsage} רשומות - אי אפשר למחוק"` : ""}>מחיקת התחום${catUsage ? ` (בשימוש ע"י ${catUsage})` : ""}</button>
          </form>
        </div>
        <div style="margin-top:12px;padding-inline-start:16px;border-inline-start:2px solid #eee2d8;">
          ${(c.subcategories || []).length ? (c.subcategories || []).map((s) => {
            const subUsage = subcategoryUsageCount(d, c.id, s.id);
            return `
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;">
              <form method="post" action="/admin/subcategory/${c.id}/${s.id}/rename" style="display:flex;gap:6px;align-items:center;flex:1;min-width:200px;margin:0;">
                <input type="text" name="name" value="${esc(s.name)}" required style="flex:1;" />
                <button class="btn btn-small btn-outline" type="submit">שינוי שם</button>
              </form>
              <form method="post" action="/admin/subcategory/${c.id}/${s.id}/delete" style="margin:0;" onsubmit="return confirm('למחוק את תת-התחום ' + ${JSON.stringify(s.name)} + '?');">
                <button class="btn btn-small btn-outline" type="submit" ${subUsage ? `disabled title="בשימוש ע&quot;י ${subUsage} רשומות - אי אפשר למחוק"` : ""}>מחיקה${subUsage ? ` (בשימוש ע"י ${subUsage})` : ""}</button>
              </form>
            </div>`;
          }).join("") : `<p class="muted" style="margin:6px 0;">אין עדיין תת-תחום בתחום הזה.</p>`}
          <form method="post" action="/admin/subcategory" style="margin-top:8px;display:flex;gap:8px;max-width:360px;">
            <input type="hidden" name="categoryId" value="${c.id}" />
            <input type="text" name="name" placeholder="תת-תחום חדש" required style="flex:1;" />
            <button class="btn btn-small" type="submit">הוספת תת-תחום</button>
          </form>
        </div>
      </div>`;
    }).join("")}
    <form method="post" action="/admin/category" style="margin-top:16px;max-width:360px;">
      <input type="text" name="name" placeholder="תחום חדש" required />
      <button class="btn btn-small" style="margin-top:10px;" type="submit">הוספת תחום חדש</button>
    </form>
  </div>

  <div class="panel" id="category-reassign" style="scroll-margin-top:90px;">
    <h3>שיוך מחדש של עסק לתחום/תת-תחום אחר</h3>
    <p class="muted">בוחרים עסק (התחום/התת-תחום הנוכחיים שלו מופיעים ליד השם), ואז את התחום החדש ותת-התחום החדש - אפשר לבחור תת-תחום קיים מהרשימה, או להקליד שם לתת-תחום חדש (הוא ייווצר רק אם תקלידי שם כאן, בפעולה מפורשת - אף פעם לא נוצר תת-תחום אוטומטית). שימי לב: הכלי הזה משייך את התחום/התת-תחום ה<strong>ראשי</strong> של העסק - אם יש לה גם "תחומים נוספים" בפרופיל, הם לא מושפעים מכאן.</p>
    <form method="post" action="/admin/reassign-listing">
      <label>עסק
        <select name="freelancerId" required>
          <option value="">בחרי עסק</option>
          ${d.freelancers.slice().sort((a, b) => (a.businessName || a.name || "").localeCompare(b.businessName || b.name || "", "he")).map((f) => `<option value="${f.id}">${esc(f.businessName || f.name)} - ${esc(catName(d, f.categoryId))}${subcatNames(d, f.categoryId, f.subcategoryIds) ? " / " + esc(subcatNames(d, f.categoryId, f.subcategoryIds)) : ""}</option>`).join("")}
        </select>
      </label>
      <label>תחום חדש
        <select name="categoryId" id="scReassignCategory" required onchange="scUpdateSubcats(this, document.getElementById('scReassignSubcat'), '');">
          <option value="">בחרי תחום</option>${d.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
        </select>
      </label>
      <label>תת-תחום קיים (לא חובה אם ממלאים תת-תחום חדש למטה)
        <select name="subcategoryId" id="scReassignSubcat"><option value="">בחרי קודם תחום למעלה</option></select>
      </label>
      <label>או תת-תחום חדש (ייווצר רק אם ממלאים כאן)
        <input type="text" name="newSubcategoryName" placeholder="השאירי ריק אם לא צריך תת-תחום חדש" />
      </label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">שיוך מחדש</button>
    </form>
  </div>

  <div class="panel">
    <h3>הערים באתר (${d.cities.length})</h3>
    <p class="muted">חסרה עיר ברשימה? אפשר להוסיף אותה כאן - היא תופיע מיד גם בטופס ההרשמה וגם בייבוא באלק.</p>
    <div class="cat-grid" style="max-height:220px;overflow-y:auto;">${d.cities.map((c) => `<div class="cat-card">${esc(c.name)}</div>`).join("")}</div>
    <form method="post" action="/admin/city" style="margin-top:14px;max-width:360px;">
      <input type="text" name="name" placeholder="עיר/יישוב חדש" required />
      <button class="btn btn-small" style="margin-top:10px;" type="submit">הוספה</button>
    </form>
  </div>
  </div>
  `;
  sendHtml(res, 200, page({ title: "ניהול", session: ctx.session, body, query, noSidebars: true }));
});

route("POST", "/admin/weekly-message", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.weeklyMessage = body.get("weeklyMessage");
  d.settings.freelancerOfWeekId = body.get("freelancerOfWeekId") || null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן - זה מה שיראו עכשיו בדף הבית, למשך שבוע אחד (אח\"כ התור האוטומטי ממשיך).")}`);
});

// Manual one-cycle pin for "story of the week" - same one-week grace mechanic as
// freelancerOfWeekId above (see tickRotation), cleared automatically at the next Wednesday
// 20:00 boundary so the automatic rotation resumes exactly where it paused.
route("POST", "/admin/story-of-week", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.storyOfWeekId = body.get("storyOfWeekId") || null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן - זה הסיפור שיוצג עכשיו, למשך שבוע אחד (אח\"כ התור האוטומטי ממשיך).")}`);
});

// Lets the admin control how many days each story stays featured before the automatic
// rotation moves to the next one (see storyRotationDays / getCurrentStory / tickRotation).
// Takes effect going forward only - it changes when the NEXT boundary lands, it never moves
// the current story's remaining time backward or forward retroactively.
route("POST", "/admin/story-rotation-days", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  let days = parseInt(body.get("days"), 10);
  if (!Number.isFinite(days) || days < 1) days = 7;
  if (days > 60) days = 60;
  d.settings.storyRotationDays = days;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן - הסיפור הבא יתחלף לפי התדירות החדשה.")}`);
});

// A direct message from the admin to one specific freelancer - shown inside her own dashboard
// AND always sent to her email too (not just as a push-unavailable fallback like notify()'s
// usual behaviour elsewhere in the app - here Sapir explicitly wants both channels every time,
// since this is meant to reliably reach her about something specific).
route("POST", "/admin/message-freelancer", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === body.get("freelancerId"));
  const text = (body.get("text") || "").trim();
  if (!f || !text) {
    return redirect(res, `/admin?err=${encodeURIComponent("יש לבחור עצמאית ולכתוב הודעה.")}`);
  }
  // context (לא חובה) מגיע רק מכפתורי "שליחת הודעה" שמופיעים ליד פריט ספציפי בתור אישור (ר.
  // messageFreelancerButtonHtml למעלה) - למשל "משפט ההשראה ששלחה לאישור". כשהוא קיים, הוא
  // נכנס לכותרת ההתראה/המייל, כדי שהיא תדע מיד על מה ההודעה מדברת בלי לפתוח אותה קודם. בפאנל
  // הכללי "שליחת הודעה לעצמאית" (בחירה ידנית מרשימה) אין context, אז חוזרים לכותרת הגנרית.
  const context = (body.get("context") || "").trim();
  const pushTitle = context ? `קיבלת הודעה לגבי ${context}` : "הודעה מהנהלת SheCan";
  const emailSubject = context ? `הודעה לגבי ${context} - SheCan` : "הודעה חדשה מהנהלת SheCan";
  d.adminMessages = d.adminMessages || [];
  d.adminMessages.push({ id: db.nextId("adminMessage"), freelancerId: f.id, text, context, date: new Date().toISOString(), read: false });
  db.save();
  sendPushToUser(f, { title: pushTitle, body: text.slice(0, 140), url: "/freelancer-dashboard" }).catch(() => {});
  if (hasRealEmail(f)) {
    sendEmail(f.email, emailSubject,
      `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(f.name || "")},</p><p>קיבלת הודעה מהנהלת SheCan${context ? ` לגבי <strong>${esc(context)}</strong>` : ""}:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(text)}</p><p>אפשר לראות אותה גם באזור האישי שלך באתר.</p></div>`
    ).catch(() => {});
  }
  redirect(res, `/admin?ok=${encodeURIComponent("ההודעה נשלחה ל" + (f.businessName || f.name) + "!")}`);
});

// גרסה מקבילה עבור לקוחה עם חשבון רשום (ר' messageCustomerButtonHtml למעלה) - כרגע רק מכפתור
// "שליחת הודעה" ליד פריט ב"מכירת יד 2" (הסוג היחיד במאגרי הקהילה, מלבד מסירות, עם customerId
// אמיתי). נשמר במאגר נפרד d.customerAdminMessages ומוצג באזור האישי של הלקוחה (ר' GET /account).
route("POST", "/admin/message-customer", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const customer = d.customers.find((x) => x.id === body.get("customerId"));
  const text = (body.get("text") || "").trim();
  if (!customer || !text) {
    return redirect(res, `/admin?err=${encodeURIComponent("יש לבחור לקוחה ולכתוב הודעה.")}`);
  }
  const context = (body.get("context") || "").trim();
  const pushTitle = context ? `קיבלת הודעה לגבי ${context}` : "הודעה מהנהלת SheCan";
  const emailSubject = context ? `הודעה לגבי ${context} - SheCan` : "הודעה חדשה מהנהלת SheCan";
  d.customerAdminMessages = d.customerAdminMessages || [];
  d.customerAdminMessages.push({ id: db.nextId("customerAdminMessage"), customerId: customer.id, text, context, date: new Date().toISOString(), read: false });
  db.save();
  sendPushToUser(customer, { title: pushTitle, body: text.slice(0, 140), url: "/account" }).catch(() => {});
  if (hasRealEmail(customer)) {
    sendEmail(customer.email, emailSubject,
      `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(customer.name || "")},</p><p>קיבלת הודעה מהנהלת SheCan${context ? ` לגבי <strong>${esc(context)}</strong>` : ""}:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(text)}</p><p>אפשר לראות אותה גם באזור האישי שלך באתר.</p></div>`
    ).catch(() => {});
  }
  redirect(res, `/admin?ok=${encodeURIComponent("ההודעה נשלחה ל" + (customer.name || "הלקוחה") + "!")}`);
});

// עבור פריטים במאגרי הקהילה שנשלחים בלי חשבון מחובר (ר' emailListingSubmitterButtonHtml למעלה)
// - מייל ישיר לכתובת שהיא מילאה בטופס עצמו, בלי עותק ב-DB ובלי התראה באתר, כי אין לה חשבון/
// תיבת דואר להציג בו את זה. אם היא לא מילאה מייל, אין שום נתיב יצירת קשר, אז חוסמים כאן גם
// בצד השרת (לא רק מסתירים את הכפתור בתצוגה).
route("POST", "/admin/community/:id/email-submitter", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const listing = (d.communityListings || []).find((x) => x.id === params.id);
  const text = (body.get("text") || "").trim();
  if (!listing || !listing.email || !text) {
    return redirect(res, `/admin?err=${encodeURIComponent("אין למי לשלוח - חסרה כתובת מייל או תוכן הודעה.")}`);
  }
  await sendEmail(listing.email, `הודעה לגבי "${listing.title}" ב-SheCan`,
    `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי${listing.contactName ? ` ${esc(listing.contactName)}` : ""},</p><p>קיבלת הודעה מהנהלת SheCan לגבי הפריט שפרסמת, <strong>${esc(listing.title)}</strong>:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(text)}</p></div>`
  ).catch(() => {});
  redirect(res, `/admin?ok=${encodeURIComponent("המייל נשלח!")}`);
});

route("POST", "/admin/ad-price", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const price = Number(body.get("adPrice"));
  d.settings.adPrice = Number.isFinite(price) && price >= 0 ? price : null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("מחיר המודעה עודכן.")}`);
});

route("POST", "/admin/change-password", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const currentPassword = body.get("currentPassword") || "";
  const newPassword = body.get("newPassword") || "";
  const d = db.load();
  const admin = d.admins.find((a) => a.id === ctx.session.id) || d.admins[0];
  if (!auth.verifyPassword(currentPassword, admin.passwordHash)) {
    return redirect(res, `/admin?err=${encodeURIComponent("הסיסמה הנוכחית שגויה - נסי שוב.")}`);
  }
  if (newPassword.length < 6) {
    return redirect(res, `/admin?err=${encodeURIComponent("הסיסמה החדשה חייבת להיות באורך 6 תווים לפחות.")}`);
  }
  admin.passwordHash = auth.hashPassword(newPassword);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הסיסמה עודכנה בהצלחה!")}`);
});

// Lets the admin move her login to a new email address herself (e.g. switching from the
// default admin@shecan.co.il to a dedicated business Gmail) - same "confirm with current
// password" pattern as change-password above, so a stolen session alone isn't enough to
// take over the login identity.
route("POST", "/admin/change-email", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const currentPassword = body.get("currentPassword") || "";
  const newEmail = (body.get("newEmail") || "").trim().toLowerCase();
  const d = db.load();
  const admin = d.admins.find((a) => a.id === ctx.session.id) || d.admins[0];
  if (!auth.verifyPassword(currentPassword, admin.passwordHash)) {
    return redirect(res, `/admin?err=${encodeURIComponent("הסיסמה הנוכחית שגויה - נסי שוב.")}`);
  }
  if (!newEmail || !newEmail.includes("@")) {
    return redirect(res, `/admin?err=${encodeURIComponent("כתובת המייל לא תקינה.")}`);
  }
  if (d.admins.some((a) => a.id !== admin.id && a.email === newEmail)) {
    return redirect(res, `/admin?err=${encodeURIComponent("כתובת המייל הזו כבר בשימוש על ידי מנהלת אחרת.")}`);
  }
  admin.email = newEmail;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("כתובת המייל להתחברות עודכנה - מעכשיו תתחברי איתה.")}`);
});

route("POST", "/admin/logo", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const d = db.load();
  const dataUri = fileToDataUri(body.files.logo, MAX_UPLOAD_BYTES);
  if (dataUri) d.settings.siteLogoDataUri = dataUri;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(dataUri ? "הלוגו עודכן!" : "לא התקבלה תמונה תקינה - נסי שוב.")}`);
});

route("POST", "/admin/logo/remove", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.siteLogoDataUri = null;
  d.settings.showLogoOnDealBadge = false;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("חזרנו לוורדמארק הטקסט.")}`);
});

// "לוגו ברירת מחדל לעסקים" - התמונה שמוצגת אוטומטית בכל מקום שמראה תמונת/לוגו עסק (כרטיסיית
// מודעה/עסק מוביל, כרטיסיית עסק בגריד, עמוד הפרופיל המלא) עבור עסק שלא העלה תמונת פרופיל או
// לוגו משלו. ר' d.settings.defaultBusinessLogoDataUri ב-db.js ו-avatarUri/cardPhotoHtml
// ב-server.js. אותו דפוס בדיוק כמו לוגו האתר למעלה - ספיר יכולה להחליף בכל שלב.
route("POST", "/admin/default-business-logo", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const d = db.load();
  const dataUri = fileToDataUri(body.files.defaultBusinessLogo, MAX_UPLOAD_BYTES);
  if (dataUri) d.settings.defaultBusinessLogoDataUri = dataUri;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(dataUri ? "לוגו ברירת המחדל לעסקים עודכן!" : "לא התקבלה תמונה תקינה - נסי שוב.")}`);
});

route("POST", "/admin/default-business-logo/remove", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.defaultBusinessLogoDataUri = null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הוסר - עסק בלי תמונה/לוגו משלו יחזור להציג ראשי תיבות.")}`);
});

route("POST", "/admin/top-banner", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const d = db.load();
  const dataUri = fileToDataUri(body.files.banner, MAX_UPLOAD_BYTES);
  if (dataUri) d.settings.topBannerDataUri = dataUri;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(dataUri ? "הבאנר עודכן!" : "לא התקבלה תמונה תקינה - נסי שוב.")}`);
});

route("POST", "/admin/top-banner/remove", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.topBannerDataUri = null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הבאנר הוסר.")}`);
});

route("POST", "/admin/background", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const d = db.load();
  const dataUri = fileToDataUri(body.files.background, MAX_UPLOAD_BYTES);
  if (dataUri) d.settings.siteBackgroundImageDataUri = dataUri;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(dataUri ? "תמונת הרקע עודכנה!" : "לא התקבלה תמונה תקינה - נסי שוב.")}`);
});

route("POST", "/admin/background/remove", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.siteBackgroundImageDataUri = null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("תמונת הרקע הוסרה.")}`);
});

route("POST", "/admin/about-text", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.aboutText = body.get("aboutText") || "";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent('עמוד "מי אנחנו" עודכן!')}`);
});

route("POST", "/admin/support-knowledge-base", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.supportKnowledgeBase = clip((body.get("supportKnowledgeBase") || "").trim(), 12000);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("מסמך המדיניות/FAQ עודכן!")}#ai-support-assistant`);
});

route("POST", "/admin/ai-search-toggle", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.aiSearchEnabled = body.get("enable") === "1";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.aiSearchEnabled ? "חיפוש ה-AI בעמוד החיפוש הופעל!" : "חיפוש ה-AI בעמוד החיפוש כובה - עובר לגרסה החינמית.")}#ai-support-assistant`);
});

route("POST", "/admin/terms-text", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.termsText = body.get("termsText") || "";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("התקנון עודכן!")}`);
});

route("POST", "/admin/privacy-text", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.privacyPolicyText = body.get("privacyPolicyText") || "";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("מדיניות הפרטיות עודכנה!")}`);
});

route("POST", "/admin/accessibility-text", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.accessibilityStatementText = body.get("accessibilityStatementText") || "";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הצהרת הנגישות עודכנה!")}`);
});

route("POST", "/admin/message/:id/read", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const m = (d.contactMessages || []).find((x) => x.id === params.id);
  if (m) m.read = true;
  db.save();
  redirect(res, "/admin");
});

// מחיקת הודעת "צרי קשר" בודדת - נוסף 2026-08-31 כדי לאפשר ניקוי הודעות ספאם (ר' ההגנה
// החדשה על הטופס עצמו ב-POST /contact, וההערה המלאה ליד isContactRateLimited) בלי לגעת
// בהודעות אמיתיות אחרות.
route("POST", "/admin/message/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.contactMessages = (d.contactMessages || []).filter((x) => x.id !== params.id);
  db.save();
  redirect(res, "/admin");
});

route("POST", "/admin/community-links", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.communityWhatsappLink = (body.get("communityWhatsappLink") || "").trim();
  d.settings.contactEmail = (body.get("contactEmail") || "").trim();
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן!")}`);
});

route("POST", "/admin/referral-settings", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.customerReferralContestActive = body.get("customerReferralContestActive") === "1";
  d.settings.customerReferralContestEndDate = (body.get("customerReferralContestEndDate") || "").trim();
  d.settings.customerReferralAnnounceDate = (body.get("customerReferralAnnounceDate") || "").trim();
  // הערה חופשית שמוצגת ללקוחות/לעצמאיות ליד המבצע שלהן (למשל "המבצע הוארך!") - לפי בקשה
  // מפורשת 2026-08-30. אופציונלי - ריקה כברירת מחדל, לא מוצגת בכלל אם לא מולאה.
  d.settings.customerReferralPromoNote = clip((body.get("customerReferralPromoNote") || "").trim(), 200);
  d.settings.freelancerReferralContestActive = body.get("freelancerReferralContestActive") === "1";
  d.settings.freelancerReferralContestEndDate = (body.get("freelancerReferralContestEndDate") || "").trim();
  d.settings.freelancerReferralAnnounceDate = (body.get("freelancerReferralAnnounceDate") || "").trim();
  d.settings.freelancerReferralPromoNote = clip((body.get("freelancerReferralPromoNote") || "").trim(), 200);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הגדרות התחרות עודכנו!")}`);
});

// עדכון מהיר של תאריך סיום/הכרזה + הערה למבצע אחד בלבד (עצמאיות או לקוחות) - ישירות מפאנל
// "מרוץ ההפניות...מי מובילה" ב-GET /admin, בלי לגעת בכלל בשדות של המבצע השני או בטוגל "פעיל"
// (ר' ההערה על כך למעלה, ליד הטופס עצמו) - נתיב נפרד ומצומצם בכוונה, כדי שלא יהיה סיכון לאפס
// בטעות שדות שלא מוצגים בטופס הקטן הזה.
route("POST", "/admin/referral-settings/quick-update", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const which = body.get("which") === "customer" ? "customer" : "freelancer";
  d.settings[`${which}ReferralContestEndDate`] = (body.get("endDate") || "").trim();
  d.settings[`${which}ReferralAnnounceDate`] = (body.get("announceDate") || "").trim();
  d.settings[`${which}ReferralPromoNote`] = clip((body.get("note") || "").trim(), 200);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("המבצע עודכן!")}#${which}-referral-race`);
});

// הכרזת מנצחת מרוץ ההפניות ופרסום אמיתי בדף הבית עד תאריך שהיא בוחרת - ר' getWeeklyFeature
// למעלה בקובץ שממש נותן לזה עדיפות בתצוגה. "until" הוא מחרוזת "YYYY-MM-DD" (מגיע מ-<input
// type="date">) - אותו פורמט בדיוק כמו israelDayKeyOffset, כדי שההשוואה בין השניים תהיה פשוטה
// והשוואת מחרוזות רגילה (עובד כי שני הצדדים תמיד "YYYY-MM-DD").
route("POST", "/admin/referral-settings/set-winner", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const f = d.freelancers.find((x) => x.id === body.get("freelancerId"));
  const until = (body.get("until") || "").trim();
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return redirect(res, `/admin?err=${encodeURIComponent("יש לבחור עצמאית ותאריך תקין.")}#freelancer-referral-race`);
  }
  d.settings.freelancerReferralWinnerId = f.id;
  d.settings.freelancerReferralWinnerUntil = until;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`${f.businessName || f.name} תוצג כ"העסק המוביל" בדף הבית עד ה-${until}!`)}#freelancer-referral-race`);
});

route("POST", "/admin/referral-settings/clear-winner", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.freelancerReferralWinnerId = null;
  d.settings.freelancerReferralWinnerUntil = null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הפרסום בוטל - חוזרים לרוטציה הרגילה.")}#freelancer-referral-race`);
});

// תיקון רטרואקטיבי של שיוך הפניה - לפי בקשה מפורשת 2026-08-30 (לקוחה טענה שהפנתה חברות בפועל
// והן לא נספרו, ככל הנראה כי הקישור האישי לא שרד עד לשליחת טופס ההרשמה - ר' /signup, שקיבל
// באותו עדכון גיבוי ידני לפי מייל להרשמות עתידיות; זה הכלי המקביל לתקן מי שכבר נרשמה בעבר בלי
// שהקישור עבד). זיהוי לפי מייל משני הצדדים - השארת "מייל מי שהזמינה" ריק מנקה שיוך קיים בלי
// למחוק את הרשומה עצמה.
route("POST", "/admin/customer/fix-referral", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const customerEmail = (body.get("customerEmail") || "").trim().toLowerCase();
  const referrerEmail = (body.get("referrerEmail") || "").trim().toLowerCase();
  const customer = d.customers.find((c) => (c.email || "").toLowerCase() === customerEmail);
  if (!customer) {
    return redirect(res, `/admin?err=${encodeURIComponent("לא נמצאה לקוחה עם המייל הזה.")}#customer-referral-race`);
  }
  if (!referrerEmail) {
    customer.referredByCustomerId = null;
    db.save();
    return redirect(res, `/admin?ok=${encodeURIComponent(`שיוך ההפניה של ${customer.name} נוקה.`)}#customer-referral-race`);
  }
  const referrer = d.customers.find((c) => (c.email || "").toLowerCase() === referrerEmail);
  if (!referrer || referrer.id === customer.id) {
    return redirect(res, `/admin?err=${encodeURIComponent("לא נמצאה לקוחה מזמינה עם המייל הזה (או שזה אותו מייל).")}#customer-referral-race`);
  }
  customer.referredByCustomerId = referrer.id;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`${customer.name} שויכה כהפניה של ${referrer.name}.`)}#customer-referral-race`);
});

route("POST", "/admin/customer/:id/unlock", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === params.id);
  if (!customer) return redirect(res, "/admin#locked-accounts");
  customer.accountLocked = false;
  customer.accountUnlockedAt = new Date().toISOString();
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`החשבון של ${customer.name} נפתח - היא יכולה להתחבר עכשיו.`)}#locked-accounts`);
});

route("POST", "/admin/toggle-youcan", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.youCanEnabled = !d.settings.youCanEnabled;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.youCanEnabled ? "מועדון YouCan הופעל." : "מועדון YouCan כובה - קוד הקופון פתוח שוב לכולן.")}#youcan-club`);
});

route("POST", "/admin/youcan/settings", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const price = Number(body.get("youCanMonthlyPrice"));
  d.settings.youCanMonthlyPrice = Number.isFinite(price) && price >= 0 ? price : (d.settings.youCanMonthlyPrice || 13);
  d.settings.youCanPaymentUrl = (body.get("youCanPaymentUrl") || "").trim();
  d.settings.youCanPaymentInstructions = (body.get("youCanPaymentInstructions") || "").trim();
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן!")}#youcan-club`);
});

route("POST", "/admin/customer/:id/approve-youcan", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === params.id);
  if (!customer) return redirect(res, "/admin#youcan-club");
  customer.youCanMember = true;
  customer.youCanActivatedAt = new Date().toISOString();
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`מועדון YouCan הופעל אצל ${customer.name}.`)}#youcan-club`);
});

route("POST", "/admin/customer/:id/revoke-youcan", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const customer = d.customers.find((c) => c.id === params.id);
  if (!customer) return redirect(res, "/admin#youcan-club");
  customer.youCanMember = false;
  customer.youCanRequestedAt = null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`חברות המועדון של ${customer.name} בוטלה.`)}#youcan-club`);
});

route("POST", "/admin/toggle-freelancer-statuses", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.freelancerStatusesEnabled = !d.settings.freelancerStatusesEnabled;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.freelancerStatusesEnabled ? "סטטוסים 24 שעות הופעלו." : "סטטוסים 24 שעות כובו.")}#freelancer-statuses`);
});

route("POST", "/admin/freelancer-statuses-position", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  d.settings.freelancerStatusesPosition = body.get("position") === "side" ? "side" : "bottom";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן!")}#freelancer-statuses`);
});

route("POST", "/admin/status/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const s = (d.freelancerStatuses || []).find((x) => x.id === params.id);
  if (s) {
    const filename = (s.url || "").split("/").pop();
    if (filename) { try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch (e) {} }
    d.freelancerStatuses = d.freelancerStatuses.filter((x) => x.id !== s.id);
    db.save();
  }
  redirect(res, `/admin?ok=${encodeURIComponent("הסטטוס נמחק.")}#freelancer-statuses`);
});

route("POST", "/admin/freelancer/fix-referral", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const freelancerEmail = (body.get("freelancerEmail") || "").trim().toLowerCase();
  const referrerEmail = (body.get("referrerEmail") || "").trim().toLowerCase();
  const freelancer = d.freelancers.find((f) => (f.email || "").toLowerCase() === freelancerEmail);
  if (!freelancer) {
    return redirect(res, `/admin?err=${encodeURIComponent("לא נמצאה עצמאית עם המייל הזה.")}#freelancer-referral-race`);
  }
  if (!referrerEmail) {
    freelancer.referredByFreelancerId = null;
    db.save();
    return redirect(res, `/admin?ok=${encodeURIComponent(`שיוך ההפניה של ${freelancer.businessName || freelancer.name} נוקה.`)}#freelancer-referral-race`);
  }
  const referrer = d.freelancers.find((f) => (f.email || "").toLowerCase() === referrerEmail);
  if (!referrer || referrer.id === freelancer.id) {
    return redirect(res, `/admin?err=${encodeURIComponent("לא נמצאה עצמאית מזמינה עם המייל הזה (או שזה אותו מייל).")}#freelancer-referral-race`);
  }
  freelancer.referredByFreelancerId = referrer.id;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`${freelancer.businessName || freelancer.name} שויכה כהפניה של ${referrer.businessName || referrer.name}.`)}#freelancer-referral-race`);
});

route("POST", "/admin/magazine", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const id = db.nextId("magazine");
  d.magazines = d.magazines || [];
  d.magazines.push({
    id, title: body.get("title") || "", url: body.get("url") || "",
    description: body.get("description") || "", createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הגיליון נוסף בהצלחה!")}`);
});

route("POST", "/admin/magazine/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.magazines = (d.magazines || []).filter((m) => m.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הגיליון הוסר.")}`);
});

route("POST", "/admin/story", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 8MB) - נסי תמונה קטנה יותר.")}`);
  const d = db.load();
  const id = db.nextId("story");
  d.stories = d.stories || [];
  const now = new Date().toISOString();
  d.stories.push({
    id, title: body.get("title") || "", freelancerId: body.get("freelancerId") || "",
    content: body.get("content") || "", answers: [], photoDataUri: fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES),
    status: "approved", createdAt: now, submittedAt: now, approvedAt: now, comments: [],
  });
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הסיפור פורסם!")}`);
});

route("POST", "/admin/story/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.stories = (d.stories || []).filter((s) => s.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הסיפור הוסר.")}`);
});

// Manually clears a story's featuredAt, so it stops appearing in "סיפורים קודמים" (see
// getCurrentStory) - a self-service fix for the one-time backfill/catch-up bug from
// 2026-08-22/23 that could stamp a story as "already shown" even though it never genuinely
// was the story displayed on the page. Safe to use any time: if the story really is due for
// its turn, the automatic rotation will pick it up and re-stamp it correctly on its own.
route("POST", "/admin/story/:id/unfeature", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const s = (d.stories || []).find((x) => x.id === params.id);
  if (s) { s.featuredAt = null; db.save(); }
  redirect(res, `/admin?ok=${encodeURIComponent("הסיפור סומן מחדש כ'טרם הוצג' - הוא לא יופיע יותר ב'סיפורים קודמים' עד שיגיע תורו האמיתי.")}`);
});

route("POST", "/admin/story/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const s = (d.stories || []).find((x) => x.id === params.id);
  if (s) {
    s.status = "approved";
    s.approvedAt = new Date().toISOString();
    const f = d.freelancers.find((x) => x.id === s.freelancerId);
    if (f && f.email) {
      const storyUrl = `${getOrigin(req)}/stories/${s.id}`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(storyUrl)}`;
      notify(f, {
        pushTitle: "הסיפור שלך עלה לאוויר ב-SheCan!", pushBody: "מוזמנת לשתף אותו עם הלקוחות שלך.", url: `/stories/${s.id}`,
        emailSubject: "הסיפור שלך עלה לאוויר ב-SheCan!",
        emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;">
          <p>היי ${esc(f.name || "")},</p>
          <p>הסיפור שלך אושר והוא כבר באוויר! מוזמנת לשתף אותו עם הלקוחות שלך:</p>
          <p><a href="${storyUrl}">${esc(storyUrl)}</a></p>
          <p style="text-align:center;"><img src="${qrUrl}" alt="QR לסיפור שלך" width="180" height="180" /></p>
          ${f.dealText ? `<p>ותזכורת - זו גם הזדמנות נהדרת להזכיר את ההטבה שלך: <strong>${esc(f.dealText)}</strong>${f.dealCode ? ` (קוד: ${esc(f.dealCode)})` : ""}</p>` : ""}
        </div>`,
      }).catch(() => {});
    }
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הסיפור אושר ופורסם!")}`);
});

route("POST", "/admin/story/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const s = (d.stories || []).find((x) => x.id === params.id);
  if (s) s.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הסיפור נדחה.")}`);
});

// ----- Admin: "הזירה" moderation -----
route("POST", "/admin/arena-question/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const q = (d.arenaQuestions || []).find((x) => x.id === params.id);
  if (q) {
    q.status = "approved";
    const matches = freelancersForCategory(d, q.categoryId, q.subcategoryId);
    const answerUrl = `${getOrigin(req)}/arena/question/${q.id}/answer`;
    matches.forEach((f) => {
      notify(f, {
        pushTitle: "שאלה חדשה בזירה בתחום שלך", pushBody: q.questionText, url: `/arena/question/${q.id}/answer`,
        emailSubject: "שאלה חדשה בזירה של SheCan בתחום שלך",
        emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;">
          <p>היי ${esc(f.name || "")},</p>
          <p>לקוחה שאלה שאלה בתחום שלך בזירה של SheCan:</p>
          <p style="background:#f3ede8;padding:14px;border-radius:8px;font-size:16px;">${esc(q.questionText)}</p>
          <p>מוזמנת לענות ולעזור - זה גם חשיפה נהדרת לעסק שלך:</p>
          <p><a href="${answerUrl}">${esc(answerUrl)}</a></p>
        </div>`,
      }).catch(() => {});
    });
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("השאלה אושרה ונשלחה למומחיות בתחום!")}`);
});

route("POST", "/admin/arena-question/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const q = (d.arenaQuestions || []).find((x) => x.id === params.id);
  if (q) q.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("השאלה נדחתה.")}`);
});

route("POST", "/admin/arena-question/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.arenaQuestions = (d.arenaQuestions || []).filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("השאלה הוסרה.")}`);
});

route("POST", "/admin/arena-question/:id/answer/:answerId/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const q = (d.arenaQuestions || []).find((x) => x.id === params.id);
  if (q) q.answers = (q.answers || []).filter((a) => a.id !== params.answerId);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("התשובה הוסרה.")}`);
});

route("POST", "/admin/consultation/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.consultations || []).find((x) => x.id === params.id);
  if (c) c.status = "approved";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("ההתייעצות אושרה ופורסמה!")}`);
});

route("POST", "/admin/consultation/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.consultations || []).find((x) => x.id === params.id);
  if (c) c.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("ההתייעצות נדחתה.")}`);
});

route("POST", "/admin/consultation/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.consultations = (d.consultations || []).filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("ההתייעצות הוסרה.")}`);
});

route("POST", "/admin/consultation/:id/reply/:replyId/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.consultations || []).find((x) => x.id === params.id);
  const r = c ? (c.replies || []).find((x) => x.id === params.replyId) : null;
  if (r) r.status = "approved";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("התגובה אושרה ופורסמה!")}`);
});

route("POST", "/admin/consultation/:id/reply/:replyId/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const c = (d.consultations || []).find((x) => x.id === params.id);
  if (c) c.replies = (c.replies || []).filter((r) => r.id !== params.replyId);
  db.save();
  redirect(res, `/arena?tab=2&ok=${encodeURIComponent("התגובה הוסרה.")}#consultation-${params.id}`);
});

route("POST", "/admin/poll/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.polls = (d.polls || []).filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הסקר הוסר.")}`);
});

// ----- סקר מהמערכת - כלי כללי לספיר ליצור סקר משלה (בשונה מהסקרים ב"מה דעתך?" שנוצרים על ידי
// עצמאיות) ולבחור בעצמה מי תראה ותוכל להצביע בו: עצמאיות בלבד, לקוחות בלבד, או שתיהן. נשמר
// באותו מערך d.polls כמו סקרי העצמאיות, רק עם source:"admin" ו-audience - כך שכל תשתית התצוגה,
// ההצבעה, השיתוף והמחיקה הקיימת מתשמשת מחדש ללא שכפול קוד (ר' pollVisibleToMe ב-/arena, הבדיקה
// המקבילה ב-/arena/poll/:id וב-/arena/poll/:id/vote, ו-pollCardHtml שמציג תג "סקר מהמערכת"
// במקום "מאת <עצמאית>" עבור סקרים כאלה). בשונה מסקר של עצמאית - אין כאן הגבלה של סקר אחד לשבוע.
route("POST", "/admin/survey", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const question = clip((body.get("question") || "").trim(), 200);
  const optionTexts = [0, 1, 2, 3].map((i) => clip((body.get(`option${i}`) || "").trim(), 80)).filter(Boolean);
  const audience = ["freelancers", "customers", "both"].includes(body.get("audience")) ? body.get("audience") : "both";
  if (!question || optionTexts.length < 2) {
    return redirect(res, `/admin?ok=${encodeURIComponent("נא למלא שאלה ולפחות שתי תשובות אפשריות לסקר.")}`);
  }
  const id = db.nextId("poll");
  d.polls = d.polls || [];
  d.polls.push({
    id, source: "admin", audience, freelancerId: null, freelancerName: "SheCan", question,
    options: optionTexts.map((t) => ({ text: t, votes: 0 })), voters: [], voterChoices: {}, createdAt: new Date().toISOString(),
  });
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הסקר פורסם בזירה!")}`);
});

route("POST", "/admin/story-question", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const question = (body.get("question") || "").trim();
  const d = db.load();
  if (question) {
    d.settings.storyQuestions = d.settings.storyQuestions || [];
    d.settings.storyQuestions.push(question);
    db.save();
  }
  redirect(res, `/admin?ok=${encodeURIComponent("השאלה נוספה!")}`);
});

route("POST", "/admin/story-question/:index/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const idx = Number(params.index);
  if (d.settings.storyQuestions && Number.isInteger(idx) && idx >= 0 && idx < d.settings.storyQuestions.length) {
    // Freelancers need at least STORY_MIN_ANSWERS answered questions to submit a story - don't
    // let the question bank shrink below that, or submitting a story becomes impossible for everyone.
    if (d.settings.storyQuestions.length <= STORY_MIN_ANSWERS) {
      return redirect(res, `/admin?err=${encodeURIComponent(`אי אפשר להוריד מ-${STORY_MIN_ANSWERS} שאלות - עצמאיות צריכות לענות על לפחות ${STORY_MIN_ANSWERS} כדי לשלוח סיפור, אז חייבות להישאר לפחות ${STORY_MIN_ANSWERS} שאלות במאגר.`)}`);
    }
    d.settings.storyQuestions.splice(idx, 1);
    db.save();
  }
  redirect(res, `/admin?ok=${encodeURIComponent("השאלה הוסרה.")}`);
});

function findByNameLoose(list, name) {
  if (!name) return null;
  const norm = (s) => (s || "").trim().toLowerCase();
  const target = norm(name);
  return list.find((x) => norm(x.name) === target) || null;
}

// A short, readable temporary password for bulk-imported freelancers - avoids ambiguous
// characters (0/O, 1/l/I) since it's typed out from an email, not copy-pasted.
function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

route("POST", "/admin/bulk-import", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const raw = (body.get("rows") || "").trim();
  if (!raw) return redirect(res, `/admin?err=${encodeURIComponent("לא הודבק כלום לייבוא.")}`);

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  let imported = 0;
  let unmatched = 0;
  const noEmailAccounts = []; // { label, tempPassword } - so Sapir can pass credentials along manually (e.g. WhatsApp) when no email was given
  // Per explicit request, after several freelancers reported never getting their credentials
  // email - the old code counted an email as "sent" the instant it queued the send, without
  // ever checking whether Resend actually accepted it (and didn't wait for the result at all).
  // Now every send is awaited and its real result recorded here, so the summary message below
  // reflects what actually happened, and anyone whose send failed still gets a manual fallback
  // (same as someone with no email at all) instead of silently falling through the cracks.
  const pendingEmails = []; // { to, subject, html, label, tempPassword }

  lines.forEach((line) => {
    const cols = line.split("\t").length > 1 ? line.split("\t") : line.split(",");
    const [name, businessName, categoryName, subcategoryName, cityName, phone, description, dealText, instagram, linkRaw, email] = cols.map((c) => (c || "").trim());
    if (!businessName) return;
    const category = findByNameLoose(d.categories, categoryName);
    const subcategory = category ? findByNameLoose(subcategoriesOf(d, category.id), subcategoryName) : null;
    const city = findByNameLoose(d.cities, cityName);
    if (!category || !city) unmatched++;
    // The optional "קישור" column can hold either a WhatsApp link (wa.me / api.whatsapp.com / whatsapp.com)
    // - in which case we just flip the hasWhatsapp flag and let the site build the wa.me link from the phone -
    // or any other link, which we store as-is in portfolioUrl ("קישור לתיק עבודות").
    const isWhatsappLink = /wa\.me|whatsapp\.com/i.test(linkRaw);
    const id = db.nextId("freelancer");
    const tempPassword = generateTempPassword();
    d.freelancers.push({
      id, name: name || businessName, businessName,
      email: email || `${id}@imported.shecan.co.il`,
      passwordHash: auth.hashPassword(tempPassword),
      categoryId: category ? category.id : "", subcategoryId: subcategory ? subcategory.id : "", subcategoryIds: subcategory ? [subcategory.id] : [], additionalCategoryIds: [], cityId: city ? city.id : "",
      phone: phone || "", instagram: instagram || "",
      portfolioUrl: (linkRaw && !isWhatsappLink) ? linkRaw : "",
      hasWhatsapp: isWhatsappLink, availableNow: false,
      offersOnline: false, offersHomeVisit: false, active: true,
      photoDataUri: null, logoDataUri: null, galleryPhotos: [],
      description: description || "", dealText: dealText || "", yearsInField: "", inspirationQuote: "", weeklyTipPublished: false, weeklyQuoteLikeCount: 0, referredByFreelancerId: null, welcomePopupSeen: false,
      dealCode: generateCouponCode(),
      tier: "basic", joinType: d.settings.chargingEnabled ? "regular" : "founding",
      paymentStatus: d.settings.chargingEnabled ? "pending_payment" : "free",
      isLeadingBusiness: false, isAdvertised: false, adPaymentStatus: "none",
      viewCount: 0, couponRevealCount: 0, pushSubscriptions: [],
      status: "approved", createdAt: new Date().toISOString(),
      siteVisitCount: 0,
    });
    imported++;
    if (email) {
      pendingEmails.push({
        to: email,
        label: `${businessName}${phone ? ` (${phone})` : ""}`,
        tempPassword,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;">
          <p>היי ${esc(name || businessName)}, ✨</p>
          <p>זוכרת שמילאת את טופס ההרשמה למאגר העצמאיות של SheCan? אז אנחנו כל כך מתרגשות לבשר שהאתר החדש נבנה ונולד במיוחד בשבילכן!</p>
          <p>יצרנו לעסק שלך כרטיסייה אישית מהממת עם כל הפרטים ששלחת אלינו.</p>
          <p>🔑 פרטי ההתחברות לאזור האישי שלך:<br/>אימייל: <strong>${esc(email)}</strong><br/>סיסמה זמנית: <strong>${esc(tempPassword)}</strong><br/>קישור להתחברות: <a href="${getOrigin(req)}/login">${getOrigin(req)}/login</a></p>
          <p>חשוב - בכניסה הראשונה כדאי לא לשכוח להחליף את הסיסמה הזמנית לסיסמה משלך.</p>
          <p>את מוזמנת להיכנס, להתרשם מהכרטיסייה שלך, ותמיד להוסיף, לשנות ולעדכן תמונות ונתונים בדיוק איך שאת אוהבת.</p>
          <p>האתר עדיין לא פתוח לקהל הרחב. פתחנו אותו קודם כל במיוחד עבורכן – נבחרת המייסדות שלנו – כדי שתוכלו לסדר, ללטש ולהעלות את כל מה שצריך בשקט ובנחת לפני שכולן מגיעות. ההשקה הרשמית תהיה ממש בשבוע הבא! 🚀</p>
          <p>אם יש לך שאלות, באגים קטנים שצריך לסדר או סתם בא לך לדבר איתנו, את מוזמנת לשלוח מייל לכתובת: <a href="mailto:Shecan.office@gmail.com">Shecan.office@gmail.com</a></p>
          <p>מחכות לראות אותך בפנים,<br/>צוות SheCan 🌸</p>
        </div>`,
      });
    } else {
      noEmailAccounts.push({ label: `${businessName}${phone ? ` (${phone})` : ""}`, tempPassword });
    }
  });
  db.save();

  // Send every queued credentials email in parallel and actually wait for + check each result,
  // instead of the old fire-and-forget approach that reported success the instant a send was
  // merely queued.
  const emailResults = await Promise.all(pendingEmails.map(async (item) => {
    const result = await sendEmail(item.to, "האזור האישי שלך ב-SheCan מוכן", item.html).catch(() => ({ ok: false, reason: "send_failed" }));
    return { ...item, ok: !!(result && result.ok) };
  }));
  const emailedOk = emailResults.filter((r) => r.ok);
  const emailedFailed = emailResults.filter((r) => !r.ok);

  let msg = `יובאו ${imported} עצמאיות בהצלחה!` + (emailedOk.length ? ` נשלח מייל עם פרטי התחברות ל-${emailedOk.length} מהן.` : "") + (unmatched ? ` שימי לב - ב-${unmatched} מהן לא הצלחנו להתאים תחום ו/או עיר בדיוק (כנראה כתיב שונה מהרשימה שלנו) - אפשר לתקן אותן ידנית בהמשך.` : "");
  const manualFallback = noEmailAccounts.concat(emailedFailed.map((x) => ({ label: x.label, tempPassword: x.tempPassword })));
  if (emailedFailed.length) {
    msg += `\n\n⚠️ שימו לב - ל-${emailedFailed.length} מהן היה מייל אבל השליחה נכשלה (יכול להיות שירות המייל לא מוגדר כמו שצריך, כדאי לבדוק). הפרטים שלהן נמצאים ברשימה הידנית למטה.`;
  }
  if (manualFallback.length) {
    msg += `\n\nל-${manualFallback.length} מהן לא נשלחה סיסמה אוטומטית בהצלחה - אלה הסיסמאות הזמניות שלהן, כדאי להעביר לכל אחת ידנית (למשל בוואטסאפ):\n` +
      manualFallback.map((x) => `${x.label}: ${x.tempPassword}`).join("\n");
  }
  redirect(res, `/admin?ok=${encodeURIComponent(msg)}`);
});

route("GET", "/admin/export/freelancers.csv", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const csvEscape = (v) => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
  const csvDealsByFreelancer = {};
  (d.deals || []).forEach((x) => { if (x.status === "confirmed") csvDealsByFreelancer[x.freelancerId] = (csvDealsByFreelancer[x.freelancerId] || 0) + 1; });
  const headers = ["שם איש קשר", "שם העסק", "אימייל", "טלפון", "תחום", "עיר", "תיאור", "טקסט הטבה", "קוד קופון", "סטטוס", "סוג הצטרפות", "סטטוס תשלום", "רמה", "נותנת חסות", "מודעה", "סטטוס תשלום מודעה", "פעילה באתר", "צפיות בעמוד", "צפיות בקופון", "עסקאות שנסגרו", "תאריך הצטרפות"];
  const rows = d.freelancers.map((f) => [
    f.name, f.businessName, f.email, f.phone, catName(d, f.categoryId), cityName(d, f.cityId),
    f.description, f.dealText, f.dealCode, f.status, f.joinType, f.paymentStatus, f.tier,
    f.isLeadingBusiness ? "כן" : "לא", f.isAdvertised ? "כן" : "לא", adPaymentStatusLabel(f.adPaymentStatus), f.active === false ? "לא" : "כן", f.viewCount || 0, f.couponRevealCount || 0, csvDealsByFreelancer[f.id] || 0, f.createdAt,
  ]);
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="shecan-freelancers.csv"' });
  res.end(csv);
});

// "מאגר הלקוחות" CSV - כל הלקוחות בלי הגבלה (בשונה מהטבלה בעמוד עצמו, שמוגבלת
// ל-CUSTOMERS_DIRECTORY_SHOW_MAX כדי לא להכביד על טעינת /admin) - לפי בקשה מפורשת 2026-08-30.
route("GET", "/admin/export/customers.csv", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const csvEscape = (v) => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
  const headers = ["שם", "אימייל", "עיר", "מייל מאומת", "מספר כניסות לאתר", "תאריך הצטרפות"];
  const rows = d.customers
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map((c) => [
      c.name, c.email, cityName(d, c.cityId), c.emailVerified ? "כן" : "לא", c.siteVisitCount || 0, c.createdAt,
    ]);
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="shecan-customers.csv"' });
  res.end(csv);
});

// Full-database backup download, per explicit request - lets Sapir keep her own independent
// copy of everything (freelancers, customers, reviews, stories, settings, and every embedded
// photo/logo as base64) outside of Render's own automatic disk snapshots. Reads straight off
// disk (the same file db.save() writes to) rather than re-serializing the in-memory cache, so
// what she downloads is guaranteed to match exactly what's actually persisted.
route("GET", "/admin/backup/download", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  db.load();
  let raw;
  try {
    raw = fs.readFileSync(db.DB_PATH, "utf8");
  } catch (e) {
    return redirect(res, `/admin?err=${encodeURIComponent("לא הצלחתי לקרוא את קובץ הנתונים לגיבוי.")}`);
  }
  const stamp = israelDayKeyOffset(0);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="shecan-backup-${stamp}.json"` });
  res.end(raw);
});

route("POST", "/admin/charging-toggle", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.chargingEnabled = !d.settings.chargingEnabled;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן!")}`);
});

route("POST", "/admin/toggle-deal-badge-logo", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.showLogoOnDealBadge = !d.settings.showLogoOnDealBadge;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.showLogoOnDealBadge ? "הלוגו יופיע עכשיו ליד תגית ההטבה." : "הלוגו הוסר מתגית ההטבה.")}`);
});

route("POST", "/admin/toggle-search-visibility", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.searchEngineVisible = !d.settings.searchEngineVisible;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.searchEngineVisible ? "האתר פתוח עכשיו למנועי חיפוש." : "האתר חסום שוב ממנועי חיפוש.")}`);
});

// Public-facing "community in numbers" strip on the home page (freelancers/customers/closed
// deals), shown right under the "יש לך עסק? בואי נכיר" section - off by default, toggled here
// exactly like search-engine visibility above, per explicit request for a button she controls
// herself rather than something always-on.
route("POST", "/admin/toggle-public-stats", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.showPublicStats = !d.settings.showPublicStats;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.showPublicStats ? "המספרים מוצגים עכשיו לכולן בעמוד הבית." : "המספרים הוסתרו מעמוד הבית.")}`);
});

route("POST", "/admin/toggle-profile-viewcount", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.showProfileViewCount = !d.settings.showProfileViewCount;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.showProfileViewCount ? "מספר הצפיות והדירוג המדויק מוצגים עכשיו בכל הפרופילים." : "מספר הצפיות והדירוג המדויק הוסתרו מהפרופילים.")}`);
});

route("POST", "/admin/toggle-arena-consultations", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.arenaConsultationsEnabled = !d.settings.arenaConsultationsEnabled;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.arenaConsultationsEnabled ? "פינת ההתייעצויות מוצגת עכשיו בזירה." : "פינת ההתייעצויות הוסתרה מהזירה.")}#arena-consultations`);
});

route("POST", "/admin/toggle-service-requests-premium", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.serviceRequestsPremiumOnly = !d.settings.serviceRequestsPremiumOnly;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.serviceRequestsPremiumOnly ? "בקשות שירות מוצגות עכשיו רק לעצמאיות 'מומלצת'." : "בקשות שירות פתוחות עכשיו לכל עצמאית מאושרת.")}`);
});

route("POST", "/admin/service-request/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.serviceRequests = (d.serviceRequests || []).filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הבקשה נמחקה.")}`);
});

route("POST", "/admin/category", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const id = String(d.categories.length + 1) + "-" + Date.now();
  d.categories.push({ id, name: body.get("name") });
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("נוסף בהצלחה.")}#categories-management`);
});

// שינוי שם לתחום - ה-id נשאר קבוע, רק c.name משתנה, אז שום דבר אחר באתר (freelancer.categoryId
// וכו') לא צריך לזוז בעקבות זה - ר' הפאנל "התחומים ותתי-התחומים באתר" ב-GET /admin.
route("POST", "/admin/category/:id/rename", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const c = d.categories.find((x) => x.id === params.id);
  const name = clip((body.get("name") || "").trim(), 60);
  if (!c || !name) return redirect(res, `/admin?err=${encodeURIComponent("לא נמצא תחום או שם ריק.")}#categories-management`);
  c.name = name;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("שם התחום עודכן.")}#categories-management`);
});

// מחיקה חסומה אם התחום עדיין בשימוש בפועל (ר' categoryUsageCount למעלה) - זה נבדק גם כאן בצד
// השרת, לא רק דרך ה-disabled בכפתור בתצוגה, כדי שאי אפשר יהיה לעקוף את זה.
route("POST", "/admin/category/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const c = d.categories.find((x) => x.id === params.id);
  if (!c) return redirect(res, `/admin?err=${encodeURIComponent("התחום לא נמצא.")}#categories-management`);
  const usage = categoryUsageCount(d, c.id);
  if (usage > 0) {
    return redirect(res, `/admin?err=${encodeURIComponent(`אי אפשר למחוק את "${c.name}" - ${usage} רשומות עדיין משויכות אליו. אפשר לשייך אותן מחדש בפאנל "שיוך מחדש" למטה.`)}#categories-management`);
  }
  d.categories = d.categories.filter((x) => x.id !== params.id);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("התחום נמחק.")}#categories-management`);
});

// הוספת תת-תחום מפורשת דרך הפאנל - יחד עם אישור המלצת תת-תחום מעצמאית (ר' POST
// /admin/subcategory-suggestion/:id/approve למעלה בקובץ) זו נקודת הכניסה השנייה והיחידה
// ל-findOrCreateSubcategory בכל הקובץ - שתיהן פעולת מנהלת מפורשת ומודעת, אף פעם לא תוצר לוואי
// של פעולה אחרת (לפי בקשה מפורשת: "אל תוסיף אוטומטית תתי תחום חדשים בשום אופן בצורה אוטומטית").
route("POST", "/admin/subcategory", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const categoryId = body.get("categoryId") || "";
  const name = (body.get("name") || "").trim();
  if (!name) return redirect(res, `/admin?err=${encodeURIComponent("לא הוזן שם תת-תחום.")}#categories-management`);
  const result = findOrCreateSubcategory(d, categoryId, name);
  if (!result) return redirect(res, `/admin?err=${encodeURIComponent("התחום לא נמצא.")}#categories-management`);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(result.isNew ? "תת-התחום נוסף." : "תת-התחום הזה כבר קיים - לא נוצר כפול.")}#categories-management`);
});

route("POST", "/admin/subcategory/:categoryId/:subId/rename", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const category = d.categories.find((c) => c.id === params.categoryId);
  const sub = category && (category.subcategories || []).find((s) => s.id === params.subId);
  const name = clip((body.get("name") || "").trim(), 60);
  if (!sub || !name) return redirect(res, `/admin?err=${encodeURIComponent("לא נמצא תת-תחום או שם ריק.")}#categories-management`);
  sub.name = name;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("שם תת-התחום עודכן.")}#categories-management`);
});

route("POST", "/admin/subcategory/:categoryId/:subId/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const category = d.categories.find((c) => c.id === params.categoryId);
  const sub = category && (category.subcategories || []).find((s) => s.id === params.subId);
  if (!sub) return redirect(res, `/admin?err=${encodeURIComponent("תת-התחום לא נמצא.")}#categories-management`);
  const usage = subcategoryUsageCount(d, params.categoryId, params.subId);
  if (usage > 0) {
    return redirect(res, `/admin?err=${encodeURIComponent(`אי אפשר למחוק את "${sub.name}" - ${usage} רשומות עדיין משויכות אליו. אפשר לשייך אותן מחדש בפאנל "שיוך מחדש" למטה.`)}#categories-management`);
  }
  category.subcategories = (category.subcategories || []).filter((s) => s.id !== params.subId);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("תת-התחום נמחק.")}#categories-management`);
});

// "שיוך מחדש" - הכלי שנותן לה בפועל לפנות תחום/תת-תחום שהיא רוצה למחוק (הכפתור למעלה חוסם
// מחיקה כל עוד יש שימוש בפועל) - משייך מחדש רק את השיוך ה"ראשי" של העסק (f.categoryId/
// subcategoryId/subcategoryIds), לא את "התחומים הנוספים" שלה (additionalCategoryIds) ולא רשומות
// additionalListings בנפרד - אלה נשארים כפי שהם. תת-תחום חדש נוצר רק אם newSubcategoryName מולא
// בפועל (findOrCreateSubcategory) - פעולה מפורשת ומודעת, בדיוק כמו POST /admin/subcategory למעלה.
route("POST", "/admin/reassign-listing", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const f = d.freelancers.find((x) => x.id === body.get("freelancerId"));
  const categoryId = body.get("categoryId") || "";
  const category = d.categories.find((c) => c.id === categoryId);
  if (!f || !category) {
    return redirect(res, `/admin?err=${encodeURIComponent("יש לבחור עסק ותחום תקין.")}#category-reassign`);
  }
  const newSubcategoryName = (body.get("newSubcategoryName") || "").trim();
  let subId = "";
  if (newSubcategoryName) {
    const result = findOrCreateSubcategory(d, categoryId, newSubcategoryName);
    subId = result ? result.sub.id : "";
  } else {
    const requested = body.get("subcategoryId") || "";
    subId = (category.subcategories || []).some((s) => s.id === requested) ? requested : "";
  }
  f.categoryId = categoryId;
  f.subcategoryId = subId;
  f.subcategoryIds = subId ? [subId] : [];
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`${f.businessName || f.name} שויכה מחדש ל${category.name}${subId ? " / " + subcatName(d, categoryId, subId) : ""}.`)}#category-reassign`);
});

route("POST", "/admin/city", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const name = (body.get("name") || "").trim();
  if (!name) return redirect(res, `/admin?err=${encodeURIComponent("לא הוזן שם עיר.")}`);
  const dup = findByNameLoose(d.cities, name);
  if (dup) return redirect(res, `/admin?err=${encodeURIComponent("העיר הזו כבר קיימת ברשימה.")}`);
  const id = String(d.cities.length + 1) + "-" + Date.now();
  d.cities.push({ id, name });
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("נוספה בהצלחה.")}`);
});

route("POST", "/admin/freelancer/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) {
    f.status = "approved";
    if (f.paymentStatus === "pending_payment") f.paymentStatus = "active";
    const profileUrl = `${getOrigin(req)}/freelancer/${f.id}`;
    // A quick push heads-up if she has notifications enabled (unchanged from before) - this
    // can't carry a file attachment, so unlike the general notify() helper (push OR email), the
    // approval email below is always sent too, regardless of push, since it's the only way to
    // deliver the join/review QR image attachments (see joinStory.js / reviewStory.js).
    sendPushToUser(f, { title: "את באוויר! הפרופיל שלך אושר", body: "הפרופיל שלך אושר והוא כבר באוויר ב-SheCan 🎉", url: `/freelancer/${f.id}` }).catch(() => {});
    // hasRealEmail (not the raw f.email truthiness check this used to be) so a bulk-imported
    // freelancer with no real address on file - who has the id@imported.shecan.co.il
    // placeholder instead - doesn't silently "succeed" at emailing a mailbox that doesn't
    // exist. In practice bulk-imported freelancers are created already-approved and never hit
    // this route, but this keeps the check correct if that ever changes.
    if (hasRealEmail(f)) {
      // The review-QR points straight to her review section (#scReview) rather than just the
      // bare profile, so a customer who scans it lands ready to write the review.
      const reviewUrl = `${profileUrl}#scReview`;
      let attachments = [];
      let hasJoinImage = false;
      let hasReviewImage = false;
      // (1) "I joined SheCan!" story image - a ready-to-post graphic (Sapir's own template, see
      // assets/join-story-bg.jpg / joinStory.js) personalized with her QR code and profile
      // link, so she can share it straight to her own Instagram/Facebook story. Per explicit
      // request. Points at the plain profile (not the review anchor below) since this is about
      // introducing the business, not specifically soliciting a review. Build failures are
      // logged and skipped silently - the approval itself, and the rest of this email, must
      // never be blocked by an image-generation problem.
      try {
        if (!STORY_IMAGES_ENABLED) throw new Error("story images temporarily disabled (STORY_IMAGES_ENABLED=false) - see kill switch near top of file");
        const profileQrRes = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(profileUrl)}`);
        if (!profileQrRes.ok) throw new Error(`qrserver responded ${profileQrRes.status}`);
        const profileQrBuf = Buffer.from(await profileQrRes.arrayBuffer());
        const profileQrDataUrl = `data:image/png;base64,${profileQrBuf.toString("base64")}`;
        const joinImageBuffer = await runChromiumSerialized(() => buildJoinStoryImageBuffer({ qrDataUrl: profileQrDataUrl, profileUrl }), "join-story image build");
        attachments.push({ filename: "1-הצטרפתי-לSheCan-לשיתוף.png", content: joinImageBuffer.toString("base64") });
        hasJoinImage = true;
      } catch (e) {
        console.warn("[join-story] could not build join-story image - sending approval email without it:", e.message);
      }
      // (2) Printable "scan for a review" image (Sapir's own template, see
      // assets/review-story-bg.jpg / reviewStory.js), personalized with a QR (+ backup link)
      // straight to her review section - meant to be printed and stuck up at her business so
      // customers can scan it in person. Replaces the older plain PDF flyer, per explicit
      // request, now that this on-brand version covers the same job. Same
      // build-can-fail-silently safety as (1) above.
      try {
        if (!STORY_IMAGES_ENABLED) throw new Error("story images temporarily disabled (STORY_IMAGES_ENABLED=false) - see kill switch near top of file");
        const reviewQrRes = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(reviewUrl)}`);
        if (!reviewQrRes.ok) throw new Error(`qrserver responded ${reviewQrRes.status}`);
        const reviewQrBuf = Buffer.from(await reviewQrRes.arrayBuffer());
        const reviewQrDataUrl = `data:image/png;base64,${reviewQrBuf.toString("base64")}`;
        const reviewImageBuffer = await runChromiumSerialized(() => buildReviewStoryImageBuffer({ qrDataUrl: reviewQrDataUrl, reviewUrl }), "review-story image build");
        attachments.push({ filename: "2-סרקי-אותי-להדפסה.png", content: reviewImageBuffer.toString("base64") });
        hasReviewImage = true;
      } catch (e) {
        console.warn("[review-story] could not build review-story image - sending approval email without it:", e.message);
      }
      // Per explicit request after freelancers reported never getting this email - the send
      // result is now actually checked (like /admin/bulk-import and resend-credentials already
      // do) so a failure shows up right here in the admin message instead of vanishing into a
      // server log nobody's watching.
      const emailResult = await sendEmail(f.email, "את באוויר! הפרופיל שלך אושר ב-SheCan",
        `<div dir="rtl" style="font-family:Arial,sans-serif;">
          <p>היי ${esc(f.name || "")},</p>
          <p>יש! הפרופיל שלך אושר והוא כבר באוויר ב-SheCan 🎉</p>
          <p>אפשר לראות אותו כאן: <a href="${profileUrl}">${esc(profileUrl)}</a></p>
          <p>מוזמנת לשתף את קוד הקופון שלך (<strong>${esc(f.dealCode || "")}</strong>) עם הלקוחות שלך, ולהזמין אותן לכתוב לך המלצה ישירות בכרטיסייה - זה מה שיעזור לך להתחיל להיראות ולהתבלט בקהילה.</p>
          ${(hasJoinImage || hasReviewImage) ? `<div style="background:#FBF3EC;border:1px solid #E8D9C9;border-radius:10px;padding:16px 18px;margin:18px 0;">
            <p style="margin:0 0 10px;font-weight:700;">📎 מצורפים לך כאן למייל הזה ${hasJoinImage && hasReviewImage ? "2 קבצים" : "קובץ"} מוכנים לשימוש - כדאי לשמור אותם מהמייל:</p>
            <ol style="margin:0;padding-right:20px;">
              ${hasJoinImage ? `<li style="margin-bottom:8px;"><strong>1-הצטרפתי-לSheCan-לשיתוף.png</strong> - תמונה מוכנה לשיתוף בסטורי/פוסט באינסטגרם או בפייסבוק, עם קוד QR והקישור לפרופיל שלך - כדי לספר לכולן שהצטרפת! 📸</li>` : ""}
              ${hasReviewImage ? `<li><strong>2-סרקי-אותי-להדפסה.png</strong> - תמונה מוכנה להדפסה ולהדבקה בעסק שלך, עם קוד QR שמוביל ישר לכתיבת המלצה - כדי שלקוחות יוכלו לסרוק במקום ולהמליץ עלייך ✍️</li>` : ""}
            </ol>
          </div>` : ""}
        </div>`,
        attachments
      ).catch(() => ({ ok: false, reason: "send_failed" }));
      if (!emailResult.ok) {
        db.save();
        return redirect(res, `/admin?ok=${encodeURIComponent(`אושרה! היא כבר באוויר. ⚠️ שימי לב - שליחת מייל האישור אליה נכשלה (${f.email}) - כדאי לבדוק את הגדרות שירות המייל, או ללחוץ "📧 שליחת פרטי התחברות" כדי לנסות שוב.`)}`);
      }
      // Surface a failed image build right here in the admin panel too, not just in the server
      // log (which nobody's watching day-to-day) - per the same "make failures visible instead
      // of silent" request as the emailResult check above. The email itself still went out fine
      // either way (build failures never block that), just without one or both attachments.
      if (!hasJoinImage || !hasReviewImage) {
        db.save();
        const missing = !hasJoinImage && !hasReviewImage ? "שני הקבצים" : !hasJoinImage ? "קובץ ה'הצטרפתי' לשיתוף" : "קובץ ה'סרקי אותי' להדפסה";
        return redirect(res, `/admin?ok=${encodeURIComponent(`אושרה! היא כבר באוויר. המייל נשלח, אבל ⚠️ ${missing} לא צורפו אליו (בעיה טכנית ביצירת התמונות בצד השרת) - כדאי לבדוק את לוג ה-Logs ב-Render מסביב לזמן הזה, לחפש שורה עם "[join-story]" או "[review-story]".`)}`);
      }
    }
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("אושרה! היא כבר באוויר.")}`);
});

route("POST", "/admin/freelancer/:id/toggle-leading", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) f.isLeadingBusiness = !f.isLeadingBusiness;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(f && f.isLeadingBusiness ? "היא עכשיו נותנת חסות - תופיע בהבלטה בדף הבית." : "הוסרה מרשימת נותנות החסות.")}`);
});

// Lets Sapir see and fix the email address on file for any freelancer, right from the admin
// table - per explicit request, after a bulk-imported freelancer turned out to have no real
// address saved at all, and a separate one suspected a typo was the reason her password-reset
// email never arrived. Doubles as the fix for a bulk-imported freelancer who originally had no
// real email (the id@imported.shecan.co.il placeholder - see hasRealEmail): typing a real
// address here and saving makes every future notification (approval, messages, password
// resets, etc.) actually reach her instead of silently targeting a mailbox that doesn't exist.
route("POST", "/admin/freelancer/:id/update-email", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, `/admin?err=${encodeURIComponent("העצמאית לא נמצאה.")}`);
  const newEmail = (body.get("email") || "").trim().toLowerCase();
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return redirect(res, `/admin?err=${encodeURIComponent("כתובת המייל לא תקינה - נסי שוב.")}`);
  }
  if (d.freelancers.some((x) => x.id !== f.id && x.email === newEmail)) {
    return redirect(res, `/admin?err=${encodeURIComponent("כתובת המייל הזו כבר בשימוש אצל עצמאית אחרת.")}`);
  }
  f.email = newEmail;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(`כתובת המייל של ${f.businessName || f.name} עודכנה ל-${newEmail}.`)}`);
});

// Manual re-send of the "your area is ready" credentials email, per explicit request after
// several bulk-imported freelancers turned out to have never actually received theirs (the
// bulk-import route used to count a send as successful the moment it was queued, without
// checking whether it actually went out - see the fix in /admin/bulk-import above). Since the
// original temp password only ever existed as a hash, this issues a brand-new one (invalidating
// whatever she had) rather than trying to recover the old one, and falls back to showing the
// password right here in the admin panel if the email send itself fails again.
route("POST", "/admin/freelancer/:id/resend-credentials", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, `/admin?err=${encodeURIComponent("העצמאית לא נמצאה.")}`);
  const tempPassword = generateTempPassword();
  f.passwordHash = auth.hashPassword(tempPassword);
  db.save();
  if (!hasRealEmail(f)) {
    return redirect(res, `/admin?ok=${encodeURIComponent(`ל${f.businessName || f.name} אין כתובת מייל אמיתית רשומה - הסיסמה הזמנית החדשה שלה היא: ${tempPassword} (כדאי להעביר ידנית, למשל בוואטסאפ).`)}`);
  }
  const result = await sendEmail(f.email, "האזור האישי שלך ב-SheCan מוכן",
    `<div dir="rtl" style="font-family:Arial,sans-serif;">
      <p>היי ${esc(f.name || f.businessName)}, ✨</p>
      <p>הנה שוב פרטי ההתחברות לאזור האישי שלך ב-SheCan:</p>
      <p>🔑 אימייל: <strong>${esc(f.email)}</strong><br/>סיסמה זמנית: <strong>${esc(tempPassword)}</strong><br/>קישור להתחברות: <a href="${getOrigin(req)}/login">${getOrigin(req)}/login</a></p>
      <p>חשוב - בכניסה הראשונה כדאי לא לשכוח להחליף את הסיסמה הזמנית לסיסמה משלך.</p>
      <p>אם יש לך שאלות, את מוזמנת לשלוח מייל לכתובת: <a href="mailto:Shecan.office@gmail.com">Shecan.office@gmail.com</a></p>
      <p>מחכות לראות אותך בפנים,<br/>צוות SheCan 🌸</p>
    </div>`
  ).catch(() => ({ ok: false }));
  if (result && result.ok) {
    redirect(res, `/admin?ok=${encodeURIComponent(`נשלח מייל עם פרטי התחברות חדשים ל${f.businessName || f.name}.`)}`);
  } else {
    redirect(res, `/admin?err=${encodeURIComponent(`השליחה למייל של ${f.businessName || f.name} נכשלה שוב. הסיסמה הזמנית החדשה שלה היא: ${tempPassword} - כדאי להעביר לה ידנית (למשל בוואטסאפ) ולבדוק את הגדרות שירות המייל.`)}`);
  }
});

route("POST", "/admin/freelancer/:id/toggle-active", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) f.active = !(f.active !== false); // treat missing/true as active, flip to false and back
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(f && f.active !== false ? "היא פעילה עכשיו - חוזרת להופיע באתר." : "היא סומנה כלא פעילה - זמנית לא תופיע באתר.")}`);
});

// עד עכשיו tier ("רמה") נבחר רק ע"י העצמאית עצמה ב-/join ולא ניתן היה לשנות אותו אחר כך -
// נוסף כאן טוגל אדמין (בדיוק כמו toggle-active/toggle-ad למעלה) כדי שספיר תוכל לשדרג/להוריד
// עצמאית ל"מומלצת" בעצמה (למשל אחרי תשלום ידני מחוץ למערכת) - משמש גם לדירוג בחיפוש/
// "מומלצת" ובעמוד הבית כרגיל, וגם (נוסף לפי בקשה מפורשת) כשער ל"בקשות שירות" - ר'
// d.settings.serviceRequestsPremiumOnly ו-GET /freelancer-dashboard.
route("POST", "/admin/freelancer/:id/toggle-tier", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) {
    f.tier = f.tier === "premium" ? "basic" : "premium";
    // כל שינוי (לכל כיוון) סוגר בקשת שדרוג ממתינה אם הייתה כזו - ר' POST
    // /freelancer-dashboard/request-tier-upgrade: אם היא ביקשה ואת אישרת (הפכת למומלצת), הבקשה
    // טופלה; אם החזרת אותה לבסיסית, הבקשה כבר לא רלוונטית.
    f.tierUpgradeRequestedAt = null;
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(f && f.tier === "premium" ? "היא מסומנת עכשיו כ'מומלצת'." : "היא סומנה בחזרה כ'בסיסית'.")}#tier-upgrade-requests`);
});

route("POST", "/admin/freelancer/:id/toggle-ad", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) {
    f.isAdvertised = !f.isAdvertised;
    // Every time an ad is turned on it starts as "awaiting payment" so nothing gets
    // forgotten; turning it off clears the payment status back to none.
    f.adPaymentStatus = f.isAdvertised ? "pending_payment" : "none";
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(f && f.isAdvertised ? "המודעה שלה פעילה עכשיו באתר (ממתינה לתשלום)." : "המודעה כובתה.")}`);
});

route("POST", "/admin/freelancer/:id/mark-ad-paid", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f && f.isAdvertised) f.adPaymentStatus = f.adPaymentStatus === "paid" ? "pending_payment" : "paid";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(f && f.adPaymentStatus === "paid" ? "המודעה סומנה כשולמה." : "המודעה סומנה כממתינה לתשלום.")}`);
});

// Mirrors the freelancer-level toggle-ad/mark-ad-paid pair above, but for one specific
// additional listing - so a listing can be advertised on its own, independently of whether
// the parent freelancer's own main profile is advertised.
route("POST", "/admin/listing/:fid/:lid/toggle-ad", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.fid);
  const l = f && (f.additionalListings || []).find((x) => String(x.id) === params.lid);
  if (l) {
    l.isAdvertised = !l.isAdvertised;
    l.adPaymentStatus = l.isAdvertised ? "pending_payment" : "none";
  }
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(l && l.isAdvertised ? "המודעה שלה פעילה עכשיו באתר (ממתינה לתשלום)." : "המודעה כובתה.")}`);
});

route("POST", "/admin/listing/:fid/:lid/mark-ad-paid", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.fid);
  const l = f && (f.additionalListings || []).find((x) => String(x.id) === params.lid);
  if (l && l.isAdvertised) l.adPaymentStatus = l.adPaymentStatus === "paid" ? "pending_payment" : "paid";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(l && l.adPaymentStatus === "paid" ? "המודעה סומנה כשולמה." : "המודעה סומנה כממתינה לתשלום.")}`);
});

route("POST", "/admin/freelancer/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) f.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("נדחה.")}`);
});

// Lets Sapir upload/delete a profile photo + לוגו + up to 4 gallery photos on behalf of a
// freelancer (e.g. one who was bulk-imported from a spreadsheet and never went through the
// /join upload form herself). Mirrors the same fields/behavior as her own dashboard for
// uploading: a new logo/profile photo replaces the old one, and uploading any new gallery
// photo replaces the whole gallery set (not merged one-by-one). Deletion (added לפי בקשה
// מפורשת: "אני רוצה שתאפשר לי למחוק לעצמאית תמונות") is separate and per-image - profile
// photo/logo each get their own "הסרה" form, and every gallery photo gets its own removal
// form (POST /admin/freelancer/:id/gallery/:idx/remove) so a single bad photo can be taken
// down without having to re-upload the whole gallery.
route("GET", "/admin/freelancer/:id/photos", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, `/admin?err=${encodeURIComponent("העצמאית לא נמצאה.")}`);
  const body = `
  <h1 class="section-title">תמונות עבור ${esc(f.businessName || f.name)}</h1>
  <div class="panel" style="max-width:560px;margin:0 auto;">
    <h3>תמונת פרופיל נוכחית</h3>
    ${f.photoDataUri ? `
    <img src="${f.photoDataUri}" alt="תמונת פרופיל" style="width:120px;height:120px;object-fit:cover;border-radius:12px;" />
    <form method="post" action="/admin/freelancer/${f.id}/photo/remove" style="margin-top:8px;" onsubmit="return confirm('להסיר את תמונת הפרופיל?');"><button class="btn btn-small btn-outline" type="submit">הסרת תמונת הפרופיל</button></form>
    ` : `<p class="muted">עדיין אין תמונת פרופיל.</p>`}
    <h3 style="margin-top:18px;">לוגו נוכחי</h3>
    ${f.logoDataUri ? `
    <img src="${f.logoDataUri}" alt="לוגו" style="width:120px;height:120px;object-fit:cover;border-radius:12px;" />
    <form method="post" action="/admin/freelancer/${f.id}/logo/remove" style="margin-top:8px;" onsubmit="return confirm('להסיר את הלוגו?');"><button class="btn btn-small btn-outline" type="submit">הסרת הלוגו</button></form>
    ` : `<p class="muted">עדיין אין לוגו.</p>`}
    <h3 style="margin-top:18px;">גלריה נוכחית</h3>
    ${(f.galleryPhotos && f.galleryPhotos.length) ? `
    <div class="gallery-scroll" style="display:flex;gap:10px;flex-wrap:wrap;">
      ${f.galleryPhotos.map((src, idx) => `
      <div style="text-align:center;">
        <img src="${src}" alt="" class="gallery-thumb" style="object-fit:cover;" />
        <form method="post" action="/admin/freelancer/${f.id}/gallery/${idx}/remove" style="margin-top:4px;" onsubmit="return confirm('להסיר את התמונה הזו מהגלריה?');"><button class="btn btn-small btn-outline" type="submit">הסרה</button></form>
      </div>`).join("")}
    </div>` : `<p class="muted">עדיין אין תמונות גלריה.</p>`}
    <form method="post" action="/admin/freelancer/${f.id}/photos" enctype="multipart/form-data" style="margin-top:18px;">
      <label>תמונת פרופיל חדשה ${f.photoDataUri ? "(להחלפה)" : ""}<input type="file" name="photo" accept="image/*" /></label>
      <label>לוגו חדש ${f.logoDataUri ? "(להחלפה)" : ""}<input type="file" name="logo" accept="image/*" data-sc-crop="1" /></label>
      <label style="margin-top:10px;">תמונות גלריה (עד 4 - העלאת תמונה כאן מחליפה את כל הגלריה הקיימת)
      <input type="file" name="gallery1" accept="image/*" style="margin-bottom:8px;" /></label>
      <input type="file" name="gallery2" accept="image/*" style="margin-bottom:8px;" />
      <input type="file" name="gallery3" accept="image/*" style="margin-bottom:8px;" />
      <input type="file" name="gallery4" accept="image/*" />
      <button class="btn" style="margin-top:14px;width:100%;" type="submit">העלאה</button>
    </form>
    <p class="muted" style="margin-top:14px;"><a href="/admin">← חזרה לניהול</a></p>
  </div>
  `;
  sendHtml(res, 200, page({ title: `תמונות - ${f.businessName || f.name}`, session: ctx.session, body, query, noSidebars: true }));
});

route("POST", "/admin/freelancer/:id/photo/remove", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) { f.photoDataUri = null; db.save(); }
  redirect(res, `/admin/freelancer/${params.id}/photos?ok=${encodeURIComponent("תמונת הפרופיל הוסרה.")}`);
});

route("POST", "/admin/freelancer/:id/logo/remove", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) { f.logoDataUri = null; db.save(); }
  redirect(res, `/admin/freelancer/${params.id}/photos?ok=${encodeURIComponent("הלוגו הוסר.")}`);
});

route("POST", "/admin/freelancer/:id/gallery/:idx/remove", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  const idx = parseInt(params.idx, 10);
  if (f && Array.isArray(f.galleryPhotos) && Number.isInteger(idx) && idx >= 0 && idx < f.galleryPhotos.length) {
    f.galleryPhotos.splice(idx, 1);
    db.save();
  }
  redirect(res, `/admin/freelancer/${params.id}/photos?ok=${encodeURIComponent("התמונה הוסרה מהגלריה.")}`);
});

// Both routes back the customSubcategoryNoteHtml highlight box - rename actually edits the
// shared subcategory record (so a typo fix applies everywhere it's used, not just for this one
// freelancer), while dismiss just clears the flag without changing anything. Either way the
// flag is cleared, since both mean "Sapir has looked at this."
route("POST", "/admin/freelancer/:id/subcategory-note/rename", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const body = await readBody(req);
  const f = d.freelancers.find((x) => x.id === params.id);
  const newName = clip((body.get("newName") || "").trim(), 80);
  if (f && newName) {
    const category = d.categories.find((c) => c.id === f.categoryId);
    const sub = category && (category.subcategories || []).find((s) => s.id === f.subcategoryId);
    if (sub) sub.name = newName;
    f.customSubcategoryPending = false;
    db.save();
  }
  redirect(res, `/admin?ok=${encodeURIComponent("שם תת-התחום עודכן.")}`);
});

route("POST", "/admin/freelancer/:id/subcategory-note/dismiss", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) { f.customSubcategoryPending = false; db.save(); }
  redirect(res, `/admin?ok=${encodeURIComponent("סומן כנבדק.")}`);
});

route("POST", "/admin/freelancer/:id/photos", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin/freelancer/${params.id}/photos?err=${encodeURIComponent("התמונות ביחד גדולות מדי - נסי עם פחות תמונות או תמונות קטנות יותר.")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, `/admin?err=${encodeURIComponent("העצמאית לא נמצאה.")}`);
  const newPhoto = fileToDataUri(body.files.photo, MAX_UPLOAD_BYTES);
  if (newPhoto) f.photoDataUri = newPhoto;
  const newLogo = fileToDataUri(body.files.logo, MAX_UPLOAD_BYTES);
  if (newLogo) f.logoDataUri = newLogo;
  const newGallery = ["gallery1", "gallery2", "gallery3", "gallery4"]
    .map((field) => fileToDataUri(body.files[field], MAX_UPLOAD_BYTES))
    .filter(Boolean);
  if (newGallery.length) f.galleryPhotos = newGallery;
  db.save();
  redirect(res, `/admin/freelancer/${f.id}/photos?ok=${encodeURIComponent("עודכן!")}`);
});

// Permanent delete - unlike reject (which just hides her from the public site but keeps the
// record), this fully removes the freelancer and every piece of data that points back at her
// id, so a mistaken bulk-import (or any other freelancer) can be cleaned up completely rather
// than left as an orphaned "rejected" row forever.
route("POST", "/admin/freelancer/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, `/admin?ok=${encodeURIComponent("כבר לא קיימת.")}`);
  const fid = f.id;
  d.freelancers = d.freelancers.filter((x) => x.id !== fid);
  d.reviews = (d.reviews || []).filter((r) => !(r.type === "freelancer" && r.targetId === fid));
  d.stories = (d.stories || []).filter((s) => s.freelancerId !== fid);
  d.chatMessages = (d.chatMessages || []).filter((m) => m.freelancerId !== fid);
  d.couponRevealEvents = (d.couponRevealEvents || []).filter((e) => e.freelancerId !== fid);
  d.deals = (d.deals || []).filter((x) => x.freelancerId !== fid);
  d.adminMessages = (d.adminMessages || []).filter((m) => m.freelancerId !== fid);
  d.polls = (d.polls || []).filter((p) => p.freelancerId !== fid);
  (d.arenaQuestions || []).forEach((q) => {
    q.answers = (q.answers || []).filter((a) => a.freelancerId !== fid);
  });
  d.customers.forEach((c) => {
    c.favorites = (c.favorites || []).filter((k) => k !== fid && !String(k).startsWith(`${fid}:`));
    c.revealedCoupons = (c.revealedCoupons || []).filter((r) => r.freelancerId !== fid);
    c.viewedDeals = (c.viewedDeals || []).filter((v) => v.freelancerId !== fid);
  });
  if (d.settings.freelancerOfWeekId === fid) d.settings.freelancerOfWeekId = null;
  if (d.settings.weeklyTipCurrentFreelancerId === fid) d.settings.weeklyTipCurrentFreelancerId = null;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("העצמאית נמחקה לצמיתות, יחד עם כל הביקורות/הודעות/מועדפים שהיו קשורים אליה.")}`);
});

route("POST", "/admin/listing/:fid/:lid/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.fid);
  const l = f && (f.additionalListings || []).find((x) => String(x.id) === params.lid);
  if (l) l.status = "approved";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("התחום אושר! הוא כבר באוויר.")}`);
});

route("POST", "/admin/listing/:fid/:lid/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.fid);
  const l = f && (f.additionalListings || []).find((x) => String(x.id) === params.lid);
  if (l) l.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("התחום נדחה.")}`);
});

route("POST", "/admin/review/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const r = d.reviews.find((x) => x.id === params.id);
  if (r) r.status = "approved";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("אושרה ועלתה לאתר.")}`);
});

route("POST", "/admin/review/:id/reject", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const r = d.reviews.find((x) => x.id === params.id);
  if (r) r.status = "rejected";
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("נדחתה.")}`);
});

// Freelancer reviews auto-publish now (no approval queue), so this is the moderation
// backstop - permanently removes a review a customer already left, for anything
// inappropriate that slipped through.
route("POST", "/admin/review/:id/delete", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const idx = d.reviews.findIndex((x) => x.id === params.id);
  if (idx !== -1) d.reviews.splice(idx, 1);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("ההמלצה נמחקה.")}`);
});

// ----- Static-ish pages -----
route("GET", "/about", async (req, res, params, query, ctx) => {
  const d = db.load();
  const body = `<h1 class="section-title">מי אנחנו</h1><div class="panel" style="text-align:right;max-width:680px;margin:0 auto;">${renderRichText(d.settings.aboutText)}</div><p class="muted" style="text-align:center;margin-top:18px;">יש לך שאלה או רצית לספר לנו משהו? <a href="/contact" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">בואי נדבר</a> ❤️</p>`;
  sendHtml(res, 200, page({ title: "מי אנחנו", session: ctx.session, body, query }));
});
route("GET", "/contact", async (req, res, params, query, ctx) => {
  const d = db.load();
  // Pulls from the same "מייל ליצירת קשר" setting shown on the home page (admin panel ->
  // קבוצת הווטסאפ והמייל ליצירת קשר), instead of a hardcoded address, so updating it in one
  // place keeps every page in sync automatically.
  const body = `
  <div class="contact-hero"><span class="contact-hero-icon" aria-hidden="true">💌</span></div>
  <h1 class="section-title">צרי קשר</h1>
  <p class="muted" style="text-align:center;max-width:560px;margin:0 auto;">${d.settings.contactEmail ? `אפשר לכתוב לנו ישירות למייל <a href="mailto:${esc(d.settings.contactEmail)}">${esc(d.settings.contactEmail)}</a>, או להשאיר כאן כמה מילים ונחזור אלייך בהקדם ❤️` : "אפשר להשאיר כאן כמה מילים ונחזור אלייך בהקדם ❤️"}</p>
  <form class="panel" method="post" action="/contact" style="max-width:480px;margin:24px auto;">
    <label>שם<input type="text" name="name" required /></label>
    <label>מייל לחזרה אלייך<input type="email" name="email" required /></label>
    <label>מה תרצי לספר לנו?<textarea name="message" required></textarea></label>
    <div style="position:absolute;left:-9999px;top:-9999px;" aria-hidden="true">
      <label>השאירי שדה זה ריק<input type="text" name="website" tabindex="-1" autocomplete="off" /></label>
    </div>
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">שליחה</button>
  </form>
  `;
  sendHtml(res, 200, page({ title: "צרי קשר", session: ctx.session, body, query }));
});

route("POST", "/contact", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const okRedirect = () => redirect(res, `/contact?ok=${encodeURIComponent("קיבלנו את ההודעה שלך - תודה! נחזור אלייך בהקדם ❤️")}`);
  // honeypot: שדה מוסתר שבן/בת אדם אמיתיים אף פעם לא רואים ולכן אף פעם לא ממלאים - אם הוא לא
  // ריק, זו כמעט בוודאות שליחה אוטומטית של בוט. "מצליחה" בשקט (אותה הודעת תודה) בלי להישמר.
  if ((body.get("website") || "").trim()) return okRedirect();
  const ip = getClientIp(req);
  // חסימת תוכן כפול - אותה הודעה, מילה במילה, מאותה IP, בתוך זמן קצר (ר' ההערה המלאה למעלה,
  // ליד isDuplicateContactMessage) - זה הדפוס המדויק של הספאם שספיר קיבלה בפועל, ולא פוגע
  // בלקוחה אמיתית ששולחת כמה הודעות שונות ברצף.
  if (isDuplicateContactMessage(ip, body.get("message"))) return okRedirect();
  // הגבלת קצב לפי IP - רשת ביטחון נוספת, עם סף גבוה בכוונה (ר' ההערה המלאה למעלה, ליד
  // isContactRateLimited) למקרה של בוט שמדלג גם על ה-honeypot וגם משנה את הטקסט כל פעם.
  if (isContactRateLimited(ip)) return okRedirect();
  const d = db.load();
  const id = db.nextId("message");
  d.contactMessages = d.contactMessages || [];
  d.contactMessages.push({
    id, name: (body.get("name") || "").trim(), email: (body.get("email") || "").trim(),
    message: (body.get("message") || "").trim(), createdAt: new Date().toISOString(), read: false,
  });
  db.save();
  okRedirect();
});

// ----- "לתמיכה לחצי 💬" - כפתור צף שמופיע בכל עמוד (ר' layout.js), בנוסף לעמוד "צרי קשר"
// הקיים למעלה, לא במקומו. כל מי שנכנסת יכולה לפתוח שיחה - כולל גולשת שלא נרשמה בכלל - ולראות
// אותה גם כאן באתר (דרך supportIdentity/supportKeyReadOnly, ר' הגדרתן למעלה) וגם במייל.
// כשספיר "מחוברת" (ר' isAdminOnline) ההודעות מוצגות/מתעדכנות כמו צ'אט חי, על בסיס polling
// קליל כל 3 שניות (בלי WebSockets - נשאר תואם ל-Node הפשוט ולפריסה ב-Render בלי שינוי תשתית).
// -----
route("GET", "/support", async (req, res, params, query, ctx) => {
  const d = db.load();
  const isCustomer = requireRole(ctx.session, "customer");
  const isFreelancer = requireRole(ctx.session, "freelancer");
  let prefillName = "", prefillEmail = "";
  if (isCustomer) {
    const c = d.customers.find((x) => x.id === ctx.session.id);
    if (c) { prefillName = c.name || ""; prefillEmail = c.email || ""; }
  } else if (isFreelancer) {
    const f = d.freelancers.find((x) => x.id === ctx.session.id);
    if (f) { prefillName = f.businessName || f.name || ""; prefillEmail = f.email || ""; }
  }
  const key = supportKeyReadOnly(req, ctx);
  const myMessages = key
    ? (d.supportMessages || []).filter((m) => m.voterKey === key).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    : [];
  const online = isAdminOnline(d);
  const lastTs = myMessages.length ? myMessages[myMessages.length - 1].createdAt : new Date(0).toISOString();
  const onlineBannerHtml = online
    ? `<p class="muted" style="text-align:center;color:var(--rose-dark);font-weight:800;">🟢 אנחנו מחוברות עכשיו - את יכולה לקבל תשובה מיידית</p>`
    : `<p class="muted" style="text-align:center;">⚪ כרגע לא מחוברות - תשאירי הודעה ונחזור אלייך בהקדם, גם באתר וגם במייל</p>`;
  const startFormHtml = `
    <form id="scSupportStartForm" method="post" action="/support/send">
      ${(isCustomer || isFreelancer) ? `<p class="muted" style="margin-bottom:10px;">שולחת בתור ${esc(prefillName)}</p>` : `<label>שם<input type="text" name="name" required maxlength="80" /></label>`}
      <label>מייל לחזרה אלייך<input type="email" name="email" required maxlength="150" value="${esc(prefillEmail)}" /></label>
      <label>מה תרצי לשאול?<textarea name="text" required maxlength="800"></textarea></label>
      <button class="btn" type="submit" style="margin-top:10px;width:100%;">שליחה</button>
    </form>`;
  const chatHtml = `
    <div id="scSupportThread" class="chat-thread" style="max-height:420px;">
      ${myMessages.map(supportBubbleHtml).join("")}
    </div>
    <form id="scSupportSendForm" method="post" action="/support/send">
      <textarea name="text" id="scSupportInput" required maxlength="800" placeholder="כתבי הודעה..." style="min-height:60px;"></textarea>
      <button class="btn" style="margin-top:8px;width:100%;" type="submit">שליחה</button>
    </form>`;
  const body = `
  <h1 class="section-title">לתמיכה לחצי 💬</h1>
  <p class="muted" style="text-align:center;">אנחנו כאן בשבילך.</p>
  <div class="panel" style="max-width:520px;margin:0 auto;">
    <div id="scSupportStatus">${onlineBannerHtml}</div>
    ${myMessages.length ? chatHtml : startFormHtml}
  </div>
  <script>
  (function(){
    var lastTs = ${JSON.stringify(lastTs)};
    var hasThread = ${myMessages.length ? "true" : "false"};
    // Guards against showing the same message twice - both from the strictly-greater-than
    // "since" filter on the server (belt-and-suspenders) and from the optimistic bubble a
    // send() adds locally possibly also coming back on the next poll() if the two overlap.
    var seenIds = {};
    Array.prototype.forEach.call(document.querySelectorAll('#scSupportThread [data-id]'), function(el){ seenIds[el.getAttribute('data-id')] = true; });
    function scrollDown(){ var t=document.getElementById('scSupportThread'); if(t) t.scrollTop = t.scrollHeight; }
    scrollDown();
    function bubbleEl(m){
      var div = document.createElement('div');
      div.className = 'chat-msg ' + (m.from === 'admin' ? 'from-admin' : 'from-asker');
      div.setAttribute('data-id', m.id);
      div.textContent = m.text;
      var meta = document.createElement('span');
      meta.className = 'chat-meta';
      meta.textContent = new Date(m.createdAt).toLocaleString('he-IL');
      div.appendChild(meta);
      return div;
    }
    function appendIfNew(m){
      if (seenIds[m.id]) return;
      seenIds[m.id] = true;
      var t = document.getElementById('scSupportThread');
      if (t) { t.appendChild(bubbleEl(m)); scrollDown(); }
    }
    function setStatus(isOnline){
      var el = document.getElementById('scSupportStatus');
      if (!el) return;
      el.innerHTML = isOnline
        ? '<p class="muted" style="text-align:center;color:var(--rose-dark);font-weight:800;">🟢 אנחנו מחוברות עכשיו - את יכולה לקבל תשובה מיידית</p>'
        : '<p class="muted" style="text-align:center;">⚪ כרגע לא מחוברות - תשאירי הודעה ונחזור אלייך בהקדם, גם באתר וגם במייל</p>';
    }
    function poll(){
      if (!hasThread) return;
      fetch('/support/poll?since=' + encodeURIComponent(lastTs), { headers: { 'Accept': 'application/json' } })
        .then(function(r){ return r.json(); })
        .then(function(data){
          setStatus(data.online);
          (data.messages || []).forEach(function(m){
            appendIfNew(m);
            lastTs = m.createdAt;
          });
        }).catch(function(){});
    }
    setInterval(poll, 3000);
    function wireForm(formId, isFirst){
      var form = document.getElementById(formId);
      if (!form) return;
      form.addEventListener('submit', function(ev){
        ev.preventDefault();
        var fd = new FormData(form);
        fetch('/support/send', { method: 'POST', body: fd, headers: { 'Accept': 'application/json' } })
          .then(function(r){ return r.json(); })
          .then(function(data){
            if (!data.ok) { alert(data.error || 'שגיאה בשליחה - נסי שוב.'); return; }
            if (isFirst) { location.reload(); return; }
            appendIfNew(data.message);
            lastTs = data.message.createdAt;
            hasThread = true;
            var ta = document.getElementById('scSupportInput');
            if (ta) ta.value = '';
          }).catch(function(){ alert('שגיאה בשליחה - נסי שוב.'); });
      });
    }
    wireForm('scSupportStartForm', true);
    wireForm('scSupportSendForm', false);
  })();
  </script>
  `;
  sendHtml(res, 200, page({ title: "לתמיכה לחצי", session: ctx.session, body, query }));
});

route("POST", "/support/send", async (req, res, params, query, ctx) => {
  const d = db.load();
  const body = await readBody(req);
  const { key, newCookie } = supportIdentity(req, ctx);
  const isCustomer = requireRole(ctx.session, "customer");
  const isFreelancer = requireRole(ctx.session, "freelancer");
  const wantsJson = (req.headers["accept"] || "").includes("application/json");
  const existing = (d.supportMessages || []).find((m) => m.voterKey === key);
  let name = "";
  let email = clip((body.get("email") || "").trim(), 150);
  if (isCustomer) {
    const c = d.customers.find((x) => x.id === ctx.session.id);
    name = c ? (c.name || "") : "";
    if (!email && c) email = c.email || "";
  } else if (isFreelancer) {
    const f = d.freelancers.find((x) => x.id === ctx.session.id);
    name = f ? (f.businessName || f.name || "") : "";
    if (!email && f) email = f.email || "";
  } else {
    name = clip((body.get("name") || "").trim(), 80) || (existing ? existing.name : "");
  }
  if (!email && existing) email = existing.email;
  const text = clip((body.get("text") || "").trim(), 800);
  const respond = (status, payload) => {
    if (wantsJson) {
      return sendHtml(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8", ...(newCookie ? { "Set-Cookie": newCookie } : {}) });
    }
    if (payload.ok) return redirect(res, `/support?ok=${encodeURIComponent("ההודעה שלך נשלחה!")}`, newCookie);
    return redirect(res, `/support?err=${encodeURIComponent(payload.error)}`, newCookie);
  };
  if (!name || !email || !text) {
    return respond(400, { ok: false, error: "נא למלא שם, מייל והודעה." });
  }
  const id = db.nextId("supportMessage");
  const message = { id, voterKey: key, name, email, from: "asker", text, createdAt: new Date().toISOString(), read: false };
  d.supportMessages = d.supportMessages || [];
  d.supportMessages.push(message);
  // הודעה חדשה ממנה היא סימן חיים - "מעירה" שיחה שהיא סימנה כסגורה/המשך טיפול בחזרה לתור
  // הרגיל, כדי שהודעה טרייה אף פעם לא תישאר קבורה (ר' reopenSupportThread למעלה).
  reopenSupportThread(d, key);
  db.save();
  // Only push/email-notify Sapir when she's NOT already live in the admin panel watching - keeps
  // an active back-and-forth chat from spamming her inbox, while a message left while she's away
  // still reaches her the same push-first/email-fallback way a new freelancer signup does.
  if (!isAdminOnline(d)) {
    const notifyAdmin = d.admins[0];
    const notifyTo = d.settings.contactEmail || notifyAdmin.email;
    sendPushToUser(notifyAdmin, { title: "הודעה חדשה מהאתר 💬", body: `${name}: ${text}`, url: "/admin" })
      .then((pushed) => { if (!pushed) sendEmail(notifyTo, `הודעה חדשה מהאתר - ${name}`,
        `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>${esc(name)} (${esc(email)}) כתבה:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(text)}</p><p>אפשר לענות לה מפאנל הניהול.</p></div>`
      ).catch(() => {}); })
      .catch(() => {});
  }
  respond(200, { ok: true, message });
});

route("GET", "/support/poll", async (req, res, params, query, ctx) => {
  const d = db.load();
  const key = supportKeyReadOnly(req, ctx);
  const since = query.get("since") ? new Date(query.get("since")).getTime() : 0;
  const messages = key
    ? (d.supportMessages || []).filter((m) => m.voterKey === key && new Date(m.createdAt).getTime() > since).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    : [];
  sendHtml(res, 200, JSON.stringify({ messages, online: isAdminOnline(d) }), { "Content-Type": "application/json; charset=utf-8" });
});

route("POST", "/admin/support/heartbeat", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return sendHtml(res, 401, JSON.stringify({ ok: false }), { "Content-Type": "application/json; charset=utf-8" });
  const d = db.load();
  d.settings.adminSupportActiveAt = new Date().toISOString();
  db.save();
  sendHtml(res, 200, JSON.stringify({ ok: true }), { "Content-Type": "application/json; charset=utf-8" });
});

// Manual on/off switch for the support service (see the panel + first-visit popup near the top
// of /admin, added per explicit request 2026-08-30) - isAdminOnline() now requires this to be
// true, on top of the existing heartbeat freshness check, so customers/freelancers only ever
// see her as "online" when she actually chose to turn the service on.
route("POST", "/admin/support/toggle", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return sendHtml(res, 401, JSON.stringify({ ok: false }), { "Content-Type": "application/json; charset=utf-8" });
  const d = db.load();
  const body = await readBody(req);
  const on = body.get("on") === "1";
  d.settings.adminSupportOnline = on;
  if (on) d.settings.adminSupportActiveAt = new Date().toISOString();
  db.save();
  sendHtml(res, 200, JSON.stringify({ ok: true, online: isAdminOnline(d) }), { "Content-Type": "application/json; charset=utf-8" });
});

route("GET", "/admin/chat/:freelancerId/:customerId", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.freelancerId);
  const c = d.customers.find((x) => x.id === params.customerId);
  const messages = (d.chatMessages || [])
    .filter((m) => m.freelancerId === params.freelancerId && m.customerId === params.customerId)
    .slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!messages.length) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את השיחה הזו.</p>` }));
  const body = `
  <h1 class="section-title">💬 שיחה בין ${esc(f ? (f.businessName || f.name) : "עצמאית שנמחקה")} ל${esc(c ? c.name : "לקוחה שנמחקה")}</h1>
  <p class="muted" style="text-align:center;">תצוגת קריאה בלבד - ${messages.length} הודעות.</p>
  <div class="panel" style="max-width:560px;margin:0 auto;">
    <div class="chat-thread" style="text-align:right;">
      ${messages.map((m) => `<div class="chat-msg from-${m.fromRole}">${esc(m.text)}<span class="chat-meta">${m.fromRole === "freelancer" ? esc(f ? (f.businessName || f.name) : "עצמאית") : esc(c ? c.name : "לקוחה")} · ${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`).join("")}
    </div>
  </div>
  <p class="muted" style="text-align:center;margin-top:16px;"><a href="/admin#chat-monitoring">חזרה לפאנל הניהול</a></p>
  `;
  sendHtml(res, 200, page({ title: "שיחה פרטית", session: ctx.session, body }));
});

route("GET", "/admin/support/thread/:key", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const voterKey = decodeSupportKey(params.key);
  const messages = (d.supportMessages || []).filter((m) => m.voterKey === voterKey).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!messages.length) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את השיחה הזו.</p>` }));
  let anyMarkedRead = false;
  messages.forEach((m) => { if (m.from === "asker" && !m.read) { m.read = true; anyMarkedRead = true; } });
  if (anyMarkedRead) db.save();
  const last = messages[messages.length - 1];
  const lastTs = last.createdAt;
  const closedNow = isSupportClosed(d, voterKey);
  const body = `
  <h1 class="section-title">💬 שיחה עם ${esc(last.name)}</h1>
  <p class="muted" style="text-align:center;">${esc(last.email)}</p>
  <div class="panel" style="max-width:560px;margin:0 auto;">
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:12px;">
      ${closedNow
        ? `<p class="muted" style="width:100%;text-align:center;margin:0 0 4px;">🔒 השיחה הזו מסומנת כסגורה.</p><form method="post" action="/admin/support/thread/${esc(params.key)}/reopen"><button class="btn btn-small btn-outline" type="submit">פתיחה מחדש</button></form>`
        : `${snoozeButtonHtml(`support:${voterKey}`, "support", `שיחת תמיכה עם ${last.name}`)}<form method="post" action="/admin/support/thread/${esc(params.key)}/close"><button class="btn btn-small btn-outline" type="submit">✖ סגירת השיחה</button></form>`}
    </div>
    <div id="scSupportThread" class="chat-thread" style="max-height:480px;">
      ${messages.map(supportBubbleHtml).join("")}
    </div>
    <!-- כפתורי הדבקה מהירה - לפי בקשה מפורשת 2026-08-30 ("במקום השלמה אוטומטית, שים לי אותן
         למעלה וכשאני לוחצת עליהן הן יופיעו בתיבת הכתיבה שלי") - מזריקות טקסט לתיבת התשובה שלה
         (scSupportInput) במיקום הסמן הנוכחי, בלי לגעת בכלל בטקסט שכבר כתובה שם. -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
      <button type="button" class="btn btn-small btn-outline" onclick="scInsertIntoSupportReply('shecan.office@gmail.com')">📧 shecan.office@gmail.com</button>
      <button type="button" class="btn btn-small btn-outline" onclick="scInsertIntoSupportReply('SheCan')">SheCan</button>
      ${AI_CONFIGURED
        ? `<button type="button" class="btn btn-small" id="scSuggestReplyBtn" onclick="scSuggestSupportReply()">💡 הצע לי תשובה</button>`
        : `<button type="button" class="btn btn-small btn-outline" disabled title="צריך להגדיר מפתח AI קודם - ראי הסבר בפאנל הגדרות האתר">💡 הצע לי תשובה (לא מוגדר עדיין)</button>`}
    </div>
    <form id="scSupportSendForm" method="post" action="/admin/support/thread/${esc(params.key)}/send">
      <textarea name="text" id="scSupportInput" required maxlength="800" placeholder="כתבי תשובה..." style="min-height:60px;"></textarea>
      <button class="btn" style="margin-top:8px;width:100%;" type="submit">שליחה</button>
    </form>
  </div>
  <p class="muted" style="text-align:center;margin-top:16px;"><a href="/admin">חזרה לפאנל הניהול</a></p>
  <script>
  function scInsertIntoSupportReply(text){
    var ta = document.getElementById('scSupportInput');
    if (!ta) return;
    var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    var pos = start + text.length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (e) {}
  }
  function scSuggestSupportReply(){
    var btn = document.getElementById('scSuggestReplyBtn');
    var ta = document.getElementById('scSupportInput');
    if (!btn || !ta) return;
    var originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'חושבת...';
    fetch('/admin/support/thread/${esc(params.key)}/suggest', { method: 'POST', headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.json(); })
      .then(function(data){
        btn.disabled = false;
        btn.textContent = originalLabel;
        if (!data.ok) { alert(data.error || 'לא הצלחנו להביא הצעה כרגע, נסי שוב.'); return; }
        ta.value = (ta.value && ta.value.trim()) ? (ta.value + '\\n\\n' + data.text) : data.text;
        ta.focus();
      }).catch(function(){
        btn.disabled = false;
        btn.textContent = originalLabel;
        alert('לא הצלחנו להביא הצעה כרגע, נסי שוב.');
      });
  }
  (function(){
    var lastTs = ${JSON.stringify(lastTs)};
    var seenIds = {};
    Array.prototype.forEach.call(document.querySelectorAll('#scSupportThread [data-id]'), function(el){ seenIds[el.getAttribute('data-id')] = true; });
    function scrollDown(){ var t=document.getElementById('scSupportThread'); if(t) t.scrollTop = t.scrollHeight; }
    scrollDown();
    function bubbleEl(m){
      var div = document.createElement('div');
      div.className = 'chat-msg ' + (m.from === 'admin' ? 'from-admin' : 'from-asker');
      div.setAttribute('data-id', m.id);
      div.textContent = m.text;
      var meta = document.createElement('span');
      meta.className = 'chat-meta';
      meta.textContent = new Date(m.createdAt).toLocaleString('he-IL');
      div.appendChild(meta);
      return div;
    }
    function appendIfNew(m){
      if (seenIds[m.id]) return;
      seenIds[m.id] = true;
      var t = document.getElementById('scSupportThread');
      if (t) { t.appendChild(bubbleEl(m)); scrollDown(); }
    }
    function poll(){
      fetch('/admin/support/thread/${esc(params.key)}/poll?since=' + encodeURIComponent(lastTs), { headers: { 'Accept': 'application/json' } })
        .then(function(r){ return r.json(); })
        .then(function(data){
          (data.messages || []).forEach(function(m){
            appendIfNew(m);
            lastTs = m.createdAt;
          });
        }).catch(function(){});
    }
    setInterval(poll, 3000);
    var form = document.getElementById('scSupportSendForm');
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      var fd = new FormData(form);
      fetch(form.action, { method: 'POST', body: fd, headers: { 'Accept': 'application/json' } })
        .then(function(r){ return r.json(); })
        .then(function(data){
          if (!data.ok) { alert('שגיאה בשליחה - נסי שוב.'); return; }
          appendIfNew(data.message);
          lastTs = data.message.createdAt;
          var ta = document.getElementById('scSupportInput');
          if (ta) ta.value = '';
        }).catch(function(){ alert('שגיאה בשליחה - נסי שוב.'); });
    });
  })();
  </script>
  `;
  sendHtml(res, 200, page({ title: `שיחה עם ${last.name}`, session: ctx.session, body, query, noSidebars: true }));
});

route("GET", "/admin/support/thread/:key/poll", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return sendHtml(res, 401, JSON.stringify({ messages: [] }), { "Content-Type": "application/json; charset=utf-8" });
  const d = db.load();
  const voterKey = decodeSupportKey(params.key);
  const since = query.get("since") ? new Date(query.get("since")).getTime() : 0;
  const messages = (d.supportMessages || []).filter((m) => m.voterKey === voterKey && new Date(m.createdAt).getTime() > since).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let anyMarkedRead = false;
  messages.forEach((m) => { if (m.from === "asker" && !m.read) { m.read = true; anyMarkedRead = true; } });
  if (anyMarkedRead) db.save();
  sendHtml(res, 200, JSON.stringify({ messages }), { "Content-Type": "application/json; charset=utf-8" });
});

route("POST", "/admin/support/thread/:key/suggest", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return sendHtml(res, 401, JSON.stringify({ ok: false }), { "Content-Type": "application/json; charset=utf-8" });
  const d = db.load();
  const voterKey = decodeSupportKey(params.key);
  const messages = (d.supportMessages || []).filter((m) => m.voterKey === voterKey).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!messages.length) return sendHtml(res, 404, JSON.stringify({ ok: false, error: "השיחה לא נמצאה." }), { "Content-Type": "application/json; charset=utf-8" });
  const result = await suggestSupportReply(d, messages.slice(-12));
  if (!result.ok) {
    const errorMsg = result.reason === "not_configured"
      ? "עוד לא הוגדר מפתח AI באתר - אפשר להגדיר אותו בהגדרות האתר (מפתח ANTHROPIC_API_KEY ב-Render) ואז הכפתור הזה יתחיל לעבוד."
      : "משהו השתבש בקבלת ההצעה מה-AI, אפשר לנסות שוב בעוד רגע.";
    return sendHtml(res, 200, JSON.stringify({ ok: false, error: errorMsg }), { "Content-Type": "application/json; charset=utf-8" });
  }
  sendHtml(res, 200, JSON.stringify({ ok: true, text: result.text }), { "Content-Type": "application/json; charset=utf-8" });
});

route("POST", "/admin/support/thread/:key/send", async (req, res, params, query, ctx) => {
  const wantsJson = (req.headers["accept"] || "").includes("application/json");
  if (!requireRole(ctx.session, "admin")) {
    return wantsJson ? sendHtml(res, 401, JSON.stringify({ ok: false }), { "Content-Type": "application/json; charset=utf-8" }) : redirect(res, "/login");
  }
  const d = db.load();
  const voterKey = decodeSupportKey(params.key);
  const existing = (d.supportMessages || []).find((m) => m.voterKey === voterKey);
  if (!existing) {
    return wantsJson ? sendHtml(res, 404, JSON.stringify({ ok: false, error: "השיחה לא נמצאה." }), { "Content-Type": "application/json; charset=utf-8" }) : redirect(res, "/admin");
  }
  const body = await readBody(req);
  const text = clip((body.get("text") || "").trim(), 800);
  if (!text) {
    return wantsJson ? sendHtml(res, 400, JSON.stringify({ ok: false, error: "נא לכתוב הודעה." }), { "Content-Type": "application/json; charset=utf-8" }) : redirect(res, `/admin/support/thread/${params.key}`);
  }
  const id = db.nextId("supportMessage");
  const message = { id, voterKey, name: existing.name, email: existing.email, from: "admin", text, createdAt: new Date().toISOString(), read: true };
  d.supportMessages = d.supportMessages || [];
  d.supportMessages.push(message);
  db.save();
  // Askers (especially anonymous ones) have no push subscription at all, so email is her only
  // real fallback notification channel if she isn't sitting on the page watching it live.
  sendEmail(existing.email, "קיבלת תשובה ל-SheCan 💬",
    `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(existing.name || "")},</p><p>קיבלת תשובה חדשה בשיחה שלך עם SheCan:</p><p style="background:#f3ede8;padding:12px;border-radius:8px;">${esc(text)}</p><p>אפשר גם לראות ולהמשיך את השיחה באתר עצמו, בעמוד "לתמיכה לחצי".</p></div>`
  ).catch(() => {});
  if (wantsJson) return sendHtml(res, 200, JSON.stringify({ ok: true, message }), { "Content-Type": "application/json; charset=utf-8" });
  redirect(res, `/admin/support/thread/${params.key}`);
});

// "לסגור את השיחה" (ר' isSupportClosed למעלה) - שיחה חוזרת לתור הרגיל לבד ברגע שהשואלת כותבת
// שוב (ר' reopenSupportThread ב-POST /support/send), אז אין צורך "לזכור" לפתוח מחדש ידנית.
route("POST", "/admin/support/thread/:key/close", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const voterKey = decodeSupportKey(params.key);
  d.supportClosed = d.supportClosed || [];
  if (!d.supportClosed.includes(voterKey)) d.supportClosed.push(voterKey);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("השיחה סומנה כסגורה.")}#support-threads`);
});

route("POST", "/admin/support/thread/:key/reopen", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const voterKey = decodeSupportKey(params.key);
  d.supportClosed = (d.supportClosed || []).filter((k) => k !== voterKey);
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("השיחה נפתחה מחדש.")}#support-threads`);
});

// JSON קטן שמזין את הוידג'ט הצף (ר' layout.js, בתוך ה-if (SC_IS_ADMIN) השלישי) - רשימת שיחות
// שממתינות למענה כרגע (לא סגורות ולא במעקב), הכי ותיקה-בלי-מענה קודם, כדי שהכי דחוף תמיד למעלה.
// גם מפעילה כאן את בדיקת התזכורת (ר' checkAndSendUnansweredReminders) כדי שהיא תרוץ גם כשהיא
// נמצאת רק על עמוד השיחה עצמה או על עמוד ניהול אחר שלא טוען מחדש את /admin.
route("GET", "/admin/support/open-summary", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return sendHtml(res, 401, JSON.stringify({ threads: [] }), { "Content-Type": "application/json; charset=utf-8" });
  const d = db.load();
  checkAndSendUnansweredReminders(d);
  const byKey = {};
  (d.supportMessages || []).forEach((m) => { (byKey[m.voterKey] = byKey[m.voterKey] || []).push(m); });
  const now = Date.now();
  const threads = Object.keys(byKey)
    .filter((key) => !isSupportClosed(d, key) && !isSnoozed(d, `support:${key}`))
    .map((key) => {
      const msgs = byKey[key].slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const unreadMsgs = msgs.filter((m) => m.from === "asker" && !m.read);
      if (!unreadMsgs.length) return null;
      const oldest = unreadMsgs[0];
      const last = msgs[msgs.length - 1];
      return {
        url: `/admin/support/thread/${encodeSupportKey(key)}`,
        name: last.name,
        lastText: (last.text || "").slice(0, 90),
        unread: unreadMsgs.length,
        waitingMinutes: Math.max(0, Math.round((now - new Date(oldest.createdAt).getTime()) / 60000)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.waitingMinutes - a.waitingMinutes);
  sendHtml(res, 200, JSON.stringify({ threads }), { "Content-Type": "application/json; charset=utf-8" });
});

route("GET", "/terms", async (req, res, params, query, ctx) => {
  const d = db.load();
  const body = `<h1 class="section-title">תקנון</h1><div class="panel" style="text-align:right;max-width:720px;margin:0 auto;">${renderRichText(d.settings.termsText)}</div>`;
  sendHtml(res, 200, page({ title: "תקנון", session: ctx.session, body, query }));
});

route("GET", "/privacy", async (req, res, params, query, ctx) => {
  const d = db.load();
  const body = `<h1 class="section-title">מדיניות פרטיות</h1><div class="panel" style="text-align:right;max-width:720px;margin:0 auto;">${renderRichText(d.settings.privacyPolicyText)}</div>`;
  sendHtml(res, 200, page({ title: "מדיניות פרטיות", session: ctx.session, body, query }));
});

route("GET", "/accessibility", async (req, res, params, query, ctx) => {
  const d = db.load();
  const body = `<h1 class="section-title">הצהרת נגישות</h1><div class="panel" style="text-align:right;max-width:720px;margin:0 auto;">${renderRichText(d.settings.accessibilityStatementText)}</div>`;
  sendHtml(res, 200, page({ title: "הצהרת נגישות", session: ctx.session, body, query }));
});

route("GET", "/coming-soon", async (req, res, params, query, ctx) => {
  const body = `
  <div class="panel" style="max-width:560px;margin:40px auto;text-align:center;">
    <div style="font-size:44px;">🚀</div>
    <h1 class="section-title" style="margin-top:10px;">בקרוב אצלנו</h1>
    <p style="font-size:17px;line-height:1.9;">פיצ'רים מתקדמים בדרך: ניהול יומן פגישות, מערכת דיוור אוטומטית והרשמה חכמה לסדנאות - בקרוב למנויות פרימיום, הישארי מחוברת.</p>
    <p style="font-size:17px;font-weight:800;color:var(--rose-dark);">✨ יש למה לחכות ✨</p>
  </div>
  `;
  sendHtml(res, 200, page({ title: "בקרוב", session: ctx.session, body, query }));
});

// ----- robots.txt - חוסם מנועי חיפוש כל עוד searchEngineVisible כבוי -----
// ---------- PWA (installable "app") + push subscriptions ----------
// Pre-load the icon files once at boot (small, static, never change at runtime) rather than
// hitting the filesystem on every request.
const ICONS_DIR = path.join(__dirname, "icons");
const ICON_FILES = {
  "icon-192.png": null, "icon-512.png": null, "icon-512-maskable.png": null, "apple-touch-icon.png": null,
};
Object.keys(ICON_FILES).forEach((name) => {
  try { ICON_FILES[name] = fs.readFileSync(path.join(ICONS_DIR, name)); }
  catch (e) { console.warn(`[pwa] missing icon file: ${name}`); }
});

route("GET", "/manifest.json", async (req, res, params, query, ctx) => {
  const manifest = {
    name: "SheCan - קהילת העצמאיות",
    short_name: "SheCan",
    description: "כל העסקים. כל התחומים. מקום אחד. SheCan",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F3EDE8",
    theme_color: "#9a8e81",
    dir: "rtl",
    lang: "he",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
  res.end(JSON.stringify(manifest));
});

route("GET", "/icons/:file", async (req, res, params, query, ctx) => {
  const buf = ICON_FILES[params.file];
  if (!buf) return sendHtml(res, 404, "not found");
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" });
  res.end(buf);
});

// Serves every image written by fileToDataUri / migrateEmbeddedPhotosToFiles (profile photos,
// logos, gallery shots, review/story photos, site logo/banner/background) - streamed straight
// off disk rather than held in memory, same reasoning as the magazine files fix above. Filenames
// are always our own randomly-generated names (never a user-typed path), but the extra pattern
// check + "..".includes guard is cheap defense-in-depth against path traversal regardless.
route("GET", "/uploads/:filename", async (req, res, params, query, ctx) => {
  const filename = params.filename || "";
  if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename.includes("..")) return sendHtml(res, 404, "not found");
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendHtml(res, 404, "not found");
    const ext = path.extname(filename).slice(1).toLowerCase();
    const mime = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
      gif: "image/gif", heic: "image/heic", heif: "image/heif", avif: "image/avif",
      bmp: "image/bmp", svg: "image/svg+xml",
      // וידאו - נוסף 2026-09-02 עבור סטטוסים (ר' saveStatusFile) שנשמרים באותה תיקייה בדיוק.
      mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    }[ext] || "application/octet-stream";
    // Filenames are random and never reused for different content, so this is safe to cache
    // "forever" on the client/CDN side - a changed photo always gets a brand-new filename.
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
    fs.createReadStream(filePath).on("error", () => res.end()).pipe(res);
  });
});

// The service worker: enables installability, and is REQUIRED for push - a push message is
// delivered to this worker even when no tab of the site is open, which is the whole point of
// "push straight to the phone" instead of email. No offline caching here on purpose - this
// site's content changes constantly (new listings, coupons, chat) and stale cached HTML would
// actively mislead people, so the fetch handler is a plain passthrough, present only because
// some browsers still use "has a fetch handler" as part of their install-eligibility check.
route("GET", "/sw.js", async (req, res, params, query, ctx) => {
  const sw = `
self.addEventListener("install", (event) => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (event) => { event.respondWith(fetch(event.request)); });
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || "SheCan";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    dir: "rtl",
    lang: "he",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const c of clientsArr) {
        if (c.url.includes(url) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
`;
  res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Service-Worker-Allowed": "/" });
  res.end(sw);
});

route("POST", "/push/subscribe", async (req, res, params, query, ctx) => {
  if (!ctx.session) return sendHtml(res, 401, "not logged in");
  const body = await readBody(req);
  let sub;
  try { sub = JSON.parse(body.get("subscription") || "{}"); } catch (e) { return sendHtml(res, 400, "bad subscription"); }
  if (!sub || !sub.endpoint || !sub.keys) return sendHtml(res, 400, "bad subscription");
  const d = db.load();
  const list = ctx.session.role === "customer" ? d.customers : ctx.session.role === "freelancer" ? d.freelancers : d.admins;
  const user = list.find((u) => u.id === ctx.session.id);
  if (!user) return sendHtml(res, 404, "not found");
  user.pushSubscriptions = user.pushSubscriptions || [];
  if (!user.pushSubscriptions.some((s) => s.endpoint === sub.endpoint)) {
    user.pushSubscriptions.push(sub);
    db.save();
  }
  sendHtml(res, 200, "ok");
});

route("POST", "/push/unsubscribe", async (req, res, params, query, ctx) => {
  if (!ctx.session) return sendHtml(res, 401, "not logged in");
  const body = await readBody(req);
  const endpoint = body.get("endpoint") || "";
  const d = db.load();
  const list = ctx.session.role === "customer" ? d.customers : ctx.session.role === "freelancer" ? d.freelancers : d.admins;
  const user = list.find((u) => u.id === ctx.session.id);
  if (user) {
    user.pushSubscriptions = (user.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
    db.save();
  }
  sendHtml(res, 200, "ok");
});

route("GET", "/robots.txt", async (req, res, params, query, ctx) => {
  const d = db.load();
  const txt = d.settings.searchEngineVisible
    ? "User-agent: *\nAllow: /\nSitemap: https://shecan.co.il/sitemap.xml\n"
    : "User-agent: *\nDisallow: /\n";
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(txt);
});

// ----- sitemap.xml (נוסף 2026-08-27, לפי בקשה מפורשת לשיפור הדירוג בגוגל) -----
// robots.txt (למעלה) כבר הצביע על /sitemap.xml מזמן, אבל שום ראוט לא באמת הגיש אותו - כלומר
// גוגל היה מקבל 404 בכל פעם שהוא מנסה להביא את מפת האתר. בונה כאן רשימה אמיתית: העמודים
// הסטטיים העיקריים, כל קטגוריה (עמוד "/search?category=X" שלה), וכל עצמאית/תחום-נוסף
// שמאושרים ופעילים כרגע - בדיוק כמו robots.txt, מוגש תמיד (גם כש-searchEngineVisible כבוי)
// כי קובץ XML לבד לא חושף כלום שלא ניתן להגיע אליו ישירות ממילא, וכך היא יכולה לבדוק/להכין
// אותו מראש לפני שהיא בכלל פותחת את האתר לגוגל.
route("GET", "/sitemap.xml", async (req, res, params, query, ctx) => {
  const d = db.load();
  const origin = getOrigin(req);
  const urls = [];
  const addUrl = (urlPath, changefreq, priority) => urls.push({ loc: `${origin}${urlPath}`, changefreq, priority });
  addUrl("/", "daily", "1.0");
  addUrl("/search", "daily", "0.9");
  addUrl("/deals", "daily", "0.7");
  addUrl("/magazine", "weekly", "0.6");
  addUrl("/stories", "weekly", "0.6");
  addUrl("/arena", "daily", "0.6");
  addUrl("/join", "monthly", "0.5");
  d.categories.forEach((c) => addUrl(`/search?category=${encodeURIComponent(c.id)}`, "weekly", "0.7"));
  d.freelancers.filter((f) => f.status === "approved" && f.active !== false).forEach((f) => {
    addUrl(`/freelancer/${encodeURIComponent(f.id)}`, "weekly", "0.8");
    (f.additionalListings || []).filter((l) => l.status === "approved").forEach((l) => {
      addUrl(`/freelancer/${encodeURIComponent(f.id)}/listing/${encodeURIComponent(l.id)}`, "weekly", "0.6");
    });
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u.loc)}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>\n`;
  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
  res.end(xml);
});

// ---------- server ----------
// Site-visit tracking, per explicit request - counts real page loads only (skips the admin
// area itself, the freelancer dashboard, static/asset routes and anything that isn't a GET),
// so the number reflects actual site traffic rather than admin/dashboard activity. Also skips
// anyone browsing while logged in as admin (Sapir's own visits to the public pages), per her
// follow-up request, so the number reflects real visitor traffic rather than her own testing/
// browsing. Kept as a simple hit counter (not unique visitors) to match how per-freelancer
// f.viewCount already works elsewhere in the app - same trade-off, same reasoning.
const SITE_VISIT_SKIP_PREFIXES = ["/admin", "/freelancer-dashboard", "/icons/", "/push/"];
// /support/poll: found and fixed 2026-08-25, while answering Sapir's question about whether the
// visit numbers could be inflated. The support chat's own live-update script (see GET /support)
// polls this endpoint every 3 seconds for as long as that page stays open - each tick is a
// normal GET, with no prefix above catching it, so it was silently counting as a full "site
// visit" the whole time (verified directly: 10 poll ticks -> totalVisits +10). A visitor who
// left the chat open for 10 minutes alone would have added ~200 to the count. The matching admin
// poll (GET /admin/support/thread/:key/poll) never had this problem - it already starts with
// "/admin", covered by the prefix list above.
const SITE_VISIT_SKIP_EXACT = new Set(["/manifest.json", "/sw.js", "/robots.txt", "/sitemap.xml", "/logout", "/support/poll"]);

// Best-effort bot/crawler detection via User-Agent, added per Sapir's request after she noticed
// a traffic spike with no promotion behind it - the raw totalVisits/dailyVisits counters above
// count every matching page load with no filtering at all (search-engine crawlers, AI-model
// crawlers, SEO/scraper tools, uptime pingers, etc. all count exactly like a real visitor - see
// the original comment above). This can never be 100% accurate (a well-behaved bot can spoof a
// normal-looking browser UA), so it's an estimate layered on top, not a replacement - the raw
// counters are kept exactly as before so nothing about existing historical numbers changes.
// Missing/empty User-Agent is also treated as a bot: every real browser sends one, so its
// absence is far more often a script/bot than a real person.
const BOT_UA_REGEX = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discordbot|skypeuripreview|vkshare|w3c_validator|headlesschrome|phantomjs|curl\/|wget\/|python-requests|python-urllib|scrapy|go-http-client|okhttp|axios\/|node-fetch|postmanruntime|archiver|ia_archiver|gptbot|chatgpt-user|claudebot|claude-web|anthropic|ccbot|bytespider|petalbot|ahrefsbot|semrushbot|mj12bot|dotbot|applebot|amazonbot|yandexbot|baiduspider|sogou|duckduckbot|google-inspectiontool|googlebot|bingbot|pingdom|uptimerobot|monitor/i;
function isLikelyBot(userAgent) {
  const ua = String(userAgent || "").trim();
  if (!ua) return true;
  return BOT_UA_REGEX.test(ua);
}

// Debounced persistence for high-frequency, low-value counters - unlike the many other
// db.save() calls throughout this file (each triggered by a rare, high-value user action like a
// signup or review, where writing to disk right away is worth it), this is for updates that fire
// on virtually every single GET request site-wide (trackSiteVisit() below, and the per-
// freelancer-profile view counter in GET /freelancer/:id). db.save() does a full
// JSON.stringify + a synchronous fs.writeFileSync of the ENTIRE database on every call - and
// this DB is not small, since every freelancer's photo and logo are stored as base64 text
// directly inside it (see the backup-download panel in the admin dashboard, which explicitly
// downloads "all photos including logos" as part of the one data file) - and only grows as more
// freelancers join. Doing that full serialize+write on every single page view - including
// back-to-back crawler hits - means a burst of traffic can pile up several full-DB
// serializations before the previous one's memory is released, which is almost certainly what
// produced the original "JavaScript heap out of memory" crash, and (even once it's not enough
// traffic to OOM) still blocks Node's single event loop for real time on every hit, which is
// exactly the kind of thing that shows up as the whole site feeling sluggish under normal
// browsing once there are enough freelancers/photos in the DB. The counters themselves still
// update instantly in memory either way (db.load() returns the same live cached object every
// route mutates), so throttling only delays *writing that to disk* - worst case a crash loses a
// few seconds of view-count history, never any real user data (every other route's own
// db.save() call still persists everything, including the latest counts, immediately as
// before). Despite the name, this is intentionally shared by any such counter, not just site
// stats - they all fold into the same 20-second window since they're all equally fine to
// coalesce together.
let lastSiteStatsSave = 0;
const SITE_STATS_SAVE_INTERVAL_MS = 20000;
function saveSiteStatsThrottled() {
  const now = Date.now();
  if (now - lastSiteStatsSave < SITE_STATS_SAVE_INTERVAL_MS) return;
  lastSiteStatsSave = now;
  db.save();
}
// Best-effort flush on a graceful shutdown (e.g. Render restarting the instance for a normal
// deploy) so a pending throttled save isn't lost - has no effect on a hard OOM kill, which never
// reaches these handlers, but costs nothing either.
process.on("SIGTERM", () => { try { db.save(); } catch (e) {} process.exit(0); });
process.on("SIGINT", () => { try { db.save(); } catch (e) {} process.exit(0); });

// Traffic-source detection, added 2026-08-25 per Sapir's request for "מאיפה היא הגיעה - צאט,
// מייל, ווצאפ" alongside the pure-entries counter below. Two layers, in priority order:
//
// 1) A tagged link (?src=whatsapp etc.) - the RELIABLE method, since she chose this over
//    referrer-only detection precisely because WhatsApp and mail apps routinely strip the
//    Referer header (they either open an in-app browser that sends none, or hand off to the
//    system browser with no referrer at all) - automatic detection alone would show most of her
//    real WhatsApp/email shares as "ישירה - לא ידוע". The admin dashboard's new "קישור לשיתוף"
//    panel builds these tagged links for her so she never has to type the parameter by hand.
// 2) The Referer header - a best-effort fallback for organic traffic she didn't personally tag
//    (someone finds her on Google, or another site links to her), classified into a handful of
//    known buckets. Same-site referrers (someone clicking a link from one SheCan page to
//    another) are deliberately NOT attributed as an external source - that's just browsing the
//    site, not a new arrival from somewhere else.
//
// Only called for the FIRST hit of a session (see isNewVisitSession in trackSiteVisit) - a
// source is captured once per visit, not once per page.
const KNOWN_SRC_TAGS = {
  whatsapp: "ווטסאפ", mail: "מייל", email: "מייל", instagram: "אינסטגרם", facebook: "פייסבוק",
  chat: "צ'אט / הודעה", sms: "SMS", other: "אחר (מתויג)",
};
function detectSource(query, refererHeader, hostHeader) {
  const tagRaw = (query.get("src") || "").toLowerCase().trim();
  if (tagRaw) {
    const key = tagRaw === "email" ? "mail" : tagRaw;
    if (KNOWN_SRC_TAGS[key]) return { key, label: KNOWN_SRC_TAGS[key] };
    const custom = tagRaw.replace(/[^a-z0-9_-]/g, "").slice(0, 30);
    if (custom) return { key: `tag:${custom}`, label: custom };
  }
  const ref = String(refererHeader || "").trim();
  if (!ref) return { key: "direct", label: "ישירה / לא ידועה" };
  try {
    const refHost = new URL(ref).hostname.replace(/^www\./, "");
    const selfHost = String(hostHeader || "").split(":")[0].replace(/^www\./, "");
    if (selfHost && (refHost === selfHost || refHost.endsWith("." + selfHost))) return null; // internal navigation - not an external source
    if (/(^|\.)google\.[a-z.]+$/.test(refHost)) return { key: "google", label: "גוגל (חיפוש)" };
    if (/(^|\.)bing\.com$/.test(refHost)) return { key: "bing", label: "Bing (חיפוש)" };
    if (["facebook.com", "m.facebook.com", "l.facebook.com", "lm.facebook.com"].includes(refHost)) return { key: "facebook", label: "פייסבוק" };
    if (refHost === "instagram.com" || refHost === "l.instagram.com") return { key: "instagram", label: "אינסטגרם" };
    if (refHost === "whatsapp.com" || refHost === "wa.me" || refHost === "web.whatsapp.com" || refHost === "api.whatsapp.com") return { key: "whatsapp", label: "ווטסאפ" };
    if (refHost === "mail.google.com") return { key: "mail", label: "מייל (Gmail)" };
    if (/^outlook\.(live|office|office365)\.com$/.test(refHost)) return { key: "mail", label: "מייל (Outlook)" };
    if (refHost === "t.co" || refHost === "twitter.com" || refHost === "x.com") return { key: "twitter", label: "טוויטר / X" };
    if (refHost === "tiktok.com") return { key: "tiktok", label: "טיקטוק" };
    return { key: `other:${refHost}`, label: refHost };
  } catch (e) {
    return { key: "direct", label: "ישירה / לא ידועה" };
  }
}
// Turns a stored source key back into a Hebrew label for display in the admin panel - kept as a
// function (not stored alongside the counts) so relabeling/retranslating never requires touching
// old data, only this lookup.
function sourceLabel(key) {
  if (key === "direct") return "ישירה / לא ידועה";
  if (key === "google") return "גוגל (חיפוש)";
  if (key === "bing") return "Bing (חיפוש)";
  if (key === "twitter") return "טוויטר / X";
  if (key === "tiktok") return "טיקטוק";
  if (KNOWN_SRC_TAGS[key]) return KNOWN_SRC_TAGS[key];
  if (key.startsWith("other:")) return key.slice(6);
  if (key.startsWith("tag:")) return key.slice(4);
  return key;
}

function trackSiteVisit(method, pathname, session, req, res, query) {
  if (method !== "GET") return;
  if (session && session.role === "admin") return;
  if (SITE_VISIT_SKIP_EXACT.has(pathname)) return;
  if (SITE_VISIT_SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return;
  const d = db.load();
  d.siteStats = d.siteStats || { totalVisits: 0, dailyVisits: {}, realVisits: 0, dailyRealVisits: {} };
  d.siteStats.realVisits = d.siteStats.realVisits || 0;
  d.siteStats.dailyRealVisits = d.siteStats.dailyRealVisits || {};
  d.siteStats.totalVisits = (d.siteStats.totalVisits || 0) + 1;
  const today = israelDayKeyOffset(0);
  d.siteStats.dailyVisits[today] = (d.siteStats.dailyVisits[today] || 0) + 1;
  // "Real" (estimated non-bot) counters - same events as above, minus anything whose User-Agent
  // matches BOT_UA_REGEX or is missing entirely.
  const bot = isLikelyBot(req.headers["user-agent"]);
  if (!bot) {
    d.siteStats.realVisits = (d.siteStats.realVisits || 0) + 1;
    d.siteStats.dailyRealVisits[today] = (d.siteStats.dailyRealVisits[today] || 0) + 1;
  }

  // "Pure entries" (unique visits/sessions, not page loads) - added 2026-08-25 per Sapir's
  // request for a count of only the ARRIVAL, not "מה שקורה אח״כ" (whatever she does on the site
  // afterward). A "session" here is marked by the scVisit cookie: the first non-skipped GET
  // without it is a new entry; every GET after that, for as long as she keeps browsing, refreshes
  // the cookie's 30-minute expiry WITHOUT counting again - so one long browsing session is one
  // entry, and only a real gap of 30+ minutes of inactivity starts a new one. Same total/real
  // split as the raw hit counters above, for the same bot-filtering reason.
  d.siteStats.uniqueEntries = d.siteStats.uniqueEntries || 0;
  d.siteStats.dailyUniqueEntries = d.siteStats.dailyUniqueEntries || {};
  d.siteStats.realUniqueEntries = d.siteStats.realUniqueEntries || 0;
  d.siteStats.dailyRealUniqueEntries = d.siteStats.dailyRealUniqueEntries || {};
  d.siteStats.sourceCounts = d.siteStats.sourceCounts || {};
  d.siteStats.dailySourceCounts = d.siteStats.dailySourceCounts || {};
  const cookies = auth.parseCookies(req);
  const VISIT_COOKIE_MAXAGE = 1800; // 30 min - matches the common "session" window (same default GA uses), easy to explain
  if (!cookies.scVisit) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    res.setHeader("Set-Cookie", `scVisit=${token}; HttpOnly; Path=/; Max-Age=${VISIT_COOKIE_MAXAGE}`);
    d.siteStats.uniqueEntries += 1;
    d.siteStats.dailyUniqueEntries[today] = (d.siteStats.dailyUniqueEntries[today] || 0) + 1;
    if (!bot) {
      d.siteStats.realUniqueEntries += 1;
      d.siteStats.dailyRealUniqueEntries[today] = (d.siteStats.dailyRealUniqueEntries[today] || 0) + 1;
      // Source is only tallied for the "real" (non-bot) side - a crawler hitting fresh every time
      // with no cookie jar would otherwise just spam the "ישירה" bucket with noise.
      const src = detectSource(query, req.headers["referer"], req.headers.host);
      if (src) {
        d.siteStats.sourceCounts[src.key] = (d.siteStats.sourceCounts[src.key] || 0) + 1;
        d.siteStats.dailySourceCounts[today] = d.siteStats.dailySourceCounts[today] || {};
        d.siteStats.dailySourceCounts[today][src.key] = (d.siteStats.dailySourceCounts[today][src.key] || 0) + 1;
      }
    }
  } else {
    // Same visit, later page - just slide the expiry so a long session doesn't lapse mid-browse.
    res.setHeader("Set-Cookie", `scVisit=${cookies.scVisit}; HttpOnly; Path=/; Max-Age=${VISIT_COOKIE_MAXAGE}`);
  }

  // Per-registered-user visit count, via the long-lived scUid identity cookie (see
  // identityCookie() above) - works whether or not she's currently logged in, as long as she's
  // logged in at least once on this browser before. Silently no-ops for anyone without the
  // cookie (never logged in, or a plain anonymous visitor) - nothing to attribute the visit to.
  const scUid = (cookies.scUid || "").split(":");
  if (scUid.length === 2) {
    const [uRole, uId] = scUid;
    const list = uRole === "customer" ? d.customers : uRole === "freelancer" ? d.freelancers : null;
    const user = list && list.find((x) => x.id === uId);
    if (user) user.siteVisitCount = (user.siteVisitCount || 0) + 1;
  }
  saveSiteStatsThrottled();
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const { session, sid } = getSession(req);
    const match = routes.find((r) => r.method === req.method && r.regex.test(u.pathname));
    if (!match) return sendHtml(res, 404, page({ title: "לא נמצא", session, body: "<p>הדף הזה לא קיים - בואי נחזור <a href=\"/\">הביתה</a> ❤️</p>" }));
    trackSiteVisit(req.method, u.pathname, session, req, res, u.searchParams);
    const m = u.pathname.match(match.regex);
    const params = {};
    match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    await match.handler(req, res, params, u.searchParams, { session, sid });
  } catch (e) {
    console.error(e);
    sendHtml(res, 500, "<h1>שגיאת שרת</h1><pre>" + esc(e.stack) + "</pre>");
  }
});

server.listen(PORT, () => console.log(`SheCan running on http://localhost:${PORT}`));
