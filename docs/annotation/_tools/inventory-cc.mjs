// Phase 0 盘点脚本（只读仓库，不修改任何源码）
// 用法：node d:\code\_annot_baseline\inventory-cc.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\claude-code-main';
const OUT = 'd:\\code\\_annot_baseline\\cc-inventory.json';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.screenshots']);
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function analyze(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rawLines = text.split(/\r?\n/);
  const totalLines = rawLines.length;
  let inBlock = false;
  let codeLines = 0;
  let commentLines = 0;
  let chineseCommentLines = 0;
  let headerChineseLines = 0;
  const chineseLineNos = [];

  rawLines.forEach((line, i) => {
    const t = line.trim();
    let isComment = false;
    let chinese = false;
    if (inBlock) {
      isComment = true;
      chinese = CJK.test(t);
      if (t.includes('*/')) inBlock = false;
    } else if (t.startsWith('//')) {
      isComment = true;
      chinese = CJK.test(t);
    } else if (t.startsWith('/*')) {
      isComment = true;
      chinese = CJK.test(t);
      if (!t.includes('*/')) inBlock = true;
    } else if (t.includes('{/*')) {
      isComment = true;
      chinese = CJK.test(t);
    } else {
      const idx = line.indexOf('//');
      if (idx >= 0 && CJK.test(line.slice(idx))) chinese = true;
    }
    if (isComment) commentLines++;
    else if (t.length > 0) codeLines++;
    if (chinese) {
      chineseCommentLines++;
      chineseLineNos.push(i + 1);
      if (i < 60) headerChineseLines++;
    }
  });

  // 导出符号检测
  const exportRe = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/;
  const reExportRe = /^\s*export\s+(?:type\s+)?\{/;
  const exportLines = [];
  const reExportLines = [];
  rawLines.forEach((line, i) => {
    const m = exportRe.exec(line);
    if (m) exportLines.push({ name: m[1], line: i + 1, lineText: line });
    else if (reExportRe.test(line)) reExportLines.push(i + 1);
  });
  // 去重同名（interface + 实现等）
  const seen = new Set();
  const exports = exportLines.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });

  function hasChineseAbove(idx) {
    let n = 0;
    for (let j = idx - 1; j >= 0 && n < 10; j--, n++) {
      const t = rawLines[j].trim();
      if (t === '') continue;
      if (t.startsWith('//') || t.startsWith('*') || t.endsWith('*/') || t.startsWith('/*') || t.includes('{/*')) {
        if (CJK.test(t)) return true;
        continue;
      }
      return false;
    }
    return false;
  }

  let exportsWithChinese = 0;
  for (const e of exports) {
    if (hasChineseAbove(e.line - 1)) exportsWithChinese++;
  }

  // barrel 判定：代码行是否几乎全是 re-export/import
  const nonTrivial = rawLines.filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*') && !t.startsWith('*/');
  });
  const barrelLike = nonTrivial.filter((l) => /^\s*(export\s+(?:type\s+)?(?:\*|\{)|import\s+)/.test(l)).length;
  const isBarrel = nonTrivial.length > 0 && barrelLike / nonTrivial.length > 0.8 && exports.length <= 2;

  return {
    totalLines,
    codeLines,
    commentLines,
    chineseCommentLines,
    headerChineseLines,
    exports: exports.length,
    exportsWithChinese,
    isBarrel,
    chineseLineNos,
  };
}

const all = walk(ROOT);
const files = [];
const dtsFiles = [];
for (const f of all) {
  const base = path.basename(f);
  if (!/\.(ts|tsx)$/.test(base)) continue;
  if (/\.d\.ts$/.test(base)) {
    dtsFiles.push({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), lines: fs.readFileSync(f, 'utf8').split(/\r?\n/).length });
    continue;
  }
  if (/\.(test|spec)\.(ts|tsx)$/.test(base)) continue;
  const a = analyze(f);
  files.push({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), ...a });
}

// 分类：无注释 / 文件头级（待升级 L2）/ L2 达标
for (const f of files) {
  if (f.chineseCommentLines === 0) f.level = 'none';
  else {
    const cov = f.exports > 0 ? f.exportsWithChinese / f.exports : 0;
    const density = f.totalLines > 0 ? f.chineseCommentLines / f.totalLines : 0;
    const l2 = cov >= 0.5 && density >= 0.03;
    f.level = l2 ? 'l2' : 'header';
  }
}

const byDir = {};
for (const f of files) {
  const parts = f.rel.split('/');
  const dir = parts.length === 1 ? '(root)' : parts[0];
  const d = (byDir[dir] ||= { files: 0, lines: 0, none: 0, header: 0, l2: 0, exports: 0, chinese: 0 });
  d.files++;
  d.lines += f.totalLines;
  d[ f.level ]++;
  d.exports += f.exports;
  d.chinese += f.chineseCommentLines;
}

const report = {
  root: ROOT,
  generatedAt: new Date().toISOString(),
  totals: {
    files: files.length,
    lines: files.reduce((s, f) => s + f.totalLines, 0),
    codeLines: files.reduce((s, f) => s + f.codeLines, 0),
    exports: files.reduce((s, f) => s + f.exports, 0),
    chineseCommentLines: files.reduce((s, f) => s + f.chineseCommentLines, 0),
    none: files.filter((f) => f.level === 'none').length,
    header: files.filter((f) => f.level === 'header').length,
    l2: files.filter((f) => f.level === 'l2').length,
    dtsFiles: dtsFiles.length,
    dtsLines: dtsFiles.reduce((s, f) => s + f.lines, 0),
  },
  byDir,
  bigFiles: files.filter((f) => f.totalLines > 800).sort((a, b) => b.totalLines - a.totalLines).map((f) => ({ rel: f.rel, totalLines: f.totalLines, exports: f.exports, level: f.level, chineseCommentLines: f.chineseCommentLines })),
  files,
  dtsFiles,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

const pad = (s, n) => String(s).padEnd(n);
console.log('TOTAL ' + JSON.stringify(report.totals));
console.log('\nDIR SUMMARY');
console.log(pad('dir', 24) + pad('files', 7) + pad('lines', 8) + pad('none', 7) + pad('header', 8) + pad('l2', 6) + pad('exports', 9) + 'chinese');
for (const [dir, d] of Object.entries(byDir).sort((a, b) => b[1].lines - a[1].lines)) {
  console.log(pad(dir, 24) + pad(d.files, 7) + pad(d.lines, 8) + pad(d.none, 7) + pad(d.header, 8) + pad(d.l2, 6) + pad(d.exports, 9) + d.chinese);
}
console.log('\nBIG FILES > 800 lines: ' + report.bigFiles.length);
for (const f of report.bigFiles) console.log(pad(f.totalLines, 7) + '  ' + pad(f.level, 7) + pad(f.exports, 5) + '  ' + f.rel);
