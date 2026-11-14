import fs from 'node:fs';

const root = 'D:/code/ZCode';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b59-spec-03.json';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const target = spec.files[0];
const src = fs.readFileSync(`${root}/${target.file}`, 'utf8').split(/\r?\n/);

let total = 0;
const problems = [];
const bannedStart = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;

for (const item of target.items) {
  const anchor = String(item.anchor).trim();
  const hits = [];
  for (let i = 0; i < src.length; i++) if (src[i].trim() === anchor) hits.push(i);
  const nth = item.nth || 1;
  if (item.nth) {
    if (hits.length < nth) problems.push(`anchor nth out of range (${hits.length} < ${nth}): ${anchor}`);
  } else if (hits.length !== 1) {
    problems.push(`anchor not unique (${hits.length}): ${anchor}`);
  }

  const lines = item.raw ? item.raw : item.lines.map((t) => (t === '' ? '//' : '// ' + t));
  total += lines.length;
  for (const l of lines) {
    if (!l.trim().startsWith('//')) problems.push(`not comment line: ${l}`);
    if (l.includes('*/')) problems.push(`contains */: ${l}`);
    const body = l.replace(/^\s*\/\/\s?/, '');
    if (body && bannedStart.test(body)) problems.push(`banned start: ${body}`);
    if (/;\s*$/.test(body)) problems.push(`ends with ;: ${body}`);
    if (body.includes('=>')) problems.push(`contains =>: ${body}`);
    if (/[A-Za-z0-9_$]\.[A-Za-z0-9_$]+\s*\(/.test(body)) problems.push(`call form: ${body}`);
  }
}

const invCount = target.items[0].raw.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
console.log(`items=${target.items.length}`);
console.log(`totalLines=${total}`);
console.log(`headerLines=${target.items[0].raw.length} INV=${invCount}`);
console.log(problems.length ? `FAIL\n${problems.join('\n')}` : 'PASS: all checks ok');
if (total < 68 || total > 70) console.log(`FAIL: total lines ${total} not in 68..70`);
if (invCount < 18 || invCount > 20) console.log(`FAIL: INV count ${invCount} not in 18..20`);
