const { patternDataUri } = require("./pattern");
const db = require("./db");
const PATTERN = patternDataUri();
// Public VAPID key for Web Push subscription (safe to expose client-side - it's the PUBLIC
// half of the keypair). Set VAPID_PUBLIC_KEY in Render alongside VAPID_PRIVATE_KEY (server.js);
// until both are set, push notifications quietly stay disabled and the app falls back to email.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";

// Shared with server.js (categoryIcon) AND with the client-side join-preview script below,
// so a category's icon is defined in exactly one place instead of drifting between the
// server-rendered card and the live JS preview.
const CATEGORY_ICONS = {
  "יופי וטיפוח": "💄",
  "בריאות ורפואה משלימה": "🌿",
  "אימון גופני ובריאות": "🏋️‍♀️",
  "ליווי נפשי ואימון אישי (קואצ'ינג)": "🧠",
  "הריון, לידה והורות": "🤰",
  "חינוך, הוראה והעשרה": "📚",
  "טיפול בילדים ומשפחה": "🧸",
  "עיצוב ואמנות": "🎨",
  "צילום ווידאו": "📷",
  "אופנה, סטייליניג ותפירה": "👗",
  "שיווק דיגיטלי ורשתות חברתיות": "📱",
  "ייעוץ עסקי וניהול": "💼",
  "משפטים, ראיית חשבון וייעוץ פיננסי": "⚖️",
  "טכנולוגיה ופיתוח": "💻",
  "אירועים ושמחות": "🎉",
  "מזון, אפייה ותזונה": "🧁",
  "בית, גינון וארגון הבית": "🌸",
  "תרגום, כתיבה ועריכה": "✍️",
};
function categoryIcon(name) { return CATEGORY_ICONS[name] || "✨"; }

function esc(s) {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flashHtml(query) {
  if (!query) return "";
  const params = new URLSearchParams(query);
  const ok = params.get("ok");
  const err = params.get("err");
  if (ok) return `<div class="flash flash-ok">${esc(decodeURIComponent(ok))}</div>`;
  if (err) return `<div class="flash flash-err">${esc(decodeURIComponent(err))}</div>`;
  return "";
}

// Unread direct-message count for the current session - customers see unread replies
// from freelancers, freelancers see unread messages from customers.
function unreadChatCount(session) {
  if (!session) return 0;
  const d = db.load();
  const chats = d.chatMessages || [];
  if (session.role === "customer") {
    return chats.filter((m) => m.customerId === session.id && m.fromRole === "freelancer" && !m.read).length;
  }
  if (session.role === "freelancer") {
    return chats.filter((m) => m.freelancerId === session.id && m.fromRole === "customer" && !m.read).length;
  }
  return 0;
}

function badge(count) {
  return count > 0 ? `<span class="unread-badge">${count > 9 ? "9+" : count}</span>` : "";
}

function nav(session) {
  const d = db.load();
  const settings = d.settings;
  let right = `
    <a class="nav-link" href="/login">אזור אישי</a>
    <a class="nav-btn" href="/signup">עדיין לא נרשמתי</a>
  `;
  if (session && session.role === "customer") {
    const customer = d.customers.find((c) => c.id === session.id);
    const label = customer ? esc(customer.name) : "האזור שלי";
    right = `<a class="nav-link" href="/account" title="אזור אישי">${label}${badge(unreadChatCount(session))}</a><a class="nav-link" href="/logout">יציאה</a>`;
  } else if (session && session.role === "freelancer") {
    right = `<a class="nav-link" href="/freelancer-dashboard" title="אזור אישי">האזור שלי${badge(unreadChatCount(session))}</a><a class="nav-link" href="/logout">יציאה</a>`;
  } else if (session && session.role === "admin") {
    right = `<a class="nav-link" href="/admin">ניהול</a><a class="nav-link" href="/logout">יציאה</a>`;
  }
  // Per explicit request, the top nav no longer shows the "SheCan" wordmark or heart as a
  // text fallback - only a custom uploaded logo image is shown there; without one, the brand
  // slot stays empty (the site name still appears in the page <title> and footer).
  const brandInner = settings.siteLogoDataUri
    ? `<img src="${settings.siteLogoDataUri}" alt="SheCan" class="brand-logo" />`
    : ``;
  return `
  <div class="bsd-strip">בס"ד</div>
  ${settings.topBannerDataUri ? `<div class="top-banner-wrap"><a href="/" aria-label="חזרה לדף הבית"><img src="${settings.topBannerDataUri}" alt="SheCan" class="top-banner" /></a></div>` : ""}
  <div class="site-header-sticky">
    <header class="site-header" role="banner">
      <div class="container header-inner">
        ${brandInner ? `<a href="/" class="brand">${brandInner}</a>` : ""}
        <nav class="main-nav" aria-label="ניווט ראשי">
          <a class="nav-link" href="/">דף הבית</a>
          <a class="nav-link" href="/search"><span>חיפוש</span><span aria-hidden="true" style="color:var(--rose-dark);">🔍</span></a>
          <a class="nav-link" href="/deals">הטבות SheCan</a>
          <a class="nav-link" href="/stories">SheCan Stories</a>
          <a class="nav-link" href="/magazine">מגזין SheCan</a>
          <a class="nav-link nav-link-cta" href="/join">יש לי עסק</a>
          <a class="nav-link nav-link-arena" href="/arena">🥊 הזירה</a>
        </nav>
        <nav class="nav-side" aria-label="חשבון">${right}</nav>
      </div>
    </header>
  </div>`;
}

function footer() {
  return `
  <footer class="site-footer" role="contentinfo">
    <div class="container footer-inner">
      <div>SheCan <span aria-hidden="true" style="color:var(--danger);">♥</span> הבית של העצמאיות בישראל</div>
      <nav class="footer-links" aria-label="קישורי תחתית"><a href="/about">מי אנחנו</a> · <a href="/reviews">מה אומרות עלינו</a> · <a href="/contact">דברו איתנו</a> · <a href="/coming-soon">COMING SOON</a> · <a href="/terms">תקנון</a> · <a href="/privacy">מדיניות פרטיות</a> · <a href="/accessibility">הצהרת נגישות</a></nav>
    </div>
  </footer>`;
}

const CSS = `
:root{
  --cream:#F3EDE8; --rose:#c1b2a1; --rose-dark:#9a8e81;
  --dark:#5D5E56; --gray:#5D5E56; --white:#FBF8F4; --danger:#B5453B; --ok:#5C7A5A;
  --brand-font:"Heebo","Egul","Rubik","Assistant","Futura","Century Gothic","Poppins",sans-serif;
  /* "הזירה" - עמוד קהילתי מודגש בכוונה, בצבע שונה ובולט מהפלטה הרכה של שאר האתר. */
  --arena:#A6265B; --arena-dark:#7C1743; --arena-light:#F7E3EB;
}
*{box-sizing:border-box;}
html{font-family:"Heebo","Assistant","Rubik","Segoe UI","Arial",sans-serif;font-size:19px;}
body{
  margin:0; color:var(--dark); font-weight:400;
  font-family:"Heebo","Assistant","Rubik","Segoe UI","Arial",sans-serif; line-height:1.75;
  letter-spacing:-0.1px;
  background-color:var(--cream);
}
.container{max-width:1080px;margin:0 auto;padding:0 24px;}
a{color:inherit;text-decoration:none;}
.site-header-sticky{position:sticky;top:0;z-index:10;}
/* Persistent "בס"ד" strip: always shown at the very top of the page, above the (sticky) header
   row, in its own thin bar rather than merged into the nav row. */
.bsd-strip{text-align:right;font-size:13px;font-weight:700;color:var(--gray);background:var(--cream);padding:4px 24px;border-bottom:1px solid #e5ddd0;}
.site-header{background:rgba(251,248,244,.88);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border-bottom:1px solid #e5ddd0;}
.header-inner{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;flex-wrap:wrap;gap:8px 10px;}
/* The header's own inner row is allowed a bit wider than the site's normal 1080px content
   column, so the nav buttons sit a little further toward the right edge on wide screens
   instead of lining up with the (narrower) main-content column below it, per explicit request. */
.site-header .header-inner{max-width:1200px;}
.brand{font-family:var(--brand-font);font-size:28px;font-weight:800;letter-spacing:1px;color:var(--dark);}
.brand .heart{color:var(--dark);font-size:20px;vertical-align:middle;}
.brand-logo{height:34px;display:block;}
.top-banner-wrap{position:relative;overflow:hidden;}
.top-banner{width:100%;display:block;max-height:120px;object-fit:cover;cursor:pointer;}
.unread-badge{display:inline-block;background:var(--danger);color:var(--white);border-radius:10px;font-size:11px;font-weight:800;padding:1px 6px;margin-inline-start:4px;vertical-align:middle;}
.whatsapp-link{display:inline-flex;align-items:center;gap:4px;color:#25D366;font-weight:700;text-decoration:none;font-size:14px;}
.chat-thread{max-height:320px;overflow-y:auto;margin-bottom:14px;}
.chat-msg{padding:10px 14px;border-radius:12px;margin-bottom:8px;max-width:80%;}
.chat-msg.from-customer{background:var(--cream);margin-inline-end:auto;}
.chat-msg.from-freelancer{background:var(--rose);color:var(--white);margin-inline-start:auto;}
.chat-msg .chat-meta{display:block;font-size:11px;opacity:.75;margin-top:4px;}
.chat-target-label{display:block;font-size:11px;font-weight:700;opacity:.85;margin-bottom:4px;}
.badge-available{background:#5C7A5A;}
.review-response{background:var(--cream);border-radius:8px;padding:10px 14px;margin-top:10px;font-size:14px;}
.sc-zoomable{cursor:zoom-in;}
.gallery-thumb{width:150px;height:150px;border-radius:10px;flex-shrink:0;background-color:var(--cream);background-repeat:no-repeat;}
/* Was a dark/near-black overlay - per explicit request, switched to the site's own cream tone
   so a photo that doesn't exactly fill the frame (different aspect ratio than the screen)
   shows warm cream letterboxing around it instead of stark black bars. */
.sc-lightbox-overlay{position:fixed;inset:0;background:rgba(243,237,232,.97);display:none;align-items:center;justify-content:center;z-index:200;padding:24px;cursor:zoom-out;}
.sc-lightbox-overlay img{max-width:92vw;max-height:92vh;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.4);}
.profile-detail{text-align:right;max-width:520px;margin:0 auto;}
.profile-detail p, .profile-detail .muted{text-align:right;}
.narrow-panels .panel{max-width:640px;margin-left:auto;margin-right:auto;}
.gallery-scroll{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;scroll-behavior:smooth;}
.gallery-scroll .gallery-thumb{flex-shrink:0;}
.sc-lightbox-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.85);border:none;border-radius:50%;width:44px;height:44px;font-size:22px;cursor:pointer;color:var(--dark);z-index:201;}
.sc-lightbox-nav.sc-lightbox-prev{right:24px;}
.sc-lightbox-nav.sc-lightbox-next{left:24px;}
.card, .panel, .price-card, .search-box, .weekly-tip, .review, .table-simple, .site-footer{background:var(--white);}
/* Nav links pulled close together (not spread across the full header width) - only the
   account-area links (nav-side, below) stay pinned to the far left, per explicit request. */
.main-nav{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1 1 auto;justify-content:flex-start;}
.nav-link{display:inline-flex;align-items:center;gap:4px;font-size:14px;color:var(--gray);padding:6px 8px;font-weight:600;border-radius:8px;border:1px solid transparent;transition:border-color .15s ease,background .15s ease;white-space:nowrap;}
.nav-link:hover, .nav-link.nav-active{background:var(--cream);border-color:var(--rose-dark);}
/* "עדיין לא נרשמתי" + "אזור אישי" pinned to the far (visual) left of the bar, per explicit request. */
.nav-side{display:flex;gap:8px;align-items:center;font-size:14px;margin-inline-start:auto;padding-inline-start:10px;flex-shrink:0;}
.nav-btn{display:inline-flex;align-items:center;gap:6px;background:var(--rose);color:var(--white);padding:6px 12px;border-radius:8px;font-size:14px;font-weight:700;border:1.5px solid var(--rose-dark);transition:background .15s ease;white-space:nowrap;}
.nav-btn:hover{background:var(--rose-dark);}
/* "יש לי עסק" - emphasized CTA within the regular nav flow. */
.nav-link-cta{background:#fff7f0;border:1.5px solid #cfa193;color:#8a5240;font-weight:800;}
.nav-link-cta:hover, .nav-link-cta.nav-active{background:#fbe9df;border-color:#b98576;}
main{min-height:60vh;padding:18px 0 60px;}
/* Text halo: instead of one big translucent box wrapping the entire page content (which used
   to sit behind panels/cards too, even though those are already opaque), the halo now only
   hugs loose text that sits directly on the page background - headings and intro paragraphs
   that are NOT inside a .panel/.card/.arena-section etc. It's a soft text-shadow rather than a
   background box, so it follows the exact shape of the letters (no padding, no expanding
   rectangle) and stays legible over a busy custom background image without ever showing when
   there's no text there to protect. Selected via direct-child combinators so it only reaches
   loose headings/paragraphs, not text nested inside cards/panels (which already sit on solid
   white and need no help). */
main > .container > h1,
main > .container > h2,
main > .container > p,
main > .container > .hero,
main > .container > .hero *,
main .main-col > h1,
main .main-col > h2,
main .main-col > p,
main .main-col > .hero,
main .main-col > .hero *{
  text-shadow:0 0 6px rgba(251,248,244,.75),0 0 6px rgba(251,248,244,.75),0 0 12px rgba(251,248,244,.55);
}
/* Accessibility: labels now wrap their form controls (for screen-reader association).
   Force block layout + full width on every wrapped control so the visual result stays
   identical to before the wrap - this matters most for file inputs, which are inline by
   default and would otherwise sit on the same line as the label text. */
label > input:not([type=checkbox]):not([type=radio]),
label > select,
label > textarea{display:block;width:100%;margin-top:4px;}
/* Accessibility: skip-to-content link, visible only when focused (keyboard/screen-reader users
   can jump straight past the nav bar to the main content instead of tabbing through every link). */
.skip-link{position:absolute;top:-60px;right:10px;background:var(--rose-dark);color:var(--white);padding:10px 20px;border-radius:0 0 10px 10px;z-index:1000;font-weight:700;transition:top .15s ease;text-decoration:none;}
.skip-link:focus{top:0;}
main:focus{outline:none;}
/* Accessibility: a clear, consistent focus ring for keyboard navigation on every interactive
   element (links, buttons, form fields) - relies on :focus-visible so mouse clicks stay clean
   and only keyboard/assistive-tech focus shows the ring. */
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible,
textarea:focus-visible, [tabindex]:focus-visible{outline:3px solid #1a56db;outline-offset:2px;border-radius:4px;}
/* Accessibility: user-facing toolbar (font size / high contrast / link underline / stop
   animations), preferences saved in localStorage and re-applied via JS on every page load. */
.sc-a11y-widget{position:fixed;bottom:20px;left:20px;z-index:500;}
.sc-a11y-toggle{width:52px;height:52px;border-radius:50%;background:var(--rose-dark);color:var(--white);border:none;font-size:24px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.25);}
.sc-a11y-panel{position:absolute;bottom:62px;left:0;background:var(--white);border:1px solid #e5ddd0;border-radius:12px;padding:16px;width:220px;box-shadow:0 6px 24px rgba(0,0,0,.18);text-align:right;}
.sc-a11y-panel button{cursor:pointer;}
.sc-a11y-panel > div > button{background:var(--cream);border:1px solid #e5ddd0;border-radius:8px;padding:6px 12px;font-size:16px;flex:1;}
.sc-a11y-row-btn{width:100%;background:var(--cream);border:1px solid #e5ddd0;border-radius:8px;padding:8px 10px;font-size:14px;margin-bottom:8px;color:var(--dark);}
.sc-a11y-row-btn[aria-pressed="true"]{background:var(--rose);color:var(--white);border-color:var(--rose-dark);}
/* High contrast mode: near-black text on white/yellow, stronger borders. */
body.sc-a11y-contrast{background:#fff !important;color:#000 !important;}
body.sc-a11y-contrast, body.sc-a11y-contrast *{color:#000 !important;}
body.sc-a11y-contrast a{color:#00008B !important;}
body.sc-a11y-contrast .card, body.sc-a11y-contrast .panel, body.sc-a11y-contrast .price-card,
body.sc-a11y-contrast .search-box, body.sc-a11y-contrast .weekly-tip, body.sc-a11y-contrast .review,
body.sc-a11y-contrast .table-simple, body.sc-a11y-contrast .site-footer, body.sc-a11y-contrast .site-header,
body.sc-a11y-contrast main > .container{background:#fff !important;border:1px solid #000 !important;}
body.sc-a11y-contrast .nav-btn, body.sc-a11y-contrast .btn{background:#000 !important;color:#fff !important;}
body.sc-a11y-underline a{text-decoration:underline !important;}
body.sc-a11y-noanim, body.sc-a11y-noanim *{transition:none !important;animation:none !important;scroll-behavior:auto !important;}
/* "Add to home screen" install banner - fixed bar at the bottom of the screen, above the
   accessibility widget so the two never overlap. */
#scInstallBanner{position:fixed;bottom:0;left:0;right:0;background:var(--white);border-top:1px solid #e5ddd0;box-shadow:0 -4px 16px rgba(0,0,0,.12);padding:12px 20px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;z-index:600;font-size:14px;text-align:center;}
/* Cookie consent banner - fixed bar, shown once until a choice is made (stored in
   localStorage). Sits above the install banner (higher z-index) so the two can't overlap. */
#scCookieBanner{position:fixed;bottom:0;left:0;right:0;background:var(--dark);color:var(--white);box-shadow:0 -4px 16px rgba(0,0,0,.2);padding:14px 20px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;z-index:700;font-size:14px;text-align:center;}
#scCookieBanner a{text-decoration:underline;color:var(--white);}
#scCookieBanner button{cursor:pointer;font-family:inherit;}
.hero{text-align:center;padding:8px 0 2px;}
.hero h1{font-family:var(--brand-font);font-size:60px;font-weight:800;letter-spacing:1px;margin:0 0 12px;}
.hero p{color:var(--gray);font-size:21px;max-width:600px;margin:0 auto;}
.hero-sub{font-size:23px;font-weight:800;color:var(--dark);margin:0 auto 6px;}
.hero-sub2{font-size:19px;font-weight:600;color:var(--gray);margin:0 auto;}
/* "Weekly Tip from the Expert" floating card: replaces the old "משפט השבוע" quote box.
   Subtle border/shadow makes it appear to float above the page; a small circular avatar +
   name sits at top, the tip itself is shown as a large blockquote-style quote in the middle,
   and a button at the bottom links through to her profile (or the arena when there's no
   specific freelancer attached). */
/* Shrunk down further, per explicit request, so it doesn't push the search box below the
   fold - tighter padding/margins throughout and a smaller quote, while keeping the same
   "floating card with avatar+name, quote, and a button" shape. */
.weekly-tip{position:relative;background:var(--white);border:1px solid #eee2d8;border-radius:14px;padding:32px 20px 30px;max-width:680px;margin:6px auto 10px;text-align:center;box-shadow:0 6px 18px rgba(154,142,129,.18);}
/* Kicker moved into the top-right corner of the box as a plain colored label (no pill/
   background behind it anymore), sized up slightly - per explicit request. */
.weekly-tip-kicker{position:absolute;top:12px;right:18px;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--rose-dark);}
.weekly-tip-person{display:flex;align-items:center;justify-content:center;gap:6px;margin:8px 0 2px;}
.weekly-tip-avatar{width:26px;height:26px;border-radius:50%;object-fit:cover;background:var(--rose);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;flex-shrink:0;}
.weekly-tip-name{font-weight:800;color:var(--dark);font-size:13px;}
.weekly-tip-quote{position:relative;font-size:14.5px;line-height:1.45;font-style:italic;color:var(--dark);margin:4px auto 6px;padding:0 22px;max-width:520px;}
.weekly-tip-quote::before{content:"“";font-size:26px;font-family:Georgia,"Times New Roman",serif;color:var(--rose-dark);opacity:.5;position:absolute;top:-8px;right:-2px;line-height:1;}
.weekly-tip-quote::after{content:"”";font-size:26px;font-family:Georgia,"Times New Roman",serif;color:var(--rose-dark);opacity:.5;position:absolute;bottom:-14px;left:-2px;line-height:1;}
/* Attribution (business name | field) moved into the bottom-left corner - per explicit
   request - out of normal document flow so it doesn't push the button around. */
.weekly-tip-attr{position:absolute;bottom:12px;left:18px;font-size:11.5px;color:var(--gray);font-weight:700;}
.weekly-tip-btn{display:inline-block;background:var(--rose);color:#fff !important;font-weight:700;padding:5px 16px;border-radius:20px;font-size:12.5px;}
.weekly-tip-btn:hover{background:var(--rose-dark);}
/* "הזירה" - עמוד קהילה מודגש: כותרת בגרדיאנט בולט, וכל אחד מ-3 החלקים הגדולים מסומן
   בפס עליון עבה בצבע הזירה, כדי שהעמוד יבלוט בבירור מול שאר האתר הרך יותר. */
/* Hero box shrunk down significantly (it used to be a huge, mostly-empty block) and given
   a softer background; a handful of loosely-scattered, low-opacity decorative icons (question
   marks, a poll/chart glyph, a lightbulb) hint at the 3 sections below without competing with
   the title text. */
.arena-hero{position:relative;overflow:hidden;background:linear-gradient(135deg,var(--arena),var(--arena-dark));color:#fff;border-radius:14px;padding:18px 24px;text-align:center;margin-bottom:26px;}
.arena-hero h1{position:relative;z-index:1;margin:0 0 4px;font-size:24px;font-weight:800;}
.arena-hero p{position:relative;z-index:1;margin:0;font-size:14px;opacity:.95;}
.arena-hero-deco{position:absolute;inset:0;pointer-events:none;z-index:0;}
.arena-hero-deco span{position:absolute;opacity:.18;font-size:26px;color:#fff;}
.arena-hero-deco span:nth-child(1){top:8%;right:6%;font-size:30px;transform:rotate(-12deg);}
.arena-hero-deco span:nth-child(2){bottom:10%;right:16%;font-size:20px;transform:rotate(8deg);}
.arena-hero-deco span:nth-child(3){top:12%;left:8%;font-size:24px;transform:rotate(10deg);}
.arena-hero-deco span:nth-child(4){bottom:14%;left:20%;font-size:22px;transform:rotate(-8deg);}
.arena-hero-deco span:nth-child(5){top:44%;left:2%;font-size:18px;transform:rotate(6deg);}
/* 3 big horizontal tab buttons (right-to-left, matching the site's RTL flow) instead of the
   3 sections all showing at once stacked vertically - clicking a button reveals just that
   section below (see scArenaShowTab in the shared script block). */
.arena-tabs{display:flex;gap:14px;margin-bottom:28px;}
/* Each tab is now a bigger illustrated card: a large icon, then the (un-numbered) title,
   then a short explanatory subtitle - rather than the old plain numbered text button. */
.arena-tab-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;background:var(--white);border:2px solid var(--arena-light);border-radius:14px;padding:22px 14px;font-weight:800;line-height:1.4;color:var(--arena-dark);cursor:pointer;font-family:inherit;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.05);transition:background .15s ease,border-color .15s ease,color .15s ease;}
.arena-tab-btn:hover{border-color:var(--arena);}
.arena-tab-btn.active{background:var(--arena);color:#fff;border-color:var(--arena-dark);}
.arena-tab-btn.active .arena-tab-sub{color:#fff;opacity:.9;}
.arena-tab-icon{font-size:40px;line-height:1;margin-bottom:2px;}
.arena-tab-title{font-size:18px;font-weight:800;}
.arena-tab-sub{display:block;font-size:12.5px;font-weight:500;color:var(--gray);line-height:1.5;}
@media (max-width:720px){.arena-tabs{flex-direction:column;}}
.arena-section{background:var(--white);border-top:6px solid var(--arena);border-radius:14px;padding:26px 24px;margin-bottom:32px;box-shadow:0 2px 14px rgba(0,0,0,.06);}
.arena-section h2{color:var(--arena-dark);margin-top:0;font-size:26px;}
.arena-disclaimer{margin:-6px 0 14px;font-size:10.5px;color:var(--gray);text-align:center;opacity:.8;}
.arena-card{background:var(--arena-light);border-radius:10px;padding:16px 18px;margin-top:14px;}
.arena-card .muted{color:var(--gray);}
.btn-arena{display:inline-block;background:var(--arena);color:#fff;padding:11px 24px;border-radius:22px;border:1.5px solid var(--arena-dark);font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;}
.btn-arena:hover{background:var(--arena-dark);}
.badge-arena{background:var(--arena);}
.arena-toggle{background:none;border:none;color:var(--arena-dark);font-weight:700;cursor:pointer;padding:4px 0;font-size:14px;}
.arena-answers{display:none;margin-top:10px;border-top:1px dashed #d8b9c8;padding-top:10px;}
.arena-answer{margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #eee1e7;}
.arena-answer:last-child{border-bottom:none;}
/* Clear visual hierarchy: the question/consultation itself is bold and larger; the meta line
   (who + when) is small and muted right beneath it; an answer/reply is a clearly readable
   size but never as bold/emphasized as the question, with its own author+timestamp line. */
.arena-question-text{margin:8px 0 2px;font-weight:800;font-size:17px;color:var(--dark);}
.arena-meta{margin:0 0 6px;font-size:12.5px;color:var(--gray);}
.arena-answer-author{font-weight:700;color:var(--arena-dark);}
.arena-answer-text{margin:4px 0 0;font-size:14.5px;font-weight:400;color:var(--dark);}
.poll-option-row{display:flex;align-items:center;gap:10px;margin-top:8px;}
.poll-bar-wrap{flex:1;background:#eee1e7;border-radius:8px;overflow:hidden;height:26px;position:relative;}
.poll-bar-fill{background:var(--arena);height:100%;border-radius:8px 0 0 8px;transition:width .3s ease;}
.poll-bar-label{position:absolute;inset:0;display:flex;align-items:center;padding:0 10px;font-size:13px;font-weight:700;color:var(--dark);}
/* "הזירה" nav button: pinned to the far (visual) left edge of the header via an auto
   inline-start margin (absorbs all remaining row space on its own row), and colored with the
   requested #cfa193 instead of the arena page's own deep-rose accent color. */
/* "הזירה" now sits inline within the main nav flow (not pinned to the edge) but stays visually
   distinct via a gradient badge treatment, rather than the plain pill it used to have. */
.nav-link-arena{background:linear-gradient(135deg,#cfa193,#a6265b);color:#fff !important;border-radius:8px;padding:6px 12px !important;font-weight:800;box-shadow:0 2px 8px rgba(166,38,91,.3);border-color:transparent !important;}
.nav-link-arena:hover, .nav-link-arena.nav-active{background:linear-gradient(135deg,#b98576,#7c1743);box-shadow:0 2px 10px rgba(166,38,91,.45);}
.search-box{background:var(--white);border-radius:14px;padding:16px 22px;max-width:680px;margin:6px auto 14px;box-shadow:0 2px 14px rgba(0,0,0,.06);}
/* Story-of-the-week banner: sized/aligned to the same 680px centered column as the search box
   and weekly-tip card above/below it, instead of the old small right-floated pill badge that
   didn't line up with the rest of the page content. */
.story-of-week-banner{display:block;background:var(--rose-dark);color:#fff !important;text-decoration:none;font-size:14px;font-weight:700;text-align:center;padding:8px 20px;border-radius:12px;max-width:680px;margin:0 auto 10px;box-shadow:0 2px 10px rgba(0,0,0,.06);}
.story-of-week-banner:hover{background:var(--rose);}
/* Dismissible "story of the week updated" notice - floats on the left side of the home page
   (opposite the RTL reading direction, so it doesn't compete with the main content flow).
   Shown once per customer via localStorage, keyed to the current story's id so it naturally
   re-appears the next time the featured story rotates to a different freelancer. */
.story-notice{position:fixed;left:16px;bottom:16px;max-width:270px;background:var(--white);border:1px solid #eee2d8;border-radius:14px;box-shadow:0 10px 28px rgba(0,0,0,.16);padding:16px 16px 14px;z-index:600;text-align:right;}
.story-notice-close{position:absolute;top:8px;left:10px;background:none;border:none;font-size:16px;color:var(--gray);cursor:pointer;line-height:1;}
.story-notice-text{margin:0 0 8px;font-size:13.5px;line-height:1.5;color:var(--dark);padding-left:14px;}
.story-notice-link{font-weight:700;font-size:13px;color:var(--rose-dark);text-decoration:underline;}
@media (max-width:640px){.story-notice{left:10px;right:10px;bottom:10px;max-width:none;}}
/* Small decorative visual element for the "צרי קשר" page. */
.contact-hero{text-align:center;margin-bottom:4px;}
.contact-hero-icon{display:inline-flex;align-items:center;justify-content:center;width:84px;height:84px;border-radius:50%;background:linear-gradient(135deg,var(--rose),var(--rose-dark));font-size:40px;box-shadow:0 8px 22px rgba(154,142,129,.35);}
/* Bullet lists with a flower/emoji marker: each <li> is a flex row of [icon][text] so that when
   the text wraps to a second line, the continuation lines up under the text (after the emoji)
   instead of restarting from the line's own right edge - a proper hanging indent. */
.bullet-list li{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;}
.bullet-list .bullet-icon{flex-shrink:0;}
.search-row{display:flex;gap:12px;flex-wrap:wrap;}
.search-row select, .search-row input{flex:1;min-width:160px;}
.search-row .city-autocomplete{flex:1;min-width:160px;}
select, input[type=text], input[type=email], input[type=password], input[type=tel], textarea{
  padding:11px 14px;border:1px solid #ddd3c4;border-radius:8px;font-size:16px;background:var(--white);color:var(--dark);width:100%;font-family:inherit;font-weight:500;
}
textarea{min-height:90px;}
label{display:block;font-size:16px;color:var(--dark);margin:16px 0 6px;font-weight:800;}
form .field{margin-bottom:6px;}
.btn{display:inline-block;background:var(--rose);color:var(--white);padding:12px 26px;border-radius:24px;border:1.5px solid var(--rose-dark);font-size:16px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 2px 6px rgba(173,125,104,.25);}
.btn:hover{background:var(--rose-dark);}
.btn-outline{background:transparent;border:1.5px solid var(--rose);color:var(--rose-dark);}
.btn-small{padding:7px 16px;font-size:14px;border-radius:18px;}
.city-autocomplete{position:relative;}
.city-autocomplete-list{position:absolute;z-index:20;top:100%;right:0;left:0;margin-top:4px;max-height:240px;overflow-y:auto;background:var(--white);border:1px solid #ddd3c4;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.12);}
.city-autocomplete-item{padding:10px 14px;font-size:15px;cursor:pointer;}
.city-autocomplete-item:hover,.city-autocomplete-item.active{background:var(--rose);color:var(--white);}
.city-autocomplete-empty{padding:10px 14px;font-size:14px;color:var(--gray);}
.section-title{font-size:26px;font-weight:700;letter-spacing:0.5px;margin:44px 0 20px;text-align:center;}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;}
.cat-card{background:var(--white);border-radius:10px;padding:18px;text-align:center;font-size:16px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.05);}
.cat-card:hover{background:var(--rose);color:var(--white);}
.cat-icon{display:block;font-size:26px;margin-bottom:6px;}
/* Card width tuned so 3 fit per row (instead of 2) on the main content column, including on
   pages with the sidebar sponsor/ad slots eating into that width - the card itself is a touch
   smaller (shorter photo, tighter body padding below) to keep 3-per-row comfortable. */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:14px;}
.card{background:var(--white);border-radius:14px;overflow:hidden;box-shadow:0 3px 14px rgba(207,161,147,.35);display:flex;flex-direction:column;}
/* Uniform solid accent color (no more diagonal gradient) behind initials/contained logos, so
   every card without a real photo reads as one consistent color instead of a partial-looking
   two-tone blend. */
.card-photo{height:130px;background:var(--rose);display:flex;align-items:center;justify-content:center;color:var(--white);font-size:34px;font-weight:600;}
/* When falling back to a business logo (rather than a real photo), the logo is shown scaled
   DOWN to fit inside the frame (background-size:contain, set inline) rather than cropped to
   fill it like a photo - a white backing keeps transparent-background logos legible. */
.card-photo-logo{background-color:#fff;}
.card-body{padding:14px 16px;flex:1;display:flex;flex-direction:column;text-align:center;gap:2px;}
.card-badges{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:2px 0;}
.badge{display:inline-block;background:var(--rose-dark);color:var(--white);font-size:12px;font-weight:600;padding:3px 10px;border-radius:12px;align-self:flex-start;margin-inline-end:4px;}
.card-badges .badge{align-self:center;margin-inline-end:0;}
.badge-outline{background:transparent;border:1px solid var(--gray);color:var(--gray);}
.badge-leading{background:#8A6B2E;}
.badge-ad{background:transparent;border:1px solid var(--rose-dark);color:var(--rose-dark);}
.card-leading{border:2px solid #D9B36C;box-shadow:0 4px 16px rgba(217,179,108,.35);}
.card-ad{border:1.5px dashed var(--rose-dark);}
.leading-strip{background:linear-gradient(135deg,#FCF3E3,var(--white));border-radius:16px;padding:22px;margin:26px 0;}
/* Compact card layout: bold name+field as the emphasized header, then every other detail
   flows into one centered block (.card-info) with tight line spacing instead of separate
   spaced-out paragraphs and a divider bar between them. */
.card-name{margin:2px 0 0;font-size:18px;font-weight:800;color:#5c5d55;text-align:center;}
/* Category directly under the business name, no icon, then a thin divider in the name's own
   text color, per explicit request. .card-top has a fixed min-height so whatever comes next
   (.card-meta-block: location + years) always starts on the same line across a row of cards,
   regardless of how long any one card's name/category text happens to be. */
.card-top{min-height:72px;}
.card-category{margin:2px 0 0;font-size:13px;font-weight:700;color:var(--gray);}
.card-name-divider{width:34px;height:2px;background:#5c5d55;border-radius:2px;margin:6px auto 0;}
.card-meta-block{margin-top:2px;}
.card-meta-row{display:flex;align-items:center;justify-content:center;gap:4px;font-size:12.5px;font-weight:700;color:var(--gray);margin:2px 0;}
.muted{color:var(--gray);font-size:15px;}
.card-info{margin-top:4px;display:flex;flex-direction:column;flex:1;}
.card-info p, .card-info > div{margin:3px 0;font-size:13px;line-height:1.45;color:var(--gray);}
.card-reviewcount{font-weight:700;color:var(--rose-dark);}
/* Deal is pinned to the bottom of the card regardless of how much content sits above it -
   .card-info is a flex column filling the remaining card height, and margin-top:auto on
   the deal pushes it (and anything after it, like the decorative view-btn) to the end. */
.card-deal{background:#FBF3EC;border:1px dashed var(--rose);border-radius:8px;padding:8px 10px;margin-top:auto !important;font-weight:600;}
/* card-field (main category/subcategory), card-desc (bio) and card-view-btn (decorative
   "view profile" pill - the card itself is already the link, so this is visual only, never a
   real nested <a>) all stay hidden by default. This keeps the plain card (home page, deals
   page) exactly as reverted, and only the /search results grid - via its [data-view] wrapper
   below - opts individual pieces back in for the "medium"/"expanded" view modes. */
.card-field, .card-desc, .card-view-btn{display:none;}
#scCardsGrid[data-view="medium"] .card-field,
#scCardsGrid[data-view="expanded"] .card-field{display:block;font-size:14px;font-weight:700;color:var(--gray);margin-top:1px;}
#scCardsGrid[data-view="expanded"] .card-desc{display:block;}
#scCardsGrid[data-view="expanded"] .card-view-btn{display:inline-block;margin-top:8px;pointer-events:none;}
#scCardsGrid[data-view="compact"] .card-badges,
#scCardsGrid[data-view="compact"] .card-info{display:none;}
#scCardsGrid[data-view="compact"]{grid-template-columns:repeat(auto-fill,minmax(115px,1fr));gap:8px;}
#scCardsGrid[data-view="compact"] .card-photo{height:64px;}
#scCardsGrid[data-view="compact"] .card-body{padding:6px 8px;gap:0;}
#scCardsGrid[data-view="compact"] .card-name{font-size:12.5px;margin:0;}
#scCardsGrid[data-view="expanded"]{grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;}
/* The "תצוגה" view-mode switcher on /search - 3 buttons, each with a small CSS-drawn icon
   (not an emoji, so it renders identically everywhere) approximating the requested look:
   2x2 big squares for "מורחבת", 3x3 grid for "בינונית", stacked rows for "קומפקטית". */
.view-toggle{display:flex;align-items:center;gap:5px;}
.view-toggle-label{font-size:12px;font-weight:700;color:var(--gray);margin-inline-end:2px;}
.view-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1.5px solid transparent;background:transparent;cursor:pointer;padding:0;}
.view-btn:hover{background:var(--cream);}
.view-btn.active{border-color:var(--rose-dark);background:var(--cream);}
.view-icon{display:grid;gap:2px;width:15px;height:15px;}
.view-icon i{background:var(--gray);border-radius:1px;display:block;}
.view-icon-expanded{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;}
.view-icon-medium{grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr;}
.view-icon-compact{grid-template-columns:1fr;grid-template-rows:repeat(4,1fr);}
.view-icon-compact i{height:2px;align-self:center;}
.deal-box{background:#FBF3EC;border:1px dashed var(--rose);border-radius:8px;padding:12px 14px;margin-top:auto;font-size:15px;font-weight:500;}
.profile-hero{display:flex;gap:26px;flex-wrap:wrap;align-items:center;justify-content:center;text-align:center;background:var(--white);border-radius:16px;padding:28px;box-shadow:0 2px 14px rgba(0,0,0,.05);max-width:520px;margin:0 auto;}
.profile-hero .muted{justify-content:center;}
.profile-photo{width:130px;height:130px;border-radius:50%;background:linear-gradient(135deg,var(--rose),var(--cream));flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--white);font-size:44px;font-weight:600;}
/* Compact merged profile section: photo + name/field + נעים להכיר + contact details + deal,
   all in one centered panel instead of three separate spaced-out ones, per explicit request. */
/* No max-width override here (was 480px) - inherits .profile-detail's 520px so every panel
   on the profile page (this merged block, the gallery, the reviews, and the message box)
   lines up on the exact same borders, per explicit request. */
.profile-merged{text-align:center;}
.profile-merged p, .profile-merged .muted{text-align:center;}
.profile-photo-compact{width:92px;height:92px;font-size:32px;margin:0 auto;}
/* Thin divider under the category/field line - inset margins so it doesn't run edge-to-edge,
   per explicit request. Still used on the additional-listing detail page. */
.profile-field-divider{height:1px;background:#000;margin:10px 34px 0;}
/* The freelancer's location/phone/link/email/instagram - each on its own line (bigger,
   bolded text), stacked as a block, every row's icon+text pair aligned so they all start
   from the same point instead of each line being centered separately, per explicit request. */
.profile-detail-list{display:inline-flex;flex-direction:column;margin:8px auto;}
.profile-detail-row{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:800;color:#5c5d55;padding:1px 0;}
.profile-detail-row a{color:inherit;text-decoration:none;}
.profile-detail-icon{flex-shrink:0;width:24px;text-align:center;}
.profile-merged-heading{color:var(--gray);font-size:20px;text-align:center;margin:18px 0 8px;}
/* Coupon/deal box on the profile page shrink-wraps to its own content (per explicit request)
   instead of stretching across the whole panel - inline-block lets .profile-merged's
   text-align:center handle the centering, so the gift icon sits snug against the text
   instead of looking spread out across a wide box. */
.deal-box-compact{padding:10px 14px;font-size:14px;margin-top:14px;display:inline-block;max-width:100%;}
/* Redesigned full-profile header (item 2, round 2): horizontal layout - logo on the right,
   business name/years/rating/location beside it (to the logo's left), and contact details
   in their own column further left, everything aligned with icons instead of the old
   fully-centered stacked block. Wraps to a stacked layout on narrow screens. */
.profile-header-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;text-align:right;margin-top:6px;}
.profile-header-namelogo{display:flex;align-items:flex-start;gap:12px;}
.profile-header-logo{width:88px;height:88px;border-radius:16px;flex-shrink:0;background:linear-gradient(135deg,var(--rose),var(--cream));display:flex;align-items:center;justify-content:center;color:var(--white);font-size:30px;font-weight:600;}
.profile-header-info{min-width:0;}
.profile-header-name{margin:0;font-size:22px;color:#5c5d55;line-height:1.25;}
.profile-header-years{margin-top:4px;font-size:13px;font-weight:700;color:var(--gray);}
.profile-stars-row{margin-top:4px;display:flex;align-items:center;gap:6px;}
.profile-stars-row .stars{color:#D9A441;font-size:16px;letter-spacing:1px;}
.profile-review-count-small{font-size:11.5px;font-weight:700;color:var(--gray);}
.profile-header-location{margin-top:4px;font-size:13.5px;font-weight:700;color:var(--gray);display:flex;align-items:center;gap:4px;}
/* Contact rows pulled in a bit closer together (was gap:7px/row padding:3px) per explicit
   request - still has a little breathing room, just not as loose as before. */
.profile-contact-col{display:flex;flex-direction:column;gap:3px;flex-shrink:0;min-width:150px;align-items:flex-start;}
.profile-header-desc{text-align:right;font-size:14px;margin:14px 0 0;}
/* Vertical divider between the name/logo/rating block and the contact-details column, in the
   site's established accent/"brown" tone - per explicit request. Hidden once the row wraps to
   a stacked single-column layout on narrow screens, where a vertical line makes no sense. */
.profile-header-divider{width:1px;align-self:stretch;background:var(--rose-dark);flex-shrink:0;}
@media (max-width:720px){.profile-header-divider{display:none;}}
.table-scroll{max-width:100%;overflow-x:auto;border-radius:10px;}
.table-simple{width:100%;border-collapse:collapse;background:var(--white);border-radius:10px;overflow:hidden;}
.table-simple th, .table-simple td{padding:12px 14px;text-align:right;border-bottom:1px solid #eee2d3;font-size:15px;}
.table-simple th{background:var(--rose);color:var(--white);}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin:26px 0;}
.price-card{background:var(--white);border-radius:14px;padding:26px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06);}
.price-card.featured{border:2px solid var(--rose);}
.price-card .price{font-size:32px;font-weight:700;color:var(--rose-dark);margin:10px 0;}
.review{background:var(--white);border-radius:12px;padding:16px 18px;margin-bottom:14px;text-align:right;}
.review-header{display:flex;align-items:center;justify-content:flex-start;gap:10px;border-bottom:1px solid #eee2d3;padding-bottom:8px;margin-bottom:10px;}
.review-header .review-name{font-weight:800;}
.review-text{background:var(--cream);border:1px solid #e5ddd0;border-radius:8px;padding:10px 14px;font-size:15px;}
.stars{color:var(--rose-dark);font-size:15px;}
.sc-star-input{display:flex;gap:6px;font-size:30px;justify-content:center;margin:8px 0;line-height:1;}
.sc-star{color:#ddd3c4;cursor:pointer;transition:color .1s;user-select:none;}
.sc-star.sc-star-filled{color:var(--rose-dark);}
.flash{max-width:680px;margin:14px auto;padding:12px 18px;border-radius:8px;font-size:14px;text-align:center;white-space:pre-line;}
.flash-ok{background:#e9f1e8;color:var(--ok);}
.flash-err{background:#f6e6e3;color:var(--danger);border:2px solid var(--danger);font-size:16px;font-weight:700;padding:16px 20px;box-shadow:0 3px 12px rgba(181,69,59,.25);}
.flash-err::before{content:"⚠️ ";}
@keyframes scFlashAttention{0%,100%{transform:translateX(0);}20%{transform:translateX(-6px);}40%{transform:translateX(6px);}60%{transform:translateX(-4px);}80%{transform:translateX(4px);}}
.flash-err.sc-flash-attention{animation:scFlashAttention .5s ease-in-out;}
.panel{background:var(--white);border-radius:14px;padding:22px;margin-bottom:22px;box-shadow:0 2px 10px rgba(0,0,0,.05);}
/* Admin dashboard: every top-level panel is collapsible (collapsed by default) so a long
   section (lots of reviews, lots of pending items) doesn't force endless scrolling - open
   state is remembered per-panel across visits via localStorage (see scSetupAdminCollapsibles). */
.sc-admin-page .panel > h3{cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between;gap:10px;}
.sc-admin-page .sc-panel-toggle{font-size:22px;line-height:1;color:var(--rose-dark);flex-shrink:0;}
.sc-admin-page .sc-panel-body{margin-top:14px;}
/* Logo cropper modal - shown right after picking a logo file, so freelancers can position/zoom
   into a clean square before it's saved, instead of a stretched/padded source image (e.g. a
   whole A4 page) ending up as-is in their profile. See scSetupLogoCropper. */
.sc-crop-overlay{position:fixed;inset:0;background:rgba(30,20,15,.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;}
.sc-crop-modal{background:var(--white);border-radius:16px;padding:20px;max-width:360px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.3);}
.sc-crop-modal h4{margin:0 0 4px;}
.sc-crop-modal p.muted{margin:0 0 14px;font-size:14px;}
.sc-crop-canvas-wrap{width:280px;height:280px;margin:0 auto;border-radius:14px;overflow:hidden;background:#eee;cursor:grab;touch-action:none;box-shadow:inset 0 0 0 2px var(--rose);}
.sc-crop-canvas-wrap:active{cursor:grabbing;}
.sc-crop-zoom{width:100%;margin:16px 0 6px;}
.sc-crop-actions{display:flex;gap:10px;margin-top:14px;}
.sc-crop-actions .btn{flex:1;}
.sc-crop-skip{display:block;margin-top:12px;font-size:13px;color:var(--gray);text-decoration:underline;background:none;border:none;cursor:pointer;padding:0;}
.founding-badge{background:#EFE1D8;color:var(--rose-dark);font-size:12px;padding:3px 10px;border-radius:12px;}
/* Referral-contest panels (customer "bring a friend" race + freelancer "bring a business"
   race) - a slightly warmer, bordered panel so the promo stands out a bit from the plain
   white panels around it, without introducing a whole new visual language. */
.referral-promo-panel{background:var(--cream);border:1px solid #eee2d8;text-align:center;}
.referral-prize-list{list-style:none;padding:0;margin:10px auto;max-width:360px;text-align:right;font-size:14px;line-height:1.9;}
.referral-prize-list li{display:flex;align-items:flex-start;gap:8px;}
.referral-link-row{display:flex;gap:8px;max-width:420px;margin:10px auto 0;}
.referral-link-row input{flex:1;}
.referral-status-panel h4{font-size:16px;}
/* The two "how did you hear about us" choices on the freelancer join form - kept compact
   (small text, tight spacing) so the extra field doesn't feel heavy right before the submit
   button, per explicit request. */
.referral-source-choice{margin:10px 0;font-size:13.5px;}
.referral-source-choice label{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13.5px;margin-top:4px;}
.referral-source-choice input[type="text"]{margin-top:4px;font-size:13.5px;padding:6px 10px;}
.site-footer{background:var(--white);border-top:1px solid #e5ddd0;padding:26px 0;margin-top:40px;}
.footer-inner{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;color:var(--gray);font-size:15px;}
.footer-links a{margin:0 4px;}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px;}
@media (max-width:720px){.two-col{grid-template-columns:1fr;} .profile-hero{flex-direction:column;text-align:center;}}
.page-with-sidebars{display:flex;gap:20px;align-items:flex-start;direction:rtl;}
.page-with-sidebars .main-col{flex:1;min-width:0;order:2;}
/* The column itself scrolls normally with the page now (not sticky) - sponsor tiles should
   scroll up and out of view like any other content. Only a real paid ad ("מודעה") stays
   pinned in place, via position:sticky on that specific card below (.side-ad-card-pinned),
   not on the whole column, per explicit request. */
.page-with-sidebars .side-col{width:200px;flex-shrink:0;align-self:flex-start;}
.page-with-sidebars .side-col-right{order:1;}
.page-with-sidebars .side-col-left{order:3;}
.side-ad-card{background:var(--white);border-radius:10px;padding:14px;margin-bottom:14px;box-shadow:0 2px 8px rgba(0,0,0,.05);border:1.5px dashed var(--rose-dark);}
.side-ad-card .badge-ad{margin-bottom:4px;}
.side-ad-card h4{margin:6px 0 2px;font-size:15px;font-weight:700;}
.side-ad-card .muted{font-size:13px;}
.side-ad-card-pinned{position:sticky;top:96px;}
@media (max-width:960px){
  .page-with-sidebars{flex-direction:column;}
  .page-with-sidebars .main-col,.page-with-sidebars .side-col-right,.page-with-sidebars .side-col-left{order:initial;width:100%;}
  .page-with-sidebars .side-col{display:flex;gap:14px;overflow-x:auto;position:static;}
  .page-with-sidebars .side-col .side-ad-card{min-width:200px;}
  /* Pinning only makes sense in the desktop vertical column - in this mobile horizontal
     scroller the ad card scrolls sideways with the rest, same as sponsors. */
  .page-with-sidebars .side-col .side-ad-card-pinned{position:static;}
}
.tabs{display:flex;gap:10px;margin-bottom:18px;}
.tab{padding:8px 18px;border-radius:20px;background:var(--white);font-size:14px;}
.tab.active{background:var(--rose);color:var(--white);}
.sc-modal-overlay{position:fixed;inset:0;background:rgba(93,94,86,.55);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;}
.sc-modal{background:var(--white);border-radius:18px;padding:34px 30px;max-width:460px;max-height:88vh;overflow-y:auto;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.25);position:relative;}
.sc-modal h2{font-size:26px;margin:0 0 14px;}
.sc-modal p{font-size:16px;color:var(--dark);line-height:1.7;margin:0;}
.sc-modal-close{position:absolute;top:12px;left:14px;background:none;border:none;font-size:22px;color:var(--gray);cursor:pointer;}
.sc-modal-btn{margin-top:20px;}
`;

function subcatsJsMap() {
  const d = db.load();
  const map = {};
  d.categories.forEach((c) => { map[c.id] = (c.subcategories || []).map((s) => ({ id: s.id, name: s.name })); });
  return map;
}

// A searchable city text field instead of a giant <select> (100+ cities) - drop-in
// replacement wherever a city dropdown was used. `fieldName` is the name of the hidden
// input actually submitted with the form ("cityId" on POST forms, "city" on the GET search
// filters), `selectedId`/`selectedName` pre-fill it when editing something that already has
// a city, and `placeholder` is the text shown in the empty field.
function cityAutocompleteHtml({ fieldName, selectedId, selectedName, placeholder }) {
  return `<div class="city-autocomplete">
    <input type="text" class="city-autocomplete-input" placeholder="${esc(placeholder || "הקלידי שם עיר...")}" autocomplete="off" value="${esc(selectedName || "")}" />
    <input type="hidden" name="${esc(fieldName)}" class="city-autocomplete-hidden" value="${esc(selectedId || "")}" />
    <div class="city-autocomplete-list" hidden></div>
  </div>`;
}

function sidebarCatName(d, id) {
  const c = d.categories.find((x) => x.id === id);
  return c ? c.name : "-";
}

function sponsorCardHtml(f, d) {
  return `
    <a class="side-ad-card" href="/freelancer/${f.id}" style="display:block;">
      <span class="badge badge-leading">👑 עסק מוביל</span>
      <h4>${esc(f.businessName || f.name)}</h4>
      <div class="muted">${esc(sidebarCatName(d, f.categoryId))}</div>
    </a>`;
}

// listing (optional) - a freelancer can choose to advertise one specific additional
// listing rather than her whole main profile, so the ad card and its link need to point at
// whichever one is actually the paid ad.
function adCardHtml(f, d, listing) {
  const target = listing || f;
  const href = listing ? `/freelancer/${f.id}/listing/${listing.id}` : `/freelancer/${f.id}`;
  const categoryId = listing ? listing.categoryId : f.categoryId;
  return `
    <a class="side-ad-card side-ad-card-pinned" href="${href}" style="display:block;">
      <span class="badge badge-ad">📣 מודעה</span>
      <h4>${esc(target.businessName || target.name)}</h4>
      <div class="muted">${esc(sidebarCatName(d, categoryId))}</div>
    </a>`;
}

// Sponsors and ads share the same six sidebar slots (three per side) on every page of the
// site, regardless of login state. Sponsors always take priority - they fill the shared
// slots first - and ads only fill whatever slots are left over. That way, the moment Sapir
// removes a sponsor, an ad automatically becomes eligible to take the freed slot, with no
// separate toggle needed. Both columns are always rendered (even empty) so their fixed width
// is always reserved on both sides - otherwise, whenever the two sides had an uneven number
// of cards (or none at all on one side), the empty side would take up no space and the whole
// main column would visibly drift toward the fuller side instead of staying centered.
function sidebarColumnsHtml(d) {
  const eligible = (f) => f.status === "approved" && f.active !== false;
  const sponsors = d.freelancers.filter((f) => eligible(f) && f.isLeadingBusiness).map((f) => ({ f, listing: null, kind: "sponsor" }));
  const freelancerAds = d.freelancers.filter((f) => eligible(f) && f.isAdvertised && !f.isLeadingBusiness).map((f) => ({ f, listing: null, kind: "ad" }));
  // An additional listing can be advertised on its own, independently of whether her main
  // profile is advertised - so this scans every approved freelancer's additionalListings too.
  const listingAds = [];
  d.freelancers.forEach((f) => {
    if (!eligible(f)) return;
    (f.additionalListings || []).forEach((l) => {
      if (l.status === "approved" && l.isAdvertised) listingAds.push({ f, listing: l, kind: "ad" });
    });
  });
  const combined = [...sponsors, ...freelancerAds, ...listingAds].slice(0, 6);
  const right = combined.filter((_, i) => i % 2 === 0);
  const left = combined.filter((_, i) => i % 2 === 1);
  const cardHtml = (item) => (item.kind === "sponsor" ? sponsorCardHtml(item.f, d) : adCardHtml(item.f, d, item.listing));
  const col = (list, cls) => `
  <div class="side-col ${cls}">
    ${list.length ? list.map(cardHtml).join("") : ""}
  </div>`;
  return col(right, "side-col-right") + col(left, "side-col-left");
}

// noSidebars is used for private back-office screens (admin, freelancer/customer
// dashboards) - the sponsor/ad slots are a public-marketing feature for visitor-facing
// pages, and forcing them into the narrower back-office layouts was pushing those pages'
// own wide content (like the admin freelancers table) past the page edge.
function page({ title, session, body, query, noSidebars }) {
  const d = db.load();
  const searchEngineVisible = d.settings.searchEngineVisible;
  // Whether the logged-in customer/freelancer opted into push notifications (checkbox at
  // signup/join) - drives the quiet auto-subscribe flow in the script block below, since
  // there's no standing "enable notifications" nav button anymore.
  let wantsPush = false;
  if (session && session.role === "customer") {
    const c = d.customers.find((x) => x.id === session.id);
    wantsPush = !!(c && c.wantsPushNotifications);
  } else if (session && session.role === "freelancer") {
    const f = d.freelancers.find((x) => x.id === session.id);
    wantsPush = !!(f && f.wantsPushNotifications);
  }
  const mainHtml = noSidebars
    ? `${flashHtml(query)}${body}`
    : `<div class="page-with-sidebars"><div class="main-col">${flashHtml(query)}${body}</div>${sidebarColumnsHtml(d)}</div>`;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} | SheCan</title>
${searchEngineVisible ? "" : '<meta name="robots" content="noindex, nofollow" />'}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@200;300;400;500;600;700;800&family=Rubik:wght@500;600;700;800;900&family=Assistant:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<!-- Installable-app (PWA) support: manifest + icons + iOS-specific meta tags (iOS Safari
     ignores the manifest for some of this and needs its own tags to behave like an app when
     added to the home screen). -->
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#9a8e81" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="SheCan" />
<style>${CSS}</style>
${d.settings.siteBackgroundImageDataUri ? `<style>body{background-image:url('${d.settings.siteBackgroundImageDataUri}');background-size:cover;background-position:top center;background-repeat:no-repeat;background-attachment:fixed;}</style>` : ""}
</head>
<body>
<a href="#main-content" class="skip-link">דלגי לתוכן הראשי</a>
${nav(session)}
<main id="main-content" tabindex="-1">
<div class="container">
${mainHtml}
</div>
</main>
${footer()}
<div class="sc-lightbox-overlay" id="scLightbox" onclick="scCloseLightbox(event)" role="dialog" aria-label="תצוגת תמונה מוגדלת" aria-modal="true">
  <button type="button" class="sc-lightbox-nav sc-lightbox-prev" id="scLightboxPrev" onclick="scLightboxStep(event,1)" style="display:none;" aria-label="התמונה הקודמת">›</button>
  <img id="scLightboxImg" src="" alt="" />
  <button type="button" class="sc-lightbox-nav sc-lightbox-next" id="scLightboxNext" onclick="scLightboxStep(event,-1)" style="display:none;" aria-label="התמונה הבאה">‹</button>
</div>
<script>
// ---- Make error messages impossible to miss: scroll straight to the error banner and give
// it a brief attention "shake" on load - important on long forms (like the freelancer signup)
// on a phone, where a plain banner at the top can easily go unnoticed if the page doesn't
// happen to load scrolled all the way up. ----
document.addEventListener("DOMContentLoaded", function () {
  var errBanner = document.querySelector(".flash-err");
  if (!errBanner) return;
  errBanner.scrollIntoView({ behavior: "smooth", block: "center" });
  errBanner.classList.add("sc-flash-attention");
  if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
});

// ---- Admin dashboard: make every top-level panel collapsible, collapsed by default, so a
// section with a long list (lots of reviews, lots of pending items) doesn't force scrolling
// past it every time - remembers each panel's open/closed state per browser via localStorage,
// keyed by its title text, so re-opening "מחכות לאישור שלך" once keeps it open on later visits
// until she closes it again. Only runs on pages that actually have a .sc-admin-page wrapper
// (the admin dashboard), so it never touches ordinary .panel cards elsewhere on the site. ----
function scSetupAdminCollapsibles() {
  var root = document.querySelector(".sc-admin-page");
  if (!root) return;
  var panels = root.querySelectorAll(":scope > .panel");
  panels.forEach(function (panel) {
    var h3 = panel.querySelector(":scope > h3");
    if (!h3) return;
    var key = "scAdminPanelOpen:" + h3.textContent.trim();
    var bodyWrap = document.createElement("div");
    bodyWrap.className = "sc-panel-body";
    var node = h3.nextSibling;
    var toMove = [];
    while (node) { toMove.push(node); node = node.nextSibling; }
    toMove.forEach(function (n) { bodyWrap.appendChild(n); });
    panel.appendChild(bodyWrap);
    var toggle = document.createElement("span");
    toggle.className = "sc-panel-toggle";
    h3.appendChild(toggle);
    var isOpen = false;
    try { isOpen = localStorage.getItem(key) === "1"; } catch (e) {}
    function applyState(open) {
      bodyWrap.style.display = open ? "" : "none";
      toggle.textContent = open ? "−" : "+";
    }
    applyState(isOpen);
    h3.addEventListener("click", function () {
      isOpen = !isOpen;
      applyState(isOpen);
      try { localStorage.setItem(key, isOpen ? "1" : "0"); } catch (e) {}
    });
  });
}
document.addEventListener("DOMContentLoaded", scSetupAdminCollapsibles);

var SC_SUBCATS = ${JSON.stringify(subcatsJsMap())};
var SC_CATEGORY_ICONS = ${JSON.stringify(CATEGORY_ICONS)};
var SC_VAPID_PUBLIC_KEY = ${JSON.stringify(VAPID_PUBLIC_KEY)};
var SC_LOGGED_IN = ${JSON.stringify(!!session)};
var SC_WANTS_PUSH = ${JSON.stringify(wantsPush)};
var SC_CITIES = ${JSON.stringify(d.cities.map((c) => ({ id: c.id, name: c.name })))};

// ---- City picker: a searchable text field instead of a giant dropdown (the cities list
// has grown to 100+ entries) - types filter a short suggestion list, click/tap picks one and
// fills the hidden cityId/city field the form actually submits. Falls back gracefully to
// "no city selected" if she types something that doesn't match anything (same as leaving a
// plain <select> on its blank option).
function scSetupCityAutocomplete(wrap) {
  var input = wrap.querySelector(".city-autocomplete-input");
  var hidden = wrap.querySelector(".city-autocomplete-hidden");
  var list = wrap.querySelector(".city-autocomplete-list");
  function renderList(filterText) {
    var f = (filterText || "").trim();
    var matches = f
      ? SC_CITIES.filter(function (c) { return c.name.indexOf(f) !== -1; }).slice(0, 12)
      : SC_CITIES.slice(0, 12);
    if (!matches.length) {
      list.innerHTML = '<div class="city-autocomplete-empty">לא נמצאה עיר תואמת</div>';
    } else {
      list.innerHTML = matches.map(function (c) {
        return '<div class="city-autocomplete-item" data-id="' + c.id + '" data-name="' + c.name.replace(/"/g, "&quot;") + '">' + c.name + "</div>";
      }).join("");
    }
    list.hidden = false;
  }
  input.addEventListener("focus", function () { renderList(input.value); });
  input.addEventListener("input", function () { hidden.value = ""; renderList(input.value); });
  // mousedown (not click) fires before the input's blur, so the tap on a suggestion
  // registers before the list gets hidden - this matters on mobile too, where touches
  // are reported as mousedown/mouseup as well.
  list.addEventListener("mousedown", function (e) {
    var item = e.target.closest(".city-autocomplete-item");
    if (!item || !item.getAttribute("data-id")) return;
    input.value = item.getAttribute("data-name");
    hidden.value = item.getAttribute("data-id");
    list.hidden = true;
  });
  document.addEventListener("click", function (e) {
    if (!wrap.contains(e.target)) list.hidden = true;
  });
}
document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".city-autocomplete").forEach(scSetupCityAutocomplete);
});

// ---- Logo cropper: any <input type="file" data-sc-crop="1"> (freelancer logo uploads, on
// every form that has one - join, dashboard edit, admin on-behalf-of, extra-listing panels)
// opens a small square crop/zoom modal right after a file is picked, instead of uploading the
// raw source image as-is. Fixes logos that look bad in the round/square profile frame because
// the original file is a whole page (e.g. A4) with lots of empty background around the mark.
// Pure canvas + vanilla JS, no libraries - stays in line with the rest of the app.
function scSetupLogoCropper() {
  var CROP_BOX = 280; // on-screen crop square, css px
  var OUT_SIZE = 640; // exported square logo resolution, px
  document.querySelectorAll('input[type="file"][data-sc-crop]').forEach(function (input) {
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () { scOpenCropModal(img, input, CROP_BOX, OUT_SIZE); };
        img.onerror = function () { /* not a readable image - just let the original file upload as-is */ };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  });
}

function scOpenCropModal(img, input, boxSize, outSize) {
  var overlay = document.createElement("div");
  overlay.className = "sc-crop-overlay";
  overlay.innerHTML =
    '<div class="sc-crop-modal">' +
    "<h4>התאימי את הלוגו למסגרת</h4>" +
    '<p class="muted">גררי כדי למקם, השתמשי במחוון כדי להתקרב/להתרחק</p>' +
    '<div class="sc-crop-canvas-wrap"><canvas width="' + boxSize + '" height="' + boxSize + '"></canvas></div>' +
    '<input type="range" class="sc-crop-zoom" min="1" max="3" step="0.01" value="1" />' +
    '<div class="sc-crop-actions">' +
    '<button type="button" class="btn btn-small btn-outline sc-crop-cancel">ביטול</button>' +
    '<button type="button" class="btn btn-small sc-crop-confirm">אישור</button>' +
    "</div>" +
    '<button type="button" class="sc-crop-skip">דלגי והשתמשי בתמונה המקורית כמו שהיא</button>' +
    "</div>";
  document.body.appendChild(overlay);

  var canvas = overlay.querySelector("canvas");
  var ctx = canvas.getContext("2d");
  var zoomSlider = overlay.querySelector(".sc-crop-zoom");
  var baseScale = Math.max(boxSize / img.width, boxSize / img.height);
  var scale = baseScale;
  var offsetX = (boxSize - img.width * scale) / 2;
  var offsetY = (boxSize - img.height * scale) / 2;

  function clampOffsets() {
    var w = img.width * scale, h = img.height * scale;
    var minX = Math.min(0, boxSize - w), maxX = 0;
    var minY = Math.min(0, boxSize - h), maxY = 0;
    offsetX = Math.max(minX, Math.min(maxX, offsetX));
    offsetY = Math.max(minY, Math.min(maxY, offsetY));
  }
  function draw() {
    ctx.clearRect(0, 0, boxSize, boxSize);
    ctx.drawImage(img, offsetX, offsetY, img.width * scale, img.height * scale);
  }
  clampOffsets();
  draw();

  zoomSlider.addEventListener("input", function () {
    var cx = boxSize / 2, cy = boxSize / 2;
    // keep the same point of the image centered under the box while zooming
    var imgX = (cx - offsetX) / scale, imgY = (cy - offsetY) / scale;
    scale = baseScale * parseFloat(zoomSlider.value);
    offsetX = cx - imgX * scale;
    offsetY = cy - imgY * scale;
    clampOffsets();
    draw();
  });

  var dragging = false, lastX = 0, lastY = 0;
  function pointerPos(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }
  function onDown(e) {
    dragging = true;
    var p = pointerPos(e);
    lastX = p.x; lastY = p.y;
  }
  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    var p = pointerPos(e);
    offsetX += p.x - lastX;
    offsetY += p.y - lastY;
    lastX = p.x; lastY = p.y;
    clampOffsets();
    draw();
  }
  function onUp() { dragging = false; }
  var wrap = overlay.querySelector(".sc-crop-canvas-wrap");
  wrap.addEventListener("mousedown", onDown);
  wrap.addEventListener("touchstart", onDown, { passive: true });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);

  function cleanup() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
    overlay.remove();
  }

  overlay.querySelector(".sc-crop-cancel").addEventListener("click", function () {
    input.value = "";
    cleanup();
  });
  overlay.querySelector(".sc-crop-skip").addEventListener("click", function () {
    // leave input.files untouched - the originally-picked file uploads as-is
    cleanup();
  });
  overlay.querySelector(".sc-crop-confirm").addEventListener("click", function () {
    var out = document.createElement("canvas");
    out.width = outSize; out.height = outSize;
    var octx = out.getContext("2d");
    var ratio = outSize / boxSize;
    octx.drawImage(img, offsetX * ratio, offsetY * ratio, img.width * scale * ratio, img.height * scale * ratio);
    out.toBlob(function (blob) {
      if (blob && window.DataTransfer) {
        try {
          var dt = new DataTransfer();
          var origName = (input.files && input.files[0] && input.files[0].name) || "logo.png";
          dt.items.add(new File([blob], origName.replace(/\.[^.]+$/, "") + "-cropped.png", { type: "image/png" }));
          input.files = dt.files;
        } catch (err) { /* unsupported - original file stays as picked */ }
      }
      cleanup();
    }, "image/png");
  });
}
document.addEventListener("DOMContentLoaded", scSetupLogoCropper);

// ---- Installable app (PWA): register the service worker on every page so the site becomes
// installable and can receive push messages even when no tab is open. ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(function(){});
}

// ---- Push notifications: subscribe this browser/device, tell the server about it. ----
function scUrlBase64ToUint8Array(base64String) {
  var padding = "=".repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  var rawData = atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
function scEnablePush(){
  if (!SC_LOGGED_IN || !SC_VAPID_PUBLIC_KEY || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  Notification.requestPermission().then(function(permission){
    if (permission !== "granted") return;
    navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: scUrlBase64ToUint8Array(SC_VAPID_PUBLIC_KEY),
      });
    }).then(function(sub){
      return fetch("/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "subscription=" + encodeURIComponent(JSON.stringify(sub)),
      });
    }).catch(function(){});
  });
}
// There's no standing "enable notifications" button in the nav anymore - instead, she opts in
// with a checkbox at signup/join time (stored on her record as wantsPushNotifications), and
// the very first time she's logged in afterward with that preference set, this quietly runs
// the actual browser subscribe flow once (if this browser doesn't already have a subscription)
// so it stays in sync with what she asked for without needing a button to click.
if (SC_LOGGED_IN && SC_WANTS_PUSH && "serviceWorker" in navigator && "PushManager" in window) {
  navigator.serviceWorker.ready.then(function(reg){
    return reg.pushManager.getSubscription();
  }).then(function(sub){ if (!sub) scEnablePush(); }).catch(function(){});
}

// Both bottom-fixed banners (install-app hint + cookie consent) can in principle want to show
// at the same time (e.g. a first-time iOS visitor sees both) - since they're both position:
// fixed;bottom:0, they'd otherwise render stacked directly on top of each other rather than one
// above the other. This keeps every element carrying the shared class stacked in DOM order
// (earlier elements sit lower, closer to the real bottom of the screen) - called after any of
// them is added or removed.
function scRestackBottomBanners(){
  var banners = Array.prototype.slice.call(document.querySelectorAll(".sc-bottom-banner"));
  var offset = 0;
  banners.forEach(function(el){
    el.style.bottom = offset + "px";
    offset += el.offsetHeight;
  });
}

// ---- "Add to home screen" install banner ----
// Android/Chrome fires beforeinstallprompt and lets us trigger the native install UI directly.
// iOS Safari never fires that event (and has no programmatic install API), so there we show a
// one-time hint instead, explaining the manual "Share -> Add to Home Screen" steps.
(function(){
  var DISMISS_KEY = "scInstallBannerDismissedAt";
  var DISMISS_DAYS = 14;
  function recentlyDismissed(){
    var raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    return (Date.now() - Number(raw)) < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  }
  function isStandalone(){
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  function showBanner(html, onInstallClick){
    if (isStandalone() || recentlyDismissed()) return;
    var el = document.createElement("div");
    el.id = "scInstallBanner";
    el.className = "sc-bottom-banner";
    el.innerHTML = html;
    document.body.appendChild(el);
    scRestackBottomBanners();
    var closeBtn = el.querySelector("[data-sc-dismiss]");
    if (closeBtn) closeBtn.addEventListener("click", function(){
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
      el.remove();
      scRestackBottomBanners();
    });
    var installBtn = el.querySelector("[data-sc-install]");
    if (installBtn && onInstallClick) installBtn.addEventListener("click", onInstallClick);
  }

  var deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", function(e){
    e.preventDefault();
    deferredPrompt = e;
    showBanner(
      '<span>💗 אפשר להתקין את SheCan כאפליקציה על המסך הראשי שלך</span>' +
      '<button type="button" data-sc-install class="btn-arena" style="padding:6px 16px;">התקנה</button>' +
      '<button type="button" data-sc-dismiss aria-label="סגירה" style="background:none;border:none;font-size:18px;cursor:pointer;">✕</button>',
      function(){
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function(){
          deferredPrompt = null;
          var el = document.getElementById("scInstallBanner");
          if (el) el.remove();
          scRestackBottomBanners();
        });
      }
    );
  });

  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos && !isStandalone()) {
    showBanner(
      '<span>💗 כדי להתקין את SheCan כאפליקציה: לחצי על כפתור השיתוף ⬆️ ואז "הוספה למסך הבית"</span>' +
      '<button type="button" data-sc-dismiss aria-label="סגירה" style="background:none;border:none;font-size:18px;cursor:pointer;">✕</button>'
    );
  }
})();

// ---- Cookie consent banner ----
// This site only ever sets the one strictly-necessary session cookie (used to keep you logged
// in) - there are no analytics/advertising/tracking cookies to actually switch on or off. The
// banner still lets you choose, and remembers your choice in this browser via localStorage; it
// doesn't need to be re-shown on every page once you've picked.
(function(){
  var KEY = "scCookieConsent";
  if (localStorage.getItem(KEY)) return;
  var el = document.createElement("div");
  el.id = "scCookieBanner";
  el.className = "sc-bottom-banner";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "הודעת עוגיות");
  el.innerHTML =
    '<span>🍪 אנחנו משתמשים בעוגיות חיוניות בלבד (כמו שמירת ההתחברות שלך) - אין אצלנו עוגיות מעקב או פרסום. אפשר לקרוא עוד ב<a href="/privacy">מדיניות הפרטיות</a>.</span>' +
    '<button type="button" data-sc-cookie-choice="accepted" class="btn-arena" style="padding:6px 16px;">מאשרת</button>' +
    '<button type="button" data-sc-cookie-choice="declined" style="background:none;border:1.5px solid #fff;color:#fff;border-radius:20px;padding:5px 14px;">רק החיוני</button>';
  document.body.appendChild(el);
  if (typeof scRestackBottomBanners === "function") scRestackBottomBanners();
  el.querySelectorAll("[data-sc-cookie-choice]").forEach(function(btn){
    btn.addEventListener("click", function(){
      localStorage.setItem(KEY, btn.getAttribute("data-sc-cookie-choice"));
      el.remove();
      if (typeof scRestackBottomBanners === "function") scRestackBottomBanners();
    });
  });
})();
function scCategoryIcon(name){ return SC_CATEGORY_ICONS[name] || "✨"; }
function scUpdateSubcats(catSelect, subSelect, currentValue){
  if (!subSelect) return;
  var subs = SC_SUBCATS[catSelect.value] || [];
  subSelect.innerHTML = "";
  var optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = subs.length ? "ללא תת-תחום (לא חובה)" : "אין תת-תחומים לתחום הזה";
  subSelect.appendChild(optNone);
  subs.forEach(function(s){
    var opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === currentValue) opt.selected = true;
    subSelect.appendChild(opt);
  });
}
var scLightboxImages = [];
var scLightboxIndex = 0;
function scOpenLightbox(src, allSrcs){
  if (!src) return;
  var overlay = document.getElementById("scLightbox");
  var img = document.getElementById("scLightboxImg");
  if (!overlay || !img) return;
  scLightboxImages = allSrcs && allSrcs.length ? allSrcs : [src];
  scLightboxIndex = scLightboxImages.indexOf(src);
  if (scLightboxIndex < 0) scLightboxIndex = 0;
  img.src = src;
  overlay.style.display = "flex";
  var showNav = scLightboxImages.length > 1;
  var prevBtn = document.getElementById("scLightboxPrev");
  var nextBtn = document.getElementById("scLightboxNext");
  if (prevBtn) prevBtn.style.display = showNav ? "flex" : "none";
  if (nextBtn) nextBtn.style.display = showNav ? "flex" : "none";
}
function scLightboxStep(evt, dir){
  if (evt) evt.stopPropagation();
  if (!scLightboxImages.length) return;
  scLightboxIndex = (scLightboxIndex + dir + scLightboxImages.length) % scLightboxImages.length;
  var img = document.getElementById("scLightboxImg");
  if (img) img.src = scLightboxImages[scLightboxIndex];
}
var scExtraListingCount = 0;
function scAddExtraListing(){
  var box = document.getElementById("scExtraListing" + scExtraListingCount);
  if (!box) return;
  box.style.display = "";
  // The deal-text field for an extra listing is only actually required once she's chosen to
  // fill in that listing - marking it required in the server-rendered HTML unconditionally
  // used to break submission of the WHOLE join form, even for people who never open an extra
  // listing panel at all: a required field inside a display:none box is invisible, so Chrome
  // can't show its validation bubble and silently blocks the submit instead (logged only as an
  // easy-to-miss console warning, "is not focusable" - not shown to the person filling the
  // form). Setting it required here, only once the panel is actually visible, keeps the real
  // validation intact without ever silently blocking signup for anyone who leaves it collapsed.
  var dealField = box.querySelector("textarea[name*='DealText']");
  if (dealField) dealField.required = true;
  // Same reasoning as the deal-text field above: "years in this field" is required, but only
  // once this specific extra-listing panel is actually visible.
  var yearsField = box.querySelector("select[name*='YearsInField']");
  if (yearsField) yearsField.required = true;
  scExtraListingCount++;
  if (scExtraListingCount >= 3) {
    var btn = document.getElementById("scAddExtraListingBtn");
    if (btn) btn.style.display = "none";
  }
}
function scToggleOtherCategory(select, boxId){
  var box = document.getElementById(boxId);
  if (box) box.style.display = (select.value === "__other__") ? "" : "none";
}
function scCloseLightbox(evt){
  if (evt && evt.target && evt.target.id !== "scLightbox") return;
  var overlay = document.getElementById("scLightbox");
  if (overlay) overlay.style.display = "none";
}
function scCopyProfileLink(){
  var input = document.getElementById("scProfileLink");
  if (!input) return;
  input.select();
  input.setSelectionRange(0, 99999);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).catch(function(){ document.execCommand("copy"); });
  } else {
    document.execCommand("copy");
  }
}
function scCopyStoryLink(){
  var input = document.getElementById("scStoryLink");
  if (!input) return;
  input.select();
  input.setSelectionRange(0, 99999);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).catch(function(){ document.execCommand("copy"); });
  } else {
    document.execCommand("copy");
  }
}
// Generic version of the copy-link buttons above, parameterized by input id - used by the
// referral-contest personal links (customer + freelancer) so both can share one function.
function scCopyLink(inputId){
  var input = document.getElementById(inputId);
  if (!input) return;
  input.select();
  input.setSelectionRange(0, 99999);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).catch(function(){ document.execCommand("copy"); });
  } else {
    document.execCommand("copy");
  }
}
// Free, automatic live-filtering of the currently-loaded results grid as she types or
// toggles the "reaches your home" checkbox - no page reload, no need to click a button.
function scLiveFilter(){
  var qInput = document.getElementById("scSearchQ");
  var homeInput = document.getElementById("scHomeVisitFilter");
  var q = qInput ? qInput.value.trim().toLowerCase() : "";
  var homeOnly = homeInput ? homeInput.checked : false;
  var cards = document.querySelectorAll(".card[data-name]");
  var anyVisible = false;
  cards.forEach(function(card){
    var name = card.getAttribute("data-name") || "";
    var category = card.getAttribute("data-category") || "";
    var homeVisit = card.getAttribute("data-home-visit") === "1";
    var textMatch = !q || name.indexOf(q) !== -1 || category.indexOf(q) !== -1;
    var homeMatch = !homeOnly || homeVisit;
    var match = textMatch && homeMatch;
    card.style.display = match ? "" : "none";
    if (match) anyVisible = true;
  });
  var noMatchMsg = document.getElementById("scNoLiveMatch");
  if (noMatchMsg) noMatchMsg.style.display = ((q || homeOnly) && !anyVisible) ? "" : "none";
}
// /search results view-mode switcher (מורחבת/בינונית/קומפקטית) - remembers her last choice
// in this browser via localStorage, so it stays put next time she searches, not just for
// this one page load.
var SC_RESULTS_VIEW_KEY = "scResultsView";
function scSetResultsView(mode){
  var grid = document.getElementById("scCardsGrid");
  if (grid) grid.setAttribute("data-view", mode);
  try { localStorage.setItem(SC_RESULTS_VIEW_KEY, mode); } catch (e) {}
  var btns = document.querySelectorAll(".view-btn");
  for (var i = 0; i < btns.length; i++) {
    var isActive = btns[i].getAttribute("data-view-mode") === mode;
    btns[i].classList.toggle("active", isActive);
  }
}
function scInitResultsView(){
  var grid = document.getElementById("scCardsGrid");
  if (!grid) return;
  var saved = null;
  try { saved = localStorage.getItem(SC_RESULTS_VIEW_KEY); } catch (e) {}
  if (saved) scSetResultsView(saved);
}
function scCloseModal(){
  var overlay = document.getElementById("scWelcomeModal");
  if (overlay) overlay.remove();
}
function scEsc(s){
  var d = document.createElement("div");
  d.innerText = s || "";
  return d.innerHTML;
}
function scReadFileAsDataUrl(input, callback){
  if (!input || !input.files || !input.files[0]) return callback(null);
  var reader = new FileReader();
  reader.onload = function(e){ callback(e.target.result); };
  reader.onerror = function(){ callback(null); };
  reader.readAsDataURL(input.files[0]);
}
function scShowJoinPreview(){
  var form = document.getElementById("scJoinForm");
  if (!form) return;
  var name = form.businessName.value.trim() || "שם העסק שלך";
  var catSelect = form.categoryId;
  var category = (catSelect && catSelect.selectedIndex > 0) ? catSelect.options[catSelect.selectedIndex].text : "";
  if (catSelect && catSelect.value === "__other__" && form.customCategory) category = form.customCategory.value.trim() || category;
  var subSelect = form.subcategoryId;
  var subcat = (subSelect && subSelect.value && subSelect.selectedIndex > 0) ? subSelect.options[subSelect.selectedIndex].text : "";
  if (catSelect && catSelect.value === "__other__" && form.customSubcategory) subcat = form.customSubcategory.value.trim() || subcat;
  var citySelect = form.cityId;
  var city = (citySelect && citySelect.selectedIndex > 0) ? citySelect.options[citySelect.selectedIndex].text : "";
  var dealText = form.dealText.value.trim() || "ההטבה שתבחרי תופיע כאן";
  var tier = form.tier ? form.tier.value : "basic";
  var icon = scCategoryIcon(category);
  scReadFileAsDataUrl(form.logo, function(logoUrl){
      var avatarUrl = logoUrl;
      var avatarHtml = avatarUrl
        ? '<div class="card-photo" style="background-image:url(' + avatarUrl + ');background-size:cover;background-position:center;"></div>'
        : '<div class="card-photo">' + scEsc(name.charAt(0) || "?") + '</div>';
      var badges = [];
      if (tier === "premium") badges.push('<span class="badge">מומלצת</span>');
      var html = '<div class="card" style="max-width:260px;">' + avatarHtml +
        '<div class="card-body">' +
        '<h3>' + scEsc(name) + '</h3>' +
        '<div class="card-divider"><span class="heart-dot">♥</span></div>' +
        '<div class="sc-card-sub" style="display:flex;align-items:center;gap:6px;justify-content:center;"><span>' + icon + '</span><span>' + scEsc(subcat || category || "התחום שלך") + '</span></div>' +
        '<div class="muted" style="display:flex;align-items:center;gap:6px;justify-content:center;"><span>📍</span><span>' + scEsc(city) + '</span></div>' +
        (badges.length ? '<div class="card-badges">' + badges.join(" ") + '</div>' : "") +
        '<div class="deal-box">🎁 ' + scEsc(dealText) + '</div></div></div>';
      var holder = document.getElementById("scPreviewCardHolder");
      if (holder) holder.innerHTML = html;
      var modal = document.getElementById("scPreviewModal");
      if (modal) modal.style.display = "flex";
  });
}
function scClosePreview(){
  var modal = document.getElementById("scPreviewModal");
  if (modal) modal.style.display = "none";
}
function scConfirmJoinSubmit(){
  var form = document.getElementById("scJoinForm");
  if (form) form.submit();
}
function scRevealCoupon(id, btn, listingId){
  var el = document.getElementById(listingId ? ("scCoupon-" + id + "-" + listingId) : ("scCoupon-" + id));
  if (el) el.style.display = "block";
  if (btn) btn.style.display = "none";
  var body = listingId ? ("listingId=" + encodeURIComponent(listingId)) : "";
  fetch("/freelancer/" + id + "/reveal-coupon", { method: "POST", body: body }).catch(function(){});
}
// Turns each ".sc-star-input" widget (a row of star spans plus a hidden "rating" input)
// into a clickable rating picker - runs immediately since this script tag sits at the end
// of the body, so every star widget already exists in the DOM by the time this executes.
function scInitStarInputs(){
  var groups = document.querySelectorAll(".sc-star-input");
  for (var i = 0; i < groups.length; i++) {
    (function(group){
      var stars = group.querySelectorAll(".sc-star");
      var hidden = group.querySelector("input[type=hidden]");
      function render(v){
        for (var j = 0; j < stars.length; j++) {
          var sv = Number(stars[j].getAttribute("data-v"));
          stars[j].classList.toggle("sc-star-filled", sv <= v);
          stars[j].textContent = sv <= v ? "★" : "☆";
        }
      }
      for (var k = 0; k < stars.length; k++) {
        (function(star){
          star.addEventListener("click", function(){
            var v = Number(star.getAttribute("data-v"));
            if (hidden) hidden.value = v;
            render(v);
          });
        })(stars[k]);
      }
    })(groups[i]);
  }
}
scInitStarInputs();
scInitResultsView();

// ---- highlight the nav link matching the current page, with the exact same styling as
// its own :hover state (see the .nav-active CSS rules riding along each nav-link selector) ----
function scInitNavActive(){
  var path = window.location.pathname.replace(/\\/+$/, "") || "/";
  var links = document.querySelectorAll(".main-nav .nav-link");
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute("href");
    if (!href) continue;
    var linkPath = href.replace(/\\/+$/, "") || "/";
    var isMatch = linkPath === "/" ? path === "/" : (path === linkPath || path.indexOf(linkPath + "/") === 0);
    if (isMatch) links[i].classList.add("nav-active");
  }
}
scInitNavActive();

// ---- admin panel: simple client-side search over the "העצמאיות שכבר איתנו" table ----
function scFilterAdminFreelancers(q){
  var table = document.getElementById("scActiveFreelancersTable");
  if (!table) return;
  var query = (q || "").trim().toLowerCase();
  var rows = table.querySelectorAll("tr");
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.querySelector("th")) continue;
    var text = row.textContent.toLowerCase();
    row.style.display = (!query || text.indexOf(query) !== -1) ? "" : "none";
  }
}

// ---- "הזירה" - toggle showing/hiding the answers under an arena question ----
function scArenaToggle(id, btn){
  var el = document.getElementById(id);
  if (!el) return;
  var show = el.style.display !== "block";
  el.style.display = show ? "block" : "none";
  btn.textContent = show ? btn.getAttribute("data-hide") : btn.getAttribute("data-show");
}
// ---- "הזירה" - 3 big tab buttons instead of all 3 sections stacked and visible at once.
// Only one section shows at a time, opened by clicking its button; nothing is open by default
// unless a deep link (hash anchor from a poll/consultation redirect, or a ?tab= query param
// set after submitting one of the forms) says otherwise. ----
function scArenaShowTab(n, btn){
  for (var i = 1; i <= 3; i++) {
    var sec = document.getElementById("arenaTab" + i);
    if (sec) sec.style.display = (i === n) ? "block" : "none";
  }
  var btns = document.querySelectorAll(".arena-tab-btn");
  for (var j = 0; j < btns.length; j++) btns[j].classList.remove("active");
  var activeBtn = btn || btns[n - 1];
  if (activeBtn) activeBtn.classList.add("active");
}
(function(){
  if (!document.getElementById("arenaTab1")) return; // not on the arena page
  var hash = window.location.hash || "";
  var tab = null;
  if (hash.indexOf("#consultation-") === 0) tab = 2;
  else if (hash.indexOf("#poll-") === 0) tab = 3;
  else {
    var qsTab = new URLSearchParams(window.location.search).get("tab");
    if (qsTab) tab = Number(qsTab);
  }
  if (tab >= 1 && tab <= 3) {
    scArenaShowTab(tab);
    if (hash) {
      setTimeout(function(){
        var el = document.querySelector(hash);
        if (el) el.scrollIntoView({ block: "center" });
      }, 60);
    }
  }
})();
// Copies a poll's share link to the clipboard when the "העתקת קישור" button is clicked.
function scArenaCopyLink(id, btn){
  var el = document.getElementById(id);
  if (!el) return;
  var text = el.textContent || el.innerText;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function(){
      var original = btn.textContent;
      btn.textContent = "הקישור הועתק!";
      setTimeout(function(){ btn.textContent = original; }, 1800);
    }).catch(function(){});
  }
}

// ---- Accessibility toolbar: font size, high contrast, underline links, stop animations ----
// Preferences persist across full page loads via localStorage (this site has no SPA/in-memory
// state, so localStorage - not an in-memory variable - is the correct persistence choice here).
(function(){
  var STORE_KEY = "scA11yPrefs";
  function loadPrefs(){
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function savePrefs(p){
    try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) {}
  }
  var prefs = Object.assign({ fontStep: 0, contrast: false, underline: false, noAnim: false }, loadPrefs());

  function apply(){
    var root = document.documentElement;
    root.style.fontSize = (19 + prefs.fontStep * 2) + "px";
    document.body.classList.toggle("sc-a11y-contrast", !!prefs.contrast);
    document.body.classList.toggle("sc-a11y-underline", !!prefs.underline);
    document.body.classList.toggle("sc-a11y-noanim", !!prefs.noAnim);
    var fontLabel = document.getElementById("scA11yFontLabel");
    if (fontLabel) fontLabel.textContent = "גודל טקסט: " + (100 + prefs.fontStep * 10) + "%";
    ["scA11yContrastBtn","scA11yUnderlineBtn","scA11yAnimBtn"].forEach(function(id){
      var btn = document.getElementById(id);
      if (btn) btn.setAttribute("aria-pressed", id === "scA11yContrastBtn" ? !!prefs.contrast : id === "scA11yUnderlineBtn" ? !!prefs.underline : !!prefs.noAnim);
    });
  }

  window.scA11yFont = function(delta){
    prefs.fontStep = Math.max(-2, Math.min(5, prefs.fontStep + delta));
    savePrefs(prefs); apply();
  };
  window.scA11yFontReset = function(){
    prefs.fontStep = 0; savePrefs(prefs); apply();
  };
  window.scA11yToggle = function(key){
    prefs[key] = !prefs[key]; savePrefs(prefs); apply();
  };
  window.scA11yTogglePanel = function(){
    var panel = document.getElementById("scA11yPanel");
    if (!panel) return;
    var open = panel.style.display !== "none";
    panel.style.display = open ? "none" : "block";
    var btn = document.getElementById("scA11yToggleBtn");
    if (btn) btn.setAttribute("aria-expanded", String(!open));
  };

  apply();
})();
</script>
<div class="sc-a11y-widget">
  <button type="button" id="scA11yToggleBtn" class="sc-a11y-toggle" onclick="scA11yTogglePanel()" aria-haspopup="true" aria-expanded="false" aria-controls="scA11yPanel" aria-label="אפשרויות נגישות">
    <span aria-hidden="true">♿</span>
  </button>
  <div id="scA11yPanel" class="sc-a11y-panel" style="display:none;" role="region" aria-label="אפשרויות נגישות">
    <div id="scA11yFontLabel" style="font-weight:700;margin-bottom:6px;">גודל טקסט: 100%</div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button type="button" onclick="scA11yFont(-1)" aria-label="הקטני טקסט">א-</button>
      <button type="button" onclick="scA11yFontReset()" aria-label="אפס גודל טקסט">איפוס</button>
      <button type="button" onclick="scA11yFont(1)" aria-label="הגדילי טקסט">א+</button>
    </div>
    <button type="button" id="scA11yContrastBtn" class="sc-a11y-row-btn" onclick="scA11yToggle('contrast')" aria-pressed="false">ניגודיות גבוהה</button>
    <button type="button" id="scA11yUnderlineBtn" class="sc-a11y-row-btn" onclick="scA11yToggle('underline')" aria-pressed="false">הדגשת קישורים</button>
    <button type="button" id="scA11yAnimBtn" class="sc-a11y-row-btn" onclick="scA11yToggle('noAnim')" aria-pressed="false">עצירת אנימציות</button>
    <a href="/accessibility" class="sc-a11y-row-btn" style="display:block;text-align:center;text-decoration:none;">הצהרת נגישות</a>
  </div>
</div>
</body>
</html>`;
}

module.exports = { page, esc, categoryIcon, cityAutocompleteHtml };
