// MCP SDK 注释插入器：按锚点整行插入 // 注释，保持原文件行尾（仓库为 CRLF）。
// 用法：node mcp-insert.mjs <spec.json>
// spec: [{ rel, mode: "before"|"after"|"bof"|"eof", anchor?, occ?, lines: ["// ..."] }]
// 约束：插入行必须 trim 后以 // 开头且不含 */；锚点必须唯一（或用 occ 指定第 N 次）。
// 同一文件可有多条 entry，按数组顺序依次应用（后面的锚点基于前面插入后的内容）。
import fs from 'node:fs';
import path from 'node:path';

const repo = process.env.MCP_REPO || 'D:/code/opensource/mcp-sdk';
const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node mcp-insert.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
if (!Array.isArray(spec)) {
  console.error('spec must be an array');
  process.exit(2);
}

let ok = 0;
for (const e of spec) {
  const abs = path.join(repo, e.rel);
  if (!fs.existsSync(abs)) {
    console.error('MISSING FILE: ' + e.rel);
    process.exit(1);
  }
  const text = fs.readFileSync(abs, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (text.includes('\r\n') && text.includes('\n')) {
    const lf = (text.match(/(^|[^\r])\n/g) || []).length;
    if (lf > 0) {
      console.error('MIXED EOL: ' + e.rel + ' (lf-lines=' + lf + ')');
      process.exit(1);
    }
  }
  // 保留末尾换行语义
  const endsWithEol = text.endsWith(eol);
  const rows = text.split(eol);
  if (endsWithEol) rows.pop();

  const isPy = e.rel.endsWith('.py');
  const prefix = isPy ? '#' : '//';
  const block = [];
  for (const raw of e.lines || []) {
    const t = String(raw);
    const s = t.trim();
    if (!s.startsWith(prefix)) {
      console.error('NOT A COMMENT LINE: ' + e.rel + ' :: ' + s.slice(0, 120));
      process.exit(1);
    }
    if (!isPy && s.includes('*/')) {
      console.error('STAR-SLASH IN COMMENT: ' + e.rel + ' :: ' + s.slice(0, 120));
      process.exit(1);
    }
    block.push(t.replace(/\r?\n$/, ''));
  }
  if (!block.length) {
    console.error('EMPTY BLOCK: ' + e.rel);
    process.exit(1);
  }

  let at;
  if (e.mode === 'bof') {
    at = 0;
  } else if (e.mode === 'eof') {
    at = rows.length;
  } else {
    const want = String(e.anchor ?? '').trim();
    if (!want) {
      console.error('MISSING ANCHOR: ' + e.rel);
      process.exit(1);
    }
    const hits = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].trim() === want) hits.push(i);
    const occ = e.occ ?? 1;
    if (hits.length < occ) {
      console.error('ANCHOR NOT FOUND (hits=' + hits.length + ', want=' + occ + '): ' + e.rel + ' :: ' + want.slice(0, 120));
      process.exit(1);
    }
    if (hits.length > 1 && e.occ == null) {
      console.error('ANCHOR NOT UNIQUE (hits=' + hits.length + '): ' + e.rel + ' :: ' + want.slice(0, 120));
      process.exit(1);
    }
    at = hits[occ - 1] + (e.mode === 'after' ? 1 : 0);
  }

  // Python：注释缩进必须与锚点行一致；未显式缩进的块自动补锚点缩进。
  if (isPy && e.mode !== 'bof' && e.mode !== 'eof') {
    const refIdx = e.mode === 'after' ? at - 1 : at;
    const ref = rows[Math.min(Math.max(refIdx, 0), rows.length - 1)] || '';
    const m = /^[ \t]*/.exec(ref || '');
    const indent = m ? m[0] : '';
    for (let i = 0; i < block.length; i++) {
      if (!/^[ \t]/.test(block[i])) block[i] = indent + block[i];
    }
  }

  rows.splice(at, 0, ...block);
  fs.writeFileSync(abs, rows.join(eol) + (endsWithEol ? eol : ''), 'utf8');
  ok += block.length;
  console.log(`+${block.length}\t${e.rel}\t(mode=${e.mode}, at=${at + 1})`);
}
console.log('INSERTED ' + ok + ' lines across ' + spec.length + ' blocks');
