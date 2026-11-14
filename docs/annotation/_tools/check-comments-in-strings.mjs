import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const [, , repoArg, listArg, outArg, baseArg] = process.argv;
const repo = path.resolve(repoArg);
// 基线 ref 默认 HEAD。批次随快照提交后 HEAD 已含注释，重跑时传第 5 个参数
// 指定快照提交的父提交，才能复原落盘时的判据条件。
const BASE = baseArg || 'HEAD';
const files = fs
  .readFileSync(listArg, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const req = createRequire(path.join('d:\\code\\_annot_baseline\\tools', '__resolver__.js'));
const ts = req('typescript');

// 只有「本次 diff 新增的行」才可能是我们写进字符串的污染；HEAD 里已有的字符串内
// `//` 是上游内嵌代码（C#、页面脚本、生成 HTML）的合法注释，不能当作违规拦截，
// 否则门禁会在每个自带脚本的文件上永久误报、最终被绕过。
function addedLinesOf(rel) {
  const r = execFileSync('git', ['-C', repo, '--no-pager', 'diff', '-U0', BASE, '--', rel], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const set = new Set();
  let cur = 0;
  for (const l of (r || '').split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      cur = +m[1];
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      set.add(cur);
      cur++;
    }
  }
  return set;
}

// 字符串容器的 AST 区间：落在这些区间里的行，运行时是数据，不是注释。
const STRING_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);
const KIND_NAME = {};
for (const [name, kind] of Object.entries(ts.SyntaxKind)) {
  if (typeof kind === 'number' && KIND_NAME[kind] === undefined) KIND_NAME[kind] = name;
}

function collect(node, out) {
  if (STRING_KINDS.has(node.kind)) {
    out.push({ start: node.getStart(), end: node.getEnd(), kind: KIND_NAME[node.kind] });
  }
  ts.forEachChild(node, (child) => collect(child, out));
}

const hits = [];
const scanned = [];
for (const rel of files) {
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) {
    scanned.push({ file: rel, status: 'missing' });
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const ranges = [];
  collect(sf, ranges);
  ranges.sort((a, b) => a.start - b.start);

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);

  const hitRange = (offset) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (offset < r.start) hi = mid - 1;
      else if (offset >= r.end) lo = mid + 1;
      else return r;
    }
    return null;
  };

  const addedLines = addedLinesOf(rel);
  let fileHits = 0;
  for (let i = 0; i < lineStarts.length; i++) {
    const start = lineStarts[i];
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] : text.length;
    const line = text.slice(start, end);
    const lead = line.length - line.trimStart().length;
    const trimmed = line.trimStart();
    // 整行注释形态：行首空白后是 // 或 /*
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      const r = hitRange(start + lead);
      if (r) {
        hits.push({
          file: rel,
          line: i + 1,
          kind: r.kind,
          form: 'whole-line',
          added: addedLines.has(i + 1),
          snippet: trimmed.slice(0, 80),
        });
        fileHits++;
      }
    }
    // 行内形态：字符串区间内出现 // 或 # 紧跟中文（插入式注释的典型形状）
    const r = hitRange(start + lead);
    if (r && trimmed.length > 0) {
      const m = /(\/\/|#|<!--)\s*[\u4e00-\u9fff]/.exec(line);
      if (m && !trimmed.startsWith('//')) {
        hits.push({
          file: rel,
          line: i + 1,
          kind: r.kind,
          form: 'inline',
          added: addedLines.has(i + 1),
          snippet: trimmed.slice(0, 80),
        });
        fileHits++;
      }
    }
  }
  scanned.push({ file: rel, status: 'ok', stringRanges: ranges.length, hits: fileHits });
}

const addedHits = hits.filter((h) => h.added);
const report = {
  repo,
  files: files.length,
  scanned: scanned.filter((s) => s.status === 'ok').length,
  missing: scanned.filter((s) => s.status === 'missing').map((s) => s.file),
  stringRanges: scanned.reduce((n, s) => n + (s.stringRanges || 0), 0),
  violations: hits.length,
  addedViolations: addedHits.length,
  hits,
};
if (outArg) fs.writeFileSync(outArg, JSON.stringify(report, null, 2));
console.log(
  `SUMMARY files=${files.length} scanned=${report.scanned} stringRanges=${report.stringRanges} violations=${report.violations} addedViolations=${report.addedViolations}`,
);
for (const h of hits) console.log(`${h.added ? 'ADDED' : 'PRE-EXISTING'}\t${h.form}\t${h.kind}\t${h.file}:${h.line}\t${h.snippet}`);
if (report.missing.length) console.log('MISSING ' + report.missing.join(', '));
// 只有「本次新增」的字符串内注释才是我们的污染；HEAD 既有的内嵌代码注释只作清单输出。
process.exit(report.addedViolations > 0 || report.missing.length > 0 ? 1 : 0);
