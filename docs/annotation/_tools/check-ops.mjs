import fs from 'node:fs';
const REPO = 'd:\\code\\opensource\\valkey\\';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let bad = 0;
for (const item of spec) {
  const lines = fs.readFileSync(REPO + item.file.split('/').join('\\'), 'utf8').split(/\r?\n/);
  for (const op of item.ops) {
    const cur = lines[op.line - 1];
    if (cur === undefined || cur.trim() !== op.expect) {
      bad++;
      console.log(`MISMATCH ${item.file}:${op.line}\n  expect: ${JSON.stringify(op.expect)}\n  actual: ${JSON.stringify(cur)}`);
    }
  }
}
console.log(bad === 0 ? 'ALL MATCH' : `BAD=${bad}`);
process.exit(bad ? 1 : 0);
