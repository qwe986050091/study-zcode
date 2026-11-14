// 找出“只写做什么”的新增单行注释：无前置条件/顺序并发/失败后果三类线索，且块很短。
// 输出 JSON：line / comments / anchor（紧邻下一行代码）/ ctx（前后各 4 行）。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'd:\\code\\opensource\\uv';
const SNAP = 'd:\\code\\_annot_baseline\\uv-rework\\pre-s3\\';
const FILE = 'crates/uv-distribution/src/source/mod.rs';
const OUT = 'd:\\code\\_annot_baseline\\uv-thin-candidates.json';

const cur = fs.readFileSync(path.join(REPO, FILE.split('/').join(path.sep)), 'utf8').split(/\r?\n/);
const pre = new Set(fs.readFileSync(path.join(SNAP, FILE.split('/').join(path.sep)), 'utf8').split(/\r?\n/).map((l) => l.trim()));

const GOOD = /只有|仅当|前提|必须|需要先|依赖|顺序|先|再|之后|之前|原子|锁|并发|await|同步|事务|rename|否则|失败|报错|导致|崩溃|泄漏|回退|兜底|不可|无法|跳过|丢弃|重试|校验|保证|避免|防止|冲突|不变量|超时|复用|失效|悬空|重复|幂等|哨兵|边界|提前|放弃|报错/;
const isComment = (l) => /^\s*\/\//.test(l);
const texts = [];
for (let i = 0; i < cur.length; i++) {
  if (!isComment(cur[i])) continue;
  if (pre.has(cur[i].trim())) continue; // 上游已有
  const body = cur[i].replace(/^\s*\/\/\s?/, '').trim();
  if (!body) continue;
  // 连续新增注释块的长度
  let start = i;
  while (start > 0 && isComment(cur[start - 1]) && !pre.has(cur[start - 1].trim())) start--;
  let end = i;
  while (end + 1 < cur.length && isComment(cur[end + 1]) && !pre.has(cur[end + 1].trim())) end++;
  texts.push({ idx: i, start, end, body, blockLen: end - start + 1 });
}
const seen = new Set();
const out = [];
for (const t of texts) {
  if (seen.has(t.start)) continue;
  seen.add(t.start);
  const block = cur.slice(t.start, t.end + 1).map((l) => l.trim());
  const combined = block.join(' ');
  if (t.blockLen > 2) continue; // 多行块通常已展开，优先单行/两行
  if (combined.length > 90) continue; // 长句通常有信息
  if (GOOD.test(combined)) continue;
  let a = t.end + 1;
  while (a < cur.length && (!cur[a].trim() || isComment(cur[a]))) a++;
  if (a >= cur.length) continue;
  out.push({
    line: t.start + 1,
    comments: block,
    anchor: cur[a].trim(),
    ctx: cur.slice(Math.max(0, t.start - 4), Math.min(cur.length, a + 3)).map((l) => l.trimEnd()),
  });
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('candidates=' + out.length);
for (const c of out.slice(0, 40)) console.log(`${c.line}\t${c.comments.join(' / ')}`);
