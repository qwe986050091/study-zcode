// GraphQL 模板实测：用 graphql.parse 解析源码里的 query，并与 HEAD 的 query 逐字比对。
// 用法：node zc-graphql-check.mjs <repoRoot> <relPath>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2];
const rel = process.argv[3];
const tsRoot = 'D:/code/ZCode';
const ts = (await import('file:///' + path.join(tsRoot, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
const { parse } = await import('file:///' + path.join(tsRoot, 'node_modules/graphql/index.mjs').replace(/\\/g, '/'));

const norm = (s) => s.replace(/\r\n/g, '\n');

function headText(r) {
  return norm(execFileSync('git', ['-C', repo, 'show', `HEAD:${r}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function gqlTemplates(text) {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => {
    if (n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral && /sponsorsActivities/.test(n.text)) {
      out.push(n.text);
    }
    n.getChildren(sf).forEach(visit);
  };
  visit(sf);
  return out;
}

const cur = gqlTemplates(norm(fs.readFileSync(path.join(repo, rel), 'utf8')));
const head = gqlTemplates(headText(rel));

for (const [i, q] of cur.entries()) {
  try {
    const doc = parse(q);
    const defs = doc.definitions.length;
    console.log(`PARSE_OK index=${i} definitions=${defs} chars=${q.length}`);
    const op = doc.definitions[0];
    console.log(`  operation=${op.operation} selections=${op.selectionSet.selections.map((s) => s.name.value).join(',')}`);
  } catch (e) {
    console.log(`PARSE_FAIL index=${i} ${e.message}`);
    process.exitCode = 1;
  }
}

console.log(`COUNT cur=${cur.length} head=${head.length}`);
const same = cur.length === head.length && cur.every((q, i) => q === head[i]);
console.log(`SAME_AS_HEAD=${same}`);
if (!same) {
  const idx = cur.findIndex((q, i) => q !== head[i]);
  console.log(`  HEAD=${JSON.stringify(head[idx])}`);
  console.log(`  CUR =${JSON.stringify(cur[idx])}`);
  process.exitCode = 1;
}
