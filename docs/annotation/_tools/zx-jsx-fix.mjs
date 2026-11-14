// zx-jsx-fix.mjs — 删除 JSX 子节点里会被渲染成可见文本的 `//` 注释行（仅 ZCode）。
//
// 输入：zx-jsx-comment.json 中 repo=ZCode、kind=A 的命中行（AST 判定，见 zx-jsx-comment.mjs）。
// 流程：先建批次快照 orig/<rel>，再逐行删除；删除前逐行断言 trim 后以 "//" 开头（fail-closed）。
// 之后用 `node zc-verify.mjs --rewrite <batch>` 验证 codeTokenDiff=0 / 零代码删除。
//
// 用法：node zx-jsx-fix.mjs [--batch ZC-fix-b118] [--json <检测结果.json>]
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'D:/code/_annot_baseline';
const REPOS = { ZCode: 'D:/code/ZCode', 'gemini-cli': 'd:/code/opensource/gemini-cli' };
const argv = process.argv.slice(2);
const val = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const repoName = val('--only', 'ZCode');
const REPO = REPOS[repoName];
if (!REPO) {
  console.error(`FAIL: unknown repo ${repoName}（可选: ${Object.keys(REPOS).join(', ')}）`);
  process.exit(1);
}
const batch = val('--batch', repoName === 'ZCode' ? 'ZC-fix-b118' : 'GC-jsxfix1');
const jsonPath = val('--json', path.join(BASE, 'zx-jsx-comment.json'));
const batchDir = path.join(BASE, batch);
if (fs.existsSync(batchDir) && !argv.includes('--force')) {
  console.error(`FAIL: batch dir exists: ${batchDir}（换名或加 --force）`);
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const target = payload.results.find((r) => r.repo === repoName);
if (!target) {
  console.error(`FAIL: no ${repoName} result in ` + jsonPath);
  process.exit(1);
}
const hits = target.hits.filter((h) => h.kind === 'A');
if (!hits.length) {
  console.log('no A hits');
  process.exit(0);
}

const byFile = new Map();
for (const h of hits) {
  if (h.added !== true) {
    console.error(`FAIL: hit not added vs HEAD: ${h.file}:${h.line}`);
    process.exit(1);
  }
  if (!byFile.has(h.file)) byFile.set(h.file, []);
  byFile.get(h.file).push(h.line);
}

fs.mkdirSync(path.join(batchDir, 'orig'), { recursive: true });
const rels = [...byFile.keys()].sort();
let deleted = 0;
const perFile = [];
for (const rel of rels) {
  const abs = path.join(REPO, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n');
  const targets = [...new Set(byFile.get(rel))].sort((a, b) => b - a);
  for (const ln of targets) {
    const t = (lines[ln - 1] ?? '').trim();
    if (!t.startsWith('//')) {
      console.error(`FAIL: line ${ln} of ${rel} is not a // comment: ${JSON.stringify(t.slice(0, 80))}`);
      process.exit(1);
    }
  }
  const baseAbs = path.join(batchDir, 'orig', rel);
  fs.mkdirSync(path.dirname(baseAbs), { recursive: true });
  fs.writeFileSync(baseAbs, raw);
  for (const ln of targets) {
    lines.splice(ln - 1, 1);
    deleted++;
  }
  fs.writeFileSync(abs, lines.join('\n'));
  perFile.push({ file: rel, deleted: targets.length });
}

fs.writeFileSync(path.join(batchDir, '_files.txt'), rels.join('\n') + '\n');
fs.writeFileSync(
  path.join(batchDir, '_jsx-fix.json'),
  JSON.stringify({ batch, source: jsonPath, files: rels.length, deletedLines: deleted, perFile }, null, 2),
);
console.log(`batch=${batch} files=${rels.length} deletedLines=${deleted}`);
console.log(`verify: node zc-verify.mjs --rewrite ${batch}`);
