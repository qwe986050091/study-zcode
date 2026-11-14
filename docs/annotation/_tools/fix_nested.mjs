import fs from 'node:fs';

const target = process.argv[2];
const text = fs.readFileSync(target, 'utf8');
const lines = text.split('\n');
let fixed = 0;
const out = lines.map((line) => {
  const m = line.match(/^(\s*)\/\/\s+\/\/\s?(.*)$/);
  if (m) {
    fixed += 1;
    return `${m[1]}// ${m[2]}`;
  }
  return line;
});
fs.writeFileSync(target, out.join('\n'), 'utf8');
console.log(`fixed=${fixed}`);
