// 干跑校验 b73-03：只读 spec 与目标文件，模拟 zc-insert 的整行匹配与插入，不写仓库。
// 用法：node d:\code\_annot_baseline\_check-b73-03.mjs
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b73-spec-03.json';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const BANNED = ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'return', 'if', 'else',
  'for', 'while', 'switch', 'try', 'catch', 'await', 'async', 'throw', 'new', 'interface', 'type', 'enum'];

let bad = 0;
const fail = (msg) => { bad++; console.log('FAIL ' + msg); };

for (const f of spec.files) {
  const abs = path.join(repo, f.file);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const trims = lines.map((l) => l.trim());

  const inserts = new Map(); // index -> array of inserted lines
  let total = 0;

  for (const item of f.items) {
    const anchor = item.anchor.trim();
    const hits = [];
    for (let i = 0; i < trims.length; i++) if (trims[i] === anchor) hits.push(i);

    let idx;
    if (hits.length === 1) {
      idx = hits[0];
      if (item.nth !== undefined && item.nth !== 1) fail(`nth 无意义 ${f.file} :: ${anchor}`);
    } else if (hits.length === 0) {
      fail(`NOT FOUND ${f.file} :: ${anchor}`);
      continue;
    } else {
      if (item.nth === undefined) { fail(`AMBIGUOUS(${hits.length}) ${f.file} :: ${anchor}`); continue; }
      if (item.nth < 1 || item.nth > hits.length) { fail(`NTH OUT OF RANGE ${item.nth}/${hits.length} ${f.file} :: ${anchor}`); continue; }
      idx = hits[item.nth - 1];
    }

    const indent = (lines[idx].match(/^\s*/) || [''])[0];
    let out;
    if (item.raw) {
      out = item.raw.slice();
    } else if (item.lines) {
      out = item.lines.map((l) => (l === '' ? indent + '//' : indent + '// ' + l));
    } else {
      fail(`NO CONTENT ${f.file} :: ${anchor}`);
      continue;
    }

    if (inserts.has(idx)) fail(`DUPLICATE INSERT INDEX ${idx + 1} ${f.file}`);
    inserts.set(idx, out);
    total += out.length;

    for (const l of out) {
      const t = l.trim();
      if (!t.startsWith('//')) fail(`NOT COMMENT ${f.file} :: ${JSON.stringify(l)}`);
      if (l.includes('*/')) fail(`STAR SLASH ${f.file} :: ${JSON.stringify(l)}`);
      const body = t.replace(/^\/\/\s?/, '').trim();
      if (body) {
        const first = body.split(/\s+/)[0];
        if (BANNED.includes(first)) fail(`BANNED WORD(${first}) ${f.file} :: ${JSON.stringify(t)}`);
        if (/;\s*$/.test(body)) fail(`TRAILING SEMICOLON ${f.file} :: ${JSON.stringify(t)}`);
        if (body.includes('=>')) fail(`ARROW ${f.file} :: ${JSON.stringify(t)}`);
        if (/[A-Za-z0-9_$)\]]\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(body)) fail(`CALL EXPR ${f.file} :: ${JSON.stringify(t)}`);
      }
    }
  }

  if (total !== 61) fail(`TOTAL LINES ${total} != 61 ${f.file}`);

  const head = f.items[0];
  if (!head || !Array.isArray(head.raw)) fail(`HEADER MISSING RAW ${f.file}`);
  else {
    if (head.raw.length !== 22) fail(`HEADER RAW LEN ${head.raw.length} != 22`);
    if (!head.raw[0].startsWith('// INV-01')) fail(`HEADER FIRST ${JSON.stringify(head.raw[0])}`);
    if (head.raw[18] !== '//') fail(`HEADER LINE19 ${JSON.stringify(head.raw[18])}`);
    for (let i = 0; i < 18; i++) {
      const tag = '// INV-' + String(i + 1).padStart(2, '0');
      if (!head.raw[i].startsWith(tag + ' ')) fail(`HEADER TAG ${i + 1} ${JSON.stringify(head.raw[i])}`);
      if (!head.raw[i].includes('守住位置')) fail(`HEADER NO POSITION ${i + 1}`);
      if (!head.raw[i].includes('改错故障')) fail(`HEADER NO FAULT ${i + 1}`);
    }
    if (!head.raw[19].startsWith('// 模块职责：')) fail('HEADER NO 模块职责');
    if (!head.raw[20].startsWith('// 状态所有权：')) fail('HEADER NO 状态所有权');
    if (!head.raw[21].startsWith('// 阅读顺序：')) fail('HEADER NO 阅读顺序');
  }

  console.log(`${f.file}: blocks=${f.items.length} lines=${total} anchors=${inserts.size}`);
}

console.log(bad === 0 ? 'OK' : `CHECK FAIL ${bad}`);
process.exit(bad === 0 ? 0 : 1);
