// 校验：当前文件必须是在基线基础上「仅插入整行 // 注释」，且保持 CRLF。
// 用法：node b5a-verify.mjs <root-relative-dir>
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const base = 'D:/code/_annot_baseline/ZC-deep-svc-b5/orig';
const root = process.argv[2] ?? 'packages/services/src/conversation-share';
let bad = 0;
for (const name of fs.readdirSync(path.join(repo, root))) {
  if (!name.endsWith('.ts')) continue;
  const cur = fs.readFileSync(path.join(repo, root, name), 'utf8');
  const old = fs.readFileSync(path.join(base, root, name), 'utf8');
  const cl = cur.split('\r\n');
  const ol = old.split('\r\n');
  if (!cur.includes('\r\n') || cur.includes('\n') && /[^\r]\n/.test(cur)) {
    bad++;
    console.log(`EOL ${name}`);
  }
  if (cl.length > 0 && cl[cl.length - 1] === '') cl.pop();
  const o = ol.length > 0 && ol[ol.length - 1] === '' ? ol.slice(0, -1) : ol;
  const inserted = [];
  let i = 0;
  let extra = 0;
  for (let j = 0; j < cl.length; j++) {
    if (i < o.length && cl[j] === o[i]) {
      i++;
    } else if (cl[j].trimStart().startsWith('//')) {
      extra++;
    } else {
      bad++;
      console.log(`CHANGED ${name}:${j + 1} -> ${cl[j]}`);
      break;
    }
  }
  if (i !== o.length) {
    bad++;
    console.log(`MISSING ${name}: ${o.length - i} baseline line(s) not found`);
  }
  console.log(`${name}\tbaseline=${o.length}\tnow=${cl.length}\tinserted=${extra}`);
}
console.log(bad === 0 ? 'VERIFY OK' : `VERIFY FAIL ${bad}`);
process.exit(bad === 0 ? 0 : 1);
