// 覆盖率分区：声明区（import / interface 字段 / 对象字面量属性 / 类型别名）与逻辑区分别报数。
// 用法：node _region-split.mjs <repo> <json> <relPath>
import fs from 'node:fs';
import path from 'node:path';

const [repo, jsonPath, rel] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const row = j.rows.find((r) => r.path === rel) ?? j.rows[0];
const unitLines = row.unitLines ?? [];
const uncovered = new Set((row.uncoveredUnits ?? []).map((u) => u.line));

const ts = (await import('file:///' + path.join(repo, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
const text = fs.readFileSync(path.join(repo, rel), 'utf8');
const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const decl = new Set();
const mark = (node) => {
  const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  for (let l = s; l <= e; l++) decl.add(l);
};
const visit = (node) => {
  if (
    ts.isImportDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isEnumMember(node)
  ) {
    mark(node);
    // 只标节点自身行；interface/type 的子成员会各自被访问并标记，避免整段并入声明区。
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      for (let l = s; l <= sf.getLineAndCharacterOfPosition(node.name.getEnd()).line + 1; l++) decl.add(l);
    }
  }
  ts.forEachChild(node, visit);
};
visit(sf);

const stat = { logic: { u: 0, c: 0 }, decl: { u: 0, c: 0 } };
for (const line of unitLines) {
  const k = decl.has(line) ? 'decl' : 'logic';
  stat[k].u++;
  if (!uncovered.has(line)) stat[k].c++;
}
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');
const total = { u: stat.logic.u + stat.decl.u, c: stat.logic.c + stat.decl.c };
console.log(`全文件    units=${total.u} covered=${total.c} coverage=${pct(total.c, total.u)}%`);
console.log(`逻辑区    units=${stat.logic.u} covered=${stat.logic.c} coverage=${pct(stat.logic.c, stat.logic.u)}%`);
console.log(`声明区    units=${stat.decl.u} covered=${stat.decl.c} coverage=${pct(stat.decl.c, stat.decl.u)}%`);
