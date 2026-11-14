import fs from 'node:fs';

const SPEC = 'd:/code/_annot_baseline/ZC-deep-b58-spec-08.json';
const ROOT = 'D:/code/ZCode';
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const FORBIDDEN_HEAD = ['const','let','var','function','class','import','export','return','if','else','for','while','switch','try','catch','await','async','throw','new','interface','type','enum'];

let errors = 0;
const fail = (m) => { errors++; console.log('[FAIL] ' + m); };

for (const f of spec.files) {
  if (f.file.startsWith('ZCode/') || f.file.startsWith('D:') || f.file.includes('\\')) fail('bad file path: ' + f.file);
  const abs = ROOT + '/' + f.file;
  const raw = fs.readFileSync(abs, 'utf8');
  const srcLines = raw.split(/\r?\n/);
  let total = 0;
  let idx = 0;
  const usedIdx = new Set();
  for (const item of f.items) {
    idx++;
    const out = item.raw ? item.raw : item.lines;
    total += out.length;
    if (idx === 1 && !item.raw) fail('first item must be raw header');
    if (idx > 1 && item.raw) fail('raw item outside header: item ' + idx);
    const anchor = String(item.anchor ?? '').trim();
    const hits = [];
    srcLines.forEach((l, i) => { if (l.trim() === anchor) hits.push(i); });
    let target = 0;
    if (item.nth) {
      if (hits.length < item.nth) fail(`item ${idx}: hits ${hits.length} < nth ${item.nth}: ${anchor}`);
      else target = hits[item.nth - 1];
    } else if (hits.length !== 1) {
      fail(`item ${idx}: hits ${hits.length} (need 1): ${anchor}`);
    } else target = hits[0];
    if (usedIdx.has(target)) fail(`item ${idx}: duplicate insert line ${target + 1}`);
    usedIdx.add(target);

    const emitted = item.raw
      ? out
      : out.map((t) => ('// ' + t).replace(/\/\/ $/, '//'));
    for (const l of emitted) {
      if (!l.trim().startsWith('//')) fail(`item ${idx}: not comment: ${l}`);
      if (l.includes('*/')) fail(`item ${idx}: contains */`);
      const body = l.trim().replace(/^\/\/\s?/, '').trim();
      if (!body) continue;
      const head = body.split(/[\s，。；、：（]/)[0];
      if (FORBIDDEN_HEAD.includes(head)) fail(`item ${idx}: forbidden head "${head}": ${body}`);
      if (/;\s*$/.test(body)) fail(`item ${idx}: ends with ;: ${body}`);
      if (body.includes('=>')) fail(`item ${idx}: contains =>: ${body}`);
      if (/[\w$)\]]\.[\w$]+\s*\(/.test(body)) fail(`item ${idx}: call style: ${body}`);
    }
  }
  console.log(`file=${f.file} items=${f.items.length} lines=${total}`);
  if (total < 76 || total > 78) fail('total out of range: ' + total);
  if (total !== 76) console.log(`[warn] total ${total} (allowed 76-78)`);
}
console.log(errors === 0 ? 'ALL CHECKS PASSED' : `ERRORS ${errors}`);
process.exit(errors === 0 ? 0 : 1);
