// 字符串字面量 & 代码 token 与 HEAD 的逐字比对。
// TS/TSX：TypeScript AST 取 StringLiteral / 模板字符串 原文数组，逐项 === 比较。
// Rust：自制词法，取字符串 token（普通/raw）与「去注释去空白后的代码 token」两个数组逐项比较。
// 用法：node zc-tokeneq.mjs <repoRoot> <file1> [file2 ...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2];
const files = process.argv.slice(3);
const tsRoot = 'D:/code/ZCode';
const ts = (await import('file:///' + path.join(tsRoot, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;

// 两侧统一 LF：git show 输出原始 blob 为 LF，工作树在 Windows 上多为 CRLF，
// 不归一会把纯行尾差异误判成字符串内容变化。
const norm = (s) => s.replace(/\r\n/g, '\n');

function headText(rel) {
  try {
    return norm(execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

function tsStrings(text) {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (node) => {
    const k = node.kind;
    if ((k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateExpression) && node.getChildren(sf).length >= 0) {
      if (k !== ts.SyntaxKind.TemplateExpression || node.getChildren(sf).length > 0) out.push(node.getText(sf));
    }
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);
  return out;
}

function rustTokens(text) {
  const strings = [];
  const code = [];
  const n = text.length;
  let i = 0;
  const pushCode = (t) => code.push(t);
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < n && depth > 0) { if (text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      continue;
    }
    const raw = /^(?:b)?r(#*)"/.exec(text.slice(i, i + 8));
    if (raw && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const closer = '"' + raw[1];
      const e = text.indexOf(closer, i + raw[0].length);
      const end = e < 0 ? n : e + closer.length;
      const tok = text.slice(i, end);
      strings.push(tok); pushCode(tok); i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) { if (text[j] === '\\') { j += 2; continue; } if (text[j] === '"') { j++; break; } j++; }
      const tok = text.slice(i, j);
      strings.push(tok); pushCode(tok); i = j; continue;
    }
    if (c === "'") {
      // 字符字面量 'x' / '\n'；否则按生命周期处理
      let j = i + 1; let ok = false;
      if (j < n && text[j] === '\\') { j += 2; if (text[j] === "'") { j++; ok = true; } }
      else if (j + 1 < n && text[j + 1] === "'") { j += 2; ok = true; }
      if (ok) { pushCode(text.slice(i, j)); i = j; continue; }
      pushCode("'"); i++; continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      pushCode(text.slice(i, j)); i = j; continue;
    }
    pushCode(c); i++;
  }
  return { strings, code };
}

let bad = 0;
for (const rel of files) {
  const head = headText(rel);
  const cur = norm(fs.readFileSync(path.join(repo, rel), 'utf8'));
  if (head === null) { console.log(`MISSING_HEAD ${rel}`); bad++; continue; }
  const isRust = rel.endsWith('.rs');
  if (isRust) {
    const a = rustTokens(head); const b = rustTokens(cur);
    const sameStrings = JSON.stringify(a.strings) === JSON.stringify(b.strings);
    const sameCode = JSON.stringify(a.code) === JSON.stringify(b.code);
    if (!sameStrings) {
      const idx = a.strings.findIndex((s, i) => s !== b.strings[i]);
      console.log(`DIFF_STRING ${rel} index=${idx}\n  HEAD=${JSON.stringify(a.strings[idx])}\n  CUR =${JSON.stringify(b.strings[idx])}`);
    }
    if (!sameCode) {
      const idx = a.code.findIndex((s, i) => s !== b.code[i]);
      console.log(`DIFF_CODE ${rel} index=${idx}\n  HEAD=${JSON.stringify(a.code[idx])}\n  CUR =${JSON.stringify(b.code[idx])}`);
    }
    console.log(`FILE ${rel} strings=${a.strings.length}/${b.strings.length} stringsSame=${sameStrings} codeTokensSame=${sameCode}`);
    if (!sameStrings || !sameCode) bad++;
  } else {
    const a = tsStrings(head); const b = tsStrings(cur);
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) {
      const idx = a.findIndex((s, i) => s !== b[i]);
      console.log(`DIFF_STRING ${rel} index=${idx}\n  HEAD=${JSON.stringify(a[idx])}\n  CUR =${JSON.stringify(b[idx])}`);
    }
    console.log(`FILE ${rel} strings=${a.length}/${b.length} stringsSame=${same}`);
    if (!same) bad++;
  }
}
console.log(`SUMMARY files=${files.length} mismatched=${bad}`);
process.exit(bad === 0 ? 0 : 1);
