// 深度注释密度度量 / 验收脚本（通用：Rust / C-family / Python）
//
// 用法：
//   node deep-density.mjs <repo> --baseline <dir> [--root src] [--ext .rs] [--threshold 30]
//                           [--mode code|total] [--json out.json] [--quiet]
//
//   <repo>       被测仓库根目录（必填）
//   --baseline   基线目录（必填）。基线里保存「本次深注开始前」的同名文件快照，
//                用于把「上游原有注释」与「本次新增注释」分开；缺文件即判失败。
//   --root       源码子目录，逗号分隔，默认 src
//   --ext        扩展名，逗号分隔，默认 .rs
//   --threshold  阈值（百分数），默认 30
//   --mode       code（默认）：注释行 ≥ 阈值% × 代码行（体检报告口径，对应 3,506 行缺口）
//                total：注释行 ≥ 阈值% × 总行（更严格，要求注释密度更高）
//
// 输出：
//   逐文件一行：<ratio>\t<total>\t<code>\t<comment>\t<new>\t<path>
//   末行：SUMMARY files=<n> coreBelow30=<n> needLines=<n> min=<x> median=<x> newComments=<n>
//   有任一条不达标 / 文件缺失 / 解析失败 → 退出码 1（fail-closed，绝不静默通过）
//
// 口径（与 docs/annotation/DEEP-SPEC.md 一致）：
//   - 总行：文件按行切分后的行数（末尾换行不额外计一行）
//   - 空行：trim 后为空的行
//   - 注释行：整行注释（trim 后以该语言的行注释记号开头），或处于块注释状态内的行；
//             行尾注释不计（整行仍算代码行），这样「在代码后面挂一句注释」不能刷密度
//   - Python docstring 不计（只认 #），与体检报告口径一致
//   - 代码行 = 总行 - 空行 - 注释行
//   - ratio = 注释行 / 总行；needLines = max(0, ceil(代码行 × 阈值%) - 注释行)
//   - 新增注释行：基线→当前的 diff 新增行中属于整行注释的行；上游注释 = 注释行 - 新增注释行
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('usage: node deep-density.mjs <repo> --baseline <dir> [--root src] [--ext .rs] [--threshold 30] [--mode code|total] [--json out.json]');
  process.exit(2);
}
const repo = path.resolve(argv[0]);
const opt = { root: 'src', ext: '.rs', threshold: 30, mode: 'code', baseline: '', json: '', quiet: false, only: [], exclude: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--baseline') opt.baseline = argv[++i];
  else if (a === '--only') opt.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--exclude') opt.exclude = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--root') opt.root = argv[++i];
  else if (a === '--ext') opt.ext = argv[++i];
  else if (a === '--threshold') opt.threshold = Number(argv[++i]);
  else if (a === '--mode') opt.mode = argv[++i];
  else if (a === '--json') opt.json = argv[++i];
  else if (a === '--quiet') opt.quiet = true;
  else {
    console.error('unknown arg: ' + a);
    process.exit(2);
  }
}
if (!opt.baseline) {
  console.error('ERROR: --baseline is required (fail-closed: 无法区分上游注释与本次新增)');
  process.exit(2);
}
if (!fs.existsSync(repo)) {
  console.error('ERROR: repo not found: ' + repo);
  process.exit(2);
}
const baselineDir = path.resolve(opt.baseline);
if (!fs.existsSync(baselineDir)) {
  console.error('ERROR: baseline dir not found: ' + baselineDir);
  process.exit(2);
}
if (!['code', 'total'].includes(opt.mode)) {
  console.error('ERROR: --mode must be code|total');
  process.exit(2);
}
if (!Number.isFinite(opt.threshold) || opt.threshold <= 0 || opt.threshold > 100) {
  console.error('ERROR: --threshold must be (0,100]');
  process.exit(2);
}

const roots = opt.root.split(',').map((s) => s.trim()).filter(Boolean);
const exts = opt.ext.split(',').map((s) => s.trim()).filter(Boolean);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error('ERROR: cannot read dir ' + dir + ': ' + e.message);
    process.exit(1);
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['target', 'node_modules', '.git', 'dist', 'build'].includes(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile() && exts.some((e) => ent.name.endsWith(e))) {
      out.push(p);
    }
  }
}

// 逐字符扫描，正确跳过字符串/字符字面量，避免把 "//" 或 "/*" 当注释。
// 返回 { total, blank, comment, code, parseError }
function measure(text, file) {
  const py = file.endsWith('.py');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let comment = 0;
  let blank = 0;
  let block = false; // C 风格块注释状态
  let quote = null; // Python 三引号状态
  for (const raw of lines) {
    const line = raw;
    const t = line.trim();
    if (t === '') {
      blank++;
      continue;
    }
    if (py) {
      if (quote) {
        // docstring 内部：不计注释，也不计代码（按「非代码」处理，归入注释以外的中性行）
        // 为保证 total = blank + comment + code，这里把它记作注释行是不对的；
        // 体检口径要求 docstring 不计注释，因此记为「非注释非空」即代码行会高估代码。
        // 折中且保守：docstring 记为代码行（只会让密度偏低，不会虚高）。
        if (t.includes(quote) && (t.split(quote).length - 1) % 2 === 1) quote = null;
        continue;
      }
      if (t.startsWith('#')) {
        comment++;
        continue;
      }
      const m = /^(?:[rubfRUBF]{0,2})("""|''')/.exec(t);
      if (m) {
        const marker = m[1];
        const rest = t.slice(m[0].length);
        if (!(rest.includes(marker) && (rest.split(marker).length - 1) % 2 === 1)) quote = marker;
        continue;
      }
      continue;
    }
    if (block) {
      comment++;
      if (t.includes('*/')) block = false;
      continue;
    }
    if (t.startsWith('/*')) {
      comment++;
      if (!t.includes('*/')) block = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('#')) {
      comment++;
      continue;
    }
    // 行内出现字符串之外的 /* 时进入块注释（极少数情况），但不把该行计为注释行
    const stripped = stripStrings(t);
    if (stripped.includes('/*') && !stripped.includes('*/')) block = true;
    // 其余一律视为代码行
  }
  const total = lines.length;
  const code = total - blank - comment;
  if (code < 0) return { parseError: 'negative code lines' };
  return { total, blank, comment, code };
}

// 把字符串与字符字面量替换成空串，供块注释探测使用（不追求完备，只求不误判常见写法）
function stripStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && s[i + 1] === '/') break;
    out += c;
    i++;
  }
  return out;
}

function baselineCommentLines(curFile, rel) {
  const baseFile = path.join(baselineDir, rel);
  if (!fs.existsSync(baseFile)) {
    return { error: 'baseline missing: ' + baseFile };
  }
  const baseText = fs.readFileSync(baseFile, 'utf8');
  const baseM = measure(baseText, baseFile);
  if (baseM.parseError) return { error: 'baseline parse error: ' + rel };
  // 用 git diff --no-index 取「新增的整行注释」：约束是只增不删，所以
  // 新增注释行 = 当前注释行 - 上游注释行。这里不依赖 diff 的上下文，直接数 + 行。
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', baseFile, curFile], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { error: 'git diff failed: ' + String(r.error) };
  let addedComment = 0;
  let addedOther = 0;
  let deleted = 0;
  for (const l of (r.stdout || '').split(/\r?\n/)) {
    if (l.startsWith('+') && !l.startsWith('+++')) {
      const t = l.slice(1).trim();
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('*')) addedComment++;
      else if (t !== '') addedOther++;
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      deleted++;
    }
  }
  return { baseComment: baseM.comment, addedComment, addedOther, deleted };
}

const files = [];
for (const r of roots) {
  const dir = path.join(repo, r);
  if (!fs.existsSync(dir)) {
    console.error('ERROR: source root not found: ' + dir);
    process.exit(1);
  }
  walk(dir, files);
}
// --exclude：逗号分隔的 glob（* 匹配单段、** 匹配任意段），作用于相对路径。
// 用途：测试/示例/构建产物不计入验收分母（与 gemini-cli 口径一致）。
function globToRegExp(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}
const excludeRes = opt.exclude.map(globToRegExp);
if (excludeRes.length) {
  const before = files.length;
  for (let i = files.length - 1; i >= 0; i--) {
    const relEx = path.relative(repo, files[i]).replace(/\\/g, '/');
    if (excludeRes.some((re) => re.test(relEx))) files.splice(i, 1);
  }
  if (!opt.quiet) console.error(`EXCLUDED ${before - files.length} file(s) by --exclude`);
}
const selected = opt.only.length
  ? files.filter((f) => opt.only.includes(path.relative(repo, f).replace(/\\/g, '/')))
  : files.slice();
if (opt.only.length && selected.length !== opt.only.length) {
  const have = new Set(selected.map((f) => path.relative(repo, f).replace(/\\/g, '/')));
  for (const want of opt.only) {
    if (!have.has(want)) {
      console.error('ERROR: --only file not found under roots: ' + want);
      process.exit(1);
    }
  }
}
files.length = 0;
files.push(...selected);
if (files.length === 0) {
  console.error('ERROR: no files matched (ext=' + exts.join(',') + ')');
  process.exit(1);
}

const rows = [];
let errors = 0;
for (const abs of files) {
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    console.error('ERROR: cannot read ' + rel + ': ' + e.message);
    errors++;
    continue;
  }
  const m = measure(text, abs);
  if (m.parseError) {
    console.error('ERROR: ' + rel + ': ' + m.parseError);
    errors++;
    continue;
  }
  const b = baselineCommentLines(abs, rel);
  if (b.error) {
    console.error('ERROR: ' + b.error);
    errors++;
    continue;
  }
  if (b.addedOther > 0) {
    console.error('ERROR: ' + rel + ': 新增行里有 ' + b.addedOther + ' 行不是整行注释（违反只增注释约束）');
    errors++;
  }
  if (b.deleted > 0) {
    console.error('ERROR: ' + rel + ': 相对基线删除了 ' + b.deleted + ' 行（违反零删除约束）');
    errors++;
  }
  const ratio = (m.comment / m.total) * 100;
  const codeRatio = (m.comment / m.code) * 100;
  const measured = opt.mode === 'code' ? codeRatio : ratio;
  const need = Math.max(0, Math.ceil((m.code * opt.threshold) / 100) - m.comment);
  const newComments = b.addedComment;
  rows.push({
    path: rel,
    total: m.total,
    blank: m.blank,
    comment: m.comment,
    code: m.code,
    ratio,
    codeRatio,
    measured,
    need,
    newComments,
    upstreamComments: m.comment - newComments,
  });
}

rows.sort((a, b) => a.measured - b.measured || a.path.localeCompare(b.path));
if (!opt.quiet) {
  for (const r of rows) {
    console.log(
      `${r.measured.toFixed(2)}\t${r.total}\t${r.code}\t${r.comment}\t${r.newComments}\t${r.path}`,
    );
  }
}

const below = rows.filter((r) => r.measured + 1e-9 < opt.threshold);
const needLines = below.reduce((n, r) => n + r.need, 0);
const ratios = rows.map((r) => r.measured).sort((a, b) => a - b);
const min = ratios.length ? ratios[0] : 0;
const median = ratios.length
  ? ratios.length % 2
    ? ratios[(ratios.length - 1) / 2]
    : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
  : 0;
const newComments = rows.reduce((n, r) => n + r.newComments, 0);
console.log(
  `SUMMARY files=${rows.length} coreBelow30=${below.length} needLines=${needLines} min=${min.toFixed(2)} median=${median.toFixed(2)} newComments=${newComments}`,
);

if (opt.json) {
  fs.writeFileSync(opt.json, JSON.stringify({ mode: opt.mode, threshold: opt.threshold, rows }, null, 2));
}

if (errors > 0) {
  console.error(`FAIL: ${errors} error(s); see above (fail-closed)`);
  process.exit(1);
}
if (below.length > 0) {
  console.error(
    `FAIL: ${below.length}/${rows.length} file(s) below ${opt.threshold}% (mode=${opt.mode}); needLines=${needLines}`,
  );
  process.exit(1);
}
console.error(`PASS: all ${rows.length} file(s) >= ${opt.threshold}% (mode=${opt.mode})`);
process.exit(0);
