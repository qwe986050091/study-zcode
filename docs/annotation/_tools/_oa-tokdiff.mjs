// 定位 codeTokenDiff：打印首个不一致 token 附近的节点种类与源码行。
import fs from 'node:fs';

const ts = (await import('file:///d:/code/ZCode/node_modules/typescript/lib/typescript.js')).default;

const REL = 'packages/services/src/oauth/oauthService.ts';
const JsxTextKind = ts.SyntaxKind.JsxText;
const base = fs.readFileSync('d:/code/_annot_baseline/_cad-oauth/orig/' + REL, 'utf8').replace(/\r\n/g, '\n');
const cur = fs.readFileSync('d:/code/ZCode/' + REL, 'utf8').replace(/\r\n/g, '\n');

function tokensOf(text) {
  const sf = ts.createSourceFile(REL, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const walk = (node) => {
    if (node.kind === ts.SyntaxKind.JSDoc) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      out.push({ s: node.kind + '\0' + node.getText(sf), node, sf });
    } else {
      out.push({ s: '(' + node.kind, node, sf });
      for (const c of kids) walk(c);
      out.push({ s: ')' + node.kind, node, sf });
    }
  };
  walk(sf);
  return out;
}

const a = tokensOf(base);
const b = tokensOf(cur);
const n = Math.min(a.length, b.length);
let i = 0;
while (i < n && a[i].s === b[i].s) i++;
for (const [name, list] of [['base', a], ['cur', b]]) {
  console.log('---', name, 'around', i);
  for (let k = Math.max(0, i - 3); k < Math.min(list.length, i + 4); k++) {
    const t = list[k];
    const line = t.sf.getLineAndCharacterOfPosition(t.node.getStart(t.sf)).line + 1;
    console.log(k, 'L' + line, JSON.stringify(t.s.slice(0, 80)));
  }
}
