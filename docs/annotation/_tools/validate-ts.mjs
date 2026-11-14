// 语法校验（fail-closed）+ 改写记账：
// 1) 用 typescript 编译器解析每个关键文件，任何 parseDiagnostic 都视为失败；
// 2) 与基线快照逐个做 git diff --no-index --numstat，统计 added/deleted。
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const listFile = process.argv[3];
const baseline = process.argv[4];

function loadTs() {
  for (const c of [repo, path.resolve('d:\\code\\_annot_baseline\\tools')]) {
    try {
      return createRequire(path.join(c, '__validate_resolver__.js'))('typescript');
    } catch {
      /* next */
    }
  }
  return null;
}
const ts = loadTs();
if (!ts) {
  console.log('SYNTAX-FAIL typescript unavailable');
  process.exit(1);
}

const files = fs
  .readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean);

let failed = 0;
let addedSum = 0;
let deletedSum = 0;

for (const rel of files) {
  const abs = path.join(repo, rel);
  const source = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(
    abs,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    failed++;
    console.log(`SYNTAX-FAIL ${rel}`);
    for (const d of diags.slice(0, 5)) {
      const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
      console.log(
        `  line ${pos.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
      );
    }
  }

  const baseAbs = path.join(baseline, rel);
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['diff', '--no-index', '--numstat', '--', baseAbs, abs],
      { encoding: 'utf8' },
    );
  } catch (e) {
    out = (e.stdout ?? '').toString();
  }
  const m = out.trim().match(/^(\d+|-)\t(\d+|-)\t/m);
  if (m) {
    addedSum += m[1] === '-' ? 0 : Number(m[1]);
    deletedSum += m[2] === '-' ? 0 : Number(m[2]);
  }
}

console.log(
  `SUMMARY files=${files.length} syntaxFailed=${failed} added=${addedSum} deleted=${deletedSum}`,
);
process.exit(failed === 0 ? 0 : 1);
