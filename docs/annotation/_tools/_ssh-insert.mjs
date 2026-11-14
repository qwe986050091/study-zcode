// ssh-backend 注释插入器：读 _ssh-batch.json（{行号: [注释行...]}），按行号倒序插入。
// 只插入整行 `//`，不动代码；行号以插入前文件的当前状态为准（因此必须倒序）。
// 缩进由锚点行自动对齐，EOL 沿用文件现状（CRLF），避免整文件被 git 判成改写。
import fs from 'node:fs';

const FILE = process.argv[3] || 'd:/code/ZCode/packages/server/src/remote/ssh-backend.ts';
const BATCH = process.argv[2] || 'd:/code/_annot_baseline/_ssh-batch.json';
const E = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
const raw = fs.readFileSync(FILE, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
const keys = Object.keys(E).map(Number).sort((a, b) => b - a);

// 前置 W 检查：本批任一行注释不含 >=3 字符 ASCII 标识符就拒绝写入。
// 逐字段短注释最容易漏标识符（index.ts b4 十处、b5 十四处），落盘后返工成本 > 落盘前拦截。
const IDENT = /[A-Za-z_][A-Za-z0-9_.]{2,}/;
const bad = [];
for (const k of keys) {
  for (const s of E[k]) {
    if (!IDENT.test(s)) bad.push({ anchor: k, text: s });
  }
}
if (bad.length > 0) {
  console.error(`PRECHECK FAIL: ${bad.length} 行注释缺少 ASCII 标识符（>=3 字符），已拒绝写入：`);
  for (const b of bad) console.error(`  anchor ${b.anchor}: ${b.text}`);
  process.exit(1);
}

for (const k of keys) {
  const idx = k - 1;
  if (idx < 0 || idx >= lines.length) throw new Error(`line ${k} out of range`);
  const indent = (lines[idx].match(/^[ \t]*/) || [''])[0];
  const body = E[k].map((s) => {
    if (!s.startsWith('//')) throw new Error(`line ${k} comment must start with //: ${s}`);
    return indent + s.trim();
  });
  lines.splice(idx, 0, ...body);
}
fs.writeFileSync(FILE, lines.join(eol));
console.log('inserted', keys.reduce((s, k) => s + E[k].length, 0), 'lines at', keys.length, 'anchors');
