// 改写模式校验（B1 质量修正专用，只读仓库文件，不写入仓库）
// 用法:
//   node rewrite-check.mjs --snapshot d:\code\_annot_baseline\fix-b1\pre [--segments N]
//
// 对快照目录里的每个文件（相对路径与仓库一致）校验：
//   1) orig 基线（未经注释的 HEAD 内容）与 git HEAD 逐字节一致 —— 确保「新增行」口径成立
//   2) pre -> post 的删除行必须是 // 注释行，且 text 不在上游注释集合里（只删自己加的）
//   3) 新增行必须全部是 // 注释行（nonCommentAdded 必须为 0）
//   4) post 的代码 token 流与 orig 逐 token 一致（codeTokenDiff 必须为 0）
//   5) post 的注释行数不少于 orig（绝不吞掉上游原注释）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'file:///D:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js';

const REPO = 'd:/code/opensource/mcp-sdk';
const BASE = 'd:/code/_annot_baseline';
const argv = process.argv.slice(2);
const snapIdx = argv.indexOf('--snapshot');
const SNAP = snapIdx >= 0 ? argv[snapIdx + 1] : path.join(BASE, 'fix-b1', 'pre');
const segIdx = argv.indexOf('--segments');
const rewrittenSegments = segIdx >= 0 ? Number(argv[segIdx + 1]) : 0;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const isComment = line => /^\s*\/\//.test(line);
const commentText = line => line.replace(/^\s*\/\//, '').trim();

function findOrig(rel) {
  for (const d of fs.readdirSync(BASE)) {
    if (!/^mcp-b\d+$/.test(d)) continue;
    const p = path.join(BASE, d, 'orig', rel.split('/').join(path.sep));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 代码指纹：用 TS 解析树遍历所有 token（注释是 trivia，不在树里），
// 只保留 kind + 原文，因此空白与注释的增删不影响结果。
function tokensOf(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const walk = node => {
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      out.push([node.kind, node.getText(sf)]);
    } else {
      out.push(['(', node.kind]);
      for (const c of kids) walk(c);
      out.push([')', node.kind]);
    }
  };
  walk(sf);
  return out;
}

// 逐行 LCS diff（文件不大，O(n*m) 可接受）
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: '=', a: i + 1, b: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', a: i + 1, text: a[i] }); i++; }
    else { ops.push({ t: '+', b: j + 1, text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: '-', a: i + 1, text: a[i] }); i++; }
  while (j < m) { ops.push({ t: '+', b: j + 1, text: b[j] }); j++; }
  return ops;
}

const files = walk(SNAP);
let totalDel = 0, totalAdd = 0, totalCodeDiff = 0, bad = 0;
const detail = [];

for (const abs of files) {
  const rel = path.relative(SNAP, abs).split(path.sep).join('/');
  const postPath = path.join(REPO, rel.split('/').join(path.sep));
  const origPath = findOrig(rel);
  const problems = [];
  if (!origPath) { problems.push('找不到 orig 基线'); }
  if (!fs.existsSync(postPath)) { problems.push('仓库内文件不存在'); }

  const headBytes = execSync(`git -C "${REPO}" show HEAD:${rel}`, { maxBuffer: 1 << 28 });
  const origBytes = origPath ? fs.readFileSync(origPath) : Buffer.alloc(0);
  const norm = b => b.toString('utf8').replace(/\r\n/g, '\n');
  const headHash = crypto.createHash('sha256').update(norm(headBytes)).digest('hex');
  const origHash = crypto.createHash('sha256').update(norm(origBytes)).digest('hex');
  if (origPath && headHash !== origHash) problems.push('orig 基线 ≠ git HEAD（按 LF 归一后仍不同）');

  const pre = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const post = fs.readFileSync(postPath, 'utf8').split(/\r?\n/);
  const orig = origPath ? fs.readFileSync(origPath, 'utf8').split(/\r?\n/) : [];

  const origComments = new Set(orig.filter(isComment).map(commentText));
  const ops = diffLines(pre, post);
  let del = 0, add = 0;
  const deletedLines = [], addedLines = [], upstreamHits = [], nonCommentDel = [], nonCommentAdd = [];
  for (const op of ops) {
    if (op.t === '-') {
      del++;
      deletedLines.push(op.text);
      if (!isComment(op.text)) nonCommentDel.push(op);
      else if (origComments.has(commentText(op.text))) upstreamHits.push(op);
    } else if (op.t === '+') {
      add++;
      addedLines.push(op.text);
      if (!isComment(op.text)) nonCommentAdd.push(op);
    }
  }
  if (nonCommentDel.length) problems.push(`删除非注释行 ${nonCommentDel.length}`);
  if (upstreamHits.length) problems.push(`删除了上游原注释 ${upstreamHits.length}`);
  if (nonCommentAdd.length) problems.push(`新增非注释行 ${nonCommentAdd.length}`);

  let codeDiff = 0;
  let diffDetail = '';
  if (origPath) {
    const ta = tokensOf(orig.join('\n'), rel);
    const tb = tokensOf(post.join('\n'), rel);
    if (ta.length !== tb.length) codeDiff = Math.abs(ta.length - tb.length);
    for (let k = 0; k < Math.min(ta.length, tb.length); k++) {
      if (ta[k][0] !== tb[k][0] || ta[k][1] !== tb[k][1]) {
        codeDiff++;
        diffDetail = `#${k} orig=${JSON.stringify(ta[k])} post=${JSON.stringify(tb[k])}`;
        break;
      }
    }
    if (codeDiff) problems.push(`代码 token 流不一致 (${ta.length} vs ${tb.length}) ${diffDetail}`);
  }

  const origCommentCount = orig.filter(isComment).length;
  const postCommentCount = post.filter(isComment).length;
  if (postCommentCount < origCommentCount) problems.push(`注释行数少于上游 (${postCommentCount}<${origCommentCount})`);

  totalDel += del;
  totalAdd += add;
  totalCodeDiff += codeDiff;
  if (problems.length) bad++;
  detail.push({ rel, del, add, codeDiff, ok: problems.length === 0, problems, deletedLines, addedLines });
  console.log(`${problems.length ? 'FAIL' : 'OK  '} ${rel} del=${del} add=${add} codeDiff=${codeDiff}`);
  for (const p of problems) console.log(`     ! ${p}`);
  if (problems.length) {
    for (const l of [...nonCommentDel, ...nonCommentAdd, ...upstreamHits].slice(0, 5)) console.log(`     >> ${l.t} ${JSON.stringify(l.text)}`);
  }
}

console.log('');
console.log(`SUMMARY files=${files.length} rewrittenSegments=${rewrittenSegments} deletedOwnCommentLines=${totalDel} addedCommentLines=${totalAdd} codeTokenDiff=${totalCodeDiff} bad=${bad}`);
process.exit(bad === 0 && totalCodeDiff === 0 ? 0 : 1);
