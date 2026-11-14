// 打印重复对上下文，便于人工判定保留哪一版。
// 用法：node dup-ctx.mjs <repo> <rel> <pairsFile>
import fs from 'node:fs';
const [repo, rel, pairsFile] = process.argv.slice(2);
const cur = repo.replace(/\\+$/, '') + '\\' + rel.replace(/\//g, '\\');
const lines = fs.readFileSync(cur, 'utf8').split(/\r?\n/);
const text = fs.readFileSync(pairsFile, 'utf8');
const pairs = [];
const re = /SIM ([\d.]+) L(\d+)\(ours\) \/ L(\d+)\(other\)/g;
let m;
while ((m = re.exec(text))) pairs.push({ s: +m[1], a: +m[2], b: +m[3] });
for (const p of pairs) {
  const lo = Math.max(1, Math.min(p.a, p.b) - 3);
  const hi = Math.min(lines.length, Math.max(p.a, p.b) + 3);
  console.log(`=== ${rel} pair L${p.a}(ours)/L${p.b}(other) sim=${p.s} ===`);
  for (let i = lo; i <= hi; i++) {
    const tag = i === p.a ? 'A>' : i === p.b ? 'B>' : '  ';
    console.log(`${tag}${i}: ${lines[i - 1]}`);
  }
}
