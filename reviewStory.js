// Builds a personalized "I'm on SheCan!" printable review-request image, meant to be attached
// to a freelancer's approval email so she can print it and stick it up at her business - a
// customer scans the code (or uses the link as a backup) and lands straight on her review
// form. Replaces the older PDF-based flyer (see the removed flyer.js integration in
// server.js) now that Sapir supplied this nicer, on-brand template for the exact same purpose.
// Structurally a near-twin of joinStory.js - same template-image + QR + link compositing
// approach, same Playwright/Chromium exception already justified there - just a different
// template image and a QR that points at the review anchor instead of the bare profile.
const fs = require("fs");
const path = require("path");

const TEMPLATE_PATH = path.join(__dirname, "assets", "review-story-bg.jpg");
let templateDataUri = null;
try {
  templateDataUri = `data:image/jpeg;base64,${fs.readFileSync(TEMPLATE_PATH).toString("base64")}`;
} catch (e) {
  console.warn("[review-story] missing template file at assets/review-story-bg.jpg - the review-story image feature will be skipped.");
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Template is 1124x1999px, same as join-story's, but this one's body text is a couple of lines
// shorter, leaving less blank room below it - "סרקי את הקוד" ends ~y=1030 and the
// "SheCan.co.il" wordmark starts ~y=1855, measured directly off this template image.
function reviewStoryHtml({ qrDataUrl, reviewUrl }) {
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
    position: absolute; top: 1130px; left: 50%; transform: translateX(-50%);
    background:#fff; border-radius:28px; padding:34px;
    box-shadow: 0 10px 34px rgba(93,94,86,.16);
  }
  .qr-wrap img { display:block; width:380px; height:380px; }
  .link-pill {
    position: absolute; top: 1630px; left: 50%; transform: translateX(-50%);
    max-width: 900px;
    background: rgba(255,255,255,.7); border-radius:16px; padding: 14px 28px;
    font-size: 24px; font-weight: 700; color: #5D5E56; text-align:center;
    direction: ltr;
  }
</style>
</head>
<body>
  <div class="qr-wrap"><img src="${qrDataUrl}" /></div>
  <div class="link-pill">${escHtml(reviewUrl)}</div>
</body>
</html>`;
}

async function buildReviewStoryImageBuffer({ qrDataUrl, reviewUrl }) {
  if (!templateDataUri) throw new Error("review-story template missing");
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1124, height: 1999 } });
    await page.setContent(reviewStoryHtml({ qrDataUrl, reviewUrl }), { waitUntil: "load" });
    const pngBuffer = await page.screenshot({ type: "png" });
    return pngBuffer;
  } finally {
    await browser.close();
  }
}

module.exports = { buildReviewStoryImageBuffer };
