// vk-gate：valkey 注释批次门禁（2026-11-09 修订）
//
// 相对 zc-gate 的两处修正：
//   1) 块级判定：把「行号连续且都是注释」的行先聚成块，块内只要有一行给出
//      标识符/数字/反引号锚点，或条件、顺序、后果、不变量、目的谓词，整块不算 W。
//      逐行判会把多行块的头行、分节标题、承接句全判成 W（100 条抽样里 56 条如此）。
//   2) 接受中文谓词：才能/漏做则/不更新则/反之/因为/避免/用于/之后/之前……
//      原 PRECOND 只认一组裸关键词，且裸「会/未」会命中「会话/未来」，两头都错。
//
// 门禁两条（用户 2026-11-09 指令）：
//   A. extra = 实际新增注释行 − entries 声明行数；extra !== 0 即 fail。
//   B. 新增注释行的 W 率 > 5% 即 fail。
//
// 用法：
//   node vk-gate.mjs scan --all [--repo d:/code/opensource/valkey] [--json]
//   node vk-gate.mjs scan --files a.c,b.c
//   node vk-gate.mjs batch VK-A5 [--json]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IDENT = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const TAG_STOP = new Set(['STEP', 'INV', 'TODO', 'FIXME', 'NOTE', 'SAFETY', 'XXX', 'HACK', 'OK', 'NULL']);
// 条件 / 顺序 / 后果 / 不变量 / 目的：只要命中任一，就不再是「无信息单行」。
const PREDICATE = new RegExp(
  [
    // 条件
    '前提', '前置', '依赖', '必须先', '先于', '顺序', '调用前', '调用后', '一旦', '若', '如果',
    '只有.*才', '没有.*时', '当.*时', '只(?:在|有).*(?:时|才)', '只要',
    '未(?:初始化|设置|命中|闭合|完成|找到|定义|赋值|加载)',
    // 后果
    '否则', '会(?:导致|使|让|破坏|失效|泄漏|泄露|被|把|造成|退化|读到|写到|覆盖|崩溃|报错|返回|卡|丢|多|少)',
    '无法', '不能', '只能', '必须', '失败', '回滚', '重放', '越界', '拒绝', '抛出', '冲突',
    '泄漏', '泄露', '失效', '失真', '悬空', '退化', '脏数据', '堆损坏', '不一致', '不匹配',
    '漏', '缺一不可', '不得', '危险', '误用', '不可达', '不可能', '无效',
    // 顺序
    '之后', '之前', '随后', '后续', '再(?:释|写|读|执|推进|检查|更新|分配)', '先(?:取|判|释|写|读|分配|检查|更新)',
    // 目的 / 理由
    '用于', '避免', '防止', '以免', '因为', '因此', '所以', '反之', '才能', '才可', '才允许', '以维护', '便于', '以便',
    // 未实现 / 未使用 / 无副作用（形参标记与桩函数的主要信息）
    '未使用', '未实现', '未定义', '未支持', '未启用', '尚未', '不影响', '不改变', '不修改', '不涉及',
    '不参与', '不需要', '无需', '不必', '不构成', '不产生', '标记(?:后|以|即可|出来)', '消除告警', '断言',
    // 等价 / 恒等 / 保持一致（不变量）
    '恒等', '等价', '相同', '保持一致', '保持', '维持',
    // 所有权 / 生命周期
    '所有权', '由别处', '递增', '递减', '自动', '引用计数',
    // 不变量
    '不变量', 'INV-', '唯一', '幂等', '原子', '有序', '单调', '只读', '线程安全', '可重入',
    '有界', '恒定', '固定', '稳定', '保证', '确保', '恰好', '始终',
    // 第二轮校准补充（2026-11-09）：返回值契约、调用方动作、状态哨兵、数量/边界语义。
    // 这些都是「读代码看不出来、必须由注释补上」的信息，不能算水。
    '据此', '调用方', '表示', '不受影响', '足以', '完成后', '说明', '意味着', '而非',
    '跳过', '首次', '下次', '本轮', '首轮', '只在', '仅在', '任一', '各自', '非零', '为零',
    '未(?:创建|分配|打开|注册|接管|激活|越过|阻塞|开启|关闭|保存|刷新|占用|删除|挂载)',
    '存活', '常驻', '延迟回收', '提前回收', '清零', '置零', '回写', '累加', '合并', '对调', '前移', '自增', '自减',
    '返回值', '出参', '入参', '容量', '上界', '下界', '边界', '哨兵',
    // 第三轮补充：单行里出现这些词，说明给出了机制、失败模式或状态迁移，不是直译。
    '互相', '视为', '不含', '成对', '正常', '降级', '减少', '精度', '容忍', '回退', '剩余',
    '错误', '次数', '重建', '摊薄', '预留', '语义', '定位', '恢复', '接入', '销毁', '复制',
    '承载', '重新', '要求', '计入', '等待', '不真正', '决定', '异常', '中断', '重试',
    '耗尽', '提前', '晚到', '并发', '独占', '有效', '无效', '已释放', '旧地址',
  ].join('|'),
);
const HEADING = /^(?:[一二三四五六七八九十]+[、.]|第\s*\d+\s*[段步]|[A-Z]\.\s|[（(]\d+[)）])/;
const SEP = /^[\s\-=*#/─═━]+$/;
const TRAILING_FRAGMENT = /[，、；,;]$/;
const LEADING_FRAGMENT = /^(?:才|而|且|并|则|但|所以|因此|于是|其中|其|该|此|这|那|即|也|仍|再|又)/;

const hasIdent = (s) => (s.match(IDENT) ?? []).some((t) => !TAG_STOP.has(t));
const hasAnchor = (s) => /\d|`[^`]+`/.test(s);
const isOwnComment = (s) => {
  const t = s.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
};
const contentOf = (s) => {
  let t = s.trim();
  if (t.startsWith('//')) t = t.slice(2);
  else if (t.startsWith('/*')) t = t.slice(2);
  else if (t.startsWith('*')) t = t.slice(1);
  t = t.replace(/\*\/\s*$/, '');
  return t.trim();
};

// 把内容切成「有信息」与「无信息」两类。块内任意一行有信息，整块通过。
export function lineHasInfo(s) {
  if (!s) return false;
  if (SEP.test(s)) return true; // 分隔线/空注释行不参与判弱
  if (HEADING.test(s)) return true;
  if (hasIdent(s)) return true;
  if (hasAnchor(s)) return true;
  if (PREDICATE.test(s)) return true;
  return false;
}

// 只有「单行成立、且是独立单行块」的纯翻译才判 W：
// 无信息、不是承接片段、不是标题、长度足够构成一句。
export function isWeakBlock(lines) {
  if (lines.length !== 1) return false;
  const s = lines[0];
  if (!s || SEP.test(s)) return false;
  if (HEADING.test(s) || TRAILING_FRAGMENT.test(s) || LEADING_FRAGMENT.test(s)) return false;
  if ([...s.replace(/\s+/g, '')].length < 8) return false;
  return !lineHasInfo(s);
}

export function judgeBlocks(entries) {
  const rows = [...entries].sort((a, b) => a.line - b.line);
  const blocks = [];
  let cur = [];
  for (const r of rows) {
    if (cur.length && r.line !== cur[cur.length - 1].line + 1) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) blocks.push(cur);
  const findings = [];
  for (const b of blocks) {
    const lines = b.map((r) => r.content);
    if (isWeakBlock(lines)) {
      findings.push({ kind: 'W', line: b[0].line, endLine: b[0].line, lines });
    }
  }
  return { findings, blocks: blocks.length };
}

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
};

// 逐行判定注释归属：返回 Map<lineNo, content>（1-based），只含整行注释。
export function commentMap(absFile) {
  const raw = fs.readFileSync(absFile, 'utf8').replace(/\r\n/g, '\n');
  const out = new Map();
  let inBlock = false;
  raw.split('\n').forEach((l, i) => {
    const t = l.trim();
    let isCmt = false;
    if (inBlock) {
      isCmt = true;
      if (t.includes('*/')) inBlock = false;
    } else if (t.startsWith('//') || t.startsWith('/*')) {
      isCmt = true;
      if (t.startsWith('/*') && !t.includes('*/')) inBlock = true;
    }
    if (isCmt) out.set(i + 1, contentOf(t));
  });
  return out;
}

// 用 git diff -U0 HEAD 取新增行号；同时统计被删的非空、非注释行（应恒为 0）。
export function diffAdded(rel, repo) {
  const d = sh(['diff', '-U0', 'HEAD', '--', rel], repo);
  const added = [];
  let deletedCode = 0;
  let cur = 0;
  for (const l of d.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      cur = +m[1];
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      added.push(cur);
      cur++;
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      const body = l.slice(1).trim();
      if (body && !isOwnComment(body)) deletedCode++;
    } else if (l.startsWith(' ')) cur++;
  }
  return { added, deletedCode };
}

export function scanFiles(repo, rels) {
  const rows = [];
  for (const rel of rels) {
    const cm = commentMap(path.join(repo, rel));
    const { added, deletedCode } = diffAdded(rel, repo);
    const entries = added.filter((n) => cm.has(n)).map((n) => ({ line: n, content: cm.get(n) }));
    const { findings } = judgeBlocks(entries);
    const water = findings.reduce((s, f) => s + (f.endLine - f.line + 1), 0);
    rows.push({
      file: rel,
      added: entries.length,
      nonCommentAdded: added.length - entries.length,
      deletedCode,
      water,
      rate: entries.length ? (water / entries.length) * 100 : 0,
      findings: findings.length,
      ids: findings.map((f) => `${f.line}`).join(','),
    });
  }
  return rows;
}

// entries 声明行数：只认形如 [{line:number, c:string[]}] 的 JSON。
// 传 only 时只统计指定文件名；否则只认 out-*.json（prep 的规范产出）。
// 同一份条目在多轮 JSON 里会重复出现，所以不能默认全目录累加。
function countEntries(dir, only) {
  let lines = 0;
  const files = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    if (only && !only.includes(f)) continue;
    if (!only && !/^out-.*\.json$/.test(f)) continue;
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(obj) || !obj.length) continue;
    const ok = obj.every((e) => e && typeof e.line === 'number' && Array.isArray(e.c) && e.c.every((x) => typeof x === 'string'));
    if (!ok) continue;
    const n = obj.reduce((s, e) => s + e.c.length, 0);
    lines += n;
    files.push({ file: f, entries: obj.length, lines: n });
  }
  return { lines, files };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const repo = (() => {
    const i = argv.indexOf('--repo');
    return i >= 0 ? argv[i + 1] : 'd:/code/opensource/valkey';
  })();
  const asJson = argv.includes('--json');
  if (mode === 'scan') {
    let rels;
    if (argv.includes('--all')) {
      rels = sh(['diff', '--name-only', 'HEAD', '--', 'src'], repo)
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /\.(c|h)$/.test(s));
    } else {
      const i = argv.indexOf('--files');
      if (i < 0) {
        console.error('usage: scan --all | --files a.c,b.c');
        process.exit(2);
      }
      rels = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
    }
    const rows = scanFiles(repo, rels);
    if (asJson) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log('FILE\tadded\twater\twaterRate%\tfindings\tlines');
      for (const r of rows.sort((a, b) => b.water - a.water)) {
        if (!r.added) continue;
        console.log(`${r.file}\t${r.added}\t${r.water}\t${r.rate.toFixed(2)}\t${r.findings}\t${r.ids}`);
      }
      const added = rows.reduce((s, r) => s + r.added, 0);
      const water = rows.reduce((s, r) => s + r.water, 0);
      const bad = rows.filter((r) => r.findings).length;
      console.log(`TOTAL files=${rows.length} badFiles=${bad} added=${added} water=${water} rate=${added ? ((water / added) * 100).toFixed(2) : '0.00'}%`);
    }
  } else if (mode === 'batch') {
    const dir = path.isAbsolute(argv[1]) ? argv[1] : path.join('d:/code/_annot_baseline', argv[1]);
    const filesTxt = path.join(dir, '_files.txt');
    const rels = fs.readFileSync(filesTxt, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const rows = scanFiles(repo, rels);
    const ei = argv.indexOf('--entries');
    const only = ei >= 0 ? argv[ei + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
    const ent = countEntries(dir, only);
    const added = rows.reduce((s, r) => s + r.added, 0);
    const water = rows.reduce((s, r) => s + r.water, 0);
    const deletedCode = rows.reduce((s, r) => s + r.deletedCode, 0);
    const extra = added - ent.lines;
    const rate = added ? (water / added) * 100 : 0;
    const result = { dir, files: rels, added, entries: ent.lines, extra, water, rate: +rate.toFixed(2), deletedCode, entryFiles: ent.files };
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`BATCH ${path.basename(dir)} files=${rels.length} added=${added} entries=${ent.lines} extra=${extra} water=${water} rate=${rate.toFixed(2)}% deletedCode=${deletedCode}`);
      for (const r of rows) console.log(`  file ${r.file}: added=${r.added} water=${r.water} rate=${r.rate.toFixed(2)}% w=${r.ids || '-'}`);
      console.log(extra === 0 ? 'GATE extra: PASS' : 'GATE extra: FAIL (未登记新增注释)');
      console.log(rate <= 5 ? 'GATE water: PASS' : 'GATE water: FAIL (>5%)');
      for (const f of ent.files.sort((a, b) => b.lines - a.lines)) console.log(`  entries ${f.file}: entries=${f.entries} lines=${f.lines}`);
    }
    process.exit(extra === 0 && rate <= 5 && deletedCode === 0 ? 0 : 1);
  } else {
    console.error('usage: scan --all | scan --files a.c,b.c | batch <VK-A5>');
    process.exit(2);
  }
}
