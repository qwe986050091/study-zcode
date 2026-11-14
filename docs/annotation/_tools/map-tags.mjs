import fs from 'node:fs';

const p = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
let inSnap = false;
for (let i = 1272; i < lines.length; i++) {
  const t = lines[i].trim();
  if (inSnap) {
    if (/^"#\);$/.test(t) || /^"\);$/.test(t) || t === '"#' || t === '"') inSnap = false;
    continue;
  }
  if (t.includes('@r#"') || (t.includes('@"') && !/@"[^"]*"$/.test(t))) {
    inSnap = true;
    continue;
  }
  if (/^(let |assert_|#\[test\]|fn |\/\/\/|use |mod )/.test(t)) {
    console.log(i + 1, t.slice(0, 100));
  }
}
