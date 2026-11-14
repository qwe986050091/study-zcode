#!/usr/bin/env node
// 注水 / 过度注释检测（DEEP-SPEC v2 配套工具）
//
// 定位两类「写了很多字但没增加信息」的注释，输出文件 + 行号 + 原文，供改写模式使用：
//   一、注水（短句堆叠）。判据（全部满足才算命中）：
//     A. 连续 >=3 行整行注释（中间不能夹代码行）
//     B. 每行有效字符 < 25（去掉注释符与空白后计数，中文按 1 字）
//     C. 组内没有任何标识符样式 token（[A-Za-z_][A-Za-z0-9_]{2,}，排除 STEP/INV 等标记词）
//     D. 分组标签由相似度决定：
//          平均相邻 char-bigram Jaccard >= 0.35 → 同义重复
//          首两字全组相同                   → 纯排比
//          其余                              → 短句堆叠
//   二、近重复（过度注释）。判据：
//     同一连续注释块内相邻两行（不要求短句、允许含标识符）的 char-bigram Jaccard
//     >= --sim-threshold（默认 0.55），说明两行在反复解释同一事实。
//     过度注释与注水同源：都增加了字数而没有增加信息，只是前者句子更长、更难一眼看出。
//     该类别单独统计（dups / dupLines），不与短句堆叠混算。
//
// 用法：
//   node deep-boilerplate.mjs <repo> [--diff] [--diff-base HEAD] [--baseline <dir>]
//                                    [--files a,b | --file-list f.txt]
//                                    [--root src] [--ext .rs,.py] [--exclude glob]
//                                    [--all] [--min-lines 3] [--max-len 25]
//                                    [--sim-threshold 0.55]
//                                    [--single] [--json out.json] [--fail-on-hit]
//
//   默认只扫 git diff 的新增注释行；--all 扫整文件；--single 额外列出「单行无指代」。
//   退出码：0 = 扫描完成；1 = 读取/diff 失败；2 = 参数错误。
//   --fail-on-hit 时命中（注水或近重复）即退出 1（供 CI 使用）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const USAGE = `usage: node deep-boilerplate.mjs <repo> [--diff] [--diff-base HEAD] [--baseline dir]
       [--files a,b | --file-list f.txt] [--root src] [--ext .rs,.py] [--exclude glob]
       [--all] [--min-lines 3] [--max-len 25] [--sim-threshold 0.55] [--single] [--json out.json] [--fail-on-hit]`;

const DEFAULT_EXT = ['.rs', '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.c', '.h', '.cc', '.cpp', '.hpp', '.java', '.kt'];

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error(USAGE);
  process.exit(2);
}
const repo = path.resolve(argv[0]);
const opt = {
  files: [],
  fileList: '',
  root: 'src',
  ext: DEFAULT_EXT,
  exclude: [],
  all: false,
  diffBase: 'HEAD',
  baseline: '',
  minLines: 3,
  maxLen: 25,
  simThreshold: 0.55,
  single: false,
  json: '',
  failOnHit: false,
};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  const need = () => {
    const v = argv[++i];
    if (v === undefined) {
      console.error('ERROR: ' + a + ' 缺少参数值');
      process.exit(2);
    }
    return v;
  };
  if (a === '--files') opt.files = need().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--file-list') opt.fileList = need();
  else if (a === '--root') opt.root = need();
  else if (a === '--ext') opt.ext = need().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--exclude') opt.exclude.push(need());
  else if (a === '--all') opt.all = true;
  else if (a === '--diff') opt.all = false;
  else if (a === '--diff-base') opt.diffBase = need();
  else if (a === '--baseline') opt.baseline = need();
  else if (a === '--min-lines') opt.minLines = Number(need());
  else if (a === '--max-len') opt.maxLen = Number(need());
  else if (a === '--sim-threshold') opt.simThreshold = Number(need());
  else if (a === '--single') opt.single = true;
  else if (a === '--json') opt.json = need();
  else if (a === '--fail-on-hit') opt.failOnHit = true;
  else {
    console.error('unknown arg: ' + a);
    process.exit(2);
  }
}
if (!fs.existsSync(repo)) {
  console.error('ERROR: repo not found: ' + repo);
  process.exit(2);
}
if (!(opt.simThreshold > 0 && opt.simThreshold <= 1)) {
  console.error('ERROR: --sim-threshold 必须是 (0, 1] 之间的小数');
  process.exit(2);
}

function langOf(file) {
  return path.extname(file).toLowerCase() === '.py' ? 'py' : 'c';
}

function stripStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// 返回 {kind, content}；只认整行注释（与 v1 密度口径一致，行尾注释不算）
function parseFile(text, lang) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') {
      rows.push({ kind: 'blank', text: line, content: '' });
      continue;
    }
    if (lang === 'c') {
      if (inBlock) {
        rows.push({ kind: 'comment', text: line, content: t.replace(/^\*+\s?/, '').replace(/\*+\/$/, '').trim() });
        if (t.includes('*/')) inBlock = false;
        continue;
      }
      if (t.startsWith('/*')) {
        rows.push({ kind: 'comment', text: line, content: t.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim() });
        if (!t.includes('*/')) inBlock = true;
        continue;
      }
      if (t.startsWith('//')) {
        rows.push({ kind: 'comment', text: line, content: t.replace(/^\/{2,}\s?/, '') });
        continue;
      }
    } else if (t.startsWith('#')) {
      rows.push({ kind: 'comment', text: line, content: t.replace(/^#+\s?/, '') });
      continue;
    }
    rows.push({ kind: 'code', text: line, content: '' });
  }
  return rows;
}

const TAG_STOP = new Set(['STEP', 'INV', 'TODO', 'FIXME', 'NOTE', 'SAFETY', 'XXX', 'HACK']);
function identTokens(s) {
  return (s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((t) => !TAG_STOP.has(t));
}
function effLen(content) {
  return [...content.replace(/\s+/g, '')].length;
}
function bigrams(s) {
  const cs = [...s.replace(/\s+/g, '')];
  const out = new Set();
  for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i] + cs[i + 1]);
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const PRONOUN = /(该|这个|那个|这些|那些|此处|这里|其中|上述|如下|相关|对应|其|它|此)/;
// 有锚点 = 出现数字 / 反引号片段。数字足以把「INV-01 …」「返回 0」这类
// 有具体所指的行排除在外；否则文件头的不变量表会被误判成注水。
const ANCHOR = /\d|`[^`]+`/;
function noReferent(content) {
  const c = content.replace(/应该|不该|活该|其它/g, '');
  return PRONOUN.test(c) && !ANCHOR.test(content) && identTokens(content).length === 0;
}
// 纯注释符 / 空内容（如单独一行 `#` 或 `//`）是分段装饰，不参与连续短句判定。
function isSeparator(content) {
  return content.replace(/[\s\-=*#/]/g, '') === '';
}

// ---------- diff ----------
function runGit(args) {
  const r = spawnSync('git', ['-C', repo, '--no-pager', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new Error('git 调用失败: ' + String(r.error));
  if (r.status !== 0) throw new Error('git 退出码 ' + r.status + ': ' + (r.stderr || '').trim());
  return r.stdout || '';
}

function unquoteGitPath(s) {
  let v = s.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v
      .slice(1, -1)
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n');
  }
  return v.replace(/\\/g, '/');
}

function parseAddedLines(diffText, fileFilter) {
  const out = new Map();
  let cur = null;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diffText.split(/\r?\n/)) {
    if (inHunk) {
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newNo = Number(hunk[1]);
        continue;
      }
      if (raw.startsWith('\\')) continue;
      if (raw.startsWith('+')) {
        out.get(cur).set(newNo, raw.slice(1).replace(/\r$/, ''));
        newNo++;
        continue;
      }
      if (raw.startsWith('-')) continue;
      if (raw.startsWith(' ')) {
        newNo++;
        continue;
      }
      inHunk = false;
    }
    if (raw.startsWith('diff --git')) {
      cur = null;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      inHunk = true;
      newNo = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+++ ')) {
      let p = unquoteGitPath(raw.slice(4));
      if (p.startsWith('b/')) p = p.slice(2);
      if (fileFilter && !fileFilter.has(p)) {
        cur = null;
        continue;
      }
      cur = p;
      out.set(p, new Map());
    }
  }
  return out;
}

function collectDiff(rels) {
  if (opt.baseline) {
    const baseDir = path.resolve(opt.baseline);
    if (!fs.existsSync(baseDir)) throw new Error('baseline 目录不存在: ' + baseDir);
    const out = new Map();
    for (const rel of rels) {
      const baseFile = path.join(baseDir, rel);
      const curFile = path.join(repo, rel);
      if (!fs.existsSync(baseFile)) throw new Error('基线缺文件: ' + baseFile);
      const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', baseFile, curFile], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.error) throw new Error('git diff --no-index 失败: ' + String(r.error));
      // 单文件 diff 不做路径过滤：+++ 行是 b/xxx 形式，与绝对路径的过滤集对不上。
      const parsed = parseAddedLines(r.stdout || '', null);
      out.set(rel, [...parsed.values()][0] ?? new Map());
    }
    return out;
  }
  return parseAddedLines(runGit(['diff', opt.diffBase, '-U0', '--', ...rels]), new Set(rels));
}

// ---------- 文件收集 ----------
function globToRegExp(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if ('\\^$.|?+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

function walk(dir, out, exts) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error('无法读取目录 ' + dir + ': ' + e.message);
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['target', 'node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'].includes(ent.name)) continue;
      walk(p, out, exts);
    } else if (ent.isFile() && exts.some((e) => ent.name.endsWith(e))) out.push(p);
  }
}

function resolveFiles() {
  let list = [];
  if (opt.files.length || opt.fileList) {
    const names = opt.files.slice();
    if (opt.fileList) {
      for (const l of fs.readFileSync(path.resolve(opt.fileList), 'utf8').split(/\r?\n/)) {
        const v = l.trim();
        if (v) names.push(v);
      }
    }
    for (const n of names) {
      const abs = path.resolve(repo, n);
      if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + n);
      list.push(abs);
    }
  } else {
    for (const r of opt.root.split(',').map((s) => s.trim()).filter(Boolean)) {
      const dir = path.join(repo, r);
      if (!fs.existsSync(dir)) throw new Error('源码目录不存在: ' + dir);
      walk(dir, list, opt.ext);
    }
  }
  const exRes = opt.exclude.map(globToRegExp);
  if (exRes.length) {
    list = list.filter((f) => {
      const rel = path.relative(repo, f).replace(/\\/g, '/');
      return !exRes.some((re) => re.test(rel));
    });
  }
  list = [...new Set(list.map((f) => path.resolve(f)))].sort();
  if (!list.length) throw new Error('没有匹配到文件');
  return list;
}

// ---------- 主流程 ----------
let files;
let added = null;
try {
  files = resolveFiles();
  if (!opt.all) {
    const rels = files.map((f) => path.relative(repo, f).replace(/\\/g, '/'));
    added = collectDiff(rels);
  }
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}

const report = [];
let totalGroups = 0;
let totalLines = 0;
let totalDups = 0;
let totalDupLines = 0;

for (const abs of files) {
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    console.error('ERROR: 无法读取 ' + rel + ': ' + e.message);
    process.exit(1);
  }
  const lang = langOf(abs);
  const model = parseFile(text, lang);
  const addedMap = added ? added.get(rel) ?? new Map() : null;
  if (addedMap && addedMap.size === 0) continue;

  // 连续注释块
  const groups = [];
  const dups = [];
  let block = [];
  const flushBlock = () => {
    if (!block.length) return;
    for (let s = 0; s < block.length; ) {
      let e = s;
      while (
        e < block.length &&
        !isSeparator(block[e].content) &&
        !ANCHOR.test(block[e].content) &&
        effLen(block[e].content) < opt.maxLen &&
        identTokens(block[e].content).length === 0 &&
        (!addedMap || addedMap.has(block[e].line))
      ) e++;
      if (e - s >= opt.minLines) {
        const g = block.slice(s, e);
        const lead = (x) => [...x.content.replace(/\s+/g, '')].slice(0, 2).join('');
        const sameLead = g.every((x) => lead(x) === lead(g[0]));
        const avgSim =
          g.slice(1).reduce((n, x, k) => n + jaccard(bigrams(x.content), bigrams(g[k].content)), 0) /
          Math.max(1, g.length - 1);
        const label = avgSim >= 0.35 ? '同义重复' : sameLead ? '纯排比' : '短句堆叠';
        groups.push({
          file: rel,
          start: g[0].line,
          end: g[g.length - 1].line,
          count: g.length,
          label,
          avgSim: Number(avgSim.toFixed(3)),
          sameLead,
          avgLen: Number((g.reduce((n, x) => n + effLen(x.content), 0) / g.length).toFixed(1)),
          rows: g.map((x) => ({ line: x.line, text: x.text.trim() })),
        });
        s = e;
      } else s++;
    }

    // 近重复（过度注释）：相邻两行在反复解释同一事实。
    // 已判为短句堆叠的行不再重复计入，避免同一处缺陷被记两次。
    const fillerLines = new Set();
    for (const g of groups) for (const r of g.rows) fillerLines.add(r.line);
    const dupEligible = (x) => x && !isSeparator(x.content) && effLen(x.content) >= 8 && !fillerLines.has(x.line);
    const pairs = [];
    for (let i = 0; i + 1 < block.length; i++) {
      const a = block[i];
      const b = block[i + 1];
      if (!dupEligible(a) || !dupEligible(b)) continue;
      const sim = jaccard(bigrams(a.content), bigrams(b.content));
      if (sim >= opt.simThreshold) pairs.push({ i, sim });
    }
    for (let k = 0; k < pairs.length; ) {
      let j = k;
      while (j + 1 < pairs.length && pairs[j + 1].i === pairs[j].i + 1) j++;
      const g = block.slice(pairs[k].i, pairs[j].i + 2);
      const avgSim = pairs.slice(k, j + 1).reduce((n, x) => n + x.sim, 0) / (j - k + 1);
      dups.push({
        file: rel,
        start: g[0].line,
        end: g[g.length - 1].line,
        count: g.length,
        label: '近重复（过度注释）',
        avgSim: Number(avgSim.toFixed(3)),
        avgLen: Number((g.reduce((n, x) => n + effLen(x.content), 0) / g.length).toFixed(1)),
        rows: g.map((x) => ({ line: x.line, text: x.text.trim() })),
      });
      k = j + 1;
    }
    block = [];
  };
  for (let i = 0; i < model.length; i++) {
    const r = model[i];
    if (r.kind !== 'comment') {
      flushBlock();
      continue;
    }
    // 只收「本次新增」的注释行（--all 时全收），这样组不会被上游注释污染
    if (addedMap && !addedMap.has(i + 1)) {
      flushBlock();
      continue;
    }
    block.push({ line: i + 1, text: r.text, content: r.content });
  }
  flushBlock();

  const singles = [];
  if (opt.single) {
    for (let i = 0; i < model.length; i++) {
      const r = model[i];
      if (r.kind !== 'comment') continue;
      if (addedMap && !addedMap.has(i + 1)) continue;
      if (noReferent(r.content)) singles.push({ line: i + 1, text: r.text.trim(), content: r.content });
    }
  }

  if (groups.length || dups.length || singles.length) report.push({ file: rel, groups, dups, singles });
  for (const g of groups) {
    totalGroups++;
    totalLines += g.count;
  }
  for (const g of dups) {
    totalDups++;
    totalDupLines += g.count;
  }
}

for (const f of report) {
  console.log(`\n== ${f.file} ==`);
  for (const g of f.groups) {
    console.log(
      `L${g.start}-L${g.end}\t${g.count} 行\t${g.label}\tavgSim=${g.avgSim}\tavgLen=${g.avgLen}\t无标识符`,
    );
    for (const r of g.rows) console.log(`  ${r.line} | ${r.text}`);
  }
  for (const g of f.dups) {
    console.log(`DUP L${g.start}-L${g.end}\t${g.count} 行\t${g.label}\tavgSim=${g.avgSim}\tavgLen=${g.avgLen}`);
    for (const r of g.rows) console.log(`  ${r.line} | ${r.text}`);
  }
  for (const s of f.singles) console.log(`SINGLE L${s.line}\t无指代\t${s.text}`);
}

console.log(
  `\nSUMMARY groups=${totalGroups} lines=${totalLines} files=${report.filter((f) => f.groups.length).length} dups=${totalDups} dupLines=${totalDupLines} singles=${
    report.reduce((n, f) => n + f.singles.length, 0)
  } mode=${opt.all ? 'all' : 'diff'}`,
);

if (opt.json) {
  fs.writeFileSync(path.resolve(opt.json), JSON.stringify({ repo, mode: opt.all ? 'all' : 'diff', report }, null, 2));
}

if (opt.failOnHit && (totalGroups > 0 || totalDups > 0 || report.some((f) => f.singles.length))) process.exit(1);
