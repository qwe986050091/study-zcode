// 全称断言清单：扫中文行注释里的全称量词，按「句子哈希」建稳定键，
// 与 docs/annotation/DZ-claim-ledger.md 的已核记录比对，输出未核列表。
// 用法：
//   node dz-claim-audit.mjs                # 汇总 + 未核前 40 条
//   node dz-claim-audit.mjs --all          # 汇总 + 全部未核
//   node dz-claim-audit.mjs --n 20         # 未核前 20 条
//   node dz-claim-audit.mjs --keyword 唯一 # 只看某个词
//   node dz-claim-audit.mjs --correction   # 只看修正行（kind=correction，优先级最高）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOTS = ['drizzle-orm/src', 'drizzle-kit/src'];
const LEDGER = path.join(REPO, 'docs/annotation/DZ-claim-ledger.md');
// 词表按用户指定 8 个为准，另补「只有 / 仅有」：
// 依据是 R49 发现的那句失实注释「三个 select* 分支中只有 select 与 selectDistinctOn 透传」——
// 原词表抓不到它，说明「只有」与「都会」是同一类断言，必须入表。
const KEYWORDS = ['都', '全部', '一律', '始终', '从不', '必然', '只会', '唯一', '没有一处', '只有', '仅有'];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const all = flag('--all');
const limit = Number(opt('--n', 40));
const onlyKeyword = opt('--keyword', null);
const grepPath = opt('--grep', null);
const onlyCorrection = flag('--correction');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const keyOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

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
      // 修正行（R52c 起）：解释既有错误之上再叠一层说明，写错的代价高于普通注释，
      // 因此在台账里标 kind=correction，抽样与核验都排在最前。
      const kind = /^修正（键\s*[0-9a-f]{8}）/.test(text) ? 'correction' : 'normal';
      // 按句切分：中文句号、分号、冒号后的分句都算独立断言
      const segments = text.split(/(?<=[。；])/).map((s) => s.trim()).filter(Boolean);
      for (const seg of segments) {
        const hits = KEYWORDS.filter((k) => seg.includes(k));
        if (!hits.length) continue;
        const kw = hits[0];
        const at = seg.indexOf(kw);
        const subject = seg.slice(0, at).replace(/^[（(【[]/, '').trim();
        const rest = seg.slice(at);
        // 断言对象：关键词之后到最近的标点，最多 24 字
        const obj = /^[^，、（）()。；：]*/.exec(rest)[0].slice(0, 24);
        claims.push({ key: keyOf(seg), file: rel, line: i + 1, kw, subject, obj, seg, kind });
      }
    }
  }
}

// 读台账里已核的键
const audited = new Map();
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*`([0-9a-f]{8})`\s*\|/.exec(line);
    if (m) audited.set(m[1], line);
  }
}

const filtered = claims
  .filter((c) => !onlyKeyword || c.kw === onlyKeyword)
  .filter((c) => !grepPath || c.file.includes(grepPath))
  .filter((c) => !onlyCorrection || c.kind === 'correction');
const pending = filtered.filter((c) => !audited.has(c.key));
// 修正行优先：先排 kind=correction，其余保持原顺序（文件 → 行号）。
const shown = (all ? pending : pending.slice(0, limit));
shown.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'correction' ? -1 : 1));

const corrAll = filtered.filter((c) => c.kind === 'correction');
const corrPending = corrAll.filter((c) => !audited.has(c.key));
console.log(
	`TOTAL claims=${filtered.length} audited=${filtered.length - pending.length} pending=${pending.length}`
	+ ` | correction=${corrAll.length} corrPending=${corrPending.length}`,
);
for (const c of shown) {
  const tag = c.kind === 'correction' ? ' [CORRECTION]' : '';
  console.log(`${c.key}\t${c.file}:${c.line}\t[${c.kw}]${tag}\t主体=${c.subject || '(无)'}\t对象=${c.obj}`);
  console.log(`\t原句：${c.seg}`);
}
if (!all && pending.length > shown.length) console.log(`... 另有 ${pending.length - shown.length} 条未显示（--all）`);
