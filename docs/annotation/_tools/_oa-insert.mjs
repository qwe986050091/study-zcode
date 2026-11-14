// oauthService 注释插入器：读 _oa-batch.json（{行号: [注释行...]}），按行号倒序插入。
// 只插入整行 `//`，不动代码；行号以插入前文件的当前状态为准。
// 缩进按锚点行自动对齐：注释行只写正文，避免手写缩进与代码不一致。
import fs from 'node:fs';

const FILE = 'd:/code/ZCode/packages/services/src/oauth/oauthService.ts';
const BATCH = 'd:/code/_annot_baseline/_oa-batch.json';
const E = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const keys = Object.keys(E).map(Number).sort((a, b) => b - a);
for (const k of keys) {
  const idx = k - 1;
  if (idx < 0 || idx >= lines.length) throw new Error(`line ${k} out of range`);
  const indent = (lines[idx].match(/^\s*/) || [''])[0];
  const body = E[k].map((s) => (s.startsWith('//') ? indent + s.trim() : s.trim()));
  lines.splice(idx, 0, ...body);
}
fs.writeFileSync(FILE, lines.join('\n'));
console.log('inserted', keys.reduce((s, k) => s + E[k].length, 0), 'lines at', keys.length, 'anchors');
