// 生产代码范围度量：统计 packages 下五个生产 ROOT 的实现文件。
// ROOT：core/src、cli/src、a2a-server/src、sdk/src、vscode-ide-companion/src。
// 排除：*.test.ts(x) / *.spec.ts(x) / __tests__ / e2e / evals / examples / devtools。
// 总账不变量：scopeFiles + outOfScopeFiles = 全仓源码数；且 ROOT 外文件只能落在
// 已登记的 packages/devtools/src 与 packages/test-utils/src。
// 用法：node gc-scope.mjs [--baseline DIR] [--json OUT] [--threshold 30] [--list]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'd:/code/opensource/gemini-cli';
const DENSITY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deep-density.mjs');
const argv = process.argv.slice(2);
let baseline = 'd:/code/_annot_baseline/GC-deep-b1/full';
let json = '';
let threshold = 30;
let listOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--baseline') baseline = argv[++i];
  else if (a === '--json') json = argv[++i];
  else if (a === '--threshold') threshold = Number(argv[++i]);
  else if (a === '--list') listOnly = true;
  else {
    console.error('unknown arg: ' + a);
    process.exit(2);
  }
}

const ROOTS = [
  'packages/core/src',
  'packages/cli/src',
  'packages/a2a-server/src',
  'packages/sdk/src',
  'packages/vscode-ide-companion/src',
];
const EXCLUDE_SEGMENTS = new Set(['__tests__', 'e2e', 'evals', 'examples', 'devtools']);
const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;
// ROOT 外允许存在的生产源码包（测试工具 / 开发工具），其余一律视为漏登记。
const OUT_OF_SCOPE_PREFIXES = ['packages/devtools/src/', 'packages/test-utils/src/'];
// ROOT 内登记排除项（不计入密度考核，但仍在 scopeFiles 中）。
const REGISTERED_EXCLUSIONS = [
  'packages/cli/src/utils/sandboxBuiltinProfiles.ts',
  'packages/cli/src/test-utils/render.tsx',
  'packages/cli/src/test-utils/AppRig.tsx',
  'packages/cli/src/test-utils/mockConfig.ts',
  'packages/core/src/test-utils/mock-tool.ts',
  'packages/core/src/context/system-tests/simulationHarness.ts',
  'packages/core/src/telemetry/loggers.test.circular.ts',
];

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', 'build', '.git'].includes(ent.name)) continue;
      if (EXCLUDE_SEGMENTS.has(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile() && /\.(ts|tsx)$/.test(ent.name) && !TEST_RE.test(ent.name)) {
      out.push(path.relative(REPO, p).replace(/\\/g, '/'));
    }
  }
}

const files = [];
for (const r of ROOTS) {
  const dir = path.join(REPO, r);
  if (!fs.existsSync(dir)) {
    console.error('ERROR: root missing: ' + dir);
    process.exit(1);
  }
  walk(dir, files);
}
files.sort();

// ---------------- 总账不变量 ----------------
// 全仓源码 = packages/*/src 下同一套排除规则得到的全部 .ts/.tsx。
// scopeFiles + outOfScopeFiles = totalSource；ROOT 外只允许登记过的两个包。
const totalSource = [];
const packagesDir = path.join(REPO, 'packages');
for (const ent of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const dir = path.join(packagesDir, ent.name, 'src');
  if (fs.existsSync(dir)) walk(dir, totalSource);
}
totalSource.sort();
const scopeSet = new Set(files);
const outOfScope = totalSource.filter((p) => !scopeSet.has(p));
const missingRegistered = REGISTERED_EXCLUSIONS.filter((p) => !scopeSet.has(p));
const unknownOutOfScope = outOfScope.filter(
  (p) => !OUT_OF_SCOPE_PREFIXES.some((pre) => p.startsWith(pre)),
);
const ledgerOk =
  files.length + outOfScope.length === totalSource.length &&
  missingRegistered.length === 0 &&
  unknownOutOfScope.length === 0;
console.log(
  `LEDGER scopeFiles=${files.length} outOfScopeFiles=${outOfScope.length} totalSource=${totalSource.length} ` +
    `registeredExclusions=${REGISTERED_EXCLUSIONS.length} assessed=${files.length - REGISTERED_EXCLUSIONS.length} ` +
    `sum=${files.length + outOfScope.length}`,
);
if (!ledgerOk) {
  console.error('LEDGER MISMATCH:');
  if (files.length + outOfScope.length !== totalSource.length) {
    console.error(
      `  scopeFiles + outOfScopeFiles = ${files.length + outOfScope.length} != totalSource ${totalSource.length} (差额 ${totalSource.length - files.length - outOfScope.length})`,
    );
  }
  for (const p of missingRegistered) console.error('  登记排除项不存在: ' + p);
  for (const p of unknownOutOfScope) console.error('  ROOT 外未登记源码: ' + p);
  process.exit(2);
}

if (listOnly) {
  console.log(files.join('\n'));
  console.error('scope files=' + files.length);
  process.exit(0);
}

const CHUNK = 150;
const rows = [];
let errors = 0;
for (let i = 0; i < files.length; i += CHUNK) {
  const chunk = files.slice(i, i + CHUNK);
  const out = path.join(path.dirname(DENSITY), '_scope_chunk.json');
  const r = spawnSync(
    process.execPath,
    [
      DENSITY, REPO,
      '--baseline', baseline,
      '--root', 'packages',
      '--ext', '.ts,.tsx',
      '--mode', 'code',
      '--threshold', String(threshold),
      '--quiet',
      '--json', out,
      '--only', chunk.join(','),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (!fs.existsSync(out)) {
    console.error('ERROR: chunk ' + i + ' produced no json; stderr:\n' + (r.stderr || ''));
    errors++;
    continue;
  }
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  rows.push(...parsed.rows);
  fs.unlinkSync(out);
}

const below = rows.filter((x) => x.measured + 1e-9 < threshold);
const needLines = below.reduce((n, x) => n + x.need, 0);
const registered = new Set(REGISTERED_EXCLUSIONS);
const assessedRows = rows.filter((x) => !registered.has(x.path));
const assessedBelow = below.filter((x) => !registered.has(x.path));
const assessedRatios = assessedRows.map((x) => x.measured).sort((a, b) => a - b);
const min = assessedRatios.length ? assessedRatios[0] : 0;
const median = assessedRatios.length
  ? assessedRatios.length % 2
    ? assessedRatios[(assessedRatios.length - 1) / 2]
    : (assessedRatios[assessedRatios.length / 2 - 1] + assessedRatios[assessedRatios.length / 2]) / 2
  : 0;

console.log(
  `SUMMARY scopeFiles=${rows.length} coreBelow30=${below.length} assessed=${assessedRows.length} assessedBelow30=${assessedBelow.length} needLines=${needLines} min=${min.toFixed(2)} median=${median.toFixed(2)}`,
);
if (json) fs.writeFileSync(json, JSON.stringify({ threshold, registeredExclusions: REGISTERED_EXCLUSIONS, rows }, null, 2));
if (errors > 0) {
  console.error(`FAIL: ${errors} chunk(s) failed (fail-closed)`);
  process.exit(1);
}
process.exit(0);
