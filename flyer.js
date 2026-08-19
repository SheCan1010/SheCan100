// Builds the print-ready "scan me for a review" flyer PDF attached to a freelancer's
// approval email (see POST /admin/freelancer/:id/approve in server.js), per explicit request.
//
// Why headless Chromium (Playwright) instead of hand-building a PDF: the flyer's fixed
// marketing text mixes Hebrew (right-to-left) with the Latin "SheCan" and a ":)" emoticon in
// the middle of the sentence - correctly laying that out (plus wrapping it across lines) needs
// real Unicode bidi + text shaping, which a browser engine already does perfectly for free via
// normal HTML/CSS (dir="rtl"), instead of us hand-rolling bidi/wrap logic against a raw PDF
// library. Rendering real HTML also lets the flyer reuse the site's own pattern.js background
// byte-for-byte, so it's visually on-brand with zero extra design assets.
//
// This is the one deliberate exception to the app's zero-npm-dependency design (needs the
// `playwright` package + its Chromium browser available at runtime - see package.json and the
// README note next to it about the one-time Render build-command change this requires). If
// Chromium isn't available yet (e.g. Sapir hasn't updated the Render build command), building
// the PDF just throws and the caller catches it - the approval email still goes out, only
// without this attachment - so this can never block or break approving a freelancer.
const { patternDataUri } = require("./pattern");

const FLYER_FILE_TITLE = "קוד QR להדפסה לעסק - לסריקת לקוחות";
const FLYER_QUOTE = "גם העסק שלי נמצא בSheCan. אהבת את השירות שלי? אשמח שתפרגני לי שם :) . גם תמונה לא תזיק";

function flyerHtml({ qrDataUrl, businessName }) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin:0; padding:0; }
  body {
    width: 794px; height: 1123px; /* A4 @ 96dpi */
    font-family: "Heebo","Assistant","Rubik","Segoe UI","Arial",sans-serif;
    background-color: #F3EDE8;
    background-image: url("${patternDataUri()}");
    background-repeat: repeat;
    display:flex; align-items:center; justify-content:center;
    box-sizing: border-box;
  }
  .card {
    width: 640px;
    background: #FBF8F4;
    border: 2px solid #c1b2a1;
    border-radius: 28px;
    box-shadow: 0 10px 40px rgba(0,0,0,.12);
    padding: 50px 54px;
    text-align: center;
    box-sizing: border-box;
  }
  .kicker { font-size:14px; font-weight:700; color:#9a8e81; letter-spacing:.3px; margin:0 0 26px; }
  .brand { font-size:36px; font-weight:800; color:#5D5E56; margin:0 0 8px; }
  .business-name { font-size:17px; font-weight:600; color:#9a8e81; margin:0 0 22px; }
  .quote { font-size:22px; font-weight:700; color:#5D5E56; line-height:1.75; margin:0 0 34px; }
  .qr-wrap { background:#fff; border-radius:20px; padding:22px; display:inline-block; box-shadow:0 4px 16px rgba(0,0,0,.08); }
  .qr-wrap img { display:block; width:280px; height:280px; }
  .scan-hint { font-size:16px; font-weight:700; color:#9a8e81; margin-top:22px; }
</style>
</head>
<body>
  <div class="card">
    <p class="kicker">${FLYER_FILE_TITLE}</p>
    <p class="brand">SheCan 🌸</p>
    ${businessName ? `<p class="business-name">${businessName}</p>` : ""}
    <p class="quote">${FLYER_QUOTE}</p>
    <div class="qr-wrap"><img src="${qrDataUrl}" /></div>
    <p class="scan-hint">📷 סרקי אותי עם מצלמת הטלפון</p>
  </div>
</body>
</html>`;
}

// Escapes the one piece of dynamic, freelancer-controlled text that gets interpolated into the
// HTML (her business name) - a minimal inline escaper so flyer.js doesn't need to import
// server.js's esc() (which would create a circular require).
function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function buildFlyerPdfBuffer({ qrDataUrl, businessName }) {
  const { chromium } = require("playwright");
  // Same memory-saving flags as joinStory.js/reviewStory.js (not currently called from
  // server.js, but kept consistent in case that changes) - see joinStory.js's comment for why.
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--no-zygote"] });
  try {
    const page = await browser.newPage();
    await page.setContent(flyerHtml({ qrDataUrl, businessName: escHtml(businessName) }), { waitUntil: "load" });
    const pdfBuffer = await page.pdf({ width: "794px", height: "1123px", printBackground: true });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

module.exports = { buildFlyerPdfBuffer, FLYER_FILE_TITLE, FLYER_QUOTE };
