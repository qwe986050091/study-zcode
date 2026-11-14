// 临时调试：打印 HEAD 与当前文件指定 token 区间，定位 token 流漂移。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = 'D:/code/ZCode';
const rel = process.argv[2];
const from = Number(process.argv[3] || 1660);
const to = Number(process.argv[4] || 1710);
const ts = (await import('file:///' + path.join(repo, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
const head = spawnSync('git', ['-C', repo, 'show', 'HEAD:' + rel], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout;
const cur = fs.readFileSync(path.join(repo, rel), 'utf8');

const tokensOf = (text, tsx) => {
  const norm = text.replace(/\r\n/g, '\n');
  const sf = ts.createSourceFile('x.ts', norm, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const walk = (node) => {
    if (node.kind === ts.SyntaxKind.JSDoc) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push(`${node.kind}\u0000${node.getText(sf)}\u0000L${lc.line + 1}`);
    } else {
      out.push('(' + node.kind);
      for (const c of kids) walk(c);
      out.push(')' + node.kind);
    }
  };
  walk(sf);
  return out;
};
const a = tokensOf(head, rel.endsWith('.tsx'));
const b = tokensOf(cur, rel.endsWith('.tsx'));
for (let i = from; i < Math.min(to, Math.max(a.length, b.length)); i++) {
  console.log(`${i}\tHEAD=${JSON.stringify(a[i])}\tCUR=${JSON.stringify(b[i])}`);
}
