// מצב נטפרי (Netfree mode) - אותו שרת, אותו מאגר נתונים, אותן עצמאיות, אבל כשהגולשת מגיעה
// דרך הדומיין השני (d.settings.netfreeHosts / משתנה סביבה NETFREE_HOSTS) האתר מציג *רק* את
// מה שמופיע כאן ב"רשימה הלבנה" (ALLOWED_GET) - שאר האתר (מגזין, זירה, קהילה, סיפורים, הרשמה,
// התחברות וכו') פשוט לא קיים בדומיין הזה (404), גם אם יתווסף אליו קוד חדש בעתיד. כך אפשר
// להמשיך לפתח את האתר הראשי בחופשיות בלי שזה יזלוג לגרסת נטפרי ויגרום לחסימה שלה.
//
// ההכרעה "האם הבקשה הזאת נטפרי" נשמרת ב-AsyncLocalStorage (ולא מועברת כפרמטר) כדי שפונקציות
// עומק כמו cardPhotoHtml / sidebarColumnsHtml / page() בשני הקבצים יוכלו לשאול isNetfree() בלי
// לשנות חתימות של עשרות קריאות קיימות.
const { AsyncLocalStorage } = require("async_hooks");
const db = require("./db");

const als = new AsyncLocalStorage();

function runWith(ctx, fn) { return als.run(ctx, fn); }
function isNetfree() { const s = als.getStore(); return !!(s && s.netfree); }

function normalizeHost(h) {
  return String(h || "").toLowerCase().trim().replace(/:\d+$/, "").replace(/^www\./, "");
}

function configuredHosts() {
  let d = null;
  try { d = db.load(); } catch (e) { d = null; }
  const fromSettings = d && d.settings && d.settings.netfreeHosts ? String(d.settings.netfreeHosts) : "";
  const fromEnv = process.env.NETFREE_HOSTS || "";
  return `${fromSettings},${fromEnv}`.split(/[\s,;]+/).map(normalizeHost).filter(Boolean);
}

function hostIsNetfree(hostHeader) {
  const h = normalizeHost(hostHeader);
  if (!h) return false;
  return configuredHosts().includes(h);
}

// הרשימה הלבנה. כל נתיב שלא מופיע כאן => 404 בדומיין של נטפרי. אין POST בכלל (אין התחברות,
// אין שליחת טפסים) - החיפוש הוא GET.
const ALLOWED_GET = [
  /^\/$/,
  /^\/search$/,
  /^\/freelancer\/[^/]+$/,
  /^\/freelancer\/[^/]+\/listing\/[^/]+$/,
  /^\/deals$/,
  /^\/about$/,
  /^\/terms$/,
  /^\/privacy$/,
  /^\/accessibility$/,
  /^\/uploads\/[a-zA-Z0-9._-]+$/,
  /^\/icons\/[^/]+$/,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
];

function pathAllowed(method, pathname) {
  if (method !== "GET" && method !== "HEAD") return false;
  return ALLOWED_GET.some((re) => re.test(pathname));
}

function settings() {
  const d = db.load();
  return d.settings || {};
}
function brandName() { return (settings().netfreeBrandName || "").trim() || "SheCan עסקים"; }
function logosOnly() { return isNetfree() && settings().netfreeLogosOnly !== false; }
function indexable() { return settings().netfreeIndexable !== false; }

// עצמאית מוצגת בנטפרי רק אם היא מאושרת, פעילה, ולא סומנה "לא לנטפרי".
function freelancerVisible(f) {
  return !!f && f.status === "approved" && f.active !== false && !f.netfreeHidden;
}

// ----- Sanitizer: רשת ביטחון אחרונה על ה-HTML שיוצא לנטפרי -----
// כל קישור (<a>) שמוביל לנתיב שלא ברשימה הלבנה הופך לטקסט רגיל (בלי קישור), וכל טופס שלא
// מוביל לחיפוש נמחק. כך גם אם איזה רכיב קיים (למשל תג "הסיפור שלה מככב", כפתור מועדפים,
// קישור לפרסום בקשה) הגיע מקוד שלא התכוונו לגעת בו - הוא לא יוצר קישור/טופס לתוכן אסור.
const SAFE_FORM_ACTIONS = new Set(["/search"]);
function linkPath(href) {
  if (!href) return "";
  if (/^(https?:)?\/\//i.test(href)) return null; // חיצוני - לא נוגעים
  if (/^(mailto:|tel:|#|javascript:)/i.test(href)) return null;
  if (!href.startsWith("/")) return null;
  return href.split("#")[0].split("?")[0];
}
function sanitizeHtml(html) {
  if (typeof html !== "string") return html;
  let out = html.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, (m) => {
    const am = m.match(/^<form\b[^>]*\baction="([^"]*)"/i);
    const action = am ? linkPath(am[1]) : "";
    if (am && action && SAFE_FORM_ACTIONS.has(action)) return m;
    return "";
  });
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
    const hm = attrs.match(/\bhref="([^"]*)"/i);
    if (!hm) return m;
    const p = linkPath(hm[1].replace(/&amp;/g, "&"));
    if (p === null) {
      // קישור חיצוני: wa.me / אינסטגרם / אתר העסק - מותר (פרטי יצירת קשר של העסק עצמו).
      return m;
    }
    if (pathAllowed("GET", p)) return m;
    return `<span>${inner}</span>`;
  });
  return out;
}

module.exports = {
  runWith, isNetfree, hostIsNetfree, pathAllowed, normalizeHost, configuredHosts,
  brandName, logosOnly, indexable, freelancerVisible, sanitizeHtml, ALLOWED_GET,
};
