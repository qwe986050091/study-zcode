import fs from 'node:fs';

const p = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
let inSnap = false;
const cands = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (inSnap) {
    if (t === '"' || t === '");' || t === '"#' || t === '"#);' || /^"#\);?$/.test(t) || /^"\);?$/.test(t)) inSnap = false;
    continue;
  }
  if (t.includes('@r#"') || (t.includes('@"') && !/@"[^"]*"$/.test(t))) {
    inSnap = true;
    continue;
  }
  if (/^(let |assert_|assert\(|assert!|#\[test\]|fn |pub fn |impl |struct |enum |use |mod |\}|match |for |if |return |Self \{|\])/.test(t)) {
    cands.push(i + 1);
  }
}
console.log('candidates', cands.length);
console.log(cands.slice(0, 40).join(','));
