// 干跑校验 b72-04：模拟 zc-insert 的锚点匹配与插入规则，不写目标文件。
// 用法：node d:\code\_annot_baseline\_check-b72-04.mjs
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b72-spec-04.json';
const expectedLines = 62;

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const problems = [];
const bad = (msg) => problems.push(msg);

const BANNED = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_RE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*\(/;

let blockCount = 0;
let totalInserted = 0;

for (const f of spec.files) {
  const abs = path.join(repo, f.file);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

  const occupied = new Map();
  let fileInserted = 0;

  for (const item of f.items) {
    blockCount++;
    const isRaw = Array.isArray(item.raw);
    const payload = isRaw ? item.raw : item.lines;
    if (!Array.isArray(payload) || payload.length === 0) {
      bad(`EMPTY-PAYLOAD :: ${item.anchor}`);
      continue;
    }
    if (isRaw ? payload.length < 3 || payload.length > 22 : payload.length < 3 || payload.length > 6) {
      bad(`BLOCK-LEN(${payload.length}) :: ${item.anchor}`);
    }
    const nth = item.nth ?? null;

    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === String(item.anchor).trim()) hits.push(i);
    }
    let idx = -1;
    if (nth !== null) {
      if (!Number.isInteger(nth) || nth < 1) bad(`BAD-NTH :: ${item.anchor} nth=${nth}`);
      else if (hits.length < nth) bad(`NOT-ENOUGH-HITS(${hits.length}) :: ${item.anchor} nth=${nth}`);
      else idx = hits[nth - 1];
    } else if (hits.length !== 1) {
      bad(`${hits.length === 0 ? 'NOT-FOUND' : 'AMBIGUOUS(' + hits.length + ')'} :: ${item.anchor} ${hits.join(',')}`);
    } else {
      idx = hits[0];
    }
    if (idx < 0) continue;

    if (occupied.has(idx)) bad(`DUP-INDEX(${idx + 1}) :: ${item.anchor} 与 ${occupied.get(idx)}`);
    else occupied.set(idx, item.anchor);

    const indent = /^\s*/.exec(lines[idx])[0];
    const rendered = isRaw
      ? payload.slice()
      : payload.map((t) => (t === '' ? `${indent}//` : `${indent}// ${t}`));

    for (const line of rendered) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('//')) bad(`NOT-COMMENT :: ${item.anchor} :: ${trimmed}`);
      if (line.includes('*/')) bad(`STAR-SLASH :: ${item.anchor} :: ${trimmed}`);
      if (trimmed.endsWith(';')) bad(`TRAILING-SEMI :: ${item.anchor} :: ${trimmed}`);
      if (trimmed.includes('=>')) bad(`ARROW :: ${item.anchor} :: ${trimmed}`);
      const body = trimmed.replace(/^\/\/+/, '').trimStart();
      if (BANNED.test(body)) bad(`BANNED-PREFIX :: ${item.anchor} :: ${trimmed}`);
      if (body.includes('*/')) bad(`BODY-STAR-SLASH :: ${item.anchor} :: ${trimmed}`);
      const codeLike = body.replace(/`[^`]*`/g, '');
      if (CALL_RE.test(codeLike)) bad(`CALL-EXPR :: ${item.anchor} :: ${trimmed}`);
    }

    fileInserted += rendered.length;
  }

  const header = f.items[0];
  if (!Array.isArray(header.raw)) bad('HEADER-NOT-RAW');
  else {
    if (header.raw.length !== 22) bad(`HEADER-LEN(${header.raw.length}) !== 22`);
    if (!String(header.raw[0]).startsWith('// INV-01')) bad(`HEADER-FIRST :: ${header.raw[0]}`);
    if (header.raw[18] !== '//') bad(`HEADER-19 :: ${JSON.stringify(header.raw[18])}`);
    if (!header.raw.slice(0, 18).every((l, i) => l.startsWith(`// INV-${String(i + 1).padStart(2, '0')} `))) {
      bad('HEADER-INV-SEQUENCE');
    }
    if (header.raw.slice(19).length !== 3) bad('HEADER-TAIL-COUNT');
    for (const kw of ['// 模块职责：', '// 状态所有权：', '// 阅读顺序：']) {
      if (!header.raw.some((l) => l.startsWith(kw))) bad(`HEADER-MISSING ${kw}`);
    }
    if (header.raw[0] !== header.raw[0].replace(/^\s+/, '')) bad('HEADER-INDENTED');
  }

  totalInserted += fileInserted;
  if (fileInserted !== expectedLines) bad(`FILE-TOTAL(${fileInserted}) !== ${expectedLines} :: ${f.file}`);
}

if (totalInserted !== expectedLines) bad(`TOTAL(${totalInserted}) !== ${expectedLines}`);

if (problems.length) {
  for (const p of problems) console.log(p);
  console.log(`CHECK FAIL ${problems.length}`);
  process.exit(1);
} else {
  console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
}
