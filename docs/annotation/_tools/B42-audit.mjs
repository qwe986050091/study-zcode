import fs from 'node:fs';

const p = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const raw = fs.readFileSync(p, 'utf8');
const lines = raw.split('\n');

// 逐字符扫描：只保留代码骨架（注释与字符串替换为空格，换行保留）
let code = '';
let inBlock = false, inLine = false, inStr = false, inChar = false;
for (let i = 0; i < raw.length; i++) {
  const ch = raw[i], nx = raw[i + 1];
  if (inLine) { code += ch === '\n' ? '\n' : ' '; if (ch === '\n') inLine = false; continue; }
  if (inBlock) { code += ch === '\n' ? '\n' : ' '; if (ch === '*' && nx === '/') { code += ' '; i++; inBlock = false; } continue; }
  if (inStr) { code += ch === '\n' ? '\n' : ' '; if (ch === '\\') { code += ' '; i++; } else if (ch === '"') inStr = false; continue; }
  if (inChar) { code += ' '; if (ch === '\\') { i++; code += ' '; } else if (ch === "'") inChar = false; continue; }
  if (ch === '/' && nx === '/') { inLine = true; code += '  '; i++; continue; }
  if (ch === '/' && nx === '*') { inBlock = true; code += '  '; i++; continue; }
  if (ch === '"') { inStr = true; code += ' '; continue; }
  if (ch === "'") { inChar = true; code += ' '; continue; }
  code += ch;
}

// 找顶层 '{'，回溯签名
const funcs = [];
let depth = 0, sigStart = 0;
const lineOf = (pos) => code.slice(0, pos).split('\n').length;
for (let i = 0; i < code.length; i++) {
  const ch = code[i];
  if (ch === '{') {
    if (depth === 0) {
      const sig = code.slice(sigStart, i);
      const s = sig.trim();
      const ctrl = /^(if|for|while|switch|else|do)\b/.test(s);
      if (!ctrl && sig.includes('(') && !s.startsWith('struct') && !s.startsWith('typedef')) {
        const m = sig.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
        if (m) {
          const name = m[m.length - 1].match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/)[1];
          funcs.push({ name, bracePos: i, sigStart });
        }
      }
    }
    depth++;
  } else if (ch === '}') {
    depth--;
    if (depth === 0) sigStart = i + 1;
  } else if (ch === ';' && depth === 0) {
    sigStart = i + 1;
  }
}

// 计算函数体与注释
const out = [];
for (const f of funcs) {
  let d = 0, endPos = -1;
  for (let i = f.bracePos; i < code.length; i++) {
    if (code[i] === '{') d++;
    else if (code[i] === '}') { d--; if (d === 0) { endPos = i; break; } }
  }
  const startLine = lineOf(f.bracePos);
  const endLine = lineOf(endPos < 0 ? code.length - 1 : endPos);
  let comments = 0, codeLines = 0;
  const sample = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    const t = lines[ln - 1].trim();
    if (!t) continue;
    if (t.startsWith('/*') || t.startsWith('//') || t.startsWith('*')) comments++;
    else { codeLines++; if (codeLines <= 8) sample.push(lines[ln - 1]); }
  }
  let lead = 0;
  for (let ln = startLine - 1; ln >= 1; ln--) {
    const t = lines[ln - 1].trim();
    if (!t) continue;
    if (t.startsWith('/*') || t.startsWith('//') || t.startsWith('*')) lead++;
    else break;
  }
  out.push({ name: f.name, start: startLine, end: endLine, comments, lead, codeLines, sample });
}

const noComment = out.filter((f) => f.comments === 0 && f.lead === 0);
fs.writeFileSync('d:/code/_annot_baseline/B42-audit.tsv',
  'name\tstart\tend\tcomments\tlead\tcodeLines\n' +
  out.map((f) => `${f.name}\t${f.start}\t${f.end}\t${f.comments}\t${f.lead}\t${f.codeLines}`).join('\n') + '\n');
console.log(`FUNCS=${out.length} WITH_COMMENT=${out.length - noComment.length} NO_COMMENT=${noComment.length}`);
console.log('NAMES=' + out.map((f) => f.name).join(','));
for (const f of noComment) {
  console.log(`\n### ${f.name} L${f.start}-${f.end} code=${f.codeLines}`);
  for (const l of f.sample) console.log('  ' + l);
}
