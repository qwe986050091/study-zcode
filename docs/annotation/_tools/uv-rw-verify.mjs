// uv 回炉（rewrite）校验：改写模式专用，只读仓库，不写入。
//
// 用法：
//   node uv-rw-verify.mjs --phase s1|s2 --snapshot <dir> [--files a,b] [--no-syntax] [--json out]
//
// 口径（fail-closed）：
//   0) 快照目录与文件必须存在；git HEAD 必须能取到每个文件。
//   1) pre -> post 的行级 diff（git --no-index -U0）：
//      - s1（清注水）：删除行允许，但必须整行 `//` 注释，且该文本不出现在 HEAD 的注释集合中
//        （只删我们新增的）；新增行必须是 `//` 注释或空行。
//      - s2（补深）：删除行必须为 0；新增行必须是 `//` 注释或空行。
//   2) 代码 token 等价：剥掉注释后去掉全部空白，pre 与 post 必须逐字一致（codeTokenDiff=0）。
//   3) 注释行数不得低于 HEAD（绝不吞掉上游原注释）。
//   4) 语法：镜像整棵 crates/*/src 后用 rustfmt（edition 2024 + 中性配置 + skip_children）
//      --emit stdout 解析；找不到 rustfmt 一律记失败，绝不跳过算通过。
// 输出末行：
//   SUMMARY files=<n> rewrittenSegments=<n> addedCommentLines=<n> deletedOwnCommentLines=<n>
//           deletedUpstream=<n> codeTokenDiff=<n> nonCommentAdd=<n> syntaxErr=<n> bad=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { linesInsideStrings } from './uv-string-spans.mjs';

const ROOT = 'd:\\code\\opensource\\uv';
const BASE = 'd:\\code\\_annot_baseline';
const NEUTRAL = path.join(BASE, 'rustfmt-neutral.toml');
const TIMEOUT = 120000;

const argv = process.argv.slice(2);
const phaseIdx = argv.indexOf('--phase');
const phase = phaseIdx >= 0 ? argv[phaseIdx + 1] : 's1';
const snapIdx = argv.indexOf('--snapshot');
const SNAP = snapIdx >= 0 ? argv[snapIdx + 1] : path.join(BASE, 'uv-rework', 'pre-' + phase);
const filesIdx = argv.indexOf('--files');
const only = filesIdx >= 0 ? new Set(argv[filesIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)) : null;
const noSyntax = argv.includes('--no-syntax');
const jsonIdx = argv.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : '';

if (!['s1', 's2'].includes(phase)) {
  console.error('ERROR --phase 必须是 s1 或 s2');
  process.exit(2);
}
if (!fs.existsSync(SNAP)) {
  console.error('ERROR 快照目录不存在: ' + SNAP);
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith('.rs')) out.push(p);
  }
  return out;
}

const isLineComment = (line) => /^\s*\/\//.test(line);
const commentText = (line) => line.replace(/^\s*\/\//, '').trim();
const isBlank = (line) => /^\s*$/.test(line);

// 剥掉 Rust 注释（不碰字符串/字符/raw string），返回不含注释的文本。
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // raw string：r"..." / r#"..."# / br#"..."#
    if ((c === 'r' || c === 'b') && src[i + 1] === 'r') {
      const m = /^br(#*)"/.exec(src.slice(i));
      if (m) {
        const hashes = m[1] || '';
        const start = i + m[0].length;
        const closer = '"' + hashes;
        const end = src.indexOf(closer, start);
        if (end < 0) {
          out += src.slice(i);
          break;
        }
        out += src.slice(i, end + closer.length);
        i = end + closer.length;
        continue;
      }
    }
    if (c === 'r') {
      const m = /^r(#*)"/.exec(src.slice(i));
      if (m) {
        const hashes = m[1] || '';
        const start = i + m[0].length;
        const closer = '"' + hashes;
        const end = src.indexOf(closer, start);
        if (end < 0) {
          out += src.slice(i);
          break;
        }
        out += src.slice(i, end + closer.length);
        i = end + closer.length;
        continue;
      }
    }
    if (c === 'b' && src[i + 1] === '"') {
      let j = i + 2;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (c === "'") {
      // 字符字面量：'x' / '\n' / '\u{...}'；其余视为生命周期标记
      if (src[i + 1] === '\\') {
        let j = i + 2;
        while (j < n && src[j] !== "'") j++;
        out += src.slice(i, Math.min(n, j + 1));
        i = Math.min(n, j + 1);
        continue;
      }
      if (i + 2 < n && src[i + 2] === "'") {
        out += src.slice(i, i + 3);
        i += 3;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const nospace = (s) => s.replace(/\s+/g, '');
const norm = (s) => s.replace(/\r\n/g, '\n');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: TIMEOUT, ...opts });
}

// HEAD 的整行注释多重集（用于证明「只删自己加的」）
function headComments(rel) {
  const r = run('git', ['-C', ROOT, 'show', `HEAD:${rel}`]);
  if (r.status !== 0) return null;
  const set = new Map();
  for (const line of norm(r.stdout || '').split('\n')) {
    if (isLineComment(line)) {
      const t = commentText(line);
      set.set(t, (set.get(t) || 0) + 1);
    }
  }
  return set;
}

function diffPrePost(preFile, postFile) {
  const r = run('git', ['--no-pager', 'diff', '--no-index', '--no-color', '-U0', '--', preFile, postFile]);
  if (r.status !== 0 && r.status !== 1) return { ok: false, msg: `git exit ${r.status}` };
  const del = [];
  const add = [];
  let inHunk = false;
  let newLine = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) del.push(line.slice(1));
    else if (line.startsWith('+')) {
      add.push({ text: line.slice(1), line: newLine });
      newLine++;
    }
  }
  return { ok: true, del, add };
}

// 语法：镜像整棵 crates/*/src，rustfmt 只读解析
let rustfmt = null;
if (!noSyntax) {
  const override = process.env.RUSTFMT;
  const cands = [];
  if (override !== undefined) cands.push(override.trim());
  cands.push(
    path.join(os.homedir(), '.rustup', 'toolchains', 'stable-x86_64-pc-windows-msvc', 'bin', 'rustfmt.exe'),
    'rustfmt',
  );
  for (const c of cands) {
    if (!c) continue;
    const r = run(c, ['--version'], { timeout: 30000 });
    if (!r.error && r.status === 0) {
      rustfmt = c;
      break;
    }
  }
  if (!rustfmt) console.error('ERROR rustfmt 不可用，语法检查将全部记失败');
}

let tmpDir = '';
if (rustfmt) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvrw-parse-'));
  const cratesDir = path.join(ROOT, 'crates');
  for (const c of fs.readdirSync(cratesDir)) {
    const crateRoot = path.join(cratesDir, c);
    if (!fs.statSync(crateRoot).isDirectory()) continue;
    const dst = path.join(tmpDir, c);
    fs.mkdirSync(dst, { recursive: true });
    const srcDir = path.join(crateRoot, 'src');
    if (fs.existsSync(srcDir)) fs.cpSync(srcDir, path.join(dst, 'src'), { recursive: true });
    for (const f of fs.readdirSync(crateRoot)) {
      const p = path.join(crateRoot, f);
      if (f.endsWith('.rs') && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dst, f));
    }
  }
}

function syntaxCheck(rel) {
  if (!rustfmt) return { ok: false, msg: 'rustfmt unavailable' };
  const relInCrates = rel.replace(/^crates[\\/]/, '');
  const tmp = path.join(tmpDir, relInCrates);
  if (!fs.existsSync(tmp)) return { ok: false, msg: 'mirror missing: ' + relInCrates };
  const r = run(rustfmt, [
    '--edition',
    '2024',
    '--config-path',
    NEUTRAL,
    '--config',
    'skip_children=true',
    '--emit',
    'stdout',
    tmp,
  ]);
  if (r.error) return { ok: false, msg: String(r.error.message || r.error) };
  const errText = (r.stderr || '').trim();
  if (r.status !== 0 || /error:/i.test(errText)) {
    const first = errText.split(/\r?\n/).find((l) => /error/i.test(l)) || errText.split(/\r?\n/)[0];
    return { ok: false, msg: first || 'exit ' + r.status };
  }
  return { ok: true };
}

let files = walk(SNAP).map((p) => path.relative(SNAP, p).split(path.sep).join('/')).sort();
if (only) files = files.filter((f) => only.has(f));

let rewrittenSegments = 0;
let addedCommentLines = 0;
let deletedOwnCommentLines = 0;
let deletedUpstream = 0;
let codeTokenDiff = 0;
let nonCommentAdd = 0;
let syntaxErr = 0;
let starSlash = 0;
let bad = 0;
let inStringAdd = 0;
const detail = [];

if (files.length === 0) {
  console.error('ERROR 没有待校验文件');
  process.exit(2);
}

for (const rel of files) {
  const preFile = path.join(SNAP, rel.split('/').join(path.sep));
  const postFile = path.join(ROOT, rel.split('/').join(path.sep));
  const problems = [];
  if (!fs.existsSync(postFile)) {
    problems.push('仓库内文件不存在');
    bad++;
    detail.push({ rel, problems });
    console.log(`FAIL ${rel} 仓库内文件不存在`);
    continue;
  }
  const head = headComments(rel);
  if (head === null) problems.push('git HEAD 取不到该文件');

  const preText = norm(fs.readFileSync(preFile, 'utf8'));
  const postText = norm(fs.readFileSync(postFile, 'utf8'));

  const d = diffPrePost(preFile, postFile);
  if (!d.ok) {
    problems.push(d.msg);
  } else {
    const del = d.del.filter((l) => !isBlank(l));
    const adds = d.add.filter((a) => !isBlank(a.text));
    const nonCommentDel = del.filter((l) => !isLineComment(l));
    const nonCommentAddLines = adds.filter((a) => !isLineComment(a.text));
    const upstream = del.filter((l) => isLineComment(l) && head && head.has(commentText(l)));

    if (nonCommentDel.length) problems.push(`删除非注释行 ${nonCommentDel.length}`);
    if (upstream.length) problems.push(`删除了 HEAD 已有注释 ${upstream.length}`);
    if (nonCommentAddLines.length) problems.push(`新增非注释行 ${nonCommentAddLines.length}`);
    if (phase === 's2' && del.length) problems.push(`s2 不允许删除（${del.length} 行）`);
    if (del.length) {
      rewrittenSegments++;
      deletedOwnCommentLines += del.length;
    }
    deletedUpstream += upstream.length;
    nonCommentAdd += nonCommentAddLines.length;
    addedCommentLines += adds.length;
    if (adds.some((a) => a.text.includes('*/'))) {
      starSlash++;
      problems.push('新增注释包含 */');
    }
    // 插入点绝不能落在字符串字面量内部（raw string / indoc! / 多行字符串）：
    // 这类插入编译合法，却会改掉运行时数据或测试期望值，且测试可能一起被改而"通过"。
    const insideString = linesInsideStrings(postText);
    const inString = adds.filter((a) => insideString[a.line - 1]);
    if (inString.length) {
      inStringAdd += inString.length;
      problems.push(`新增注释落在字符串字面量内部 ${inString.length} 行（首个 @${inString[0].line}）`);
    }
  }

  const preTokens = nospace(stripComments(preText));
  const postTokens = nospace(stripComments(postText));
  if (preTokens !== postTokens) {
    codeTokenDiff++;
    let k = 0;
    while (k < Math.min(preTokens.length, postTokens.length) && preTokens[k] === postTokens[k]) k++;
    problems.push(
      `代码 token 流不一致 pre=${preTokens.length} post=${postTokens.length} @${k} ` +
        JSON.stringify(preTokens.slice(Math.max(0, k - 20), k + 30)),
    );
  }

  const headLine = (head ? [...head.values()].reduce((a, b) => a + b, 0) : 0);
  const postComments = postText.split('\n').filter(isLineComment).length;
  if (postComments < headLine) problems.push(`注释行数少于 HEAD (${postComments}<${headLine})`);

  if (!noSyntax) {
    const sc = syntaxCheck(rel);
    if (!sc.ok) {
      syntaxErr++;
      problems.push('SYNTAX ' + sc.msg);
    }
  }

  if (problems.length) bad++;
  detail.push({ rel, problems });
  console.log(`${problems.length ? 'FAIL' : 'OK  '} ${rel}`);
  for (const p of problems) console.log('     ! ' + p);
}

console.log('');
console.log(
  `SUMMARY files=${files.length} rewrittenSegments=${rewrittenSegments} addedCommentLines=${addedCommentLines} ` +
    `deletedOwnCommentLines=${deletedOwnCommentLines} deletedUpstream=${deletedUpstream} ` +
    `codeTokenDiff=${codeTokenDiff} nonCommentAdd=${nonCommentAdd} starSlash=${starSlash} ` +
    `inStringAdd=${inStringAdd} syntaxErr=${syntaxErr} bad=${bad}`,
);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ phase, snapshot: SNAP, detail }, null, 2));
process.exit(
  bad === 0 &&
    codeTokenDiff === 0 &&
    deletedUpstream === 0 &&
    nonCommentAdd === 0 &&
    starSlash === 0 &&
    inStringAdd === 0 &&
    syntaxErr === 0
    ? 0
    : 1,
);
