// 代码 token 差异检查：用 AST（不含 trivia）比较"非注释 token"序列，
// 证明本次改动只增加注释、没有改代码。逐节点 getChildren 会跳过注释与空白。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const listFile = process.argv[3];
const baseline = process.argv[4];

function loadTs() {
  for (const c of [repo, path.resolve('d:\\code\\_annot_baseline\\tools')]) {
    try {
      return createRequire(path.join(c, '__tokens_resolver__.js'))('typescript');
    } catch {
      /* next */
    }
  }
  return null;
}
const ts = loadTs();
if (!ts) {
  console.log('TOKEN-FAIL typescript unavailable');
  process.exit(1);
}

function tokens(file) {
  // 基线快照与工作区可能一个 LF 一个 CRLF；块注释/字符串的 token 文本含换行，
  // 不归一会把纯换行差异误报成代码差异。比较前统一成 LF。
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out = [];
  const visit = node => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      out.push(node.kind + ':' + JSON.stringify(node.getText(sf)));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  return out;
}

const files = fs
  .readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean);

let diffs = 0;
for (const rel of files) {
  const a = tokens(path.join(baseline, rel));
  const b = tokens(path.join(repo, rel));
  let first = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      first = i;
      break;
    }
  }
  if (first !== -1) {
    diffs++;
    console.log(
      `TOKEN-DIFF ${rel} index=${first}\n  base=${a[first]}\n  now =${b[first]}`,
    );
  }
}
console.log(`SUMMARY files=${files.length} codeTokenDiff=${diffs}`);
process.exit(diffs === 0 ? 0 : 1);
