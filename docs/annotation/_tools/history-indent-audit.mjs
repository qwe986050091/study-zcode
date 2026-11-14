#!/usr/bin/env node
// 历史缩进审计：用第 8 行门禁的判据回放每一批改写提交的 `提交^..提交`。
//
// 判据与 precheck-assert.mjs 的 indentEolCheck 相同：`-U0` 的同一个 hunk 内，
// 删除行与新增行按序配对（1→1 形状），只比两侧都是注释的行，
// 前导空白字节序列与行尾字节必须逐字节不变。代码行不参与（由 token 门禁负责）。
//
// 与在线门禁的唯一差别：两侧都取 `git cat-file --filters <rev>:<file>`。
// 由此 EOL 列在历史里结构性恒 0——对象库存 LF，`--filters` 把两侧都 smudge 成 CRLF；
// 改写脚本当年写坏的 LF 在 `git add` 时已被 core.autocrlf 归一化，历史不可复原。
// 该列仍保留，用于证明「确实查了」而非省略；缩进不受归一化影响，是唯一可回放信号。
//
// 用法：
//   node history-indent-audit.mjs [--repo <path>] [--pairs <tsv>]
// TSV 每行：batch \t commit \t expect_indent \t expect_eol \t note
//   expect_* 是该批已登记的读数（b283 改写 14、b283 修复 12），不是「应为 0」的猜测。
// 退出码：0 = 每批实测与 expect 一致；1 = 任一批偏离（含未登记的非零读数）。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = argOf('--repo', 'd:/code/ZCode');
const pairsFile = argOf('--pairs', path.join(here, 'history-indent-batches.tsv'));
const hitLimit = Number(argOf('--limit', '8'));

const git = (args, opts = {}) =>
  execFileSync('git', ['-C', repo, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });

const isCommentText = (line) => /^[ \t]*(\/\/|\/\*|\*)/.test(line);
const leadOf = (line) => (/^[ \t]*/.exec(line) ?? [''])[0];
const eolOf = (line) => (line.endsWith('\r\n') ? '\\r\\n' : line.endsWith('\n') ? '\\n' : 'EOF');
const splitKeepEol = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// -U0 diff 里按 hunk 配对；数量不等说明有插入/删除，这批不是 1→1 形状，跳过不猜。
function collectPairs(parent, commit, files) {
  const diff = git(['diff', '-U0', parent, commit, '--', ...files], { encoding: 'utf8' });
  const pairs = [];
  let cur = '';
  let oldLn = 0;
  let newLn = 0;
  let olds = [];
  let news = [];
  const flush = () => {
    if (cur && olds.length && olds.length === news.length) {
      for (let i = 0; i < olds.length; i += 1) {
        pairs.push({ file: cur, oldLine: olds[i], newLine: news[i] });
      }
    }
    olds = [];
    news = [];
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      flush();
      cur = line.slice(6);
      continue;
    }
    if (line.startsWith('--- a/')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      flush();
      oldLn = Number(h[1]);
      newLn = Number(h[2]);
      continue;
    }
    if (!cur || line.startsWith('\\')) continue;
    if (line.startsWith('-')) {
      olds.push(oldLn);
      oldLn += 1;
      continue;
    }
    if (line.startsWith('+')) {
      news.push(newLn);
      newLn += 1;
    }
  }
  flush();
  return pairs;
}

function auditCommit(commit) {
  const parent = `${commit}^`;
  const files = git(['diff', '--name-only', parent, commit], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const byFile = new Map();
  for (const p of collectPairs(parent, commit, files)) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  let indentChanged = 0;
  let eolChanged = 0;
  let rawCrlf = 0;
  const hits = [];
  for (const [file, list] of byFile) {
    let before;
    let after;
    try {
      before = git(['cat-file', '--filters', `${parent}:${file}`]).toString('utf8');
      after = git(['cat-file', '--filters', `${commit}:${file}`]).toString('utf8');
    } catch {
      continue;
    }
    // 原始 blob 里的 CRLF 计数：恒 0 才说明 EOL 列是「被归一化抹掉」而非「没查」。
    rawCrlf += (git(['cat-file', '-p', `${parent}:${file}`]).toString('utf8').match(/\r\n/g) ?? []).length;
    rawCrlf += (git(['cat-file', '-p', `${commit}:${file}`]).toString('utf8').match(/\r\n/g) ?? []).length;
    const oldLines = splitKeepEol(before);
    const newLines = splitKeepEol(after);
    for (const p of list) {
      const o = oldLines[p.oldLine - 1];
      const n = newLines[p.newLine - 1];
      if (!o || !n || !isCommentText(o) || !isCommentText(n)) continue;
      const indentBad = leadOf(o) !== leadOf(n);
      const eolBad = eolOf(o) !== eolOf(n);
      if (indentBad) indentChanged += 1;
      if (eolBad) eolChanged += 1;
      if (indentBad || eolBad) {
        hits.push({
          file,
          line: p.newLine,
          oldLead: leadOf(o),
          newLead: leadOf(n),
          oldEol: eolOf(o),
          newEol: eolOf(n),
          detail: `indent ${JSON.stringify(leadOf(o))} => ${JSON.stringify(leadOf(n))} eol ${eolOf(o)} => ${eolOf(n)}`,
        });
      }
    }
  }
  return { indentChanged, eolChanged, rawCrlf, hits };
}

const rows = readFileSync(pairsFile, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [batch, commit, expectIndent, expectEol, note] = l.split('\t');
    return { batch, commit, expectIndent: Number(expectIndent), expectEol: Number(expectEol), note: note ?? '' };
  });

console.log(`HISTORY AUDIT batches=${rows.length} repo=${repo}`);
let unexpected = 0;
let knownBad = 0;
const results = [];
for (const row of rows) {
  const sha = git(['rev-parse', '--short', row.commit], { encoding: 'utf8' }).trim();
  const r = auditCommit(sha);
  const ok = r.indentChanged === row.expectIndent && r.eolChanged === row.expectEol;
  if (!ok) unexpected += 1;
  if (r.indentChanged || r.eolChanged) knownBad += 1;
  results.push({ base: row.batch.replace(/-fix$/, ''), fix: row.batch.endsWith('-fix'), ...r });
  console.log(
    `HISTORY ${row.batch} ${sha} indentChanged=${r.indentChanged} eolChanged=${r.eolChanged} rawCrlf=${r.rawCrlf} expect=${row.expectIndent}/${row.expectEol} exit=${ok ? 0 : 1}${row.note ? `  # ${row.note}` : ''}`,
  );
  for (const h of r.hits.slice(0, hitLimit)) console.log(`  HIT ${h.file}:${h.line} ${h.detail}`);
  if (r.hits.length > hitLimit) console.log(`  HIT …（其余 ${r.hits.length - hitLimit} 行略）`);
}
// 净额断言：一批的改写与其修复必须逐行镜像抵消（旧空白 == 修复后的新空白，
// 且修复前的空白 == 原旧空白），否则「修过」只是换了个方向。
const bases = [...new Set(results.map((r) => r.base))];
for (const base of bases) {
  const group = results.filter((r) => r.base === base);
  if (group.length < 2) continue;
  const [a, b] = group;
  const key = (h) => `${h.file}:${h.line}`;
  const mapA = new Map(a.hits.map((h) => [key(h), h]));
  const mapB = new Map(b.hits.map((h) => [key(h), h]));
  let mirrored = mapA.size === mapB.size;
  if (mirrored) {
    for (const [k, ha] of mapA) {
      const hb = mapB.get(k);
      if (!hb || ha.oldLead !== hb.newLead || ha.newLead !== hb.oldLead || ha.oldEol !== hb.newEol || ha.newEol !== hb.oldEol) {
        mirrored = false;
        break;
      }
    }
  }
  if (!mirrored) unexpected += 1;
  console.log(
    `HISTORY AUDIT NET ${base} lines=${a.indentChanged}/${b.indentChanged} eol=${a.eolChanged}/${b.eolChanged} mirrored=${mirrored ? 'yes' : 'no'} exit=${mirrored ? 0 : 1}`,
  );
}
console.log(
  `HISTORY AUDIT SUMMARY nonzero=${knownBad} unexpected=${unexpected} result=${unexpected ? 'FAIL' : 'PASS'}`,
);
process.exit(unexpected ? 1 : 0);
