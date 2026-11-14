import fs from 'node:fs';
import path from 'node:path';
const repo = 'D:/code/ZCode';
const rel = 'packages/desktop/src/main/browserView/browserGuestManager.ts';
const j = JSON.parse(fs.readFileSync('D:/code/_annot_baseline/_tmp-bgm.json', 'utf8'));
const row = j.rows[0];
const ts = (await import('file:///' + path.join(repo, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
const text = fs.readFileSync(path.join(repo, rel), 'utf8');
const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const decl = new Map();
const visit = (node) => {
  const kind =
    ts.isImportDeclaration(node) ? 'import' :
    ts.isPropertySignature(node) ? 'propSig' :
    ts.isPropertyAssignment(node) ? 'propAssign' :
    ts.isEnumMember(node) ? 'enum' :
    ts.isInterfaceDeclaration(node) ? 'iface' :
    ts.isTypeAliasDeclaration(node) ? 'typeAlias' : null;
  if (kind) {
    const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (kind === 'import' || kind === 'propSig' || kind === 'propAssign' || kind === 'enum')
      for (let l = s; l <= e; l++) decl.set(l, kind);
  }
  ts.forEachChild(node, visit);
};
visit(sf);
const src = text.split(/\r?\n/);
for (const u of row.uncoveredUnits) {
  if (u.line >= 82 && u.line <= 618 && decl.has(u.line))
    console.log(`${u.line}\t${decl.get(u.line)}\t${src[u.line - 1].trim().slice(0, 100)}`);
}
