// Builds a personalized "I joined SheCan!" Instagram-story-style image, meant to be attached
// to a freelancer's approval email so she can post it straight to her own story/feed once her
// profile is actually live (see POST /admin/freelancer/:id/approve in server.js). The base
// design (title, blurb, and the site's own scattered-icon background pattern) was supplied by
// Sapir as a ready-made template with a deliberate blank area left in the middle - this module
// fills that blank area in with her personal QR code + profile link, per explicit request.
//
// Same "why headless Chromium" reasoning as flyer.js: this needs a QR image composited on top
// of a JPEG background with crisp centered text, which a browser lays out correctly for free.
// It reuses the very same Playwright dependency/exception already justified there - no new
// dependency is added by this file.
const fs = require("fs");
const path = require("path");

const TEMPLATE_PATH = path.join(__dirname, "assets", "join-story-bg.jpg");
// Read once at boot and cache as a data URI (small, static, never changes at runtime) - same
// preload-once pattern used for the PWA icon files in server.js.
let templateDataUri = null;
try {
  templateDataUri = `data:image/jpeg;base64,${fs.readFileSync(TEMPLATE_PATH).toString("base64")}`;
} catch (e) {
  console.warn("[join-story] missing template file at assets/join-story-bg.jpg - the join-story image feature will be skipped.");
}

// Escapes the one piece of dynamic, freelancer-controlled text interpolated into the HTML
// (her profile link, which is server-built and safe, but escaped anyway on principle) - a
// minimal inline escaper so this file doesn't need to import server.js's esc() (circular
// require otherwise).
function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Template is 1124x1999px. The blank area Sapir left for this sits roughly between the
// "סרקי את הקוד..." line (ends ~y=760) and the "SheCan.co.il" wordmark (starts ~y=1860) -
// measured directly off the template image.
function joinStoryHtml({ qrDataUrl, profileUrl }) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin:0; padding:0; }
  body {
    width: 1124px; height: 1999px;
    font-family: "Heebo","Assistant","Rubik","Segoe UI","Arial",sans-serif;
    background-image: url("${templateDataUri}");
    background-size: 1124px 1999px;
    position: relative;
    box-sizing: border-box;
  }
  .qr-wrap {
    position: absolute; top: 860px; left: 50%; transform: translateX(-50%);
    background:#fff; border-radius:28px; padding:34px;
    box-shadow: 0 10px 34px rgba(93,94,86,.16);
  }
  .qr-wrap img { display:block; width:380px; height:380px; }
  .link-pill {
    position: absolute; top: 1360px; left: 50%; transform: translateX(-50%);
    max-width: 900px;
    background: rgba(255,255,255,.7); border-radius:16px; padding: 14px 28px;
    font-size: 24px; font-weight: 700; color: #5D5E56; text-align:center;
    direction: ltr;
  }
</style>
</head>
<body>
  <div class="qr-wrap"><img src="${qrDataUrl}" /></div>
  <div class="link-pill">${escHtml(profileUrl)}</div>
</body>
</html>`;
}

async function buildJoinStoryImageBuffer({ qrDataUrl, profileUrl }) {
  if (!templateDataUri) throw new Error("join-story template missing");
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1124, height: 1999 } });
    await page.setContent(joinStoryHtml({ qrDataUrl, profileUrl }), { waitUntil: "load" });
    const pngBuffer = await page.screenshot({ type: "png" });
    return pngBuffer;
  } finally {
    await browser.close();
  }
}

module.exports = { buildJoinStoryImageBuffer };
