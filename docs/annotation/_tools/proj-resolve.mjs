import fs from 'node:fs';

const p = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const s = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const starts = [];
s.forEach((l, i) => {
  if (/^\s*ProjectCommand::\w+\(/.test(l)) starts.push(i);
});
for (const st of starts) {
  for (let j = st; j < st + 14 && j < s.length; j++) {
    if (/Settings::resolve\(/.test(s[j])) {
      console.log(`${st + 1} | ${s[st].trim()} | ${j + 1}: ${s[j].trim().slice(0, 90)}`);
      break;
    }
  }
}
