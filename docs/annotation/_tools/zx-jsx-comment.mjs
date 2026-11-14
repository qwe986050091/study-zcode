// zx-jsx-comment.mjs — 跨仓库 AST 检测：注释被插入 JSX 子节点后会渲染成页面可见文本。
//
// 判定只走 TypeScript AST，不做文本猜测：
//   A 类（功能缺陷）：JsxText 节点中，按行 trim 后以 "//" 开头的行 → 会被当成页面文本渲染。
//   A2 类（同类风险）：JsxText 行内出现 "//"（排除 "://" 协议），如 "文字 // 说明"。
//   B 类（脆弱写法）：JsxExpressionContainer 内没有任何表达式、只有行注释（{// ...\n}）。
//                     { /* ... */ } 属于合法惯用写法，不算命中。
//
// 覆盖：ZCode（packages + apps + 任意子目录）、claude-code-main、gemini-cli、mobx。
// 输出：控制台汇总 + JSON（默认 _annot_baseline/zx-jsx-comment.json）。
// 同时把命中文件映射回 _annot_baseline 下的批次目录（按各批次 _files.txt），用于说明
// "哪些历史批次把注释插进了 JSX 渲染位"。
//
// 用法：
//   node zx-jsx-comment.mjs                    # 全量四仓库
//   node zx-jsx-comment.mjs --only ZCode       # 单仓库（ZCode|claude-code|gemini-cli|mobx）
//   node zx-jsx-comment.mjs --json out.json
//   node zx-jsx-comment.mjs --include-tests    # 默认扫描全部文件，此开关仅用于显示 test 文件单列
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const TS_PATH = 'D:/code/ZCode/node_modules/typescript/lib/typescript.js';
const ts = require(TS_PATH);

const BASE = 'D:/code/_annot_baseline';
const REPOS = [
  { key: 'ZCode', root: 'D:/code/ZCode', prefixes: ['ZC-'] },
  { key: 'claude-code', root: 'D:/code/claude-code-main', prefixes: ['CC-'] },
  { key: 'gemini-cli', root: 'D:/code/opensource/gemini-cli', prefixes: ['GC-', 'GM-'] },
  { key: 'mobx', root: 'D:/code/opensource/mobx', prefixes: ['MX-'] },
];

const SKIP_DIR = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.turbo', '.git', '.cache',
  'coverage', 'storybook-static', '.idea', '.vscode', 'third_party', 'third-party',
]);

const TEST_RE = /(\.(test|spec)\.(tsx|jsx)$)|([\\/]__tests__[\\/])|([\\/]tests?[\\/])/;

function walk(dir, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile() && /\.(tsx|jsx)$/.test(e.name) && !/\.min\./.test(e.name)) {
      out.push(p);
    }
  }
}

const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// ---- 批次归属：rel 文件 → 批次名集合 ----
function loadBatchMap(prefixes) {
  const map = new Map(); // rel -> Set(batch)
  let dirs = [];
  try {
    dirs = fs.readdirSync(BASE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return map;
  }
  const hit = dirs.filter((n) => prefixes.some((p) => n.toUpperCase().startsWith(p.toUpperCase())));
  for (const b of hit) {
    const f = path.join(BASE, b, '_files.txt');
    if (!fs.existsSync(f)) continue;
    for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const rel = raw.split('\t')[0].trim().replace(/\\/g, '/');
      if (!rel) continue;
      if (!map.has(rel)) map.set(rel, new Set());
      map.get(rel).add(b);
    }
  }
  return map;
}

// 该行是否为本工程新增（相对 HEAD）；非 git 仓库返回 null。
function addedLineSet(root, rel) {
  const r = spawnSync('git', ['-C', root, '--no-pager', 'diff', '-U0', 'HEAD', '--', rel], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const set = new Set();
  let cur = 0;
  for (const l of (r.stdout || '').split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      cur = +m[1];
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      set.add(cur);
      cur++;
    } else if (l.startsWith(' ')) cur++;
  }
  return set;
}

function isInPreOrCode(node, sf) {
  let p = node.parent;
  while (p) {
    if (ts.isJsxElement(p)) {
      const name = p.openingElement.tagName.getText(sf).toLowerCase();
      if (name === 'pre' || name === 'code') return true;
    }
    p = p.parent;
  }
  return false;
}

function scanFile(abs, root) {
  const rel = relOf(root, abs);
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const kind = abs.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
  const diags = (sf.parseDiagnostics ?? []).slice(0, 2).map((d) => String(d.messageText));

  const a = []; // { line, col, kind:'A'|'A2', text, inPre }
  const b = []; // { line, col, text }

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const start = node.getStart(sf);
      const { line: baseLine, character } = sf.getLineAndCharacterOfPosition(start);
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i];
        const t = s.trim();
        if (!t) continue;
        const line = baseLine + i + 1;
        const col = (i === 0 ? character : 0) + (s.length - s.trimStart().length) + 1;
        if (t.startsWith('//')) {
          a.push({ line, col, kind: 'A', text: t, inPre: isInPreOrCode(node, sf) });
        } else {
          // 行内 "//"（排除协议 // 与已经处理过的行首）
          const idx = t.indexOf('//');
          if (idx > 0 && t[idx - 1] !== ':') {
            a.push({ line, col, kind: 'A2', text: t, inPre: isInPreOrCode(node, sf) });
          }
        }
      }
    } else if (ts.isJsxExpression(node) && !node.expression) {
      const own = node.getText(sf);
      const start = node.getStart(sf) + 1;
      const end = node.getEnd(sf) - 1;
      const inner = text.slice(start, end);
      // 抹掉块注释，避免 /* 内含 // */ 的误报
      const stripped = inner.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
      let offset = 0;
      for (const ln of stripped.split('\n')) {
        const col = ln.indexOf('//');
        if (col >= 0) {
          const line = sf.getLineAndCharacterOfPosition(start + offset + col).line + 1;
          b.push({ line, col: col + 1, text: ln.trim(), raw: own.replace(/\s+/g, ' ').slice(0, 120) });
        }
        offset += ln.length + 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { rel, a, b, diags };
}

function scanRepo(repo, opts) {
  const files = [];
  walk(repo.root, files);
  const batchMap = loadBatchMap(repo.prefixes);
  const hits = [];
  const parseErrors = [];
  let testFiles = 0;

  for (const abs of files) {
    if (TEST_RE.test(abs)) testFiles++;
    let res;
    try {
      res = scanFile(abs, repo.root);
    } catch (e) {
      parseErrors.push({ file: relOf(repo.root, abs), error: String(e.message).slice(0, 160) });
      continue;
    }
    if (res.diags.length) parseErrors.push({ file: res.rel, error: res.diags.join(' | ') });
    if (!res.a.length && !res.b.length) continue;

    let added = null;
    const needGit = res.a.length > 0;
    if (needGit) added = addedLineSet(repo.root, res.rel);

    for (const h of res.a) {
      hits.push({
        repo: repo.key, file: res.rel, line: h.line, col: h.col, kind: h.kind, text: h.text,
        inPre: h.inPre, added: added ? added.has(h.line) : null,
        batches: [...(batchMap.get(res.rel) ?? [])],
        parseError: res.diags.length > 0,
      });
    }
    for (const h of res.b) {
      hits.push({
        repo: repo.key, file: res.rel, line: h.line, col: h.col, kind: 'B', text: h.text,
        raw: h.raw, inPre: false, added: null,
        batches: [...(batchMap.get(res.rel) ?? [])],
        parseError: res.diags.length > 0,
      });
    }
  }
  return { repo: repo.key, root: repo.root, filesScanned: files.length, testFiles, parseErrors, hits };
}

function summarize(results) {
  const rows = [];
  for (const r of results) {
    const A = r.hits.filter((h) => h.kind === 'A');
    const A2 = r.hits.filter((h) => h.kind === 'A2');
    const B = r.hits.filter((h) => h.kind === 'B');
    const filesA = new Set(A.map((h) => h.file)).size;
    const filesB = new Set(B.map((h) => h.file)).size;
    rows.push({
      repo: r.repo, filesTsx: r.filesScanned, testFiles: r.testFiles,
      parseErrorFiles: new Set(r.parseErrors.map((p) => p.file)).size,
      aLines: A.length, aFiles: filesA,
      a2Lines: A2.length,
      bLines: B.length, bFiles: filesB,
      addedByUs: A.filter((h) => h.added === true).length,
      preExisting: A.filter((h) => h.added === false).length,
      unknownGit: A.filter((h) => h.added === null).length,
      annotatedFiles: new Set([...A, ...A2, ...B].flatMap((h) => h.batches)).size,
    });
  }
  return rows;
}

function batchTable(results) {
  const m = new Map(); // batch -> {repo, files:Set, a, a2, b}
  for (const r of results) {
    for (const h of r.hits) {
      for (const b of h.batches) {
        if (!m.has(b)) m.set(b, { repo: r.repo, files: new Set(), a: 0, a2: 0, b: 0 });
        const e = m.get(b);
        e.files.add(h.file);
        if (h.kind === 'A') e.a++;
        else if (h.kind === 'A2') e.a2++;
        else e.b++;
      }
    }
  }
  return [...m.entries()]
    .map(([batch, e]) => ({ batch, repo: e.repo, files: e.files.size, a: e.a, a2: e.a2, b: e.b }))
    .sort((x, y) => y.a - x.a || y.b - x.b || x.batch.localeCompare(y.batch));
}

// ---- main ----
const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = argVal('--only');
const jsonOut = argVal('--json') ?? path.join(BASE, 'zx-jsx-comment.json');
const includeTests = argv.includes('--include-tests');

const targets = REPOS.filter((r) => !only || r.key.toLowerCase() === only.toLowerCase() || r.prefixes.some((p) => p.toLowerCase() === only.toLowerCase()));
if (!targets.length) {
  console.error('unknown --only, expected: ' + REPOS.map((r) => r.key).join(' | '));
  process.exit(2);
}

const t0 = Date.now();
const results = [];
for (const repo of targets) {
  if (!fs.existsSync(repo.root)) {
    console.error(`SKIP ${repo.key}: missing ${repo.root}`);
    continue;
  }
  const res = scanRepo(repo, { includeTests });
  results.push(res);
  const A = res.hits.filter((h) => h.kind === 'A');
  const A2 = res.hits.filter((h) => h.kind === 'A2');
  const B = res.hits.filter((h) => h.kind === 'B');
  console.log(`== ${repo.key}  tsx=${res.filesScanned}  A=${A.length}  A2=${A2.length}  B=${B.length}  parseErrorFiles=${new Set(res.parseErrors.map((p) => p.file)).size}`);
  for (const h of A) {
    const tag = h.added === true ? 'ADDED' : h.added === false ? 'PRE' : '?';
    console.log(`   A  ${h.file}:${h.line}  [${tag}]${h.inPre ? ' [pre/code]' : ''} ${h.text}`);
  }
  if (A2.length) for (const h of A2) console.log(`   A2 ${h.file}:${h.line}  ${h.text}`);
  if (B.length) for (const h of B) console.log(`   B  ${h.file}:${h.line}  ${h.text}`);
  for (const p of res.parseErrors) console.log(`   ! parse ${p.file} :: ${p.error}`);
}

const summary = summarize(results);
const batches = batchTable(results);

console.log('\n== SUMMARY');
for (const r of summary) {
  console.log(`${r.repo}: tsx=${r.filesTsx} A=${r.aLines}(${r.aFiles}f, added=${r.addedByUs}, pre=${r.preExisting}, ?=${r.unknownGit}) A2=${r.a2Lines} B=${r.bLines}(${r.bFiles}f) parseErrFiles=${r.parseErrorFiles}`);
}
if (batches.length) {
  console.log('\n== BATCH ATTRIBUTION (仅命中文件所属批次)');
  for (const b of batches) console.log(`${b.batch}: files=${b.files} A=${b.a} A2=${b.a2} B=${b.b}`);
}

const payload = {
  generatedAt: new Date().toISOString(),
  typescript: ts.version,
  elapsedMs: Date.now() - t0,
  summary,
  batches,
  results: results.map((r) => ({ repo: r.repo, root: r.root, filesScanned: r.filesScanned, testFiles: r.testFiles, parseErrors: r.parseErrors, hits: r.hits })),
};
fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2), 'utf8');
console.log(`\nJSON -> ${jsonOut}  (${payload.elapsedMs}ms)`);
