const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const db = require("./db");
const auth = require("./auth");
const webpush = require("./webpush");
const { page, esc, categoryIcon } = require("./layout");

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
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "SheCan <onboarding@resend.dev>";
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set - skipping send to", to, "subject:", subject);
    return { ok: false, reason: "not_configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
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

// The single place every notification in the app should go through: try a push notification
// first (if this user has an active subscription on at least one device), and only send the
// email as a fallback when push isn't available for her yet (hasn't installed the app / hasn't
// granted notification permission) - so nothing gets silently lost for people who haven't
// opted into push. `emailHtml` is a function so we don't build the (often larger) HTML string
// unless we actually need to send it.
async function notify(user, { pushTitle, pushBody, url, emailSubject, emailHtml }) {
  const pushed = await sendPushToUser(user, { title: pushTitle, body: pushBody, url });
  if (!pushed && user && user.email) {
    await sendEmail(user.email, emailSubject, emailHtml()).catch(() => {});
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
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB per individual photo, generous enough for a phone photo
const MAX_REQUEST_BYTES = 20 * 1024 * 1024; // 20MB total per form submission - covers a logo + a few showcase photos together

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

function fileToDataUri(file, maxBytes) {
  if (!file || !file.data || !file.data.length) return null;
  if (!/^image\//.test(file.contentType || "")) return null;
  if (maxBytes && file.data.length > maxBytes) return null;
  return `data:${file.contentType};base64,${file.data.toString("base64")}`;
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...extraHeaders });
  res.end(html);
}

function redirect(res, location, cookie) {
  const headers = { Location: location };
  if (cookie) headers["Set-Cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

function sessionCookie(sid) {
  return `sid=${sid}; HttpOnly; Path=/; Max-Age=2592000`;
}
const clearCookie = "sid=; HttpOnly; Path=/; Max-Age=0";

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
// The location line shown on a card/profile: her city if she set one, otherwise whichever
// delivery option she picked instead (online / comes to the customer) - so the line is never
// just blank for a freelancer who works online-only or only does home visits.
function locationLabel(d, cityId, offersOnline, offersHomeVisit) {
  const city = cityName(d, cityId);
  if (city) return city;
  if (offersOnline) return "שירות אונליין";
  if (offersHomeVisit) return "מגיעה אלייך";
  return "";
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
function cardPhotoHtml(photoUri, logoUri, name, cssClass) {
  if (photoUri) return `<div class="${cssClass}" style="background-image:url('${esc(photoUri)}');background-size:cover;background-position:center;"></div>`;
  if (logoUri) return `<div class="${cssClass} ${cssClass}-logo" style="background-image:url('${esc(logoUri)}');background-size:contain;background-repeat:no-repeat;background-position:center;"></div>`;
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
function findOrCreateSubcategory(d, categoryId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const category = d.categories.find((c) => c.id === categoryId);
  if (!category) return null;
  category.subcategories = category.subcategories || [];
  const existing = category.subcategories.find((s) => s.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  const sub = { id: categoryId + "-custom-" + Date.now(), name: trimmed };
  category.subcategories.push(sub);
  return sub;
}
// Resolves the category/subcategory a freelancer picked at registration or profile-update
// time - handles the "אחר" (Other) option by finding-or-creating real category/subcategory
// records from her typed text, so everything downstream (search, filtering, display) just
// works with a normal categoryId/subcategoryId and never needs to know "אחר" was involved.
function resolveCategorySelection(d, body) {
  let categoryId = body.get("categoryId");
  let subcategoryId = body.get("subcategoryId") || "";
  if (categoryId === "__other__") {
    const category = findOrCreateCategory(d, body.get("customCategory"));
    categoryId = category ? category.id : "";
    const subName = (body.get("customSubcategory") || "").trim();
    if (category && subName) {
      const sub = findOrCreateSubcategory(d, category.id, subName);
      subcategoryId = sub ? sub.id : "";
    } else {
      subcategoryId = "";
    }
  }
  return { categoryId, subcategoryId };
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
    <label>לוגו (לא חובה)<input type="file" name="${prefix}Logo${idx}" accept="image/*" /></label>
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

// A "[icon] text" row that always keeps the icon visually first (rightmost) in RTL,
// regardless of whether the emoji itself carries RTL/LTR/neutral bidi metadata - plain
// "icon + text" inside one RTL text node can flip the icon to the wrong side depending on
// the specific emoji, so this uses flex layout (which orders by DOM order, not bidi rules)
// instead of relying on character-level text direction.
function detailLine(icon, html, extraStyle = "") {
  return `<div style="display:flex;align-items:flex-start;gap:6px;justify-content:center;max-width:100%;${extraStyle}"><span style="flex-shrink:0;">${icon}</span><span style="flex:1;min-width:0;overflow-wrap:break-word;word-break:break-word;">${html}</span></div>`;
}

// Converts a local Israeli phone number into the digits-only international format
// wa.me links expect (e.g. "050-123-4567" -> "972501234567").
function waPhoneDigits(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("0")) return "972" + digits.slice(1);
  if (digits.startsWith("972")) return digits;
  return digits;
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

// Given a known-correct boundary (matching weekday+hour in Israel time), returns the next
// one exactly 7 Israel-calendar-days later - stepping in local calendar days (not raw ms)
// so a DST shift that happens to fall inside that week is absorbed correctly.
function nextIsraelBoundary(boundaryUtc, weekday, hour) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(boundaryUtc);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const nextDay = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + 7));
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
function tickRotation(d, queue, getId, boundary, keys) {
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
  let next = nextIsraelBoundary(cursor, boundary.weekday, boundary.hour);
  while (next <= now) {
    if (d.settings[keys.manualIdKey]) {
      // The manual pin just used up its one cycle - clear it, but do NOT advance the
      // automatic pointer, so whoever was "waiting" is next once the pin is gone.
      d.settings[keys.manualIdKey] = null;
    } else {
      const idx = queue.findIndex((it) => getId(it) === d.settings[keys.currentIdKey]);
      d.settings[keys.currentIdKey] = getId(queue[(Math.max(idx, 0) + 1) % queue.length]);
    }
    cursor = next;
    next = nextIsraelBoundary(cursor, boundary.weekday, boundary.hour);
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
  const autoId = tickRotation(d, withQuotes, (f) => f.id, WEEKLY_TIP_BOUNDARY, {
    currentIdKey: "weeklyTipCurrentFreelancerId", lastBoundaryKey: "weeklyTipLastBoundary", manualIdKey: "freelancerOfWeekId",
  });
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
// Wednesday 20:00 Israel time, ordered by when the linked freelancer registered.
function getCurrentStory(d) {
  const approved = (d.stories || []).filter((s) => s.status === "approved");
  if (!approved.length) return null;
  const sorted = approved.slice().sort((a, b) => {
    const fa = d.freelancers.find((x) => x.id === a.freelancerId);
    const fb = d.freelancers.find((x) => x.id === b.freelancerId);
    const ta = fa ? new Date(fa.createdAt) : new Date(a.createdAt);
    const tb = fb ? new Date(fb.createdAt) : new Date(b.createdAt);
    return ta - tb;
  });
  const autoId = tickRotation(d, sorted, (s) => s.id, STORY_BOUNDARY, {
    currentIdKey: "currentStoryId", lastBoundaryKey: "storyLastBoundary", manualIdKey: "storyOfWeekId",
  });
  if (d.settings.storyOfWeekId) {
    const picked = approved.find((s) => s.id === d.settings.storyOfWeekId);
    if (picked) return picked;
  }
  return sorted.find((s) => s.id === autoId) || sorted[0];
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

function avatarUri(f) { return f.photoDataUri || f.logoDataUri || null; }

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
  const categoryForSearch = esc(catName(d, f.categoryId).toLowerCase());
  const extraCats = additionalCategoryNames(d, f);
  // If her inspiration story happens to be this week's featured story on SheCan Stories,
  // she gets a small badge with a direct link to it - shown as a sibling of the card's own
  // link (rather than nested inside it), since an <a> can't legally contain another <a>.
  const currentStory = getCurrentStory(d);
  const featuredStoryBadge = (currentStory && currentStory.freelancerId === f.id)
    ? `<a href="/stories/${currentStory.id}" class="badge badge-leading" style="position:absolute;top:10px;left:10px;z-index:2;text-decoration:none;">📖 הסיפור שלה מככב השבוע</a>`
    : "";
  const reviewCount = reviewCountFor(d, f.id);
  const catNameStr = catName(d, f.categoryId);
  const cardFieldLabel = subcatName(d, f.categoryId, f.subcategoryId) || catNameStr;
  const cardLocation = locationLabel(d, f.cityId, f.offersOnline, f.offersHomeVisit) + (extraCats.length ? ` · גם ב${extraCats.join(", ")}` : "");
  // Redesigned card body (per explicit request): business name stays as-is, category sits
  // directly under it with no icon, then a thin divider in the name's own text color, then
  // location + years-in-field - that whole top block has a fixed min-height (.card-top) so
  // the location/years line starts on the same straight line across a row of cards,
  // regardless of how long any one card's name/category text is. Review count/description/
  // deal/view-btn keep their previous behavior (hidden by default, revealed by the /search
  // view-mode toggle via the [data-view] CSS rules) - only location/years moved out of that
  // gated block since they're now part of the base card look.
  const cardHtml = `
  <a class="${cardClass}" href="/freelancer/${f.id}" data-name="${nameForSearch}" data-category="${categoryForSearch}" data-home-visit="${f.offersHomeVisit ? "1" : "0"}">
    ${cardPhotoHtml(f.photoDataUri, f.logoDataUri, f.businessName || f.name, "card-photo")}
    <div class="card-body">
      <div class="card-top">
        <h3 class="card-name">${esc(f.businessName || f.name)}</h3>
        <div class="card-category">${esc(cardFieldLabel)}</div>
        <div class="card-name-divider"></div>
      </div>
      <div class="card-meta-block">
        ${cardLocation ? `<div class="card-meta-row">📍 ${esc(cardLocation)}</div>` : ""}
        ${f.yearsInField ? `<div class="card-meta-row">🌱 ${esc(yearsInFieldShortLabel(f.yearsInField))}</div>` : ""}
      </div>
      ${badges.length ? `<div class="card-badges">${badges.join(" ")}</div>` : ""}
      <div class="card-info">
        ${reviewCount > 5 ? `<p class="card-reviewcount">⭐ ${reviewCount} דירוגים</p>` : ""}
        ${f.description ? `<div class="card-desc">${detailLine("📝", esc(f.description), "justify-content:center;")}</div>` : ""}
        <div class="card-deal">${detailLine("🎁", esc(f.dealText || "הטבה בלעדית"), "justify-content:center;")}</div>
        <span class="btn btn-small card-view-btn">לצפייה בפרופיל</span>
      </div>
    </div>
  </a>`;
  return featuredStoryBadge ? `<div style="position:relative;">${featuredStoryBadge}${cardHtml}</div>` : cardHtml;
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
  const categoryForSearch = esc(catNameStr.toLowerCase());
  const cardClass = "card" + (listing.isAdvertised ? " card-ad" : "");
  const reviewCount = reviewCountFor(d, f.id, listing.id);
  const listingFieldLabel = subcatName(d, listing.categoryId, listing.subcategoryId) || catNameStr;
  const listingLocation = locationLabel(d, f.cityId, listing.offersOnline, listing.offersHomeVisit);
  return `
  <a class="${cardClass}" href="/freelancer/${f.id}/listing/${listing.id}" data-name="${nameForSearch}" data-category="${categoryForSearch}" data-home-visit="${listing.offersHomeVisit ? "1" : "0"}">
    ${cardPhotoHtml(null, listing.logoDataUri, listing.businessName, "card-photo")}
    <div class="card-body">
      <div class="card-top">
        <h3 class="card-name">${esc(listing.businessName)}</h3>
        <div class="card-category">${esc(listingFieldLabel)}</div>
        <div class="card-name-divider"></div>
      </div>
      <div class="card-meta-block">
        ${listingLocation ? `<div class="card-meta-row">📍 ${esc(listingLocation)}</div>` : ""}
        ${listing.yearsInField ? `<div class="card-meta-row">🌱 ${esc(yearsInFieldShortLabel(listing.yearsInField))}</div>` : ""}
      </div>
      ${badges.length ? `<div class="card-badges">${badges.join(" ")}</div>` : ""}
      <div class="card-info">
        ${reviewCount > 5 ? `<p class="card-reviewcount">⭐ ${reviewCount} דירוגים</p>` : ""}
        ${listing.description ? `<div class="card-desc">${detailLine("📝", esc(listing.description), "justify-content:center;")}</div>` : ""}
        <div class="card-deal">${detailLine("🎁", esc(listing.dealText || "הטבה בלעדית"), "justify-content:center;")}</div>
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
// notified by email when a new arena question is approved.
function freelancersForCategory(d, categoryId, subcategoryId) {
  const matchIds = new Set();
  d.freelancers.forEach((f) => {
    if (f.status !== "approved") return;
    if (f.categoryId === categoryId && (!subcategoryId || f.subcategoryId === subcategoryId)) matchIds.add(f.id);
    (f.additionalListings || []).forEach((l) => {
      if (l.status === "approved" && l.categoryId === categoryId && (!subcategoryId || l.subcategoryId === subcategoryId)) matchIds.add(f.id);
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

// Renders one poll's question, options (as vote buttons, or result bars once this visitor has
// voted), and a copyable share link - shared between the "מה דעתך?" section on /arena and the
// dedicated single-poll page at /arena/poll/:id (the whole point of the share link).
function pollCardHtml(poll, voterKey, redirectTarget, shareUrl, canManage) {
  const totalVotes = poll.options.reduce((sum, o) => sum + (o.votes || 0), 0);
  const voted = !!(voterKey && (poll.voters || []).includes(voterKey));
  const optionsHtml = poll.options.map((o, i) => {
    const pct = totalVotes ? Math.round(((o.votes || 0) / totalVotes) * 100) : 0;
    if (voted || poll.closed) {
      return `<div class="poll-option-row"><div class="poll-bar-wrap"><div class="poll-bar-fill" style="width:${pct}%;"></div><span class="poll-bar-label">${esc(o.text)} - ${pct}% (${o.votes || 0})</span></div></div>`;
    }
    return `<form method="post" action="/arena/poll/${poll.id}/vote" style="margin-top:8px;">
      <input type="hidden" name="optionIndex" value="${i}" />
      <input type="hidden" name="redirectTo" value="${esc(redirectTarget)}" />
      <button type="submit" class="btn-arena" style="width:100%;text-align:right;display:flex;justify-content:space-between;gap:10px;">
        <span>${esc(o.text)}</span><span style="opacity:.85;">(${o.votes || 0})</span>
      </button>
    </form>`;
  }).join("");
  return `
  <div id="poll-${poll.id}" class="arena-card">
    ${poll.closed ? `<span class="badge badge-outline" style="margin-bottom:6px;display:inline-block;">🔒 סגור להצבעות</span>` : ""}
    <p style="margin:0 0 4px;font-weight:800;font-size:17px;">${esc(poll.question)}</p>
    <p class="muted" style="margin:0 0 8px;font-size:13px;">מאת ${esc(poll.freelancerName)} · ${totalVotes} הצבעות בסה"כ</p>
    ${optionsHtml}
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
  const cityOptions = d.cities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");

  const weekly = getWeeklyFeature(d);
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
        <span class="weekly-tip-kicker">From the Pros | טיפ שבועי מהמומחית</span>
        <p class="weekly-tip-quote">${esc(weekly.text)}</p>
        ${weekly.freelancer ? `
        <div class="weekly-tip-attr">${esc(weekly.freelancer.businessName || weekly.freelancer.name)} | ${esc(subcatName(d, weekly.freelancer.categoryId, weekly.freelancer.subcategoryId) || catName(d, weekly.freelancer.categoryId))}</div>
        <a class="weekly-tip-btn" href="/freelancer/${weekly.freelancer.id}">לצפייה בפרופיל שלה</a>
        ` : `<a class="weekly-tip-btn" href="/arena">מעבר לזירה</a>`}
      </div>` : ""}

      <form class="search-box" action="/search" method="get" role="search" aria-label="חיפוש עצמאיות">
        <div class="search-row">
          <input type="text" name="q" placeholder="חפשי לפי שם עסק, עצמאית או תחום" autocomplete="off" />
        </div>
        <div class="search-row" style="margin-top:10px;">
          <select name="category"><option value="">איזה תחום מעניין אותך?</option>${catOptions}</select>
          <select name="city"><option value="">מאיזו עיר?</option>${cityOptions}</select>
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
  sendHtml(res, 200, page({ title: "בית", session: ctx.session, body, query }));
});

// ----- Search / results -----
route("GET", "/search", async (req, res, params, query, ctx) => {
  const d = db.load();
  const category = query.get("category") || "";
  const city = query.get("city") || "";
  const homeVisit = query.get("homeVisit") === "1";
  const q = (query.get("q") || "").trim().toLowerCase();
  const results = d.freelancers.filter((f) => {
    if (f.status !== "approved") return false;
    if (f.active === false) return false;
    if (!freelancerMatchesCategory(f, category)) return false;
    if (city && f.cityId !== city) return false;
    if (homeVisit && !f.offersHomeVisit) return false;
    if (q) {
      // Matches her business name AND her own personal name, not just whichever one
      // happens to be displayed - searching "רוני" should find her even if the card
      // shows the business name "רוני מאפרת".
      const nameMatch = `${f.businessName || ""} ${f.name || ""}`.toLowerCase().includes(q);
      const categoryMatch = catName(d, f.categoryId).toLowerCase().includes(q);
      if (!nameMatch && !categoryMatch) return false;
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
      if (city && lf.cityId !== city) return;
      if (homeVisit && !l.offersHomeVisit) return;
      if (q) {
        const nameMatch = (l.businessName || "").toLowerCase().includes(q);
        const categoryMatch = catName(d, l.categoryId).toLowerCase().includes(q);
        if (!nameMatch && !categoryMatch) return;
      }
      listingMatches.push({ f: lf, l });
    });
  });

  const combinedCards = results.map((f) => ({ tier: f.tier, reviewCount: reviewCountFor(d, f.id), html: freelancerCard(f, d) }))
    .concat(listingMatches.map(({ f, l }) => ({ tier: l.tier, reviewCount: reviewCountFor(d, f.id, l.id), html: additionalListingCard(f, l, d) })))
    .sort((a, b) => ((b.tier === "premium") - (a.tier === "premium")) || (b.reviewCount - a.reviewCount));

  const catOptions = d.categories.map((c) => `<option value="${c.id}" ${c.id === category ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const cityOptions = d.cities.map((c) => `<option value="${c.id}" ${c.id === city ? "selected" : ""}>${esc(c.name)}</option>`).join("");

  const body = `
  <h1 class="section-title">מי מחכה לך היום?</h1>
      <form class="search-box" action="/search" method="get" role="search" aria-label="חיפוש עצמאיות" style="margin-right:0;margin-left:0;">
        <div class="search-row">
          <input type="text" id="scSearchQ" name="q" value="${esc(query.get("q") || "")}" placeholder="חפשי לפי שם עסק, עצמאית או תחום - הסינון אוטומטי תוך כדי הקלדה" oninput="scLiveFilter()" autocomplete="off" />
        </div>
        <div class="search-row" style="margin-top:10px;">
          <select name="category"><option value="">כל התחומים</option>${catOptions}</select>
          <select name="city"><option value="">מאיזו עיר?</option>${cityOptions}</select>
          <button class="btn" type="submit">חפשי</button>
        </div>
        <div class="search-row" style="margin-top:10px;justify-content:space-between;align-items:center;">
          <label style="display:flex;align-items:center;gap:4px;font-weight:600;width:auto;white-space:nowrap;margin:0;">
            <input type="checkbox" id="scHomeVisitFilter" name="homeVisit" value="1" ${homeVisit ? "checked" : ""} style="width:auto;margin:0;" onchange="scLiveFilter()" /><span>🚗 מגיעה עד הבית</span>
          </label>
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
  `;
  sendHtml(res, 200, page({ title: "חיפוש", session: ctx.session, body, query }));
});

// ----- Freelancer profile -----
route("GET", "/freelancer/:id", async (req, res, params, query, ctx) => {
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f || f.status !== "approved" || f.active === false) return sendHtml(res, 404, page({ title: "לא נמצא", session: ctx.session, body: `<p>אופס, לא מצאנו את הפרופיל הזה.</p>` }));
  const reviews = d.reviews.filter((r) => r.type === "freelancer" && r.targetId === f.id && r.status === "approved" && !r.listingId);
  const isCustomer = requireRole(ctx.session, "customer");
  let customer = null;
  if (isCustomer) customer = d.customers.find((c) => c.id === ctx.session.id);
  const isFav = customer && customer.favorites.includes(favKey(f.id, null));
  const myExistingReview = customer ? d.reviews.find((r) => r.type === "freelancer" && r.targetId === f.id && r.authorCustomerId === customer.id && !r.listingId) : null;

  if (isCustomer) {
    customer.viewedDeals = customer.viewedDeals || [];
    if (!customer.viewedDeals.find((v) => v.freelancerId === f.id)) {
      customer.viewedDeals.push({ freelancerId: f.id, date: new Date().toISOString() });
      db.save();
    }
  }

  f.viewCount = (f.viewCount || 0) + 1;
  db.save();

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
  const profileLocation = locationLabel(d, f.cityId, f.offersOnline, f.offersHomeVisit);
  // Redesigned profile header (per explicit request): horizontal layout, logo on the right,
  // name/years/rating/location beside it, contact details in their own column further left,
  // "נעים להכיר" removed entirely in favor of her own description text directly.
  const contactRows = [
    f.phone ? `<div class="profile-detail-row"><span class="profile-detail-icon">📞</span><a href="tel:${esc(f.phone)}">${esc(f.phone)}</a></div>` : "",
    (f.hasWhatsapp && f.phone) ? `<div class="profile-detail-row"><span class="profile-detail-icon">${whatsappIconSvg}</span><a class="whatsapp-link" href="https://wa.me/${esc(waPhoneDigits(f.phone))}" target="_blank" rel="noopener">WhatsApp</a></div>` : "",
    f.portfolioUrl ? `<div class="profile-detail-row"><span class="profile-detail-icon">🔗</span><a href="${esc(f.portfolioUrl)}" target="_blank" rel="noopener">תיק עבודות</a></div>` : "",
    f.email ? `<div class="profile-detail-row"><span class="profile-detail-icon">📧</span><a href="#scMessageBox" onclick="var t=document.querySelector('#scMessageBox textarea');if(t){t.focus();}">${esc(f.email)}</a></div>` : "",
    f.instagram ? `<div class="profile-detail-row"><span class="profile-detail-icon">📸</span><span>${esc(f.instagram)}</span></div>` : "",
  ].filter(Boolean).join("");
  const body = `
  <div class="panel profile-detail profile-merged">
    <div class="profile-header-row">
      <div class="profile-header-namelogo">
        ${zoomableImage(avatarUri(f), f.businessName || f.name, "profile-header-logo")}
        <div class="profile-header-info">
          <h1 class="profile-header-name">${esc(f.businessName || f.name)}</h1>
          ${f.yearsInField ? `<div class="profile-header-years">🌱 ${esc(yearsInFieldShortLabel(f.yearsInField))}</div>` : ""}
          ${profileAvgRating !== null ? `<div class="profile-stars-row">${starRow(Math.round(profileAvgRating))}${profileReviewCount > 5 ? `<span class="profile-review-count-small">(${profileReviewCount})</span>` : ""}</div>` : ""}
          ${profileLocation ? `<div class="profile-header-location">📍 ${esc(profileLocation)}</div>` : ""}
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
        isCustomer
          ? `<button type="button" class="btn btn-small" style="margin-top:8px;" onclick="scRevealCoupon('${f.id}', this)">לצפייה בקוד קופון</button><div id="scCoupon-${f.id}" style="display:none;margin-top:6px;font-weight:800;">קוד: ${esc(f.dealCode)}</div>`
          : `<a class="btn btn-small" style="margin-top:8px;display:inline-block;" href="${loginUrl}">התחברי כדי לצפות בקוד הקופון</a>`
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

  <div class="panel profile-detail">
    <h3 style="text-align:center;">⭐ מה אומרות עליה</h3>
    ${reviews.length ? reviews.map(reviewCard).join("") : `<p class="muted">עוד אין ביקורות - היי הראשונה לספר איך היה.</p>`}
    ${isCustomer ? reviewFormHtml(f.businessName || f.name, `/freelancer/${f.id}/review`, "", myExistingReview) : `<p class="muted"><a href="${loginUrl}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי לכתוב המלצה.</p>`}
  </div>

  <div class="panel profile-detail" id="scMessageBox">
    <h3>💌 מוזמנת לשלוח הודעה ל ${esc(f.businessName || f.name)}, היא תקבל את ההודעה שלך גם במייל :)</h3>
    ${isCustomer ? `
      ${myThread.length ? `<div class="chat-thread" style="text-align:right;">${myThread.map((m) => `<div class="chat-msg from-${m.fromRole}">${esc(m.text)}<span class="chat-meta">${esc(new Date(m.date).toLocaleString("he-IL"))}</span></div>`).join("")}</div>` : `<p class="muted">עדיין לא כתבתן - זו ההזדמנות לשאול אותה כל מה שמעניין אותך, ישירות.</p>`}
      <form method="post" action="/freelancer/${f.id}/message">
        <textarea name="text" placeholder="כתבי הודעה ל ${esc(f.businessName || f.name)}..." style="min-height:80px;" required></textarea>
        <button class="btn" style="margin-top:10px;" type="submit">שליחת הודעה</button>
      </form>
    ` : `<p class="muted"><a href="${loginUrlToMessage}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי לשלוח הודעה ישירה לעצמאית.</p>`}
  </div>
  `;
  sendHtml(res, 200, page({ title: f.businessName || f.name, session: ctx.session, body, query }));
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
  const listingContactRows = [
    f.phone ? `<div class="profile-detail-row"><span class="profile-detail-icon">📞</span><a href="tel:${esc(f.phone)}">${esc(f.phone)}</a></div>` : "",
    (f.hasWhatsapp && f.phone) ? `<div class="profile-detail-row"><span class="profile-detail-icon">${whatsappIconSvg}</span><a class="whatsapp-link" href="https://wa.me/${esc(waPhoneDigits(f.phone))}" target="_blank" rel="noopener">WhatsApp</a></div>` : "",
    l.portfolioUrl ? `<div class="profile-detail-row"><span class="profile-detail-icon">🔗</span><a href="${esc(l.portfolioUrl)}" target="_blank" rel="noopener">תיק עבודות</a></div>` : "",
    f.email ? `<div class="profile-detail-row"><span class="profile-detail-icon">📧</span><a href="#scMessageBox" onclick="var t=document.querySelector('#scMessageBox textarea');if(t){t.focus();}">${esc(f.email)}</a></div>` : "",
    f.instagram ? `<div class="profile-detail-row"><span class="profile-detail-icon">📸</span><span>${esc(f.instagram)}</span></div>` : "",
  ].filter(Boolean).join("");
  const body = `
  <p class="muted" style="text-align:center;">תחום נוסף של <a href="/freelancer/${f.id}" style="color:var(--rose-dark);font-weight:800;">${esc(f.businessName || f.name)}</a></p>
  <div class="panel profile-detail profile-merged">
    <div class="profile-header-row">
      <div class="profile-header-namelogo">
        ${zoomableImage(l.logoDataUri, l.businessName, "profile-header-logo")}
        <div class="profile-header-info">
          <h1 class="profile-header-name">${esc(l.businessName)}</h1>
          ${l.yearsInField ? `<div class="profile-header-years">🌱 ${esc(yearsInFieldShortLabel(l.yearsInField))}</div>` : ""}
          ${listingAvgRating !== null ? `<div class="profile-stars-row">${starRow(Math.round(listingAvgRating))}${listingReviewCount > 5 ? `<span class="profile-review-count-small">(${listingReviewCount})</span>` : ""}</div>` : ""}
          ${listingLocation ? `<div class="profile-header-location">📍 ${esc(listingLocation)}</div>` : ""}
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
        isCustomer
          ? `<button type="button" class="btn btn-small" style="margin-top:8px;" onclick="scRevealCoupon('${f.id}', this, '${l.id}')">לצפייה בקוד קופון</button><div id="scCoupon-${f.id}-${l.id}" style="display:none;margin-top:6px;font-weight:800;">קוד: ${esc(l.dealCode)}</div>`
          : `<a class="btn btn-small" style="margin-top:8px;display:inline-block;" href="${loginUrl}">התחברי כדי לצפות בקוד הקופון</a>`
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
    ${isCustomer ? reviewFormHtml(l.businessName, `/freelancer/${f.id}/review`, l.id, myExistingReview) : `<p class="muted"><a href="${loginUrl}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי לכתוב המלצה.</p>`}
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
    ` : `<p class="muted"><a href="${loginUrlToMessage}" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי לשלוח הודעה ישירה לעצמאית.</p>`}
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
  if (body.tooBig) return redirect(res, `${backUrl}?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
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
    </form>` : `<p class="muted"><a href="/login">מתחברות</a> או <a href="/signup">נרשמות בחינם</a> כדי לכתוב לנו כמה מילים.</p>`}
  </div>
  `;
  sendHtml(res, 200, page({ title: "המלצות", session: ctx.session, body, query }));
});

route("POST", "/reviews", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "customer")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/reviews?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
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
    return redirect(res, `/signup?err=${encodeURIComponent("מגזין SheCan פתוח רק לרשומות באתר - נרשמות זה לוקח פחות מדקה.")}`);
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

// ----- Inspiration stories - כל עצמאית יכולה לענות על כמה שאלות קבועות ולשלוח את הסיפור
// שלה לאישור. הסיפור המוצג מתחלף אוטומטית כל שבוע, לפי סדר ההרשמה של העצמאיות. -----

// Builds the display pieces (title/date/Q&A/comments) shared between the /stories index
// (current featured story) and a story's own permalink page.
function storyDetailHtml(s, d) {
  const f = d.freelancers.find((x) => x.id === s.freelancerId);
  const title = s.title || (f ? `הסיפור של ${f.businessName || f.name}` : "סיפור השראה");
  const dateStr = esc(new Date(s.approvedAt || s.createdAt).toLocaleDateString("he-IL"));
  const qaHtml = (s.answers && s.answers.length)
    ? s.answers.map((qa) => `<div style="margin-bottom:16px;"><div class="muted" style="font-weight:800;margin-bottom:4px;">${esc(qa.question)}</div><p style="margin:0;">${esc(qa.answer)}</p></div>`).join("")
    : `<p style="white-space:pre-wrap;">${esc(s.content || "")}</p>`;
  const commentsHtml = (s.comments && s.comments.length)
    ? s.comments.map((c) => `<div class="review" style="margin-bottom:10px;"><div class="review-header"><span class="review-name">${esc(c.customerName)}</span><span class="muted" style="font-size:12px;">${esc(new Date(c.createdAt).toLocaleDateString("he-IL"))}</span></div><div class="review-text">${esc(c.text)}</div></div>`).join("")
    : `<p class="muted">עוד אין תגובות - היי הראשונה להגיב.</p>`;
  return { f, title, dateStr, qaHtml, commentsHtml };
}

route("GET", "/stories", async (req, res, params, query, ctx) => {
  const d = db.load();
  const isCustomer = requireRole(ctx.session, "customer");
  const current = getCurrentStory(d);
  const approvedStories = (d.stories || []).filter((s) => s.status === "approved").slice().reverse();
  const previousStories = current ? approvedStories.filter((s) => s.id !== current.id) : approvedStories;

  let currentHtml = `<p class="muted" style="text-align:center;">הסיפור הראשון בדרך - חכי בסבלנות.</p>`;
  if (current) {
    const { f, title, dateStr, qaHtml, commentsHtml } = storyDetailHtml(current, d);
    currentHtml = `
    <div class="panel">
      <span class="badge">הסיפור המוצג עכשיו</span>
      ${current.photoDataUri ? `<img src="${current.photoDataUri}" alt="" style="width:100%;max-height:320px;object-fit:cover;border-radius:10px;margin:10px 0;" />` : ""}
      <h3>${esc(title)}</h3>
      <p class="muted">${dateStr}</p>
      ${qaHtml}
      ${f ? `<a class="btn btn-small" style="margin-top:10px;" href="/freelancer/${f.id}">לכרטיסייה של ${esc(f.businessName || f.name)}</a>` : ""}
      <h4 style="margin-top:24px;">תגובות</h4>
      ${commentsHtml}
      ${isCustomer ? `
        <form method="post" action="/stories/${current.id}/comment" style="margin-top:12px;">
          <textarea name="text" placeholder="מה חשבת על הסיפור?" required></textarea>
          <button class="btn btn-small" style="margin-top:8px;" type="submit">שליחת תגובה</button>
        </form>
      ` : `<p class="muted"><a href="/login" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי להגיב.</p>`}
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
  const isCustomer = requireRole(ctx.session, "customer");
  const { f, title, dateStr, qaHtml, commentsHtml } = storyDetailHtml(s, d);
  const body = `
  <div class="panel">
    ${s.photoDataUri ? `<img src="${s.photoDataUri}" alt="" style="width:100%;max-height:320px;object-fit:cover;border-radius:10px;margin-bottom:14px;" />` : ""}
    <h1 class="section-title" style="margin-top:0;">${esc(title)}</h1>
    <p class="muted" style="text-align:center;">${dateStr}</p>
    ${qaHtml}
    ${f ? `<a class="btn btn-small" style="margin-top:10px;" href="/freelancer/${f.id}">לכרטיסייה של ${esc(f.businessName || f.name)}</a>` : ""}
    <h4 style="margin-top:24px;">תגובות</h4>
    ${commentsHtml}
    ${isCustomer ? `
      <form method="post" action="/stories/${s.id}/comment" style="margin-top:12px;">
        <textarea name="text" placeholder="מה חשבת על הסיפור?" required></textarea>
        <button class="btn btn-small" style="margin-top:8px;" type="submit">שליחת תגובה</button>
      </form>
    ` : `<p class="muted"><a href="/login" style="color:var(--rose-dark);font-weight:800;text-decoration:underline;">התחברי</a> כדי להגיב.</p>`}
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
  const origin = getOrigin(req);

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
          ${answers.map((a) => `<div class="arena-answer"><span class="arena-answer-author">${esc(a.freelancerName)}</span><span class="arena-meta">${new Date(a.createdAt).toLocaleString("he-IL")}</span><p class="arena-answer-text">${esc(a.text)}</p></div>`).join("")}
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
  const consultationsHtml = approvedConsultations.length ? approvedConsultations.map((c) => {
    const replies = c.replies || [];
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
        return `
        <div class="arena-answer">
          <span class="arena-answer-author">${esc(replyName)}</span> <span class="muted" style="font-size:12px;">(${roleLabel})</span><span class="arena-meta">${new Date(r.createdAt).toLocaleString("he-IL")}</span><p class="arena-answer-text">${esc(r.text)}</p>
          ${ctx.session && ctx.session.role === "admin" ? `<form method="post" action="/admin/consultation/${c.id}/reply/${r.id}/delete" style="margin-top:6px;"><button type="submit" class="btn btn-small btn-outline">מחיקת התגובה הזו</button></form>` : ""}
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

  const activePolls = (d.polls || []).slice().reverse().slice(0, 20);
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
    <button type="button" class="arena-tab-btn" onclick="scArenaShowTab(2,this)">
      <span class="arena-tab-icon" aria-hidden="true">🤝💬</span>
      <span class="arena-tab-title">פינת ההתייעצויות</span>
      <span class="arena-tab-sub">דילמות עסקיות מהשטח – מקום שבו לקוחות ועצמאיות פותחות שולחן ומדברות על הכל</span>
    </button>
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

  <div class="arena-section" id="arenaTab2" style="display:none;">
    <h2>פינת ההתייעצויות</h2>
    <p class="arena-disclaimer">* SheCan אינה אחראית על תוכן התשובות שנכתבות כאן</p>
    ${consultFormHtml}
    ${consultationsHtml}
  </div>

  <div class="arena-section" id="arenaTab3" style="display:none;">
    <h2>מה דעתך?</h2>
    ${pollCreateHtml}
    ${pollsHtml}
  </div>
  `;
  sendHtml(res, 200, page({ title: "הזירה", session: ctx.session, body, query, noSidebars: true }));
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
  const body = await readBody(req);
  const d = db.load();
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
  const body = await readBody(req);
  const d = db.load();
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
    c.replies.push({ id: db.nextId("consultationReply"), ...author, text, createdAt: new Date().toISOString() });
    db.save();
  }
  redirect(res, `/arena?tab=2&ok=${encodeURIComponent("התגובה שלך נוספה!")}#consultation-${params.id}`);
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
    options: optionTexts.map((t) => ({ text: t, votes: 0 })), voters: [], createdAt: new Date().toISOString(),
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
  const optionIndex = Number(body.get("optionIndex"));
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
    return redirect(res, redirectTo + hash);
  }
  const { voterKey, newCookie } = arenaVoterIdentity(req, ctx);
  poll.voters = poll.voters || [];
  if (!poll.voters.includes(voterKey)) {
    poll.voters.push(voterKey);
    poll.options[optionIndex].votes = (poll.options[optionIndex].votes || 0) + 1;
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

// ----- Join as freelancer -----
route("GET", "/join", async (req, res, params, query, ctx) => {
  const d = db.load();
  const charging = d.settings.chargingEnabled;
  const catOptions = d.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const cityOptions = d.cities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const storyQuestionsJoin = d.settings.storyQuestions || [];
  // A visit via another business's referral link (/join?ref=<freelancerId>) - pre-fills and
  // locks the "how did you hear" field to that business (see POST /join for how the ref is
  // resolved and credited), only trusted if it actually resolves to a real approved freelancer.
  const refId = query.get("ref") || "";
  const referrerFreelancer = refId ? d.freelancers.find((x) => x.id === refId && x.status === "approved") : null;
  const businessNameDatalist = d.freelancers.filter((x) => x.status === "approved")
    .map((x) => `<option value="${esc(x.businessName || x.name)}"></option>`).join("");
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
    <label>🌸 שם מלא<input type="text" name="name" required /></label>
    <label>🌸 שם העסק<input type="text" name="businessName" required /></label>
    <label>🌸 מייל<input type="email" name="email" required /></label>
    <label>🌸 בחרי סיסמה<input type="password" name="password" required /></label>
    <label>🌸 מה התחום שלך?
    <select name="categoryId" required onchange="scUpdateSubcats(this, document.getElementById('scSubcat'), '');scToggleOtherCategory(this, 'scOtherCategoryBox');"><option value="">בחרי תחום</option>${catOptions}<option value="__other__">אחר - התחום שלי לא ברשימה</option></select></label>
    <label>🌸 תת-תחום (לא חובה)<select name="subcategoryId" id="scSubcat"><option value="">בחרי קודם תחום</option></select></label>
    <div id="scOtherCategoryBox" style="display:none;">
      <label>🌸 מה שם התחום שלך?<input type="text" name="customCategory" placeholder="למשל: עיצוב אירועים" /></label>
      <label>🌸 תת-תחום (לא חובה)<input type="text" name="customSubcategory" placeholder="למשל: עיצוב שולחנות מתוקים" /></label>
    </div>
    <label>🌸 כמה שנים את בתחום?
    <select name="yearsInField" required><option value="">בחרי</option>${yearsInFieldOptionsHtml("")}</select></label>
    <label>🌸 מאיזו עיר?<select name="cityId"><option value="">בחרי עיר</option>${cityOptions}</select></label>
    <p class="muted" style="margin:-6px 0 6px;font-size:13px;">לא חובה לציין עיר, כל עוד מסומן למטה שאת נותנת שירות בדיגיטלית או מגיעה עד הלקוחה - אבל חובה לפחות אחד מהשלושה.</p>
    <label>🌸 טלפון<input type="tel" name="phone" /></label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="hasWhatsapp" value="1" style="width:auto;" /> יש לי וואטסאפ במספר הזה</label>
    <label>🌸 איך את נותנת את השירות? (אפשר לסמן כמה)</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:0;"><input type="checkbox" name="offersOnline" value="1" style="width:auto;" /> 💻 נותנת שירות אונליין / דיגיטלית</label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:6px;"><input type="checkbox" name="offersHomeVisit" value="1" style="width:auto;" /> 🚗 מגיעה עד הבית של הלקוחה</label>
    <label>🌸 אינסטגרם (לא חובה)<input type="text" name="instagram" /></label>
    <label>🌸 קישור לתיק עבודות (לא חובה)<input type="text" name="portfolioUrl" placeholder="https://..." /></label>
    <label>🌸 לוגו (לא חובה אבל מומלץ)<input type="file" name="logo" accept="image/*" /></label>
    <label>🌸 תמונות להתרשמות (עד 4, לא חובה) - יופיעו בגלריה קטנה בכרטיסייה שלך
    <input type="file" name="gallery1" accept="image/*" style="margin-bottom:8px;" /></label>
    <input type="file" name="gallery2" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="gallery3" accept="image/*" style="margin-bottom:8px;" />
    <input type="file" name="gallery4" accept="image/*" />
    <label>🌸 ספרי לנו בכמה מילים על העסק שלך (עד 500 תווים)<textarea name="description" maxlength="500" placeholder="ספרי לנו מה את עושה ואיך את עוזרת ללקוחות שלך – כתבי את זה כאילו את מספרת לחברה, בצורה ברורה ומדויקת. זה מה שיגרום ללקוחות לבחור דווקא בך."></textarea></label>
    <label>🌸 תני ללקוחות סיבה טובה לבחור בך (עד 200 תווים) *</label>
    <p class="muted" style="margin:0 0 6px;font-size:13px;">* עסק בלי הטבה ללקוחות לא יאושר לפרסום - זה בדיוק מה שמושך אליך לקוחות חדשות.</p>
    <textarea name="dealText" maxlength="200" placeholder="זו ההזדמנות שלך לבלוט! הציעי הטבה שווה (למשל: הנחה, פגישת ייעוץ מתנה, בונוס מיוחד). הטבה אטרקטיבית היא המפתח לסגירת העסקה הראשונה שלך כאן." required></textarea>
    <label>🌸 איזו רמה מתאימה לך?
    <select name="tier"><option value="basic">בסיסית</option><option value="premium">מומלצת</option></select></label>

    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:14px;"><input type="checkbox" name="wantsPushNotifications" value="1" style="width:auto;" /> 🔔 כן, תשלחו לי התראות</label>
    <p class="muted" style="margin:2px 0 0;font-size:12.5px;">תקבלי התראה רק כשעונים לך (בזירה או במסר), כשלקוחה מתעניינת פונה אלייך ישירות, או כשמתפרסמת שאלה חדשה בזירה בתחום שלך.</p>

    <div class="muted" style="margin-top:16px;background:var(--cream);border-radius:8px;padding:12px 14px;font-size:14px;">
      ברגע שתסיימי להירשם, המערכת שלנו תייצר עבורך באופן אוטומטי קוד קופון אישי וייחודי (בסגנון SheCan1234), שתוכלי להעביר ללקוחות שלך. הקוד הזה יהיה הכרטיס המזהה שלך בקהילה.
    </div>

    <div class="panel" style="background:var(--cream);margin-top:16px;">
      <h4 style="margin-top:0;">מתעסקת בעוד תחום? הוסיפי גם אותו למאגר</h4>
      <p class="muted" style="font-size:14px;">כל תחום נוסף מקבל כרטיסייה משלו - שם עסק, לוגו, תמונות, הטבה ותיאור נפרדים. פרטי הקשר והעיר משותפים לפרופיל הראשי שלך.</p>
      ${[0, 1, 2].map((i) => `<div id="scExtraListing${i}" style="display:none;border-top:1px solid #e5ddd0;margin-top:14px;padding-top:14px;">${extraListingFormBlock(d, "extra", i)}</div>`).join("")}
      <button type="button" class="btn btn-outline btn-small" id="scAddExtraListingBtn" style="margin-top:14px;" onclick="scAddExtraListing()">➕ הוספת תחום</button>
    </div>

    <div class="panel" style="background:var(--cream);margin-top:16px;position:relative;" id="scJoinStoryPanel">
      <button type="button" onclick="var p=document.getElementById('scJoinStoryPanel');if(p)p.style.display='none';" aria-label="לא רלוונטי בשבילי" title="לא רלוונטי בשבילי" style="position:absolute;top:12px;left:14px;background:none;border:none;font-size:20px;color:var(--gray);cursor:pointer;">✕</button>
      <h4 style="margin-top:0;">רוצה כבר עכשיו לכתוב את הסיפור שלך? (לא חובה)</h4>
      <p class="muted" style="font-size:14px;">הסיפור שלך הוא ריאיון אישי קצר שמוצג בעמוד "SheCan Stories" - כרטיס ביקור רגשי שמספר מי את ואיך הגעת לאן שהגעת. כל שבוע מוצגת עצמאית אחת, לפי סדר ההרשמה שלכן לקהילה - כך שגם הסיפור שלך יקבל את הבמה שלו בזמן. אפשר גם לדלג ולמלא את זה מאוחר יותר באזור האישי שלך, או פשוט לסגור את התיבה הזו עם ה-X אם זה לא בשבילך כרגע.</p>
      <label>🌸 תמונה שלך לסיפור (לא חובה)
      <input type="file" name="storyPhoto" accept="image/*" /></label>
      ${storyQuestionsJoin.map((q, i) => `<label>🌸 ${esc(q)}<textarea name="storyAnswer${i}" maxlength="800"></textarea></label>`).join("")}
    </div>

    <input type="hidden" name="ref" value="${esc(refId)}" />
    <div class="referral-source-choice">
      <label style="font-weight:800;font-size:13.5px;">איך שמעת על SheCan?</label>
      ${referrerFreelancer ? `
      <p class="muted" style="font-size:13px;">הגעת דרך הקישור האישי של <strong>${esc(referrerFreelancer.businessName || referrerFreelancer.name)}</strong> - היא תזכה ב-10 נקודות כשתסיימי להירשם 🎉</p>
      ` : `
      <label><input type="radio" name="howHeardChoice" value="referral" onchange="document.getElementById('scHowHeardBizBox').style.display='block';" /> חברה מהקהילה / בעלת עסק אחרת</label>
      <div id="scHowHeardBizBox" style="display:none;margin-inline-start:22px;">
        <input type="text" name="howHeardBusinessName" list="scBusinessNameList" placeholder="הקלידי לחיפוש..." />
        <datalist id="scBusinessNameList">${businessNameDatalist}</datalist>
      </div>
      <label><input type="radio" name="howHeardChoice" value="social" onchange="document.getElementById('scHowHeardBizBox').style.display='none';" /> רשתות חברתיות / חיפוש ברשת</label>
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
  sendHtml(res, 200, page({ title: "הצטרפות כעצמאית", session: ctx.session, body, query }));
});

route("POST", "/join", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/join?err=${encodeURIComponent("התמונות ביחד גדולות מדי - נסי עם פחות תמונות או תמונות קטנות יותר.")}`);
  const d = db.load();
  if (d.freelancers.find((f) => f.email === body.get("email"))) {
    return redirect(res, `/join?err=${encodeURIComponent("כבר יש חשבון עם האימייל הזה - נסי להתחבר במקום.")}`);
  }
  // City is optional now, but she must give customers SOME way to reach her - either a city,
  // or an online/digital service, or a home-visit service. At least one of the three.
  if (!body.get("cityId") && body.get("offersOnline") !== "1" && body.get("offersHomeVisit") !== "1") {
    return redirect(res, `/join?err=${encodeURIComponent("צריך לציין עיר, או לסמן שאת נותנת שירות בדיגיטלית / מגיעה עד הלקוחה - לפחות אחד מהשלושה.")}`);
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
  const { categoryId, subcategoryId } = resolveCategorySelection(d, body);
  const additionalListings = [0, 1, 2].map((i) => readExtraListingFromBody(d, body, "extra", i)).filter(Boolean);
  db.load().freelancers.push({
    id, name: body.get("name"), businessName: body.get("businessName"), email: body.get("email"),
    passwordHash: auth.hashPassword(body.get("password")), categoryId,
    subcategoryId,
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
    inspirationQuote: "", weeklyTipPublished: false,
    tier: body.get("tier") === "premium" ? "premium" : "basic",
    joinType: charging ? "regular" : "founding",
    paymentStatus: charging ? "pending_payment" : "free",
    isLeadingBusiness: false, isAdvertised: false, adPaymentStatus: "none",
    viewCount: 0, couponRevealCount: 0, pushSubscriptions: [],
    referredByFreelancerId, welcomePopupSeen: false,
    status: "pending", createdAt: new Date().toISOString(),
  });
  db.save();

  // Send her the QR code + coupon code for her new profile right away, so she has them
  // in hand for networking even before an admin gets to approve the profile itself.
  const newProfileUrl = `${getOrigin(req)}/freelancer/${id}`;
  const newQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(newProfileUrl)}`;
  sendEmail(body.get("email"), "ברוכה הבאה ל-SheCan - הקוד האישי שלך מוכן",
    `<div dir="rtl" style="font-family:Arial,sans-serif;">
      <p>היי ${esc(body.get("name") || "")},</p>
      <p>תודה שהצטרפת ל-SheCan! קיבלנו את הפרופיל שלך ונעבור עליו בקרוב לאישור.</p>
      <p>בינתיים, הנה קוד הקופון האישי שלך שכבר אפשר להתחיל לשתף:</p>
      <p style="background:#f3ede8;padding:14px;border-radius:8px;font-size:20px;font-weight:800;text-align:center;">${esc(dealCode)}</p>
      <p>וגם קוד QR לכרטיסייה שלך, לנטוורקינג בשטח:</p>
      <p style="text-align:center;"><img src="${newQrUrl}" alt="QR לכרטיסייה שלך" width="200" height="200" /></p>
      <p>ברגע שהפרופיל יאושר, הקישור הזה יהיה פעיל לכולן: ${esc(newProfileUrl)}</p>
    </div>`
  ).catch(() => {});

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

route("GET", "/login", async (req, res, params, query, ctx) => {
  const next = safeNextUrl(query.get("next"));
  const roleParam = query.get("role");
  const body = `
  <h1 class="section-title">שמחות לראות אותך שוב</h1>
  <form class="panel" method="post" action="/login" style="max-width:420px;margin:0 auto;">
    ${next ? `<input type="hidden" name="next" value="${esc(next)}" />` : ""}
    <label>מי את?
    <select name="role">
      <option value="customer" ${roleParam === "customer" ? "selected" : ""}>לקוחה</option>
      <option value="freelancer" ${roleParam === "freelancer" ? "selected" : ""}>עצמאית</option>
      <option value="admin" ${roleParam === "admin" ? "selected" : ""}>מנהלת</option>
    </select></label>
    <label>מייל<input type="email" name="email" required /></label>
    <label>סיסמה<input type="password" name="password" required /></label>
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">כניסה</button>
  </form>
  <p class="muted" style="text-align:center;margin-top:14px;"><a href="/forgot-password">שכחת סיסמה?</a></p>
  <p class="muted" style="text-align:center;margin-top:6px;">עוד לא איתנו? <a href="/signup">עדיין לא נרשמתי</a> או <a href="/join">יש לי עסק</a></p>
  `;
  sendHtml(res, 200, page({ title: "כניסה", session: ctx.session, body, query }));
});

route("POST", "/login", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const role = body.get("role");
  const email = body.get("email");
  const password = body.get("password");
  const next = safeNextUrl(body.get("next"));
  const nextQS = next ? `&next=${encodeURIComponent(next)}` : "";
  const d = db.load();
  let user, list;
  if (role === "customer") list = d.customers;
  else if (role === "freelancer") list = d.freelancers;
  else list = d.admins;
  user = list.find((u) => u.email === email);
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return redirect(res, `/login?err=${encodeURIComponent("משהו לא הסתדר - בדקי את האימייל והסיסמה ונסי שוב.")}${nextQS}`);
  }
  if (role === "freelancer" && user.status !== "approved") {
    return redirect(res, `/login?err=${encodeURIComponent("עוד רגע סבלנות - הפרופיל שלך ממתין לאישור, ונעדכן אותך ברגע שהוא יאושר.")}${nextQS}`);
  }
  const sid = auth.createSession(role, user.id);
  redirect(res, next || (role === "admin" ? "/admin" : role === "freelancer" ? "/freelancer-dashboard" : "/account"), sessionCookie(sid));
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
    await sendEmail(email, "איפוס סיסמה ל-SheCan",
      `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(user.name || "")},</p><p>קיבלנו בקשה לאפס את הסיסמה שלך ל-SheCan. הקישור הבא בתוקף לשעה אחת:</p><p><a href="${link}">${link}</a></p><p>אם לא ביקשת את זה, אפשר פשוט להתעלם מהמייל.</p></div>`);
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

route("GET", "/signup", async (req, res, params, query, ctx) => {
  const d = db.load();
  // A visit via a friend's referral link (/signup?ref=<customerId>) - kept through the form
  // as a hidden field so POST /signup can credit the right person, and only trusted if it
  // actually resolves to a real customer (garbage/old ids are silently ignored).
  const refId = query.get("ref") || "";
  const referrer = refId ? d.customers.find((c) => c.id === refId) : null;
  const body = `
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
    <label>שם מלא<input type="text" name="name" required /></label>
    <label>מייל<input type="email" name="email" required /></label>
    <label>בחרי סיסמה<input type="password" name="password" required /></label>
    <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:6px;"><input type="checkbox" name="wantsPushNotifications" value="1" style="width:auto;" /> 🔔 כן, תשלחו לי התראות</label>
    <p class="muted" style="margin:2px 0 0;font-size:12.5px;">תקבלי התראה רק כשעונים לשאלה או להתייעצות שלך בזירה, או כשעצמאית עונה להודעה שכתבת לה.</p>
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">צרפי אותי</button>
  </form>
  `;
  sendHtml(res, 200, page({ title: "הרשמה", session: ctx.session, body, query }));
});

route("POST", "/signup", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const d = db.load();
  if (d.customers.find((c) => c.email === body.get("email"))) {
    return redirect(res, `/signup?err=${encodeURIComponent("כבר יש חשבון עם האימייל הזה - נסי להתחבר במקום.")}`);
  }
  const id = db.nextId("customer");
  const emailVerifyToken = crypto.randomBytes(24).toString("hex");
  const email = body.get("email");
  const name = body.get("name");
  // Only credited if it actually resolves to a real, different customer - guards against a
  // stale/tampered ref value crediting a deleted account or, worse, someone referring herself.
  const refId = body.get("ref") || "";
  const referrer = refId && refId !== id ? d.customers.find((c) => c.id === refId) : null;
  db.load().customers.push({
    id, name, email,
    passwordHash: auth.hashPassword(body.get("password")), cityId: "",
    favorites: [], viewedDeals: [], revealedCoupons: [], pushSubscriptions: [], createdAt: new Date().toISOString(),
    emailVerified: false, emailVerifyToken,
    wantsPushNotifications: body.get("wantsPushNotifications") === "1",
    referredByCustomerId: referrer ? referrer.id : null,
    referralPopupSeen: false,
  });
  db.save();
  const sid = auth.createSession("customer", id);
  // Email verification is a one-time link, not time-limited like a password reset - stored
  // directly on the customer record (rather than auth.js's in-memory reset-token map) so it
  // survives server restarts and works whenever she gets around to checking her inbox.
  const link = `${getOrigin(req)}/verify-email?token=${emailVerifyToken}`;
  await sendEmail(email, "אימות כתובת המייל שלך ב-SheCan",
    `<div dir="rtl" style="font-family:Arial,sans-serif;"><p>היי ${esc(name || "")},</p><p>תודה שהצטרפת ל-SheCan! רק נשאר לאמת את כתובת המייל שלך - לחצי על הקישור הבא:</p><p><a href="${link}">${link}</a></p><p>אם לא נרשמת אצלנו, אפשר פשוט להתעלם מהמייל.</p></div>`);
  redirect(res, "/account", sessionCookie(sid));
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
  // Each favorite key is either a bare freelancer id (her main profile) or
  // "freelancerId:listingId" (one specific additional listing) - resolved into its own card
  // and link so two listings belonging to the same freelancer never get merged into one.
  const favCards = customer.favorites.map((key) => {
    const [fid, lid] = String(key).split(":");
    const f = d.freelancers.find((x) => x.id === fid);
    if (!f || f.status !== "approved" || f.active === false) return null;
    if (lid) {
      const l = (f.additionalListings || []).find((x) => String(x.id) === lid);
      return (l && l.status === "approved") ? additionalListingCard(f, l, d) : null;
    }
    return freelancerCard(f, d);
  }).filter(Boolean);
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

  const body = `
  ${referralPopupHtml}
  <h1 class="section-title">היי ${esc(customer.name)} <span style="color:var(--danger);">♥</span></h1>

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
    <h3>הקופונים שכבר צפית בהם 🎁</h3>
    ${revealedCoupons.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>עסק</th><th>קוד קופון</th><th>תאריך</th></tr>
      ${revealedCoupons.map((rc) => `<tr>
        <td><a href="/freelancer/${rc.freelancer.id}">${esc(rc.freelancer.businessName || rc.freelancer.name)}</a></td>
        <td>${esc(rc.dealCode || "-")}</td>
        <td>${esc(new Date(rc.date).toLocaleDateString("he-IL"))}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עוד לא צפית באף קוד קופון - כשתלחצי על "לצפייה בקוד קופון" בכרטיסייה של עצמאית, הוא יופיע כאן.</p>`}
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
  const subcatOptions = subcategoriesOf(d, f.categoryId).map((s) => `<option value="${s.id}" ${s.id === f.subcategoryId ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  const cityOptions = d.cities.map((c) => `<option value="${c.id}" ${c.id === f.cityId ? "selected" : ""}>${esc(c.name)}</option>`).join("");
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

  const body = `
  ${welcomePopupHtml}
  <h1 class="section-title">היי ${esc(f.name.split(" ")[0])}, בואי נעדכן קצת</h1>

  <p class="muted" style="text-align:center;max-width:640px;margin:0 auto 20px;">כעצמאית יש לך גם אופציה להירשם גם כלקוחה - שימי לב שאי אפשר להתחבר בו-זמנית לשני הפרופילים.</p>

  <div class="narrow-panels">
  <div class="panel">
    ${f.joinType === "founding" ? `<span class="founding-badge">מייסדת ✦</span> ` : ""}
    ${f.isLeadingBusiness ? `<span class="badge badge-leading">👑 נותנת חסות</span> ` : ""}
    ${f.isAdvertised ? `<span class="badge badge-ad">📣 מודעה פעילה</span> ` : ""}
    <span class="muted">סטטוס: ${f.status !== "approved" ? "עדיין ממתינה לאישור" : f.active === false ? "מושהית זמנית - לא מוצגת באתר" : "את באוויר!"} · תשלום: ${statusLabel} · רמה: ${f.tier === "premium" ? "מומלצת" : "בסיסית"}</span>
  </div>

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
  </div>
  ${referralStatusHtml({
    entities: d.freelancers, refField: "referredByFreelancerId", selfId: f.id,
    nameOf: (x) => x.businessName || x.name, firstNameOf: (x) => (x.name || "").split(" ")[0],
    endDateLabel: d.settings.freelancerReferralContestEndDate, noun: "חברות", rivalNoun: "עצמאיות",
  })}` : ""}

  <div class="panel" style="text-align:center;">
    <h3>הסיפור שלך</h3>
    ${!myStory ? `
      <p class="muted">עני בכמה מילים על השאלות הבאות ונבנה מזה את סיפור ההשראה שלך - הוא יעבור אלינו לאישור, ואחרי שהוא יאושר תקבלי קישור לשתף אותו.</p>
      <form method="post" action="/freelancer-dashboard/story" enctype="multipart/form-data" style="text-align:right;">
        ${storyQuestions.map((q, i) => `<label>${esc(q)}<textarea name="answer${i}" maxlength="800" required></textarea></label>`).join("")}
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
      <p class="muted">שלחת את הסיפור שלך - הוא ממתין לאישור, ותקבלי מייל ברגע שהוא יעלה לאוויר. כל עוד הוא לא פורסם, את יכולה לערוך אותו כאן.</p>
      <form method="post" action="/freelancer-dashboard/story/edit" enctype="multipart/form-data" style="text-align:right;margin-top:10px;">
        ${storyQuestions.map((q, i) => {
          const existing = (myStory.answers || []).find((a) => a.question === q);
          return `<label>${esc(q)}<textarea name="answer${i}" maxlength="800">${esc(existing ? existing.answer : "")}</textarea></label>`;
        }).join("")}
        <label>תמונה לסיפור (להחלפה, לא חובה)<input type="file" name="photo" accept="image/*" /></label>
        <button class="btn" style="margin-top:14px;" type="submit">עדכון הסיפור שלי</button>
      </form>
    `}
  </div>

  <form class="panel" method="post" action="/freelancer-dashboard" enctype="multipart/form-data">
    <h3>הפרופיל שלך</h3>
    ${avatarUri(f) ? `<div style="margin-bottom:10px;">${photoOrInitials(avatarUri(f), f.businessName, "profile-photo")}</div>` : ""}
    <label>תמונת פרופיל ${f.photoDataUri ? "(להחלפה)" : "(לא חובה)"}<input type="file" name="photo" accept="image/*" /></label>
    <label>לוגו העסק ${f.logoDataUri ? "(להחלפה)" : "(לא חובה)"}<input type="file" name="logo" accept="image/*" /></label>
    <label>שם העסק<input type="text" name="businessName" value="${esc(f.businessName)}" required /></label>
    <label>תחום
    <select name="categoryId" onchange="scUpdateSubcats(this, document.getElementById('scSubcat'), '');scToggleOtherCategory(this, 'scOtherCategoryBoxDash');">${catOptions}<option value="__other__">אחר - התחום שלי לא ברשימה</option></select></label>
    <label>תת-תחום (לא חובה)<select name="subcategoryId" id="scSubcat"><option value="">ללא תת-תחום</option>${subcatOptions}</select></label>
    <div id="scOtherCategoryBoxDash" style="display:none;">
      <label>מה שם התחום שלך?<input type="text" name="customCategory" placeholder="למשל: עיצוב אירועים" /></label>
      <label>תת-תחום (לא חובה)<input type="text" name="customSubcategory" placeholder="למשל: עיצוב שולחנות מתוקים" /></label>
    </div>
    <label>עיר<select name="cityId">${cityOptions}</select></label>
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
    ` : `
    <label>משפט ההשראה שלך: (עד 300 תווים)
    <textarea name="inspirationQuote" maxlength="300" placeholder="גם אם לא הכנת משפט - תמיד תוכלי להיכנס לעדכון ולהוסיף משפט השראה משלך">${esc(f.inspirationQuote || "")}</textarea></label>
    <p class="muted" style="margin-top:-4px;font-size:12.5px;">אפשר לערוך את המשפט הזה בחופשיות כל עוד הוא עוד לא עלה בתור כטיפ השבועי - ברגע שהוא יופיע בדף הבית, הוא ננעל.</p>
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

route("POST", "/freelancer-dashboard/switch-to-customer", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  const customer = f && d.customers.find((c) => c.email === f.email);
  if (!customer) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("עדיין אין לך חשבון לקוחה עם המייל הזה.")}`);
  const sid = auth.createSession("customer", customer.id);
  redirect(res, "/account", sessionCookie(sid));
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
  redirect(res, "/freelancer-dashboard", sessionCookie(sid));
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

route("POST", "/freelancer-dashboard/story", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "freelancer")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === ctx.session.id);
  if ((d.stories || []).find((s) => s.freelancerId === f.id && s.status !== "rejected")) {
    return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("כבר שלחת סיפור - אי אפשר לשלוח עוד אחד.")}`);
  }
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
  const storyQuestions = d.settings.storyQuestions || [];
  const answers = storyQuestions
    .map((q, i) => ({ question: q, answer: clip((body.get(`answer${i}`) || "").trim(), 800) }))
    .filter((qa) => qa.answer);
  if (!answers.length) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("צריך לענות לפחות על שאלה אחת כדי לשלוח את הסיפור.")}`);
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
  if (body.tooBig) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
  const storyQuestions = d.settings.storyQuestions || [];
  const answers = storyQuestions
    .map((q, i) => ({ question: q, answer: clip((body.get(`answer${i}`) || "").trim(), 800) }))
    .filter((qa) => qa.answer);
  if (!answers.length) return redirect(res, `/freelancer-dashboard?err=${encodeURIComponent("צריך לענות לפחות על שאלה אחת.")}`);
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
  // turn in the rotation comes up.
  if (!f.weeklyTipPublished) f.inspirationQuote = clip(body.get("inspirationQuote") || "", 300);
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

// ----- Admin -----
route("GET", "/admin", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const admin = d.admins.find((a) => a.id === ctx.session.id) || d.admins[0];
  const pendingFreelancers = d.freelancers.filter((f) => f.status === "pending");
  const activeFreelancers = d.freelancers.filter((f) => f.status === "approved");
  const pendingReviews = d.reviews.filter((r) => r.status === "pending");
  // Reviews on a freelancer (or one of her listings) auto-publish now, so there's no
  // pre-publish queue for them - instead admin gets to see everything that's already live
  // and delete anything inappropriate after the fact.
  const publishedFreelancerReviews = d.reviews.filter((r) => r.type === "freelancer" && r.status === "approved")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // Site reviews ("מה אומרות עלינו") auto-publish the same way once approved - give admin the
  // same after-the-fact delete backstop here as for freelancer reviews.
  const publishedSiteReviews = d.reviews.filter((r) => r.type === "site" && r.status === "approved")
    .slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const pendingStories = (d.stories || []).filter((s) => s.status === "pending");
  // Used both for the delete table and the "story of the week" manual-pick dropdown below.
  const approvedStoriesForAdmin = (d.stories || []).filter((s) => s.status === "approved").map((s) => {
    const sf = d.freelancers.find((x) => x.id === s.freelancerId);
    return { id: s.id, title: s.title || (sf ? `הסיפור של ${sf.businessName || sf.name}` : "סיפור השראה") };
  });
  const pendingArenaQuestions = (d.arenaQuestions || []).filter((q) => q.status === "pending");
  const pendingConsultations = (d.consultations || []).filter((c) => c.status === "pending");
  // Live (already-approved) arena questions/consultations don't need re-approval, but admin
  // should always be able to delete anything in the arena, not just items still in the
  // moderation queue - these feed a permanent management panel below.
  const liveArenaQuestions = (d.arenaQuestions || []).filter((q) => q.status === "approved").slice().reverse();
  const liveConsultations = (d.consultations || []).filter((c) => c.status === "approved").slice().reverse();
  const allPolls = (d.polls || []).slice().reverse();
  // Pending additional listings can belong to ANY freelancer, not just ones whose main
  // profile is still pending - an already-approved freelancer can add a new listing later
  // that itself needs its own review, so this scans every freelancer's additionalListings.
  const pendingListings = [];
  const approvedListings = [];
  d.freelancers.forEach((f) => {
    (f.additionalListings || []).forEach((l) => {
      if (l.status === "pending") pendingListings.push({ f, l });
      else if (l.status === "approved") approvedListings.push({ f, l });
    });
  });

  const revealEvents = (d.couponRevealEvents || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const revealsByCategory = {};
  revealEvents.forEach((ev) => {
    const f = d.freelancers.find((x) => x.id === ev.freelancerId);
    const cat = f ? catName(d, f.categoryId) : "לא ידוע";
    revealsByCategory[cat] = (revealsByCategory[cat] || 0) + 1;
  });
  const unreadMessages = (d.contactMessages || []).filter((m) => !m.read).length;

  const body = `
  <h1 class="section-title">הבמה שלך 👑</h1>

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

  <div class="panel">
    <h3>מחכות לאישור שלך (${pendingFreelancers.length})</h3>
    ${pendingFreelancers.length ? pendingFreelancers.map((f) => `
      <div class="panel" style="background:var(--cream);">
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
          ${f.logoDataUri ? `<img src="${f.logoDataUri}" alt="" style="width:90px;height:90px;object-fit:cover;border-radius:10px;flex-shrink:0;" />` : ""}
          <div style="flex:1;min-width:220px;">
            <h4 style="margin:0 0 6px;">${esc(f.businessName)} <span class="muted" style="font-weight:600;">(${esc(f.name)})</span></h4>
            <p class="muted" style="margin:2px 0;">${esc(catName(d, f.categoryId))}${f.subcategoryId ? ` · ${esc(subcatName(d, f.categoryId, f.subcategoryId))}` : ""} · ${esc(cityName(d, f.cityId))}</p>
            <p class="muted" style="margin:2px 0;">✉️ ${esc(f.email)} ${f.phone ? `· ☎ ${esc(f.phone)}` : ""} ${f.hasWhatsapp ? "· 💬 יש וואטסאפ" : ""}</p>
            <p class="muted" style="margin:2px 0;">רמה: ${f.tier === "premium" ? "מומלצת" : "בסיסית"} ${f.offersOnline ? "· 💻 אונליין" : ""} ${f.offersHomeVisit ? "· 🚗 מגיעה עד הבית" : ""}</p>
            ${f.instagram ? `<p class="muted" style="margin:2px 0;">📸 ${esc(f.instagram)}</p>` : ""}
            ${f.portfolioUrl ? `<p class="muted" style="margin:2px 0;">🔗 <a href="${esc(f.portfolioUrl)}" target="_blank" rel="noopener">תיק עבודות</a></p>` : ""}
          </div>
        </div>
        ${f.description ? `<p style="margin-top:10px;"><strong>על העסק:</strong> ${esc(f.description)}</p>` : ""}
        ${f.dealText ? `<p style="margin-top:6px;"><strong>ההטבה:</strong> ${esc(f.dealText)}</p>` : ""}
        ${(f.galleryPhotos && f.galleryPhotos.length) ? `<div class="gallery-scroll" style="margin-top:10px;">${f.galleryPhotos.map((src) => `<img src="${src}" alt="" class="gallery-thumb" style="object-fit:cover;" />`).join("")}</div>` : ""}
        <div style="display:flex;gap:10px;margin-top:14px;">
          <form method="post" action="/admin/freelancer/${f.id}/approve"><button class="btn btn-small" type="submit">אישור</button></form>
          <form method="post" action="/admin/freelancer/${f.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
        </div>
      </div>`).join("") : `<p class="muted">אין כרגע אף אחת שמחכה - הכל מעודכן.</p>`}
  </div>

  <div class="panel">
    <h3>ביקורות שמחכות לעין שלך (${pendingReviews.length})</h3>
    ${pendingReviews.length ? pendingReviews.map((r) => `
      <div class="review">
        ${starRow(r.rating)} <strong>${esc(r.authorName)}</strong> <span class="muted">(${r.type === "site" ? "המלצה על SheCan" : "ביקורת על עצמאית: " + esc((d.freelancers.find(f=>f.id===r.targetId)||{}).businessName || "")})</span>
        <p class="muted" style="margin:8px 0;">${esc(r.text)}</p>
        <form style="display:inline" method="post" action="/admin/review/${r.id}/approve"><button class="btn btn-small" type="submit">אישור</button></form>
        <form style="display:inline" method="post" action="/admin/review/${r.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
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
        <div style="display:flex;gap:10px;margin-top:12px;">
          <form method="post" action="/admin/story/${s.id}/approve"><button class="btn btn-small" type="submit">אישור ופרסום</button></form>
          <form method="post" action="/admin/story/${s.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
        </div>
      </div>`;
    }).join("") : `<p class="muted">אין כרגע סיפורים שממתינים לאישור.</p>`}
  </div>

  <div class="panel">
    <h3>🥊 הזירה - שאלות ממתינות לאישור (${pendingArenaQuestions.length})</h3>
    ${pendingArenaQuestions.length ? pendingArenaQuestions.map((q) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">${esc(catName(d, q.categoryId))}${q.subcategoryId ? ` (${esc(subcatName(d, q.categoryId, q.subcategoryId))})` : ""} · מאת ${esc(q.customerName)}</p>
        <p style="margin:0;font-weight:700;">${esc(q.questionText)}</p>
        <div style="display:flex;gap:10px;margin-top:12px;">
          <form method="post" action="/admin/arena-question/${q.id}/approve"><button class="btn btn-small" type="submit">אישור ושליחה למומחיות</button></form>
          <form method="post" action="/admin/arena-question/${q.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
        </div>
      </div>
    `).join("") : `<p class="muted">אין כרגע שאלות שממתינות לאישור.</p>`}
  </div>

  <div class="panel">
    <h3>🥊 הזירה - התייעצויות ממתינות לאישור (${pendingConsultations.length})</h3>
    ${pendingConsultations.length ? pendingConsultations.map((c) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">מאת ${esc(c.customerName)}</p>
        <p style="margin:0;font-weight:700;">${esc(c.text)}</p>
        <div style="display:flex;gap:10px;margin-top:12px;">
          <form method="post" action="/admin/consultation/${c.id}/approve"><button class="btn btn-small" type="submit">אישור ופרסום</button></form>
          <form method="post" action="/admin/consultation/${c.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
        </div>
      </div>
    `).join("") : `<p class="muted">אין כרגע התייעצויות שממתינות לאישור.</p>`}
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
    ${liveConsultations.length ? liveConsultations.map((c) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">מאת ${esc(c.customerName)}</p>
        <p style="margin:0;font-weight:700;">${esc(c.text)}</p>
        ${(c.replies || []).length ? (c.replies || []).map((r) => `
        <div style="background:var(--white);border-radius:8px;padding:8px 12px;margin-top:8px;">
          <p style="margin:0;"><strong>${esc(r.authorName)}</strong> <span class="muted" style="font-size:12px;">(${r.authorRole === "freelancer" ? "עצמאית" : "לקוחה"})</span>: ${esc(r.text)}</p>
          <form method="post" action="/admin/consultation/${c.id}/reply/${r.id}/delete" style="margin-top:6px;"><button type="submit" class="btn btn-small btn-outline">מחיקת התגובה הזו</button></form>
        </div>
        `).join("") : `<p class="muted" style="margin-top:6px;">עוד אין תגובות.</p>`}
        <form method="post" action="/admin/consultation/${c.id}/delete" style="margin-top:10px;"><button class="btn btn-small btn-outline" type="submit">מחיקת ההתייעצות כולה</button></form>
      </div>
    `).join("") : `<p class="muted">אין כרגע התייעצויות שפורסמו.</p>`}
  </div>

  <div class="panel">
    <h3>🥊 הזירה - סקרים פעילים (${allPolls.length})</h3>
    <p class="muted">הסקרים עולים לאוויר מיד עם הפרסום - אין צורך לאשר, רק למחוק אם משהו לא ראוי.</p>
    ${allPolls.length ? allPolls.map((p) => `
      <div class="panel" style="background:var(--cream);">
        <p class="muted" style="margin:0 0 4px;">מאת ${esc(p.freelancerName)} · ${new Date(p.createdAt).toLocaleDateString("he-IL")}</p>
        <p style="margin:0;font-weight:700;">${esc(p.question)}</p>
        <p class="muted" style="margin:6px 0 0;">${(p.options || []).map((o) => `${esc(o.text)}: ${o.votes || 0}`).join(" · ")}</p>
        <form method="post" action="/admin/poll/${p.id}/delete" style="margin-top:10px;"><button class="btn btn-small btn-outline" type="submit">מחיקת הסקר</button></form>
      </div>
    `).join("") : `<p class="muted">אין כרגע סקרים.</p>`}
  </div>

  <div class="panel">
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
        <div style="display:flex;gap:10px;margin-top:14px;">
          <form method="post" action="/admin/listing/${f.id}/${l.id}/approve"><button class="btn btn-small" type="submit">אישור</button></form>
          <form method="post" action="/admin/listing/${f.id}/${l.id}/reject"><button class="btn btn-small btn-outline" type="submit">דחייה</button></form>
        </div>
      </div>`).join("") : `<p class="muted">אין כרגע תחומים נוספים שממתינים לאישור.</p>`}
  </div>

  <div class="panel">
    <h3>לוגו האתר</h3>
    <p class="muted">${d.settings.siteLogoDataUri ? "יש לך כרגע לוגו מותאם אישית שמופיע בראש כל עמוד." : "כרגע מופיע בראש העמוד הוורדמארק הטקסטואלי 'SheCan'. אפשר להעלות תמונה משלך במקומו."}</p>
    ${d.settings.siteLogoDataUri ? `<div style="margin:10px 0;"><img src="${d.settings.siteLogoDataUri}" alt="לוגו נוכחי" style="height:60px;" /></div>` : ""}
    <form method="post" action="/admin/logo" enctype="multipart/form-data">
      <label>העלאת לוגו חדש (תמונה)<input type="file" name="logo" accept="image/*" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">העלאה</button>
    </form>
    ${d.settings.siteLogoDataUri ? `<form method="post" action="/admin/logo/remove" style="margin-top:8px;"><button class="btn btn-small btn-outline" type="submit">הסרת הלוגו וחזרה לוורדמארק הטקסט</button></form>` : ""}
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

      <h4 style="margin-top:22px;">תחרות הפניות - עצמאיות ("צרפי חברה")</h4>
      <p class="muted" style="margin-top:-6px;">שולט על הבלוק שמופיע באזור האישי של העצמאיות.</p>
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" name="freelancerReferralContestActive" value="1" style="width:auto;" ${d.settings.freelancerReferralContestActive ? "checked" : ""} /> התחרות פעילה ומוצגת באתר</label>
      <label>תאריך סיום התחרות (טקסט חופשי, למשל 17.9)
      <input type="text" name="freelancerReferralContestEndDate" value="${esc(d.settings.freelancerReferralContestEndDate || "")}" /></label>
      <label>תאריך פרסום העסק המוביל
      <input type="text" name="freelancerReferralAnnounceDate" value="${esc(d.settings.freelancerReferralAnnounceDate || "")}" /></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון</button>
    </form>
  </div>

  <div class="panel">
    <h3>המגזין שלנו</h3>
    ${(d.magazines || []).length ? `<div class="table-scroll"><table class="table-simple"><tr><th>כותרת</th><th>קישור</th><th>פעולות</th></tr>
      ${d.magazines.map((m) => `<tr>
        <td>${esc(m.title)}</td><td><a href="${esc(m.url)}" target="_blank" rel="noopener">לצפייה</a></td>
        <td><form method="post" action="/admin/magazine/${m.id}/delete"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`).join("")}
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
    <p class="muted">הסיפור המוצג ב<a href="/stories">עמוד הסיפורים</a> מתחלף אוטומטית כל יום רביעי בשעה 20:00, לפי סדר ההרשמה של העצמאיות.</p>
    ${approvedStoriesForAdmin.length ? `
    <form method="post" action="/admin/story-of-week" style="margin-bottom:14px;max-width:480px;">
      <label>סיפור השבוע - בחירה ידנית (אופציונלי, תופסת שבוע אחד בלבד - אחריו התור האוטומטי ממשיך מאיפה שעצר)
      <select name="storyOfWeekId">
        <option value="">ללא - התור האוטומטי</option>
        ${approvedStoriesForAdmin.map((s) => `<option value="${s.id}" ${d.settings.storyOfWeekId === s.id ? "selected" : ""}>${esc(s.title)}</option>`).join("")}
      </select></label>
      <button class="btn btn-small" style="margin-top:10px;" type="submit">עדכון</button>
    </form>` : ""}
    ${approvedStoriesForAdmin.length ? `<div class="table-scroll"><table class="table-simple"><tr><th>כותרת</th><th>על מי</th><th>תאריך</th><th>פעולות</th></tr>
      ${d.stories.filter((s) => s.status === "approved").slice().reverse().map((s) => {
        const sf = d.freelancers.find((x) => x.id === s.freelancerId);
        const title = s.title || (sf ? `הסיפור של ${sf.businessName || sf.name}` : "סיפור השראה");
        return `<tr>
          <td><a href="/stories/${s.id}">${esc(title)}</a></td><td>${esc(sf ? (sf.businessName || sf.name) : "-")}</td><td>${esc(new Date(s.createdAt).toLocaleDateString("he-IL"))}</td>
          <td><form method="post" action="/admin/story/${s.id}/delete"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
        </tr>`;
      }).join("")}
    </table></div>` : `<p class="muted">עדיין אין סיפורים שפורסמו.</p>`}
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
    <h3>העצמאיות שכבר איתנו (${activeFreelancers.length})</h3>
    <p class="muted">"נותנת חסות" - הבלטה מיוחדת וקבועה (למשל לעצמאיות שתרמו הטבה להגרלה). "מודעה" - הבלטה בתשלום שאת מוכרת וסוגרת איתן ישירות. "צפיות" - כמה פעמים נכנסו לעמוד שלה. "צפיות בקופון" - כמה פעמים לחצו "לצפייה בקוד קופון".</p>
    <p class="muted"><a href="/admin/export/freelancers.csv">⬇️ הורדת כל הנתונים כקובץ אקסל (CSV)</a></p>
    <input type="text" id="scAdminFreelancerSearch" placeholder="🔍 חיפוש עצמאית לפי שם עסק..." oninput="scFilterAdminFreelancers(this.value)" style="max-width:320px;margin-bottom:10px;" />
    ${activeFreelancers.length ? `<div class="table-scroll"><table class="table-simple" id="scActiveFreelancersTable"><tr><th>עסק</th><th>סוג הצטרפות</th><th>סטטוס תשלום</th><th>רמה</th><th>קוד קופון</th><th>צפיות</th><th>צפיות בקופון</th><th>תמונות</th><th>נותנת חסות</th><th>מודעה</th><th>תשלום מודעה</th><th>סטטוס באתר</th><th>מחיקה</th></tr>
      ${activeFreelancers.map((f) => `<tr>
        <td>${esc(f.businessName)}</td><td>${f.joinType === "founding" ? "מייסדת" : "רגילה"}</td><td>${esc(paymentStatusLabel(f.paymentStatus))}</td><td>${f.tier === "premium" ? "מומלצת" : "בסיסית"}</td>
        <td>${esc(f.dealCode || "-")}</td><td>${f.viewCount || 0}</td><td>${f.couponRevealCount || 0}</td>
        <td><a class="btn btn-small ${(f.logoDataUri || (f.galleryPhotos && f.galleryPhotos.length)) ? "" : "btn-outline"}" href="/admin/freelancer/${f.id}/photos">📷 תמונות</a></td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-leading"><button class="btn btn-small ${f.isLeadingBusiness ? "" : "btn-outline"}" type="submit">${f.isLeadingBusiness ? "👑 נותנת חסות" : "הפכי לנותנת חסות"}</button></form></td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-ad"><button class="btn btn-small ${f.isAdvertised ? "" : "btn-outline"}" type="submit">${f.isAdvertised ? "📣 פעילה" : "הפעילי מודעה"}</button></form></td>
        <td>${f.isAdvertised ? `<form method="post" action="/admin/freelancer/${f.id}/mark-ad-paid"><button class="btn btn-small ${f.adPaymentStatus === "paid" ? "" : "btn-outline"}" type="submit">${esc(adPaymentStatusLabel(f.adPaymentStatus))}</button></form>` : `<span class="muted">-</span>`}</td>
        <td><form method="post" action="/admin/freelancer/${f.id}/toggle-active"><button class="btn btn-small ${f.active === false ? "btn-outline" : ""}" type="submit">${f.active === false ? "⏸️ לא פעילה" : "🟢 פעילה"}</button></form></td>
        <td><form method="post" action="/admin/freelancer/${f.id}/delete" onsubmit="return confirm('למחוק לצמיתות את ' + ${JSON.stringify(f.businessName || f.name)} + '? זו פעולה שלא ניתן לבטל.');"><button class="btn btn-small btn-outline" type="submit">מחיקה</button></form></td>
      </tr>`).join("")}
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

  <div class="panel">
    <h3>הודעות מ"צרי קשר" (${unreadMessages} חדשות)</h3>
    ${(d.contactMessages || []).length ? `<div class="table-scroll"><table class="table-simple"><tr><th>שם</th><th>אימייל</th><th>הודעה</th><th>תאריך</th><th>פעולות</th></tr>
      ${(d.contactMessages || []).slice().reverse().map((m) => `<tr>
        <td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${esc(m.message)}</td><td>${esc(new Date(m.createdAt).toLocaleDateString("he-IL"))}</td>
        <td>
          <a class="btn btn-small" href="mailto:${esc(m.email)}?subject=${encodeURIComponent("תגובה מ-SheCan")}">מענה במייל</a>
          ${!m.read ? `<form style="display:inline" method="post" action="/admin/message/${m.id}/read"><button class="btn btn-small btn-outline" type="submit">סימון כנקרא</button></form>` : ""}
        </td>
      </tr>`).join("")}
    </table></div>` : `<p class="muted">עדיין לא התקבלו הודעות.</p>`}
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

  <div class="panel">
    <h3>התחומים באתר</h3>
    <div class="cat-grid">${d.categories.map((c) => `<div class="cat-card">${esc(c.name)}</div>`).join("")}</div>
    <form method="post" action="/admin/category" style="margin-top:14px;max-width:360px;">
      <input type="text" name="name" placeholder="תחום חדש" required />
      <button class="btn btn-small" style="margin-top:10px;" type="submit">הוספה</button>
    </form>
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
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
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
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("חזרנו לוורדמארק הטקסט.")}`);
});

route("POST", "/admin/top-banner", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
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
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
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
  d.settings.freelancerReferralContestActive = body.get("freelancerReferralContestActive") === "1";
  d.settings.freelancerReferralContestEndDate = (body.get("freelancerReferralContestEndDate") || "").trim();
  d.settings.freelancerReferralAnnounceDate = (body.get("freelancerReferralAnnounceDate") || "").trim();
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("הגדרות התחרות עודכנו!")}`);
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
  if (body.tooBig) return redirect(res, `/admin?err=${encodeURIComponent("התמונה גדולה מדי (עד 4MB) - נסי תמונה קטנה יותר.")}`);
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
  let emailed = 0;
  const noEmailAccounts = []; // { label, tempPassword } - so Sapir can pass credentials along manually (e.g. WhatsApp) when no email was given

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
      categoryId: category ? category.id : "", subcategoryId: subcategory ? subcategory.id : "", additionalCategoryIds: [], cityId: city ? city.id : "",
      phone: phone || "", instagram: instagram || "",
      portfolioUrl: (linkRaw && !isWhatsappLink) ? linkRaw : "",
      hasWhatsapp: isWhatsappLink, availableNow: false,
      offersOnline: false, offersHomeVisit: false, active: true,
      photoDataUri: null, logoDataUri: null, galleryPhotos: [],
      description: description || "", dealText: dealText || "", yearsInField: "", inspirationQuote: "", weeklyTipPublished: false, referredByFreelancerId: null, welcomePopupSeen: false,
      dealCode: generateCouponCode(),
      tier: "basic", joinType: d.settings.chargingEnabled ? "regular" : "founding",
      paymentStatus: d.settings.chargingEnabled ? "pending_payment" : "free",
      isLeadingBusiness: false, isAdvertised: false, adPaymentStatus: "none",
      viewCount: 0, couponRevealCount: 0, pushSubscriptions: [],
      status: "approved", createdAt: new Date().toISOString(),
    });
    imported++;
    if (email) {
      emailed++;
      sendEmail(email, "האזור האישי שלך ב-SheCan מוכן",
        `<div dir="rtl" style="font-family:Arial,sans-serif;">
          <p>היי ${esc(name || businessName)}, ✨</p>
          <p>זוכרת שמילאת את טופס ההרשמה למאגר העצמאיות של SheCan? אז אנחנו כל כך מתרגשות לבשר שהאתר החדש נבנה ונולד במיוחד בשבילכן!</p>
          <p>יצרנו לעסק שלך כרטיסייה אישית מהממת עם כל הפרטים ששלחת אלינו.</p>
          <p>🔑 פרטי ההתחברות לאזור האישי שלך:<br/>אימייל: <strong>${esc(email)}</strong><br/>סיסמה זמנית: <strong>${esc(tempPassword)}</strong><br/>קישור להתחברות: <a href="${getOrigin(req)}/login">${getOrigin(req)}/login</a></p>
          <p>חשוב - בכניסה הראשונה כדאי לא לשכוח להחליף את הסיסמה הזמנית לסיסמה משלך.</p>
          <p>את מוזמנת להיכנס, להתרשם מהכרטיסייה שלך, ותמיד להוסיף, לשנות ולעדכן תמונות ונתונים בדיוק איך שאת אוהבת.</p>
          <p>האתר עדיין לא פתוח לקהל הרחב. פתחנו אותו קודם כל במיוחד עבורכן – נבחרת המייסדות שלנו – כדי שתוכלו לסדר, ללטש ולהעלות את כל מה שצריך בשקט ובנחת לפני שכולן מגיעות. ההשקה הרשמית תהיה ממש בשבוע הבא! 🚀</p>
          <p>אם יש לך שאלות, באגים קטנים שצריך לסדר או סתם בא לך לדבר איתנו, את מוזמנת לשלוח מייל לכתובת: <a href="mailto:Shecan.office@gmail.com">Shecan.office@gmail.com</a></p>
          <p>מחכות לראות אותך בפנים,<br/>צוות SheCan 🌸</p>
        </div>`
      ).catch(() => {});
    } else {
      noEmailAccounts.push({ label: `${businessName}${phone ? ` (${phone})` : ""}`, tempPassword });
    }
  });
  db.save();
  let msg = `יובאו ${imported} עצמאיות בהצלחה!` + (emailed ? ` נשלח מייל עם פרטי התחברות ל-${emailed} מהן.` : "") + (unmatched ? ` שימי לב - ב-${unmatched} מהן לא הצלחנו להתאים תחום ו/או עיר בדיוק (כנראה כתיב שונה מהרשימה שלנו) - אפשר לתקן אותן ידנית בהמשך.` : "");
  if (noEmailAccounts.length) {
    msg += `\n\nל-${noEmailAccounts.length} מהן אין מייל, אז לא נשלחה סיסמה אוטומטית - אלה הסיסמאות הזמניות שלהן, כדאי להעביר לכל אחת ידנית (למשל בוואטסאפ):\n` +
      noEmailAccounts.map((x) => `${x.label}: ${x.tempPassword}`).join("\n");
  }
  redirect(res, `/admin?ok=${encodeURIComponent(msg)}`);
});

route("GET", "/admin/export/freelancers.csv", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const csvEscape = (v) => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
  const headers = ["שם איש קשר", "שם העסק", "אימייל", "טלפון", "תחום", "עיר", "תיאור", "טקסט הטבה", "קוד קופון", "סטטוס", "סוג הצטרפות", "סטטוס תשלום", "רמה", "נותנת חסות", "מודעה", "סטטוס תשלום מודעה", "פעילה באתר", "צפיות בעמוד", "צפיות בקופון", "תאריך הצטרפות"];
  const rows = d.freelancers.map((f) => [
    f.name, f.businessName, f.email, f.phone, catName(d, f.categoryId), cityName(d, f.cityId),
    f.description, f.dealText, f.dealCode, f.status, f.joinType, f.paymentStatus, f.tier,
    f.isLeadingBusiness ? "כן" : "לא", f.isAdvertised ? "כן" : "לא", adPaymentStatusLabel(f.adPaymentStatus), f.active === false ? "לא" : "כן", f.viewCount || 0, f.couponRevealCount || 0, f.createdAt,
  ]);
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="shecan-freelancers.csv"' });
  res.end(csv);
});

route("POST", "/admin/charging-toggle", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.chargingEnabled = !d.settings.chargingEnabled;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("עודכן!")}`);
});

route("POST", "/admin/toggle-search-visibility", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  d.settings.searchEngineVisible = !d.settings.searchEngineVisible;
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(d.settings.searchEngineVisible ? "האתר פתוח עכשיו למנועי חיפוש." : "האתר חסום שוב ממנועי חיפוש.")}`);
});

route("POST", "/admin/category", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  const d = db.load();
  const id = String(d.categories.length + 1) + "-" + Date.now();
  d.categories.push({ id, name: body.get("name") });
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent("נוסף בהצלחה.")}`);
});

route("POST", "/admin/freelancer/:id/approve", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) {
    f.status = "approved";
    if (f.paymentStatus === "pending_payment") f.paymentStatus = "active";
    const profileUrl = `${getOrigin(req)}/freelancer/${f.id}`;
    notify(f, {
      pushTitle: "את באוויר! הפרופיל שלך אושר", pushBody: "הפרופיל שלך אושר והוא כבר באוויר ב-SheCan 🎉", url: `/freelancer/${f.id}`,
      emailSubject: "את באוויר! הפרופיל שלך אושר ב-SheCan",
      emailHtml: () => `<div dir="rtl" style="font-family:Arial,sans-serif;">
        <p>היי ${esc(f.name || "")},</p>
        <p>יש! הפרופיל שלך אושר והוא כבר באוויר ב-SheCan 🎉</p>
        <p>אפשר לראות אותו כאן: <a href="${profileUrl}">${esc(profileUrl)}</a></p>
        <p>מוזמנת לשתף את קוד הקופון שלך (<strong>${esc(f.dealCode || "")}</strong>) עם הלקוחות שלך, ולהזמין אותן לכתוב לך המלצה ישירות בכרטיסייה - זה מה שיעזור לך להתחיל להיראות ולהתבלט בקהילה.</p>
      </div>`,
    }).catch(() => {});
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

route("POST", "/admin/freelancer/:id/toggle-active", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (f) f.active = !(f.active !== false); // treat missing/true as active, flip to false and back
  db.save();
  redirect(res, `/admin?ok=${encodeURIComponent(f && f.active !== false ? "היא פעילה עכשיו - חוזרת להופיע באתר." : "היא סומנה כלא פעילה - זמנית לא תופיע באתר.")}`);
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

// Lets Sapir upload a logo + up to 4 gallery photos on behalf of a freelancer (e.g. one who
// was bulk-imported from a spreadsheet and never went through the /join upload form herself).
// Mirrors the same fields/behavior as her own dashboard: a new logo replaces the old one, and
// uploading any new gallery photo replaces the whole gallery set (not merged one-by-one).
route("GET", "/admin/freelancer/:id/photos", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, `/admin?err=${encodeURIComponent("העצמאית לא נמצאה.")}`);
  const body = `
  <h1 class="section-title">תמונות עבור ${esc(f.businessName || f.name)}</h1>
  <div class="panel" style="max-width:560px;margin:0 auto;">
    <h3>לוגו נוכחי</h3>
    ${f.logoDataUri ? `<img src="${f.logoDataUri}" alt="לוגו" style="width:120px;height:120px;object-fit:cover;border-radius:12px;" />` : `<p class="muted">עדיין אין לוגו.</p>`}
    <h3 style="margin-top:18px;">גלריה נוכחית</h3>
    ${(f.galleryPhotos && f.galleryPhotos.length) ? `<div class="gallery-scroll">${f.galleryPhotos.map((src) => `<img src="${src}" alt="" class="gallery-thumb" style="object-fit:cover;" />`).join("")}</div>` : `<p class="muted">עדיין אין תמונות גלריה.</p>`}
    <form method="post" action="/admin/freelancer/${f.id}/photos" enctype="multipart/form-data" style="margin-top:18px;">
      <label>לוגו חדש ${f.logoDataUri ? "(להחלפה)" : ""}<input type="file" name="logo" accept="image/*" /></label>
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

route("POST", "/admin/freelancer/:id/photos", async (req, res, params, query, ctx) => {
  if (!requireRole(ctx.session, "admin")) return redirect(res, "/login");
  const body = await readBody(req);
  if (body.tooBig) return redirect(res, `/admin/freelancer/${params.id}/photos?err=${encodeURIComponent("התמונות ביחד גדולות מדי - נסי עם פחות תמונות או תמונות קטנות יותר.")}`);
  const d = db.load();
  const f = d.freelancers.find((x) => x.id === params.id);
  if (!f) return redirect(res, `/admin?err=${encodeURIComponent("העצמאית לא נמצאה.")}`);
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
    <button class="btn" style="margin-top:16px;width:100%;" type="submit">שליחה</button>
  </form>
  `;
  sendHtml(res, 200, page({ title: "צרי קשר", session: ctx.session, body, query }));
});

route("POST", "/contact", async (req, res, params, query, ctx) => {
  const body = await readBody(req);
  const d = db.load();
  const id = db.nextId("message");
  d.contactMessages = d.contactMessages || [];
  d.contactMessages.push({
    id, name: (body.get("name") || "").trim(), email: (body.get("email") || "").trim(),
    message: (body.get("message") || "").trim(), createdAt: new Date().toISOString(), read: false,
  });
  db.save();
  redirect(res, `/contact?ok=${encodeURIComponent("קיבלנו את ההודעה שלך - תודה! נחזור אלייך בהקדם ❤️")}`);
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

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const { session, sid } = getSession(req);
    const match = routes.find((r) => r.method === req.method && r.regex.test(u.pathname));
    if (!match) return sendHtml(res, 404, page({ title: "לא נמצא", session, body: "<p>הדף הזה לא קיים - בואי נחזור <a href=\"/\">הביתה</a> ❤️</p>" }));
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
