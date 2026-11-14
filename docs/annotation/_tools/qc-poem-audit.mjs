// 质量审计：统计「短句三连」式空洞注释（只统计，不改写）。
// 判据：连续 >=3 行新增注释，每行正文 <25 字符，且不含 ASCII 字母、反引号、下划线。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/ZCode';

function batchKey(label) {
  const m = /^(\d+)([a-z]*)$/.exec(label);
  return m ? [Number(m[1]), m[2]] : [9999, label];
}

const batchDirs = fs
  .readdirSync(BASE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^ZC-deep-b.+$/.test(d.name))
  .map((d) => d.name)
  .map((name) => ({ name, label: name.slice('ZC-deep-b'.length) }))
  .filter((b) => fs.existsSync(path.join(BASE, b.name, 'orig')))
  .sort((a, b) => {
    const ka = batchKey(a.label);
    const kb = batchKey(b.label);
    return ka[0] - kb[0] || String(ka[1]).localeCompare(String(kb[1]));
  });

// 以快照树为清单：不依赖 files.txt 命名。
function listOrigFiles(dir, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listOrigFiles(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

// 只插入不删除：用贪心对齐求出「当前文件里新增的行号」。
function addedLineIndexes(origLines, curLines) {
  const added = new Set();
  let j = 0;
  for (let i = 0; i < curLines.length; i++) {
    if (j < origLines.length && curLines[i] === origLines[j]) {
      j++;
    } else {
      added.add(i);
    }
  }
  return added;
}

function isCommentLine(line) {
  return line.trim().startsWith('//');
}

function contentOf(line) {
  return line.trim().slice(2).trim();
}

function isPoemLine(line) {
  if (!isCommentLine(line)) return false;
  const c = contentOf(line);
  if (c.length === 0) return false;
  if (c.length >= 25) return false;
  if (/[A-Za-z`_]/.test(c)) return false;
  return true;
}

const perBatch = [];
const occurrences = [];
const literalCount = new Map();
let scannedFiles = 0;
let missingOrig = 0;
let addedCommentLines = 0;

for (const batch of batchDirs) {
  const rels = listOrigFiles(path.join(BASE, batch.name, 'orig'));
  let occ = 0;
  let linesHit = 0;
  const filesHit = new Set();
  for (const rel of rels) {
    const origPath = path.join(BASE, batch.name, 'orig', rel);
    const curPath = path.join(REPO, rel);
    if (!fs.existsSync(origPath) || !fs.existsSync(curPath)) {
      missingOrig++;
      continue;
    }
    scannedFiles++;
    const origLines = fs.readFileSync(origPath, 'utf8').split('\n');
    const curLines = fs.readFileSync(curPath, 'utf8').split('\n');
    const added = addedLineIndexes(origLines, curLines);
    const poem = new Set();
    for (const idx of added) {
      if (isCommentLine(curLines[idx])) addedCommentLines++;
      if (isPoemLine(curLines[idx])) poem.add(idx);
    }
    const sorted = [...poem].sort((a, b) => a - b);
    let run = [];
    const flush = () => {
      if (run.length >= 3) {
        occ++;
        linesHit += run.length;
        filesHit.add(rel);
        for (const idx of run) {
          const c = contentOf(curLines[idx]);
          literalCount.set(c, (literalCount.get(c) ?? 0) + 1);
        }
        occurrences.push({
          batch: batch.label,
          file: rel,
          startLine: run[0] + 1,
          runLength: run.length,
          lines: run.map((idx) => contentOf(curLines[idx])),
        });
      }
      run = [];
    };
    for (const idx of sorted) {
      if (run.length === 0 || idx === run[run.length - 1] + 1) run.push(idx);
      else {
        flush();
        run.push(idx);
      }
    }
    flush();
  }
  if (occ > 0) {
    perBatch.push({ batch: batch.label, occurrences: occ, lines: linesHit, files: filesHit.size });
  }
}

const report = {
  scannedFiles,
  missingOrig,
  addedCommentLines,
  batchesScanned: batchDirs.length,
  batchesWithHits: perBatch.length,
  totalOccurrences: occurrences.length,
  totalLines: occurrences.reduce((n, o) => n + o.runLength, 0),
  perBatch,
  worst: [...occurrences]
    .sort((a, b) => b.runLength - a.runLength || avgLen(a) - avgLen(b))
    .slice(0, 10),
  literalTop: [...literalCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  literalDistinct: literalCount.size,
  literalTotal: [...literalCount.values()].reduce((n, v) => n + v, 0),
  occurrences,
};

function avgLen(o) {
  return o.lines.reduce((n, l) => n + l.length, 0) / o.lines.length;
}

fs.writeFileSync(path.join(BASE, 'qc-poem-audit.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`batchesScanned=${report.batchesScanned} scannedFiles=${report.scannedFiles} missingOrig=${report.missingOrig}`);
console.log(`addedCommentLines=${report.addedCommentLines}`);
console.log(`batchesWithHits=${report.batchesWithHits} totalOccurrences=${report.totalOccurrences} totalLines=${report.totalLines}`);
console.log(`literalDistinct=${report.literalDistinct} literalTotal=${report.literalTotal}`);
console.log('--- perBatch ---');
for (const r of perBatch) console.log(`${r.batch}\tocc=${r.occurrences}\tlines=${r.lines}\tfiles=${r.files}`);
console.log('--- worst10 ---');
for (const o of report.worst) {
  console.log(`[B${o.batch}] ${o.file}:${o.startLine} run=${o.runLength} :: ${o.lines.join(' | ')}`);
}
console.log('--- literalTop20 ---');
for (const [text, n] of report.literalTop) console.log(`${n}\t${text}`);
