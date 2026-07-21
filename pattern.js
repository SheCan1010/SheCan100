// Subtle scattered "feminine line-art" background pattern, inspired by the SheCan logo artwork.
// Built as plain SVG shapes (no external assets/network needed) and exposed as a data-URI
// so it can be dropped straight into a CSS background-image.

const ROSE = "#C89985";

const ICONS = {
  lipstick: `<g><rect x="-3" y="-14" width="6" height="10" rx="1.5"/><path d="M-3 -4 L-4 6 Q0 10 4 6 L3 -4 Z"/></g>`,
  heel: `<g fill="none"><path d="M-8 6 L-8 -2 Q-8 -8 -2 -9 L7 -9 L7 -4 L1 -2 Q3 3 9 4 L9 6 Z"/></g>`,
  glasses: `<g fill="none"><circle cx="-7" cy="0" r="6"/><circle cx="7" cy="0" r="6"/><path d="M-1 0 H1"/><path d="M-13 -1 L-16 -3"/><path d="M13 -1 L16 -3"/></g>`,
  bag: `<g fill="none"><rect x="-9" y="-4" width="18" height="14" rx="2"/><path d="M-5 -4 V-8 Q-5 -12 0 -12 Q5 -12 5 -8 V-4"/></g>`,
  flower: `<g><ellipse cx="0" cy="-7" rx="3.4" ry="5"/><ellipse cx="0" cy="7" rx="3.4" ry="5"/><ellipse cx="-7" cy="0" rx="5" ry="3.4"/><ellipse cx="7" cy="0" rx="5" ry="3.4"/><circle cx="0" cy="0" r="2.6" fill="#fff"/></g>`,
  camera: `<g fill="none"><rect x="-11" y="-6" width="22" height="15" rx="2"/><path d="M-5 -6 L-3 -9 H3 L5 -6"/><circle cx="0" cy="1" r="4.5"/></g>`,
  ring: `<g fill="none"><circle cx="0" cy="3" r="7"/><path d="M-3 -4 L0 -10 L3 -4 Z"/></g>`,
  nail: `<g><rect x="-3.5" y="-11" width="7" height="5" rx="1"/><path d="M-3.5 -6 L-4.5 9 Q0 12 4.5 9 L3.5 -6 Z"/></g>`,
  bow: `<g><path d="M0 0 L-10 -6 L-10 6 Z"/><path d="M0 0 L10 -6 L10 6 Z"/><circle cx="0" cy="0" r="2.6"/></g>`,
  heart: `<g><path d="M0 6 C-8 -1 -9 -8 -3 -9 C0 -9.5 0 -6 0 -6 C0 -6 0 -9.5 3 -9 C9 -8 8 -1 0 6 Z"/></g>`,
  sparkle: `<g><path d="M0 -9 Q1 -1 9 0 Q1 1 0 9 Q-1 1 -9 0 Q-1 -1 0 -9 Z"/></g>`,
  monogram: `<text x="-7" y="4" font-family="Georgia, serif" font-size="11" font-style="italic">SC</text>`,
};

// hand-placed layout: [icon, x, y, rotation, scale, opacity]
const LAYOUT = [
  ["lipstick", 60, 70, -15, 1, 0.5],
  ["heel", 230, 40, 8, 1, 0.4],
  ["glasses", 400, 90, -5, 1, 0.45],
  ["bag", 560, 50, 10, 0.9, 0.4],
  ["flower", 100, 220, 0, 1, 0.45],
  ["camera", 300, 210, 6, 0.9, 0.4],
  ["sparkle", 470, 230, 0, 0.8, 0.5],
  ["monogram", 30, 300, -8, 1, 0.35],
  ["ring", 210, 320, 0, 0.9, 0.4],
  ["nail", 370, 330, 12, 1, 0.45],
  ["heart", 540, 300, 0, 0.9, 0.45],
  ["bow", 660, 180, -10, 0.9, 0.4],
  ["lipstick", 680, 340, 20, 0.8, 0.35],
  ["glasses", 40, 420, 6, 0.85, 0.4],
  ["flower", 620, 60, 15, 0.8, 0.4],
  ["heel", 470, 400, -18, 0.85, 0.4],
  ["sparkle", 150, 130, 0, 0.6, 0.4],
  ["monogram", 610, 420, 10, 0.9, 0.3],
  ["bag", 260, 430, -6, 0.8, 0.35],
  ["camera", 30, 150, -10, 0.7, 0.35],
];

function buildSvg() {
  const groups = LAYOUT.map(([icon, x, y, r, s, o]) =>
    `<g transform="translate(${x},${y}) rotate(${r}) scale(${s})" fill="${ROSE}" stroke="${ROSE}" stroke-width="1.4" opacity="${o}">${ICONS[icon]}</g>`
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480" viewBox="0 0 720 480">${groups}</svg>`;
}

function patternDataUri() {
  const svg = buildSvg();
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

module.exports = { patternDataUri };
