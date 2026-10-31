// One-shot migration: rewrite the old orange/navy literals that were hard-coded
// in components (instead of using theme tokens) to the neon palette.
//
// These are exactly the values the theme registry cannot follow, because a bare
// literal is linked to no token: it is frozen at whatever it said when it was
// typed. Replacing them here is a one-time mechanical edit, not a runtime hack.
const fs = require('fs');
const path = require('path');

const MAP = [
  // accent (orange -> electric violet)
  ['#FF9D1F', '#C13BFF'],
  ['#FF7A00', '#E52BFF'],
  ['rgba(255,157,31,', 'rgba(193,59,255,'],
  ['rgba(255,122,0,', 'rgba(229,43,255,'],
  ['rgba(255, 157, 31,', 'rgba(193,59,255,'],
  ['rgba(255, 122, 0,', 'rgba(229,43,255,'],
  // verified badge glow
  ['#FFB02E', '#22D3EE'],
  // secondary violet
  ['#8B7BFF', '#8B5CF6'],
  // the old palette values that were pasted into styles by hand
  ['#0D1426', '#0C1030'],
  ['#141C33', '#141A47'],
  ['#0B1224', '#0A0E28'],
  ['#0A101F', '#0A0E26'],
  ['#1E2A47', '#1E2466'],
  ['#2C3B61', '#2F3798'],
  ['#060A16', '#06070F'],
  ['#04070F', '#03040A'],
  ['rgba(20,28,51,1)', 'rgba(21,26,70,1)'],
  ['rgba(30,42,71,1)', 'rgba(47,55,152,1)'],
];

const root = path.join(__dirname, '..', 'src');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(root);

let touched = 0;
let total = 0;
for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  let after = before;
  const hits = {};
  for (const [from, to] of MAP) {
    const n = after.split(from).length - 1;
    if (n) {
      hits[from] = n;
      total += n;
      after = after.split(from).join(to);
    }
  }
  if (after !== before) {
    fs.writeFileSync(f, after, 'utf8');
    touched++;
    console.log(path.relative(root, f), JSON.stringify(hits));
  }
}
console.log(`\n${total} literals replaced across ${touched} files`);
