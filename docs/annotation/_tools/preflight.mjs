#!/usr/bin/env node
// 收口试错的两个一次性命令（b353 起）：把「白名单落后」与「rewrite.tsv 未登记」从手工比对变成一行输出。
//
//   node preflight.mjs --repo <root> --whitelist
//     FRESH                                  meta.head == HEAD
//     STALE-OK docs-only n=<k>               落后 k 个提交，且全部落在 docs/annotation/（放行）
//     STALE-EXPECTED n=<k> source=<m> docs=<d> <sha...>
//                                           落后 k 个提交，全部是本窗口的批次提交
//                                           （`注释清水 bNNN` 源码 + 配套 `docs(注释)` 台账），
//                                           source≤5：增量记账期间预期落后，**不跑产能即可放行**
//     STALE-BAD n=<k> <file...>              落后且含非批次提交 / 触碰 _tools（exit 1，必须先重生成白名单）
//
//   node preflight.mjs --repo <root> --total-start <sha> [--batch-commit <sha>]
//     TOTAL-START OK <short> <date>          起点 sha 存在（给了 --batch-commit 时再校验 == 其父提交）
//     TOTAL-START MISMATCH expect=<sha> got=<sha>    （exit 1）
//     TOTAL-START UNKNOWN <arg> hint=<HEAD~1>       （exit 1；sha 打错时直接给出正确候选）
//
//   node preflight.mjs --repo <root> --batch b353 [--files <list.txt>]
//     REWRITE-TSV OK n=<k>                   docs/annotation/ZC-deep-b353-rewrite.tsv 的文件集 == 清单
//     REWRITE-TSV MISSING <path>             tsv 还没落盘（exit 1）
//     REWRITE-TSV DIFF missing=<file...> extra=<file...>   （exit 1）
//
// 判据不做语义修正：只回答「能不能继续跑产能」，不代替重生成。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { OWN_AUTHORS } from './own-commits-gen.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const repo = opt('repo');
const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
// 静默版：用于「sha 可能不存在」的探测，避免 git 的 fatal 混进一行结论里。
const gitQuiet = (args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

if (argv.includes('--whitelist')) {
  const metaPath = `${repo}/docs/annotation/_tools/OWN-COMMITS.meta.json`;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const head = git(['rev-parse', 'HEAD']);
  if (meta.head === head) {
    console.log('FRESH');
    process.exit(0);
  }
  const changed = git(['diff', '--name-only', `${meta.head}..HEAD`]).split('\n').filter(Boolean);
  const nonDoc = changed.filter((p) => !p.startsWith('docs/annotation/'));
  if (!nonDoc.length) {
    console.log(`STALE-OK docs-only n=${changed.length}`);
    process.exit(0);
  }
  // STALE-EXPECTED：落后提交全部是本窗口自己的批次提交（源码 `注释清水 bNNN` + 配套 docs(注释) 台账），
  // 且源码提交数 ≤5（= 一个 5 批窗口）。此时白名单只用于「增量记账」，不跑产能，属预期落后。
  const shas = git(['rev-list', '--reverse', `${meta.head}..HEAD`]).split('\n').filter(Boolean);
  let source = 0;
  let docs = 0;
  const bad = [];
  for (const sha of shas) {
    const subject = git(['log', '-1', '--format=%s', sha]);
    const author = git(['log', '-1', '--format=%an', sha]);
    const files = git(['show', '--name-only', '--pretty=format:', sha]).split('\n').filter(Boolean);
    // 台账提交每批都会动 `_tools/INDEX.md`，所以只按「路径全在 docs/annotation/」判台账，
    // 不因触碰 _tools 直接判 BAD；真正要拦的是别人的提交和非批次源码提交（见下面两个条件）。
    const onlyDocs = files.every((p) => p.startsWith('docs/annotation/'));
    const isBatchSource = /^注释清水 b\d{3}/.test(subject) && OWN_AUTHORS.includes(author);
    if (!OWN_AUTHORS.includes(author) || !(onlyDocs || isBatchSource)) {
      bad.push(`${sha.slice(0, 8)}(${subject})`);
      continue;
    }
    if (onlyDocs) docs += 1;
    else source += 1;
  }
  if (!bad.length && source >= 1 && source <= 5) {
    console.log(
      `STALE-EXPECTED n=${shas.length} source=${source} docs=${docs} ` +
        `head=${meta.head.slice(0, 8)}..${head.slice(0, 8)} ${shas.map((s) => s.slice(0, 8)).join(' ')}`,
    );
    process.exit(0);
  }
  console.log(`STALE-BAD n=${changed.length} ${(bad.length ? bad : nonDoc).join(' ')}`);
  process.exit(1);
}

const totalStart = opt('total-start');
if (totalStart) {
  const batchCommit = opt('batch-commit');
  const hint = (() => {
    try {
      return gitQuiet(['rev-parse', '--short', 'HEAD~1']);
    } catch {
      return '?';
    }
  })();
  let sha = '';
  try {
    sha = gitQuiet(['rev-parse', '--verify', `${totalStart}^{commit}`]);
  } catch {
    console.log(`TOTAL-START UNKNOWN ${totalStart} hint=${hint}`);
    process.exit(1);
  }
  const when = git(['log', '-1', '--format=%ad', '--date=format:%H:%M:%S', sha]);
  if (batchCommit) {
    const expect = git(['rev-parse', '--verify', `${batchCommit}^`]);
    if (expect !== sha) {
      console.log(`TOTAL-START MISMATCH expect=${expect.slice(0, 8)} got=${sha.slice(0, 8)}`);
      process.exit(1);
    }
    console.log(`TOTAL-START OK ${sha.slice(0, 8)} ${when} = ${batchCommit.slice(0, 8)}~1`);
    process.exit(0);
  }
  console.log(`TOTAL-START OK ${sha.slice(0, 8)} ${when}`);
  process.exit(0);
}

const batch = opt('batch');
if (batch) {
  const tsv = `${repo}/docs/annotation/ZC-deep-${batch}-rewrite.tsv`;
  if (!fs.existsSync(tsv)) {
    console.log(`REWRITE-TSV MISSING ${tsv}`);
    process.exit(1);
  }
  const tsvFiles = new Set(
    fs
      .readFileSync(tsv, 'utf8')
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split('\t')[0]),
  );
  const listPath = opt('files', `d:/code/_annot_baseline/${batch}-files.txt`);
  const list = new Set(fs.readFileSync(listPath, 'utf8').split(/\r?\n/).filter(Boolean));
  const missing = [...list].filter((f) => !tsvFiles.has(f));
  const extra = [...tsvFiles].filter((f) => !list.has(f));
  if (missing.length || extra.length) {
    console.log(`REWRITE-TSV DIFF missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    process.exit(1);
  }
  console.log(`REWRITE-TSV OK n=${list.size}`);
  process.exit(0);
}

console.error(
  'usage: node preflight.mjs --repo <root> --whitelist | --total-start <sha> [--batch-commit <sha>] | --batch b353 [--files <list>]',
);
process.exit(2);
