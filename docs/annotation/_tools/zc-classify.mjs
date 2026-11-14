// 把统一判据命中的注释行分三档，只有 1/2 档进入修复队列。
//   1 真注水：无标识符、无谓词、无前置/后果 —— 按 v2 整行重写。
//   2 可增强：有时序或条件/后果之一，但缺锚点 —— 原地补真实标识符 + 一句「做错会怎样」。
//   3 误判：同时具备「顺序/条件」与「后果」两个语义槽，只是句子短 —— 记录保留，不进队列。
// 统计口径：去重文件全量扫描，禁止按批次快照累加。
// 用法：node zc-classify.mjs [out.json]
import fs from "node:fs";
import { scanFile, ident } from "./zc-gate.mjs";

const P = "D:/code/_annot_baseline/";
const ORDER = /(先|再|然后|之后|之前|最后|顺序|调用前|调用后|等到|紧接着|随后)/;
const COND = /(若|如果|一旦|仅当|只有|除非|否则|条件)/;
const CONSEQ = /(导致|会|造成|破坏|失效|错误|崩溃|泄漏|死锁|回滚|报错|抛错|错乱|重复|丢失|无法|不能|退化为|污染|卡住|挂起|空转)/;
// 谓词：gate 的 PREDICATE 之外，补上注释里高频的动作词。
const VERB =
  /(返回|抛出|写入|读取|分配|释放|等于|大于|小于|防止|保证|确保|依赖|产生|触发|恢复|丢弃|重试|拒绝|跳过|合并|拆分|持有|借用|指向|覆盖|保持|限制|决定|渲染|拼接|命中|生成|构造|冻结|截断|追加|过滤|排序|派发|消费|挂载|注册|注销|切换|回退|兜底|交给|取自|暴露|收敛|归一|夹到|夹取|取|用|把|让|由)/;

export function classify(content) {
  const o = ORDER.test(content);
  const c = COND.test(content);
  const q = CONSEQ.test(content);
  const v = VERB.test(content);
  if (!o && !c && !q && !v) return 1;
  // 误判：顺序/条件 + 后果 两个语义槽齐全，只是句子短、缺锚点。
  if ((o || c) && q) return 3;
  return 2;
}

const byFile = new Map();
for (const d of fs.readdirSync(P, { withFileTypes: true })) {
  if (!d.isDirectory() || !/^ZC-deep-b/.test(d.name) || !fs.existsSync(`${P}${d.name}/orig`)) continue;
  const label = d.name.replace(/^ZC-deep-/, "");
  const walk = (dir, pre) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = pre ? pre + "/" + e.name : e.name;
      if (e.isDirectory()) walk(dir + "/" + e.name, rel);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const cur = byFile.get(rel) ?? { batches: new Set() };
        cur.batches.add(label);
        byFile.set(rel, cur);
      }
    }
  };
  walk(`${P}${d.name}/orig`, "");
}

const files = [];
const totals = { 1: 0, 2: 0, 3: 0 };
for (const [rel, meta] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const res = scanFile(rel);
  if (!res.findings.length) continue;
  const seen = new Map();
  for (const f of res.findings) {
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.line + i;
      if (seen.has(line)) continue;
      seen.set(line, { line, kind: f.kind, text: f.lines[i], cls: classify(f.lines[i]) });
    }
  }
  const rows = [...seen.values()].sort((a, b) => a.line - b.line);
  const cnt = { 1: 0, 2: 0, 3: 0 };
  for (const r of rows) cnt[r.cls]++;
  totals[1] += cnt[1];
  totals[2] += cnt[2];
  totals[3] += cnt[3];
  const nums = [...meta.batches].map((b) => +((/^b?(\d+)/i.exec(b) ?? [0, 0])[1])).filter(Boolean);
  const era = nums.some((n) => n <= 120) ? "B1-120" : nums.some((n) => n <= 180) ? "B121-180" : "B181+";
  files.push({ rel, era, batches: [...meta.batches].join(","), added: res.addedCommentLines, c1: cnt[1], c2: cnt[2], c3: cnt[3], rows });
}

files.sort((a, b) => b.c1 + b.c2 - (a.c1 + a.c2) || b.c1 - a.c1 || a.rel.localeCompare(b.rel));
const out = process.argv[2] ?? P + "zc-classify-all.json";
fs.writeFileSync(out, JSON.stringify({ totals, files }, null, 1), "utf8");
fs.writeFileSync(
  P + "zc-work-queue.txt",
  files
    .filter((f) => f.c1 + f.c2 > 0)
    .map((f) => `${f.c1 + f.c2}\t${f.c1}\t${f.c2}\t${f.c3}\t${f.era}\t${f.rel}`)
    .join("\n") + "\n",
  "utf8",
);

for (const f of files.slice(0, 12)) console.log(`${f.c1 + f.c2}\t(1:${f.c1} 2:${f.c2} 3:${f.c3})\t${f.era}\t${f.rel}`);
const work = files.filter((f) => f.c1 + f.c2 > 0);
console.log(
  `SUMMARY files=${files.length} workFiles=${work.length} class1=${totals[1]} class2=${totals[2]} class3=${totals[3]} workLines=${totals[1] + totals[2]}`,
);
