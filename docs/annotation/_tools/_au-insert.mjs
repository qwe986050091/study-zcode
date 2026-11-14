// autoUpdater 注释插入器：读 _au-batch.json（{行号: [注释行...]}），按行号倒序插入。
// 只插入整行 `//`，不动代码；行号以插入前文件的当前状态为准（因此必须倒序）。
// 注释行必须以 `//` 开头（缩进由锚点行自动对齐），否则会被门禁判成非注释新增。
// 行尾沿用文件现有 EOL：ZCode 工作区是 CRLF，插入裸 LF 会让 core.autocrlf=true 的
// git diff 把整文件判成改写（-2614/+2882），门禁随即误报。
import fs from 'node:fs';

const FILE = 'd:/code/ZCode/packages/desktop/src/main/autoUpdater.ts';
const BATCH = 'd:/code/_annot_baseline/_au-batch.json';
const E = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
const raw = fs.readFileSync(FILE, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
const keys = Object.keys(E).map(Number).sort((a, b) => b - a);
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
