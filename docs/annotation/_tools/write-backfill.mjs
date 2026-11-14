// 把回填块写回 20 份台账。
// 原则：只写实测值。现行 W/POEM/L 判据下未通过的，写 waterLines=N 与「未通过」，
// 不写 PASS——回填不是重新验收，也不是替旧批次背书。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = 'D:/code/_annot_baseline';
const DOCS = 'D:/code/ZCode/docs/annotation';
const SNAP = 'a8784b7e';
const PREFIX = '8f7daaf0';

const results = JSON.parse(fs.readFileSync(path.join(BASE, 'snapshot', 'backfill-results.json'), 'utf8'));

// b224 单独修正：它的 4 个文件在 a8784b7e 之前就已由 b34d5ba5 提交，
// 以 8f7daaf0 为基线重跑会得到 addedCommentLines=0 的假 PASS，必须用 b34d5ba5^。
const b224 = results.find((r) => r.batch === 'ZC-deep-b224');
const B224_COMMIT = 'b34d5ba5';
const b224Base = execFileSync('git', ['-C', 'D:/code/ZCode', 'rev-parse', B224_COMMIT + '^'], { encoding: 'utf8' }).trim();
const gateOut = execFileSync(
  process.execPath,
  [path.join(BASE, 'zc-gate.mjs'), '--scan', path.join(BASE, 'ZC-deep-b224', '_files.txt'), '--base', b224Base],
  { cwd: BASE, encoding: 'utf8' },
);
b224.gates.gate = gateOut.split(/\r?\n/).filter((l) => l.startsWith('SUMMARY')).pop();
b224.fixedNumstat = { commit: B224_COMMIT, added: 120, deleted: 0 };
b224.allPass = /badFiles=0/.test(b224.gates.gate);

const totalWater = results.reduce((s, r) => {
  const m = /waterLines=(\d+)/.exec(r.gates.gate || '');
  return s + (m ? Number(m[1]) : 0);
}, 0);
const totalAdded = results.reduce((s, r) => s + (r.fixedNumstat ? r.fixedNumstat.added : r.added), 0);
const passCount = results.filter((r) => r.allPass).length;

for (const r of results) {
  const file = path.join(DOCS, `ZC-DEEP-b${r.n}.md`);
  if (!fs.existsSync(file)) {
    console.error('缺台账: ' + file);
    continue;
  }
  let doc = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (doc.includes('## 提交回填（2026-11-10）')) {
    console.log('skip ' + r.batch);
    continue;
  }
  const commit = r.fixedNumstat ? r.fixedNumstat.commit : SNAP;
  const added = r.fixedNumstat ? r.fixedNumstat.added : r.added;
  const deleted = r.fixedNumstat ? r.fixedNumstat.deleted : r.deleted;
  const wm = /waterLines=(\d+)/.exec(r.gates.gate || '');
  const acm = /addedCommentLines=(\d+)/.exec(r.gates.gate || '');
  const water = wm ? Number(wm[1]) : null;
  const commentAdded = acm ? Number(acm[1]) : null;

  const verdict = r.allPass
    ? '门禁 PASS'
    : `门禁 未通过（现行 W/POEM/L 判据：waterLines=${water}${commentAdded !== null ? ' / ' + commentAdded : ''}）`;

  const block = [
    '',
    '## 提交回填（2026-11-10）',
    '',
    '```text',
    `${r.batch} | 提交 ${commit} | numstat ${added} ${deleted} | ${verdict}`,
    '```',
    '',
    '口径与边界：',
    '',
    `- **提交边界不代表批次边界。** ${r.fixedNumstat ? `本批由 \`${commit}\` 单独提交（numstat ${added} 0），与快照提交 \`${SNAP}\` 无关。` : `本批注释在安全快照 \`${SNAP}\` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。`}`,
    `- 门禁以 \`${r.fixedNumstat ? B224_COMMIT + '^' : PREFIX}\` 为基线重跑（\`--base\` / \`--diff-base\`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。`,
    '- 六件套原始 SUMMARY：',
    '',
    '```text',
    `deep-gate    ${r.gates.gate}`,
    `zc-verify    ${r.gates.verify}`,
    `code-tokens  ${r.gates.tokens}`,
    `in-strings   ${r.gates.strings}`,
    `boilerplate  ${r.gates.boiler}`,
    `upstream     ${r.gates.upstream}`,
    '```',
    '',
    r.allPass
      ? '- 结论：六件套全部通过，本批可标「已提交、已验证」。'
      : `- 结论：**六件套未全通过**。waterLines=${water} 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。`,
    '',
  ].join('\n');

  fs.writeFileSync(file, doc.replace(/\s*$/, '\n') + block, 'utf8');
  console.log(`wrote ${r.batch} ${verdict}`);
}

console.log(`\nTOTAL batches=${results.length} pass=${passCount} added=${totalAdded} water=${totalWater}`);
