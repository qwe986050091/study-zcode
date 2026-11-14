// SQL 运行时可编译性实测：从 TS 源码里取出 prepare()/exec() 的模板字符串，
// 去掉 `${...}` 插值后在 node:sqlite 内存库上逐个编译（prepare），全部成功才算通过。
// 用法：node zc-sqlprepare-check.mjs <repoRoot> <file1> [file2 ...]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const repo = process.argv[2] || 'D:/code/ZCode';
const ts = (await import('file:///' + path.join(repo, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
const files = process.argv.slice(3);

const KEYWORDS = new Set(('select insert into update delete from where set values as on conflict do nothing ' +
  'and or not null is in like glob between case when then else end asc desc limit offset order by group having ' +
  'inner left right outer join create table if exists primary key unique index alter add column drop ' +
  'coalesce count sum max min avg cast exists distinct union all returning begin commit rollback ' +
  'integer text real blob numeric current_timestamp').split(/\s+/));

function extractStatements(text) {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (name === 'prepare' || name === 'exec') {
        const arg = node.arguments[0];
        if (arg && (ts.isTemplateExpression(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          out.push({ line, kind: name, sql: arg.getText(sf).replace(/^`|`$/g, '') });
        }
      }
    }
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);
  return out;
}

function normalize(sql) {
  return sql.replace(/\$\{[^}]*\}/g, 'NULL');
}

function stripLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/@[A-Za-z_][A-Za-z0-9_]*/g, ' ');
}

function identifiers(sql) {
  const ids = new Set();
  for (const m of stripLiterals(sql).matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const name = m[0].toLowerCase();
    if (!KEYWORDS.has(name)) ids.add(name);
  }
  return ids;
}

function tables(sql) {
  const found = new Set();
  const re = /\b(?:from|into|update|join|table(?:\s+if\s+not\s+exists)?)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const m of stripLiterals(sql).matchAll(re)) found.add(m[1]);
  return found;
}

const db = new DatabaseSync(':memory:');
const stmts = [];
for (const rel of files) {
  const text = fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(repo, rel), 'utf8');
  for (const s of extractStatements(text)) {
    const sql = normalize(s.sql);
    if (!/\b(select|insert|update|delete|pragma|create|alter|drop)\b/i.test(sql)) continue;
    // PRAGMA 的参数位是标识符而不是字面量，无法用 NULL 占位；它们也不是本次被改动的语句。
    if (/^\s*PRAGMA\b/i.test(sql)) continue;
    stmts.push({ rel, line: s.line, kind: s.kind, sql, rawHasComment: /(^|\n)\s*\/\//.test(s.sql) });
  }
}

// 为所有被引用但尚不存在的表建桩：列取该表相关语句里出现的标识符并集。
const tableCols = new Map();
for (const s of stmts) {
  const ts_ = tables(s.sql);
  for (const t of ts_) {
    if (t.toLowerCase() === 'sqlite_master') continue;
    if (!tableCols.has(t)) tableCols.set(t, new Set());
    for (const id of identifiers(s.sql)) tableCols.get(t).add(id);
  }
}
for (const [table, cols] of tableCols) {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (existing) continue;
  // ON CONFLICT(col) 在 prepare 阶段就要求 col 具备唯一约束，桩表必须补上。
  const conflictCols = new Set();
  for (const s of stmts) {
    const hit = /\bon\s+conflict\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/i.exec(s.sql);
    if (hit && tables(s.sql).has(table)) conflictCols.add(hit[1]);
  }
  const colDefs = [...cols].filter((c) => c !== table).map((c) => `"${c}" TEXT`);
  if (colDefs.length === 0) colDefs.push('"id" TEXT');
  if (conflictCols.size) {
    colDefs.push(`UNIQUE (${[...conflictCols].map((c) => `"${c}"`).join(', ')})`);
  }
  try {
    db.exec(`CREATE TABLE "${table}" (${colDefs.join(', ')});`);
  } catch (e) {
    console.log(`STUB_ERR ${table}: ${e.message}`);
  }
}

let ok = 0;
const failures = [];
for (const s of stmts) {
  try {
    db.prepare(s.sql);
    ok += 1;
  } catch (e) {
    failures.push({ ...s, error: e.message });
    console.log(`ERR ${s.rel}:${s.line} [${s.kind}] ${e.message}`);
    console.log(s.sql.trim().split('\n').map((l) => '    ' + l).join('\n'));
  }
}
console.log(`SUMMARY files=${files.length} statements=${stmts.length} ok=${ok} failed=${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
