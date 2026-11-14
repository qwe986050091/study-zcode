import fs from 'node:fs';
const files = process.argv.slice(2);
const ROOT = 'd:/code/opensource/langgraph';
for (const rel of files) {
  const raw = fs.readFileSync(`${ROOT}/${rel}`, 'utf8');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let blank = 0, comment = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') blank++;
    else if (t.startsWith('#')) comment++;
  }
  const code = lines.length - blank - comment;
  console.log(`${rel} total=${lines.length} comment=${comment} code=${code} density=${(comment / code * 100).toFixed(2)}% need30=${Math.max(0, Math.ceil(code * 0.3) - comment)} need32=${Math.max(0, Math.ceil(code * 0.32) - comment)}`);
}
