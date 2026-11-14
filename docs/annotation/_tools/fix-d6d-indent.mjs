// 按 rustfmt --check 的建议修正新增注释行的缩进；只改空白，不删除任何行。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-resolver\\src\\pubgrub\\report.rs';
const NEUTRAL = 'd:\\code\\_annot_baseline\\rustfmt-neutral.toml';

const r = spawnSync('rustfmt', ['--edition', '2024', '--config-path', NEUTRAL, '--check', file], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const out = (r.stdout || '') + (r.stderr || '');
const lines = fs.readFileSync(file, 'utf8').split('\n');

const pairs = [];
let minus = null;
for (const raw of out.split(/\r?\n/)) {
  if (raw.startsWith('Diff in ')) {
    minus = null;
    continue;
  }
  if (raw.startsWith('-') && !raw.startsWith('---')) {
    minus = raw.slice(1);
  } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
    const plus = raw.slice(1);
    if (minus !== null) pairs.push({ minus, plus });
    minus = null;
  }
}

let fixed = 0;
const unresolved = [];
for (const { minus, plus } of pairs) {
  const mt = minus.trim();
  const pt = plus.trim();
  if (!mt.startsWith('//')) {
    unresolved.push({ minus, plus, why: 'source line changed' });
    continue;
  }
  if (!pt.startsWith('//')) {
    unresolved.push({ minus, plus, why: 'comment merged into code line' });
    continue;
  }
  const idx = lines.findIndex((l) => l.trim() === mt);
  if (idx < 0) {
    unresolved.push({ minus, plus, why: 'line not found' });
    continue;
  }
  if (lines[idx] !== plus) {
    lines[idx] = plus;
    fixed++;
  }
}

fs.writeFileSync(file, lines.join('\n'));
console.log('pairs', pairs.length, 'fixed', fixed, 'unresolved', unresolved.length);
for (const u of unresolved) console.log('UNRESOLVED', u.why, '|', u.minus.trim().slice(0, 80), '=>', u.plus.trim().slice(0, 80));
