// 扫描模板字符串内部被误写成 `//` 的注释行（这些文本会随 SQL 一起发送到数据库）。
// 用法：node zc-sqlscan.mjs <repoRoot> <相对目录>
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2] || 'D:/code/ZCode';
const relRoot = process.argv[3] || 'packages/services/src';
// typescript 始终从真实仓库加载；扫描根可以指向任意快照目录。
const tsRoot = process.argv[4] || 'D:/code/ZCode';
const ts = (await import('file:///' + path.join(tsRoot, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;

const files = [];
const walkDir = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walkDir(p);
    } else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      files.push(p);
    }
  }
};
walkDir(path.join(repo, relRoot));

const isLiteralKind = (k) =>
  k === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
  k === ts.SyntaxKind.TemplateHead ||
  k === ts.SyntaxKind.TemplateMiddle ||
  k === ts.SyntaxKind.TemplateTail ||
  k === ts.SyntaxKind.StringLiteral;

let hitFiles = 0;
let hitLines = 0;
for (const abs of files) {
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  const text = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits = [];
  const visit = (node) => {
    if (isLiteralKind(node.kind) && node.getChildren(sf).length === 0) {
      const raw = node.getText(sf);
      if (raw.includes('\n')) {
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        raw.split('\n').forEach((line, i) => {
          if (line.trim().startsWith('//')) hits.push({ line: startLine + i + 1, text: line.trim() });
        });
      }
    }
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);
  if (hits.length) {
    hitFiles++;
    hitLines += hits.length;
    for (const h of hits) console.log(`${rel}:${h.line} :: ${h.text}`);
  }
}
console.log(`SUMMARY files=${files.length} hitFiles=${hitFiles} hitLines=${hitLines}`);
