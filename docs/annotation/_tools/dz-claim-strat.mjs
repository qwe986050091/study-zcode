// 全称断言分层抽样：词 × 目录交叉分层。
// 用法：
//   node dz-claim-strat.mjs                 # 打印分层矩阵（规模 + 结构型占比）
//   node dz-claim-strat.mjs --plan          # 生成抽样计划（每层 n>=10 抽 10，其余全取）
//   node dz-claim-strat.mjs --plan --seed 52
// 输出：R52-claim-sample.json（含每层规模、抽样条数、总抽样条数）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOTS = ['drizzle-orm/src', 'drizzle-kit/src'];
const OUT = path.join('D:/code/_annot_baseline', 'R52-claim-sample.json');

const KEYWORDS = ['都', '全部', '一律', '始终', '从不', '必然', '只会', '唯一', '没有一处', '只有', '仅有'];
// 用户点名的分层词（8 个）；「都」是最大层，排除会让全仓估计失真，单独保留并在报告里说明。
const STRAT_WORDS = ['都', '全部', '只有', '唯一', '只会', '一律', '始终', '从不', '必然'];
// 「没有一处 / 仅有」规模过小（合计 <5 条），并入「唯一 / 只有」所在层统计，不单独成层。

// 目录层：只分 orm / kit 两档。再细会碎成 155 个单元（总量 ~900 条，超出预算），
// 目录集中度改用「抽样命中错误的子目录分布」做描述性统计。
const dirLayer = (rel) => (rel.startsWith('drizzle-kit/') ? 'kit' : 'orm');
const subdir = (rel) => {
  if (rel.startsWith('drizzle-kit/')) {
    const p = rel.split('/');
    return 'kit:' + (p[1] === 'src' ? (p[2] || 'src') : p[1]);
  }
  const m = /^drizzle-orm\/src\/([^/]+)/.exec(rel);
  return m ? m[1] : 'src';
};

// 结构型断言：断言对象是代码结构（类/方法/分支/参数/文件），而非运行时行为。
const STRUCT_RE = /(继承|类|接口|方法|函数|构造器|分支|重载|签名|形参|实参|字段|属性|导出|文件|模块|目录|入口|调用点|赋值|声明|类型)/;

const keyOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const claims = [];
for (const root of ROOTS) {
  for (const abs of walk(path.join(REPO, root))) {
    const rel = path.relative(REPO, abs).replace(/\\/g, '/');
    const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*\/\/(.*)$/.exec(lines[i]);
      if (!m) continue;
      const text = m[1].trim();
      if (!/[\u4e00-\u9fff]/.test(text)) continue;
      for (const seg of text.split(/(?<=[。；])/).map((s) => s.trim()).filter(Boolean)) {
        const hits = KEYWORDS.filter((k) => seg.includes(k));
        if (!hits.length) continue;
        claims.push({ key: keyOf(seg), file: rel, line: i + 1, kw: hits[0], seg });
      }
    }
  }
}

// 已核键（台账只认 | `key` | 行）
const audited = new Set();
const LEDGER = path.join(REPO, 'docs/annotation/DZ-claim-ledger.md');
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*`([0-9a-f]{8})`\s*\|/.exec(line);
    if (m) audited.add(m[1]);
  }
}

const pending = claims.filter((c) => !audited.has(c.key));

// 建层
const strata = new Map();
for (const c of pending) {
  const kw = STRAT_WORDS.includes(c.kw) ? c.kw : '都';
  const dir = dirLayer(c.file);
  const id = `${kw} @ ${dir}`;
  if (!strata.has(id)) strata.set(id, []);
  strata.get(id).push({ ...c, dir, subdir: subdir(c.file), structural: STRUCT_RE.test(c.seg) });
}

const args = process.argv.slice(2);
const plan = args.includes('--plan');
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : 52;

if (!plan) {
  console.log(`TOTAL pending=${pending.length} strata=${strata.size} structural=${pending.filter((c) => STRUCT_RE.test(c.seg)).length}`);  console.log('层\t规模\t结构型\t抽\n');
  const rows = [...strata.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [id, cs] of rows) {
    const st = cs.filter((c) => c.structural).length;
    console.log(`${id}\t${cs.length}\t${st}\t${cs.length >= 10 ? 10 : cs.length}`);
  }
} else {
  const rand = rng(seed);
  const picked = [];
  const layerInfo = [];
  for (const [id, cs] of [...strata.entries()].sort()) {
    const take = cs.length >= 10 ? 10 : cs.length;
    const pool = [...cs];
    const chosen = [];
    while (chosen.length < take && pool.length) {
      const i = Math.floor(rand() * pool.length);
      chosen.push(pool.splice(i, 1)[0]);
    }
    picked.push(...chosen);
    layerInfo.push({ id, size: cs.length, sampled: chosen.length, structural: cs.filter((c) => c.structural).length });
  }
  fs.writeFileSync(OUT, JSON.stringify({ seed, totalPending: pending.length, layers: layerInfo, sample: picked }, null, 2), 'utf8');
  console.log(`sample=${picked.length} layers=${layerInfo.length} seed=${seed} -> ${OUT}`);
  console.log(`structural in sample=${picked.filter((c) => c.structural).length}`);
}
