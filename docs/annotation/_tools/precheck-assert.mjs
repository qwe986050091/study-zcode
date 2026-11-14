#!/usr/bin/env node
// 落笔预检断言（PLAN#2 改写批用）：预检不是一次性动作，而是「对最终正文的断言」。
//
// 背景：b268 的首稿与预检稿不同，预检过了、门禁仍出 1 处 L。靠「记得预检最终正文」是纪律，会忘；
// 这里改成两步约束：
//   --record  对当前 git diff 里的新增注释行跑 judgeEntries，命中必须为 0，并落一份快照；
//   --verify  门禁前重算一遍，先比对快照（文件/行号/正文字节逐字），不一致即 exit 7，再要求命中为 0。
// 于是「预检之后又改一个字」不可能悄悄溜进门禁。
//
// 快照里的 sha 只覆盖**正文字节**：每个新增注释行的原始文本（去掉前导 `+`，保留行内与行尾空白）
// 按行序拼接后取 sha256；不含文件路径、行号与时间戳。比对仍逐条比 文件/行号/正文，
// 因此空白改动同样会被 exit 7 拦住（字节级，不做语义归一）。
// 边界：换行符由 `git diff` 的文本行切分归一（`\r?\n`），CRLF/LF 切换本身不构成正文改动；
// 把一行注释拆成两行会改变条目数，同样 exit 7。
//
// 计时（b272 起）：时间戳由工具自己落，人不参与；b273 起三量并列，缺一不影响另外两量。
//   --start   模型动第一笔之前调用，立刻落 <前缀>-t-start.txt（ts / epoch / base），已存在则保留首次；
//             起笔前先断言工作树干净（`git status --porcelain` 为空），否则 exit 6 并打印文件清单；
//             唯一放行口是工具内的 START_ALLOW（相对 repo 的路径前缀），不写在文档里。
//   --record  成功写 <前缀>-t-record.txt（ts / epoch / sha / record_runs），旧 t-verify 作废；
//   --verify  通过后写 <前缀>-t-verify.txt，打印 tail = t-verify − t-record；
//             若有 t-start，同时打印落笔段 = t-verify − t-start（全段：改写 + 预检 + 返修）；
//   --watch   批内每 10 s 对 --files 里的文件拍一次「非 plan 行」的 sha，追加到 writes-<batch>.tsv；
//             --record / --verify 末尾按「start(HEAD) 与 record(工作树) 两种合法 sha」复核，
//             出现第三种 sha 即 LINE-DRIFT（只报不拦）。抓得到持续 >10 s 的漂移，抓不到瞬时还原。
//   --record / --verify 另跑第 8 行门禁（b284 起）：`indentChanged` / `eolChanged`。
//     1→1 改写只该替换注释正文，每个改动行的**前导空白字节**与**行尾字节**必须逐字节不变；
//     任一非零即 exit 1。--record 只比正文字节、七行门禁只判行分类，两者都看不见「整行被重建」。
//     只比两侧都是注释的行；代码行的格式差异仍交给现有 token 门禁。
//   --order   对 git 提交时间做最终断言：t-start < t-record ≤ t-verify < commit_time，
//             并打印两段墙钟：batch_wall_total（上一提交 → 本提交，两端取 git）与
//             batch_wall_controllable（t-start → commit）。前者含批间非改写动作（尺子升级、台账提交），
//             不得除以行数当改写成本；后者才是本批自己可控的一段。
//   返修后重跑 --record 会覆盖 t-record 并把 record_runs 加一；tail 只记「最后一次 record → verify」。
//   record_runs 只表示「预检返修轮数」，与「越界改动」分开记，不合并成一个「返修成本」。
//
// 集合断言（b274 起）：--record 必须带 --plan <tsv>，「改动行集合 == plan 行集合」是硬断言。
//   取 git diff -U0 的旧行号集合与新增行号集合，分别与 plan tsv 的 (file, baseLine) 集合双向求差：
//     越界 = diff 里有、plan 里没有（plan 外多改）；漏改 = plan 里有、diff 里没有。
//   唯一例外是 --allow <file> 逐行列出的「已登记池外自清行」（格式 file:line），必须显式列出、不隐式放行。
//   差集非空即 exit 8，并逐行打印 文件:行 + 原文（旧行原文，便于判断是否上游注释）。
//   于是越界在门禁之前就被看见，而不是等事后 numstat 自查。
//
// 用法：
//   node precheck-assert.mjs --repo <root> --base <rev> --files <list.txt> --snapshot <s.json> --start
//   node precheck-assert.mjs --repo <root> --base <rev> --files <list.txt> --snapshot <s.json> --scope --plan <tsv> [--allow <file>]
//   node precheck-assert.mjs --repo <root> --base <rev> --files <list.txt> --snapshot <s.json> --record --plan <tsv> [--allow <file>]
//   node precheck-assert.mjs --repo <root> --base <rev> --files <list.txt> --snapshot <s.json> --verify [--plan <tsv>] [--allow <file>]
//   node precheck-assert.mjs --repo <root> --base <rev> --files <list.txt> --snapshot <s.json> --watch --plan <tsv> [--interval 10000] [--max-ticks 720]
//   node precheck-assert.mjs --repo <root> --base <rev> --files <list.txt> --snapshot <s.json> --order --commit <rev> [--prev <rev>]
// 退出码：0 通过 / 1 判据命中或缩进/行尾变化 / 2 用法错或 plan 文件缺失 / 6 起笔时工作树非空 / 7 正文或时间戳/顺序不成立 / 8 改动行集合 ≠ plan 行集合
// --plan 指向的文件不存在时一律 exit 2：登记表没落盘比「分类漂移」更危险——它会让正确的批看起来像错，
// 也会让错误的批看起来像对（b281 的 ALIGNED diff=100 就是这种假信号）。
// --scope 检出越界/漏改即 exit 1（b362 负控实测）；它不写状态文件，只是把 plan-vs-diff 断言提前跑一次。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { judgeEntries } from './zc-gate-v4.mjs';

const argv = process.argv.slice(2);
const opt = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const repo = opt('repo');
const base = opt('base');
const filesFile = opt('files');
const snapshotFile = opt('snapshot');
const mode = flag('start')
  ? 'start'
  : flag('scope')
    ? 'scope'
    : flag('record')
      ? 'record'
      : flag('verify')
        ? 'verify'
        : flag('watch')
          ? 'watch'
          : flag('order')
            ? 'order'
            : '';

// 时间戳文件与快照同前缀：b272-precheck.json -> b272-t-record.txt / b272-t-verify.txt / b272-t-start.txt
const snapshotBase = snapshotFile.replace(/-precheck\.json$/i, '').replace(/\.json$/i, '');
const tStartFile = `${snapshotBase}-t-start.txt`;
const tRecordFile = `${snapshotBase}-t-record.txt`;
const tVerifyFile = `${snapshotBase}-t-verify.txt`;
const mtimesFile = `${snapshotBase}-mtimes.json`;
const linesFile = `${snapshotBase}-lines.json`;
// 行级漂移：writes-<batch>.tsv（批内周期样本）与 watch 停止开关
const batch = path.basename(snapshotBase).replace(/-precheck$/i, '').replace(/\.json$/i, '');
const writesFile = path.join(path.dirname(snapshotBase), `writes-${batch}.tsv`);
const watchStopFile = `${snapshotBase}-watch-stop`;

const stampText = ({ iso, epoch, sha, runs }) =>
  `ts=${iso}\tepoch=${epoch}\tsha=${sha.slice(0, 12)}\trecord_runs=${runs}`;

const parseStamp = (file) => {
  const text = readFileSync(file, 'utf8').trim();
  const get = (k) => {
    const m = new RegExp(`${k}=([^\\t]+)`).exec(text);
    return m ? m[1] : '';
  };
  return {
    iso: get('ts'),
    epoch: Number(get('epoch')),
    sha: get('sha'),
    runs: Number(get('record_runs')),
  };
};

const gitEpoch = (rev) => {
  const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%ct', rev], { encoding: 'utf8' }).trim();
  return Number(out);
};
const gitIso = (rev) => {
  const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI', rev], { encoding: 'utf8' }).trim();
  return out;
};

// 「碰过又还原」检测（b281 起）：内容 diff 看不见，mtime 看得见。
//   --start 对 `git ls-files` 全量拍 mtime；--record / --verify 复拍，
//   凡 mtime 变了、且 `git diff --quiet HEAD -- <file>` 为干净（内容 == HEAD）的文件，
//   就是本批改过又恢复原样的行。它不计入 diff，却会漏记 write_phase（b280 的 3 行只能靠人记），
//   这里把它变成工具读数。命中不阻断（与越界同口径：回滚不等于未发生，照计不拦）。
function listTracked() {
  return execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

function statMap(paths) {
  const map = {};
  for (const p of paths) {
    try {
      map[p] = statSync(path.join(repo, p)).mtimeMs;
    } catch {
      map[p] = -1;
    }
  }
  return map;
}

function mtimeCheck() {
  if (!existsSync(mtimesFile)) return null;
  const snap = JSON.parse(readFileSync(mtimesFile, 'utf8'));
  const hits = [];
  for (const p of listTracked()) {
    const prev = snap.mtimes?.[p];
    if (prev === undefined) continue; // 批中新增的跟踪文件不算「还原」
    let now;
    try {
      now = statSync(path.join(repo, p)).mtimeMs;
    } catch {
      continue;
    }
    if (now === prev) continue;
    let clean = false;
    try {
      execFileSync('git', ['-C', repo, 'diff', '--quiet', 'HEAD', '--', p]);
      clean = true;
    } catch {
      clean = false;
    }
    if (clean) hits.push(p);
  }
  return hits;
}

function printMtime(hits) {
  if (hits === null) return;
  console.log(`PRECHECK MTIME touched_restored=${hits.length}${hits.length ? '（mtime 变了但内容 == HEAD，计入 write_phase）' : ''}`);
  const CAP = 12;
  for (const f of hits.slice(0, CAP)) console.error(`MTIME HIT ${f}`);
  if (hits.length > CAP) console.error(`MTIME HIT …（其余 ${hits.length - CAP} 个略）`);
}

if (!repo || !base || !filesFile || !snapshotFile || !mode) {
  console.error(
    '用法：--repo <root> --base <rev> --files <list.txt> --snapshot <s.json> (--start | --scope --plan <tsv> | --record --plan <tsv> | --verify | --watch --plan <tsv> | --order --commit <rev>)',
  );
  process.exit(2);
}
// 登记表缺失必须是硬错误：b281 漏落盘时 ACCT 报出 diff=100 的假信号，
// 让一次正确的批看起来像错。宁可在这里 exit 2，也不让差值去承担报错职责。
if (opt('plan') && !existsSync(opt('plan'))) {
  console.error(
    `PRECHECK ${mode.toUpperCase()} FAIL 缺 plan 文件 ${opt('plan')}：登记表未落盘，改动行集合与 ACCT 都会指向错误方向；先把 plan 写出来`,
  );
  process.exit(2);
}
if (mode === 'record' && !opt('plan')) {
  console.error('--record 需要 --plan <tsv>：改动行集合必须等于 plan 行集合（越界 exit 8）');
  process.exit(2);
}
if (mode === 'order' && !opt('commit')) {
  console.error('--order 需要 --commit <rev>：顺序断言的上界是本批代码提交时间');
  process.exit(2);
}

const files = readFileSync(filesFile, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const strip = (raw) => {
  let s = raw.trim();
  if (s.startsWith('//')) s = s.slice(2);
  else if (s.startsWith('/*')) s = s.slice(2).replace(/\*\/\s*$/, '');
  else if (s.startsWith('*')) s = s.slice(1);
  return s.trim();
};

function collectAdded() {
  const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', base, '--', ...files], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = [];
  let cur = '';
  let ln = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      cur = line.slice(6);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      ln = Number(h[1]);
      continue;
    }
    if (!cur || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) {
      const raw = line.slice(1);
      const body = strip(raw);
      if (body) out.push({ file: cur, line: ln, content: body, raw });
      ln += 1;
    }
  }
  return out;
}

// 集合断言用的原始改动行（旧行号 + 新行号都取），与 collectAdded 分开：
// collectAdded 只收「新增的注释正文」做判据，这里要的是「动了哪些行」，包括删除行。
function collectScope() {
  const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', base, '--', ...files], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const oldLines = [];
  const newLines = [];
  let cur = '';
  let oldLn = 0;
  let newLn = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      cur = line.slice(6);
      continue;
    }
    if (line.startsWith('--- a/')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldLn = Number(h[1]);
      newLn = Number(h[2]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('\\')) continue; // 「\ No newline at end of file」不是行
    if (line.startsWith('-')) {
      oldLines.push({ file: cur, line: oldLn, raw: line.slice(1) });
      oldLn += 1;
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push({ file: cur, line: newLn, raw: line.slice(1) });
      newLn += 1;
      continue;
    }
    oldLn += 1;
    newLn += 1;
  }
  return { oldLines, newLines };
}

// plan tsv：`file\tbaseLine\tblame\tcontent`。按形状校验（baseLine 必须是纯数字）跳表头，不按位置跳。
function readPlan(file) {
  const map = new Map();
  for (const line of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2 || !/^\d+$/.test(parts[1])) continue;
    if (!map.has(parts[0])) map.set(parts[0], new Set());
    map.get(parts[0]).add(Number(parts[1]));
  }
  return map;
}

// --allow：唯一的放行口，只收「已登记的池外自清行」，一行一条 `file:line`。
function readAllow(file) {
  const set = new Set();
  if (!file) return set;
  for (const line of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^(.+?):(\d+)\b/.exec(line.trim());
    if (m) set.add(`${m[1]}:${m[2]}`);
  }
  return set;
}

const keyOf = (e) => `${e.file}:${e.line}`;

function scopeCheck() {
  const planFile = opt('plan');
  if (!planFile) return null;
  const plan = readPlan(planFile);
  const allow = readAllow(opt('allow'));
  const { oldLines, newLines } = collectScope();
  const inPlan = (e) => (plan.get(e.file) ?? new Set()).has(e.line);
  const isAllowed = (e) => allow.has(keyOf(e));
  const outOfScope = (e) => !inPlan(e) && !isAllowed(e);

  const outOld = oldLines.filter(outOfScope);
  const outNew = newLines.filter(outOfScope);
  const outKeys = new Set([...outOld, ...outNew].map(keyOf));

  // 计划行逐行覆盖（b350 起）：计划集必须被「新增注释行」完全覆盖。
  // 只比行数（numstat==plan）证明不了覆盖同一批行：整体平移 1 行、两端都在计划集内时会全过。
  const covered = new Set(newLines.map(keyOf));
  const missing = [];
  let planCount = 0;
  for (const [file, lines] of plan) {
    for (const line of lines) {
      planCount += 1;
      if (!covered.has(`${file}:${line}`)) missing.push({ file, line, raw: '' });
    }
  }
  return { planCount, allowCount: allow.size, oldCount: oldLines.length, newCount: newLines.length, outOld, outNew, outKeys, missing, coveredCount: planCount - missing.length };
}

function printScope(scope) {
  if (!scope) return;
  console.log(
    `PRECHECK SCOPE plan=${scope.planCount} allow=${scope.allowCount} diff_old=${scope.oldCount} diff_new=${scope.newCount} out_of_scope_edits=${scope.outKeys.size} plan_lines_covered=${scope.coveredCount}/${scope.planCount}`,
  );
  if (!scope.outKeys.size && !scope.missing.length) return;
  const CAP = 12;
  const oldShown = scope.outOld.slice(0, CAP);
  for (const e of oldShown) console.error(`SCOPE OUT old ${e.file}:${e.line} ${e.raw}`);
  if (scope.outOld.length > CAP) console.error(`SCOPE OUT old …（其余 ${scope.outOld.length - CAP} 行略）`);
  const newShown = scope.outNew.slice(0, CAP);
  for (const e of newShown) console.error(`SCOPE OUT new ${e.file}:${e.line} ${e.raw}`);
  if (scope.outNew.length > CAP) console.error(`SCOPE OUT new …（其余 ${scope.outNew.length - CAP} 行略）`);
  const missingShown = scope.missing.slice(0, CAP);
  for (const e of missingShown) console.error(`SCOPE MISSING ${e.file}:${e.line}（plan 登记但未改动）`);
  if (scope.missing.length > CAP) console.error(`SCOPE MISSING …（其余 ${scope.missing.length - CAP} 行略）`);
}

// 第 8 行门禁（b284 起）：缩进与行尾。1→1 改写只该换注释正文，前导空白与行尾必须逐字节不变。
// 「替换前」自 b289 起取 `--start` 拍的**实盘逐行基准**（`<batch>-lines.json`），
// 不再用 `git cat-file --filters <base>:<file>` 重建：那个基准依赖 core.autocrlf / .gitattributes，
// 配置一变判定就翻（b288 的 cron.ts 实盘 LF、重建 CRLF，15 行假阳性即此）。
const isCommentText = (line) => /^[ \t]*(\/\/|\/\*|\*)/.test(line);
const leadOf = (line) => (/^[ \t]*/.exec(line) ?? [''])[0];
const splitKeepEol = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// 每行记 `<c|x>|<lead>|<eol>|<sha16>`：是否注释行、前导空白、行尾、正文哈希。
const lineMetaOf = (raw) => {
  const eol = raw.endsWith('\r\n') ? 'CRLF' : raw.endsWith('\n') ? 'LF' : 'EOF';
  const body = raw.slice(0, raw.length - (eol === 'CRLF' ? 2 : eol === 'LF' ? 1 : 0));
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `${isCommentText(body) ? 'c' : 'x'}|${leadOf(body)}|${eol}|${digest}`;
};

const diskLines = (file) =>
  splitKeepEol(readFileSync(path.join(repo, file), 'utf8')).map(lineMetaOf);

const readBaseline = () => {
  if (!existsSync(linesFile)) {
    console.error(
      `PRECHECK FAIL 缺 ${path.basename(linesFile)}：第 8 行门禁的「替换前」必须取 --start 拍的实盘逐行基准（b289 起），不用过滤器重建`,
    );
    process.exit(2);
  }
  return JSON.parse(readFileSync(linesFile, 'utf8'));
};

// 配对：-U0 的同一个 hunk 里，删除行与新增行数量相等时按序配对（1→1 改写的形状）。
// 数量不等说明有插入/删除，交给集合断言 exit 8，这里不猜映射。
function collectPairs() {
  const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', base, '--', ...files], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const pairs = [];
  let cur = '';
  let oldLn = 0;
  let newLn = 0;
  let olds = [];
  let news = [];
  const flush = () => {
    if (cur && olds.length && olds.length === news.length) {
      for (let i = 0; i < olds.length; i += 1) pairs.push({ file: cur, oldLine: olds[i], newLine: news[i] });
    }
    olds = [];
    news = [];
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      flush();
      cur = line.slice(6);
      continue;
    }
    if (line.startsWith('--- a/')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      flush();
      oldLn = Number(h[1]);
      newLn = Number(h[2]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) {
      olds.push(oldLn);
      oldLn += 1;
      continue;
    }
    if (line.startsWith('+')) {
      news.push(newLn);
      newLn += 1;
    }
  }
  flush();
  return pairs;
}

function indentEolCheck() {
  const baseline = readBaseline();
  const byFile = new Map();
  for (const p of collectPairs()) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  let indentChanged = 0;
  let eolChanged = 0;
  const hits = [];
  for (const [file, list] of byFile) {
    const before = baseline.files[file];
    if (!before) continue;
    const after = diskLines(file);
    for (const p of list) {
      const o = before[p.oldLine - 1];
      const n = after[p.newLine - 1];
      if (!o || !n) continue;
      const [, oLead, oEol] = o.split('|');
      const [, nLead, nEol] = n.split('|');
      if (!o.startsWith('c|') || !n.startsWith('c|')) continue;
      const indentBad = oLead !== nLead;
      const eolBad = oEol !== nEol;
      if (indentBad) indentChanged += 1;
      if (eolBad) eolChanged += 1;
      if (indentBad || eolBad) {
        hits.push({
          file,
          line: p.newLine,
          detail: `indent ${JSON.stringify(oLead)} => ${JSON.stringify(nLead)} eol ${oEol} => ${nEol}`,
        });
      }
    }
  }
  return { indentChanged, eolChanged, hits };
}

// SAME（b288 教训）：plan 行「替换文案与原文逐字相同」等于没改写，
// hits / indent / eol 都看不见它；用 --start 的实盘基准逐行比对，命中即失败。
function sameCheck() {
  if (!opt('plan')) return [];
  const baseline = readBaseline();
  const plan = readPlan(opt('plan'));
  const hits = [];
  for (const [file, lineSet] of plan) {
    const before = baseline.files[file];
    if (!before) continue;
    const after = diskLines(file);
    for (const line of lineSet) {
      if (before[line - 1] && before[line - 1] === after[line - 1]) hits.push({ file, line });
    }
  }
  return hits;
}

function printSame(hits) {
  console.log(
    `PRECHECK SAME same_rewrites=${hits.length}${hits.length ? '（替换文案与原文逐字相同，等于未改写，exit 1）' : ''}`,
  );
  const CAP = 12;
  for (const h of hits.slice(0, CAP)) console.error(`SAME HIT ${h.file}:${h.line}`);
  if (hits.length > CAP) console.error(`SAME HIT …（其余 ${hits.length - CAP} 行略）`);
}

function printIndent(check) {
  const bad = check.indentChanged || check.eolChanged;
  console.log(
    `PRECHECK INDENT indentChanged=${check.indentChanged} eolChanged=${check.eolChanged}${bad ? '（1→1 改写必须保持原前导空白与行尾，exit 1）' : ''}`,
  );
  const CAP = 12;
  for (const h of check.hits.slice(0, CAP)) console.error(`INDENT HIT ${h.file}:${h.line} ${h.detail}`);
  if (check.hits.length > CAP) console.error(`INDENT HIT …（其余 ${check.hits.length - CAP} 行略）`);
}

const entries = collectAdded();
const sha = createHash('sha256')
  .update(entries.map((e) => e.raw).join('\n'))
  .digest('hex');

const judgeAll = () => {
  const byFile = new Map();
  for (const e of entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const hits = [];
  for (const [file, rows] of byFile) {
    for (const f of judgeEntries(rows)) hits.push({ file, ...f });
  }
  return hits;
};

const printHits = (hits) => {
  for (const h of hits) console.log(`HIT ${h.file}:${h.line} ${h.kind} ${h.reason} :: ${(h.lines || []).join(' | ')}`);
};

// 行级「改过又还原」（b282 起）：文件级 mtime 只能抓整文件回到 HEAD，
// 抓不到「同一文件内某段改过又补回原文」（b280 的 3 行、b281 的 embeddedBrowserHelpers.ts:111）。
// 中间层做法：只看**非 plan 行**的 sha——本线是 1→1 改写，行号不变，
// 因此除 plan 行以外的正文在整个批内必须逐字节不变；一旦拍到的 sha 既不是 start（实盘基准）
// 也不是 record（工作树内容），就说明批中有一段非 plan 行被改过。
// 采样由 --watch 每 10 s 拍一次写进 writes-<batch>.tsv；抓得到持续 >10 s 的漂移，抓不到瞬时的。
// b289 起与第 8 行门禁共用同一份实盘逐行快照（同一套行元组、同一个哈希定义）。
const residualShaOf = (metas, planLines) => {
  const keep = [];
  metas.forEach((m, i) => {
    if (!planLines.has(i + 1)) keep.push(m.slice(m.lastIndexOf('|') + 1));
  });
  return createHash('sha256').update(keep.join('\n')).digest('hex');
};

const worktreeResidualSha = (file, planLines) => {
  try {
    return residualShaOf(diskLines(file), planLines);
  } catch {
    return 'MISSING';
  }
};

const startResidualSha = (file, planLines) => {
  const before = readBaseline().files[file];
  return before ? residualShaOf(before, planLines) : 'MISSING';
};

const sampleWrites = (kind) => {
  const plan = readPlan(opt('plan'));
  const ts = new Date().toISOString();
  const rows = files.map(
    (f) => `${ts}\t${kind}\t${f}\t${worktreeResidualSha(f, plan.get(f) ?? new Set())}`,
  );
  appendFileSync(writesFile, `${rows.join('\n')}\n`, 'utf8');
};

function lineDriftCheck() {
  if (!existsSync(writesFile) || !opt('plan')) return null;
  const plan = readPlan(opt('plan'));
  const allowed = new Map();
  for (const f of files) {
    const planLines = plan.get(f) ?? new Set();
    allowed.set(f, new Set([startResidualSha(f, planLines), worktreeResidualSha(f, planLines)]));
  }
  let samples = 0;
  const hits = new Map();
  for (const row of readFileSync(writesFile, 'utf8').split(/\r?\n/)) {
    const parts = row.split('\t');
    if (parts.length < 4) continue;
    samples += 1;
    const [, , f, sha] = parts;
    if (!allowed.has(f) || allowed.get(f).has(sha)) continue;
    if (!hits.has(f)) hits.set(f, { count: 0, shas: new Set() });
    hits.get(f).count += 1;
    hits.get(f).shas.add(sha.slice(0, 8));
  }
  return { samples, hits };
}

function printDrift(drift) {
  if (!drift) return 0;
  const files = [...drift.hits.keys()];
  console.log(
    `PRECHECK LINE-DRIFT samples=${drift.samples} files=${files.length}${files.length ? '（非 plan 行被改过，计入 write_phase）' : ''}`,
  );
  for (const f of files) {
    console.error(`LINE-DRIFT HIT ${f} 非 plan 行样本 sha=${[...drift.hits.get(f).shas].join(',')} 出现 ${drift.hits.get(f).count} 次`);
  }
  return files.length;
}

if (mode === 'watch') {
  // 后台采样器：起笔后立刻跑，--verify 完成（t-verify 出现）或写入停止开关时自行退出。
  // 只读工作树、只追加 writes-<batch>.tsv，不碰 git 索引，也不影响门禁。
  if (!opt('plan')) {
    console.error('--watch 需要 --plan <tsv>：非 plan 行集合来自登记表');
    process.exit(2);
  }
  const plan = readPlan(opt('plan'));
  const intervalMs = Number(opt('interval', '10000')) || 10000;
  const maxTicks = Number(opt('max-ticks', '720')) || 720;
  if (!existsSync(writesFile)) writeFileSync(writesFile, 'ts\tkind\tfile\tsha\n', 'utf8');
  sampleWrites('watch');
  let ticks = 0;
  while (ticks < maxTicks) {
    if (existsSync(watchStopFile) || existsSync(tVerifyFile)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
    if (existsSync(watchStopFile) || existsSync(tVerifyFile)) break;
    sampleWrites('watch');
    ticks += 1;
  }
  console.log(
    `WATCH DONE files=${files.length} ticks=${ticks} interval=${intervalMs}ms plan=${plan.size} -> ${path.basename(writesFile)}`,
  );
  process.exit(0);
}

if (mode === 'scope') {
  // 改写完成 → --record 之间的漂移窗口：同一套断言**只报不拦**，让漂移立刻可见，
  // 不依赖 numstat +N/−M 这种间接信号；真正的拦截仍留在 --record / --verify。
  if (!opt('plan')) {
    console.error('--scope 需要 --plan <tsv>：同一套 plan-vs-diff 断言（只报不拦）');
    process.exit(2);
  }
  const preScope = scopeCheck();
  printScope(preScope);
  const out = preScope.outKeys.size;
  const missing = preScope.missing.length;
  if (!out && !missing) {
    console.log('PRECHECK SCOPE PASS 越界 0 / 漏改 0（--scope 下漏改也 exit 1）');
  } else {
    const code = missing ? 1 : 0;
    console.log(`PRECHECK SCOPE FAIL 越界 ${out} 行 / 漏改 ${missing} 行（plan_lines_covered=${preScope.coveredCount}/${preScope.planCount}）`);
    process.exit(code || 1);
  }
  process.exit(0);
}

if (mode === 'start') {
  // 起笔前置：树必须干净。脏树会让 numstat 越界检测与 weak 快照都建立在不干净的地基上。
  // 放行路径只能写在这里（工具内），不写进文档，避免「文档说可以」而工具不知道。
  const START_ALLOW = [];
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const pathOf = (line) => line.slice(3).replace(/\\/g, '/');
  const allowed = (line) => START_ALLOW.some((p) => pathOf(line) === p || pathOf(line).startsWith(`${p}/`));
  const dirty = status.filter((line) => !allowed(line));
  if (dirty.length) {
    console.error(`PRECHECK START FAIL 工作树非空（${dirty.length} 项），拒绝起笔：`);
    for (const line of dirty) console.error(`  ${line}`);
    console.error('先提交或回滚这些改动再重跑 --start；要放行的路径必须加进工具内 START_ALLOW。');
    process.exit(6);
  }
  // 起笔戳：只写一次。重跑保留首次，避免「晚起笔」把改写耗时藏掉。
  if (existsSync(tStartFile)) {
    const prev = parseStamp(tStartFile);
    console.log(`PRECHECK START 已存在，保留首次 ts=${prev.iso} epoch=${prev.epoch} -> ${path.basename(tStartFile)}`);
    if (!existsSync(linesFile)) {
      console.error(
        `PRECHECK START FAIL 已有 t-start 但缺 ${path.basename(linesFile)}：该批用旧版起笔，实盘基准无法补拍；归档后用新版重起一批`,
      );
      process.exit(2);
    }
    process.exit(0);
  }
  const now = new Date();
  writeFileSync(tStartFile, `ts=${now.toISOString()}\tepoch=${now.getTime()}\tbase=${base}\n`, 'utf8');
  const tracked = listTracked();
  writeFileSync(
    mtimesFile,
    `${JSON.stringify({ base, takenAt: now.toISOString(), mtimes: statMap(tracked) }, null, 1)}\n`,
    'utf8',
  );
  // 实盘逐行基准：第 8 行门禁与 LINE-DRIFT 共用，不依赖 core.autocrlf / .gitattributes。
  const baseline = { base, takenAt: now.toISOString(), files: {} };
  for (const f of files) {
    try {
      baseline.files[f] = diskLines(f);
    } catch {
      baseline.files[f] = null;
    }
  }
  writeFileSync(linesFile, `${JSON.stringify(baseline)}\n`, 'utf8');
  const lineTotal = Object.values(baseline.files).reduce((n, v) => n + (v ? v.length : 0), 0);
  console.log(
    `PRECHECK START ts=${now.toISOString()} base=${base} mtime 快照 ${tracked.length} 文件 实盘逐行基准 files=${files.length} lines=${lineTotal} -> ${path.basename(tStartFile)}`,
  );
  process.exit(0);
}

if (mode === 'record') {
  // 每次调用都计数（含命中的失败尝试），返修成本才算得全；成功时才写 t-record。
  const runsFile = `${snapshotBase}-record-runs.txt`;
  let runs = 1;
  if (existsSync(runsFile)) {
    const prevRuns = Number(readFileSync(runsFile, 'utf8').trim());
    if (Number.isFinite(prevRuns) && prevRuns > 0) runs = prevRuns + 1;
  }
  writeFileSync(runsFile, `${runs}\n`, 'utf8');

  // SAME 先跑：plan 行与 --start 实盘逐字相同 = 这一行没被改写。
  // 它排在集合断言之前，是为了给出「哪一行原样未动」而不是笼统的「漏改」。
  const same = sameCheck();
  printSame(same);
  if (same.length) {
    console.log(`PRECHECK RECORD FAIL same_rewrites=${same.length} record_runs=${runs}`);
    process.exit(1);
  }

  // 集合断言：越界/漏改在判据之前暴露，且与 record_runs 分开计（record_runs 只记预检轮数）。
  const scope = scopeCheck();
  printScope(scope);
  if (scope && (scope.outKeys.size || scope.missing.length)) {
    console.error(
      `PRECHECK RECORD FAIL 改动行集合 ≠ plan 行集合：越界 ${scope.outKeys.size} 行 / 漏改 ${scope.missing.length} 行（plan=${scope.planCount} allow=${scope.allowCount}）`,
    );
    process.exit(8);
  }

  const indent = indentEolCheck();
  printIndent(indent);
  if (indent.indentChanged || indent.eolChanged) {
    console.error(
      `PRECHECK RECORD FAIL 第 8 行门禁：indentChanged=${indent.indentChanged} eolChanged=${indent.eolChanged}（改写行被整行重建，恢复原前导空白与行尾）`,
    );
    process.exit(1);
  }

  const hits = judgeAll();
  printHits(hits);
  if (hits.length) {
    console.log(`PRECHECK RECORD FAIL n=${entries.length} hits=${hits.length} record_runs=${runs}`);
    process.exit(1);
  }
  const restored = mtimeCheck();
  printMtime(restored);
  const driftFiles = printDrift(lineDriftCheck());
  const now = new Date();
  // 起笔戳若存在，必须早于本次 record；否则是被篡改成未来或顺序造假。
  if (existsSync(tStartFile)) {
    const start = parseStamp(tStartFile);
    if (!Number.isFinite(start.epoch) || start.epoch <= 0) {
      console.error(`PRECHECK RECORD FAIL ${path.basename(tStartFile)} 的 epoch 不可解析：${start.epoch}`);
      process.exit(7);
    }
    if (start.epoch > now.getTime()) {
      console.error(`PRECHECK RECORD FAIL t-start=${start.iso} 晚于当前时刻（拒绝未来时间戳或篡改）`);
      process.exit(7);
    }
  } else {
    console.log(`PRECHECK RECORD 提示：缺 ${path.basename(tStartFile)}（未跑 --start），tail 仍可算，落笔段不可算`);
  }
  // 重跑 --record 意味着正文变了：旧 t-verify 属于上一轮，必须作废，否则会与新 t-record 顺序冲突。
  if (existsSync(tVerifyFile)) unlinkSync(tVerifyFile);
  writeFileSync(
    snapshotFile,
    `${JSON.stringify({ base, files, sha, recordRuns: runs, recordedAt: now.toISOString(), entries }, null, 1)}\n`,
    'utf8',
  );
  writeFileSync(tRecordFile, `${stampText({ iso: now.toISOString(), epoch: now.getTime(), sha, runs })}\n`, 'utf8');
  console.log(
    `PRECHECK RECORD n=${entries.length} hits=0 sha=${sha.slice(0, 12)} record_runs=${runs} out_of_scope_edits=0 touched_restored=${restored ? restored.length : 0} line_drift=${driftFiles} -> ${path.basename(tRecordFile)}`,
  );
  process.exit(0);
}

if (mode === 'order') {
  const commit = opt('commit');
  const fail = (msg) => {
    console.error(`PRECHECK ORDER FAIL ${msg}`);
    process.exit(7);
  };
  const missing = [tStartFile, tRecordFile, tVerifyFile].filter((f) => !existsSync(f));
  if (missing.length) {
    fail(`缺时间戳 ${missing.map((f) => path.basename(f)).join(', ')}——顺序断言要求三枚戳齐全（先跑 --start）`);
  }
  const start = parseStamp(tStartFile);
  const rec = parseStamp(tRecordFile);
  const ver = parseStamp(tVerifyFile);
  const nowMs = Date.now();
  for (const [name, s] of [
    ['t-start', start],
    ['t-record', rec],
    ['t-verify', ver],
  ]) {
    if (!Number.isFinite(s.epoch) || s.epoch <= 0) fail(`${name} 的 epoch 不可解析：${s.epoch}`);
    if (s.epoch > nowMs) fail(`${name}=${s.iso} 晚于当前时刻（未来时间戳或篡改）`);
  }
  if (!(start.epoch < rec.epoch)) fail(`t-start(${start.iso}) 不早于 t-record(${rec.iso})`);
  if (!(rec.epoch <= ver.epoch)) fail(`t-record(${rec.iso}) 晚于 t-verify(${ver.iso})`);
  if (existsSync(snapshotFile)) {
    const snap = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    const want = String(snap.sha).slice(0, 12);
    if (rec.sha !== want) fail(`t-record sha=${rec.sha} ≠ 快照 sha=${want}`);
    if (ver.sha !== want) fail(`t-verify sha=${ver.sha} ≠ 快照 sha=${want}`);
  }
  const commitEpoch = gitEpoch(commit);
  if (!Number.isFinite(commitEpoch) || commitEpoch <= 0) fail(`无法解析提交时间：${commit}`);
  // git 提交时间是秒粒度、戳是毫秒：按秒比较，同秒提交不算逆序。
  if (Math.floor(ver.epoch / 1000) > commitEpoch) {
    fail(`t-verify(${ver.iso}) 不早于提交时间(${gitIso(commit)})`);
  }
  const prevRev = opt('prev') || `${commit}^`;
  const prevEpoch = gitEpoch(prevRev);
  if (!Number.isFinite(prevEpoch) || prevEpoch <= 0) fail(`无法解析上一提交时间：${prevRev}`);
  if (prevEpoch > commitEpoch) fail(`上一提交(${prevRev}) 晚于本提交(${commit})`);
  const wallTotalSec = commitEpoch - prevEpoch;
  // 可控段 = 起笔 → 提交；提交时间是秒粒度，起笔戳是毫秒，按秒取整后再相减。
  const controllableSec = commitEpoch - Math.floor(start.epoch / 1000);
  if (controllableSec < 0) fail(`t-start(${start.iso}) 晚于提交时间(${gitIso(commit)})`);
  const tailSec = (ver.epoch - rec.epoch) / 1000;
  const batchSec = (ver.epoch - start.epoch) / 1000;
  console.log(
    `PRECHECK ORDER OK t-start=${start.iso} < t-record=${rec.iso} <= t-verify=${ver.iso} < commit=${gitIso(commit)}`,
  );
  console.log(
    `PRECHECK WALL batch_wall_total=${wallTotalSec.toFixed(1)}s(${prevRev}->${commit}) batch_wall_controllable=${controllableSec.toFixed(1)}s(start->commit) 注：total 含批间非改写动作，不得除以行数当改写成本`,
  );
  console.log(
    `PRECHECK THREE 落笔段=${batchSec.toFixed(1)}s(start->verify) tail=${tailSec.toFixed(1)}s(record->verify) record_runs=${rec.runs}`,
  );
  process.exit(0);
}

if (!existsSync(snapshotFile)) {
  console.error(`PRECHECK VERIFY FAIL 快照不存在：${snapshotFile}（先跑 --record）`);
  process.exit(7);
}
const snap = JSON.parse(readFileSync(snapshotFile, 'utf8'));
if (snap.base !== base) {
  console.error(`PRECHECK VERIFY FAIL 快照 base=${snap.base} ≠ 当前 --base=${base}`);
  process.exit(7);
}
if (snap.sha !== sha) {
  const a = snap.entries;
  const b = entries;
  let shown = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 5; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.file !== y.file || x.line !== y.line || x.raw !== y.raw) {
      const show = (e) =>
        e ? `${e.file}:${e.line} ${e.raw !== e.content ? JSON.stringify(e.raw) : e.content}` : '(无)';
      console.error(`DRIFT #${i}\n  want ${show(x)}\n  got  ${show(y)}`);
      shown += 1;
    }
  }
  console.error(`PRECHECK VERIFY FAIL 正文与快照不一致（record ${a.length} 行 / now ${b.length} 行）——记录后改过文本，重跑 --record`);
  process.exit(7);
}
const same = sameCheck();
printSame(same);
if (same.length) {
  console.error(`PRECHECK VERIFY FAIL same_rewrites=${same.length}（替换文案与原文逐字相同）`);
  process.exit(1);
}
const verifyScope = scopeCheck();
printScope(verifyScope);
if (verifyScope && (verifyScope.outKeys.size || verifyScope.missing.length)) {
  console.error(
    `PRECHECK VERIFY FAIL 改动行集合 ≠ plan 行集合：越界 ${verifyScope.outKeys.size} 行 / 漏改 ${verifyScope.missing.length} 行`,
  );
  process.exit(8);
}
const indent = indentEolCheck();
printIndent(indent);
if (indent.indentChanged || indent.eolChanged) {
  console.error(
    `PRECHECK VERIFY FAIL 第 8 行门禁：indentChanged=${indent.indentChanged} eolChanged=${indent.eolChanged}（改写行被整行重建）`,
  );
  process.exit(1);
}
const hits = judgeAll();
printHits(hits);
if (hits.length) {
  console.log(`PRECHECK VERIFY FAIL n=${entries.length} hits=${hits.length}`);
  process.exit(1);
}
printMtime(mtimeCheck());
printDrift(lineDriftCheck());

if (!existsSync(tRecordFile)) {
  console.error(`PRECHECK VERIFY FAIL 缺 ${path.basename(tRecordFile)}（时间戳必须由 --record 生成）`);
  process.exit(7);
}
const rec = parseStamp(tRecordFile);
const nowMs = Date.now();
if (!Number.isFinite(rec.epoch) || rec.epoch <= 0) {
  console.error(`PRECHECK VERIFY FAIL ${path.basename(tRecordFile)} 的 epoch 不可解析：${rec.epoch}`);
  process.exit(7);
}
if (rec.epoch > nowMs) {
  console.error(
    `PRECHECK VERIFY FAIL t-record=${rec.iso} 晚于当前时刻 ${new Date(nowMs).toISOString()}（拒绝未来时间戳或篡改）`,
  );
  process.exit(7);
}
if (rec.sha !== sha.slice(0, 12)) {
  console.error(`PRECHECK VERIFY FAIL t-record 的 sha=${rec.sha} ≠ 快照 sha=${sha.slice(0, 12)}`);
  process.exit(7);
}

const start = existsSync(tStartFile) ? parseStamp(tStartFile) : null;
if (start) {
  if (!Number.isFinite(start.epoch) || start.epoch <= 0) {
    console.error(`PRECHECK VERIFY FAIL ${path.basename(tStartFile)} 的 epoch 不可解析：${start.epoch}`);
    process.exit(7);
  }
  if (start.epoch > nowMs) {
    console.error(`PRECHECK VERIFY FAIL t-start=${start.iso} 晚于当前时刻（拒绝未来时间戳或篡改）`);
    process.exit(7);
  }
  if (!(start.epoch < rec.epoch)) {
    console.error(`PRECHECK VERIFY FAIL t-start(${start.iso}) 不早于 t-record(${rec.iso})，时间戳顺序不成立`);
    process.exit(7);
  }
}

let verifyStamp;
if (existsSync(tVerifyFile)) {
  verifyStamp = parseStamp(tVerifyFile);
  if (!Number.isFinite(verifyStamp.epoch) || verifyStamp.epoch < rec.epoch) {
    console.error(`PRECHECK VERIFY FAIL ${path.basename(tVerifyFile)} 早于 t-record，时间戳顺序不成立`);
    process.exit(7);
  }
} else {
  verifyStamp = { iso: new Date(nowMs).toISOString(), epoch: nowMs, sha: sha.slice(0, 12), runs: rec.runs };
  writeFileSync(tVerifyFile, `${stampText(verifyStamp)}\n`, 'utf8');
}

const tailSec = (verifyStamp.epoch - rec.epoch) / 1000;
const batchSec = start ? (verifyStamp.epoch - start.epoch) / 1000 : null;
console.log(`PRECHECK VERIFY n=${entries.length} hits=0 sha=${sha.slice(0, 12)}  OK`);
console.log(
  `PRECHECK TIMING t-start=${start ? start.iso : '(缺失)'} t-record=${rec.iso} t-verify=${verifyStamp.iso} ` +
    `落笔段=${batchSec === null ? '缺失(未跑 --start)' : `${batchSec.toFixed(1)}s`} ` +
    `tail=${tailSec.toFixed(1)}s record_runs=${rec.runs}`,
);
process.exit(0);
