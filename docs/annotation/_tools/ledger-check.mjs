#!/usr/bin/env node
// 注释范围总账断言（redb / valkey / uv / mobx）
//
// 目的：把各仓库 docs/annotation/README-summary.md 里的「范围声明（显式清单）」
//       变成可执行的不变量：
//         scopeFiles + excludedFiles === 全仓源码文件数
//       并且两类清单互不重叠、每条声明都能在磁盘上落到实处。
//
// 用法：
//   node d:\code\_annot_baseline\ledger-check.mjs             # 跑全部四个仓库
//   node d:\code\_annot_baseline\ledger-check.mjs redb uv     # 只跑指定仓库
//   node d:\code\_annot_baseline\ledger-check.mjs --list      # 只打印配置摘要
//
// 退出码（fail-closed）：
//   0  四个仓库全部算平且无差额
//   1  存在差额（未归类文件 / 清单失效项 / 重复计入 / 计数漂移）
//   2  配置或 IO 错误（仓库目录不存在、扩展名枚举为 0、用法错误等）
//
// 三类差额（对应任务要求）：
//   A. unlisted  既不在考核范围、也不在排除清单里的文件
//   B. stale     清单里声明了、但磁盘上匹配不到任何文件的条目（含精确路径已不存在）
//   C. duplicate 同时被多条清单（或跨 scope/excluded）计入的文件

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 仓库配置
//
// 每个条目的 `expect` 必须与 docs/annotation/README-summary.md 中声明的数字一致；
// 仓库内容变化时先改文档、再同步这里，否则本检查会以「计数漂移」失败。
// ---------------------------------------------------------------------------
const REPOS = {
  redb: {
    root: 'd:/code/opensource/redb',
    exts: ['.rs'],
    skipDirs: ['.git', 'target', 'node_modules'],
    scope: [
      { glob: 'src/**/*.rs', expect: 48, note: '主 crate 生产代码' },
      { glob: 'crates/*/src/**/*.rs', expect: 12, note: '子 crate 生产代码（含 redb-python / redb-derive / redb-bench / redb-no-std-test / redb-derive-rename-test）' },
      { glob: 'crates/*/build.rs', expect: 1, note: 'cargo 构建脚本（redb-python）' },
      { glob: 'build.rs', expect: 1, note: '根构建脚本（探测 backtrace 能力）' },
    ],
    excluded: [
      { glob: 'tests/**/*.rs', expect: 16, reason: '集成测试，断言行为而非实现' },
      { glob: 'examples/**/*.rs', expect: 4, reason: '示例代码，面向使用者而非维护者' },
      { glob: 'fuzz/**/*.rs', expect: 3, reason: 'fuzz 靶子，属模糊测试脚手架' },
      { glob: 'crates/*/benches/**/*.rs', expect: 10, reason: '基准驱动，属测量脚手架' },
      { glob: 'crates/*/tests/**/*.rs', expect: 3, reason: '子 crate 集成测试' },
    ],
  },
  valkey: {
    root: 'd:/code/opensource/valkey',
    exts: ['.c', '.h'],
    skipDirs: ['.git', 'node_modules'],
    scope: [
      { glob: 'src/**/*.c', expect: 159, note: '服务端生产代码（验收分母固定 159 个 .c）' },
      { glob: 'src/**/*.h', expect: 117, note: '服务端头文件（本批新增入分母）' },
    ],
    excluded: [
      { glob: 'deps/**/*.c', expect: 297, reason: '第三方依赖（jemalloc / lua / lz4 / libvalkey 等）的 C 源，不属本项目代码' },
      { glob: 'deps/**/*.h', expect: 225, reason: '第三方依赖头文件' },
      { glob: 'tests/**/*.c', expect: 53, reason: '集成测试（tests/modules、tests/rdma），全部为 .c' },
      { glob: 'utils/**/*.c', expect: 3, reason: '开发/运维辅助工具，不随服务端发布' },
    ],
  },
  uv: {
    root: 'd:/code/opensource/uv',
    exts: ['.rs'],
    skipDirs: ['.git', 'target', 'node_modules'],
    scope: [
      { glob: 'crates/*/src/**/*.rs', expect: 647, note: '全部 crate 生产代码（含 src/build.rs 这类同名模块）' },
      { glob: 'crates/*/build.rs', expect: 4, note: 'cargo 构建脚本：uv / uv-cli / uv-python-managed / uv-trampoline' },
    ],
    excluded: [
      { glob: 'crates/*/tests/**/*.rs', expect: 101, reason: '集成测试与夹具，断言行为而非实现' },
      { glob: 'crates/*/benches/**/*.rs', expect: 11, reason: '基准驱动，属测量脚手架' },
      { glob: 'test/packages/deptry_reproducer/src/lib.rs', expect: 1, reason: '端到端复现用例的测试包，不随 uv 发布' },
    ],
  },
  mobx: {
    root: 'd:/code/opensource/mobx',
    exts: ['.ts', '.tsx'],
    skipDirs: ['.git', 'node_modules', 'dist', 'lib'],
    scope: [
      { glob: 'packages/mobx/src/**/*.ts', expect: 56, note: '运行时核心包（含 src/global.d.ts）' },
    ],
    excluded: [
      { glob: 'packages/mobx/__tests__/**/*.ts', expect: 11, reason: '核心包单元测试' },
      { glob: 'packages/mobx/jest.setup.ts', expect: 1, reason: '测试环境初始化，属测试脚手架' },
      { glob: 'packages/mobx-react/**', expect: 24, reason: 'React 适配层，独立包、独立维护' },
      { glob: 'packages/mobx-react-lite/**', expect: 25, reason: 'React 轻量适配层，独立包、独立维护' },
      { glob: 'packages/eslint-plugin-mobx/src/**', expect: 6, reason: 'ESLint 工具包，不属于运行时' },
      { glob: 'packages/mobx-undecorate/src/**', expect: 1, reason: '代码迁移工具包，不属于运行时' },
      { glob: 'packages/mobx-undecorate/__tests__/**', expect: 2, reason: '迁移工具包的测试' },
    ],
  },
  zcode: {
    root: 'd:/code/ZCode',
    exts: ['.ts', '.tsx'],
    skipDirs: ['target', 'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.tmp'],
    // 与 zc-measure.mjs 的 defaultExcludes 完全一致：只统计生产代码。
    fileExcludes: [
      /\.test\.tsx?$/,
      /\.spec\.tsx?$/,
      /(^|\/)(__tests__|tests|test|fixtures|examples|__mocks__|mocks)(\/|$)/,
      /(^|\/)generated(\/|$)/,
      /\.generated\.tsx?$/,
      /\.gen\.tsx?$/,
      /\.d\.ts$/,
      /(^|\/)wdio\.conf\.ts$/,
    ],
    // L0 逐字字典同时落在 packages/ui 与 apps 的通配清单内，
    // 声明为排除项优先，避免被当成重复计入。
    excludedWins: true,
    scope: [
      { glob: 'packages/ui/**', expect: 1927, note: 'UI 包生产代码（含 4 个 L0 字典中的 2 个，按排除项优先）' },
      { glob: 'packages/desktop/**', expect: 398, note: '桌面壳层生产代码' },
      { glob: 'packages/shared/**', expect: 301, note: '共享类型与工具' },
      { glob: 'packages/server/**', expect: 56, note: '本地服务端' },
      { glob: 'packages/zcode-server-cli/**', expect: 51, note: '服务端 CLI' },
      { glob: 'packages/web/**', expect: 49, note: 'Web 入口' },
      { glob: 'packages/provider/**', expect: 24, note: 'Provider 契约' },
      { glob: 'packages/provider-node/**', expect: 18, note: 'Node 侧 Provider 实现' },
      { glob: 'packages/rpc/**', expect: 17, note: 'RPC 协议' },
      { glob: 'packages/stream-animate/**', expect: 17, note: '流式动画' },
      { glob: 'packages/client/**', expect: 12, note: '客户端 SDK' },
      { glob: 'packages/e2e-report/**', expect: 10, note: '端到端报告模型' },
      { glob: 'packages/model-option-map/**', expect: 8, note: '模型选项映射' },
      { glob: 'packages/formal-proof/**', expect: 3, note: '形式化证明辅助' },
      { glob: 'packages/web-share/**', expect: 3, note: 'Web 分享' },
      { glob: 'packages/share-ui/**', expect: 1, note: '共享 UI 入口' },
      { glob: 'packages/zcode-cua/**', expect: 1, note: 'CUA 包入口' },
      { glob: 'apps/**', expect: 1657, note: 'CLI / TUI / 插件等应用（含 4 个 L0 字典中的 2 个，按排除项优先）' },
      { glob: 'docs/**', expect: 11, note: '文档站脚本' },
      { glob: 'scripts/**', expect: 2, note: '仓库级脚本' },
    ],
    excluded: [
      { glob: 'packages/services/**', expect: 466, reason: 'services 子工程由另一条线负责，不进入本线分母' },
      { glob: '.agents/**', expect: 83, reason: 'Agent 技能示例脚本，非产品源码；zc-measure 的 ROOTS 亦未纳入，单列为非分母文件' },
      { glob: 'vitest.config.ts', expect: 1, reason: '测试运行器配置，属测试脚手架' },
      { glob: 'vitest.setup.ts', expect: 1, reason: '测试环境初始化，属测试脚手架' },
      { glob: 'packages/ui/src/i18n/locales/en-US.ts', expect: 1, reason: 'L0 逐字字典，不做注释密度考核' },
      { glob: 'packages/ui/src/i18n/locales/zh-CN.ts', expect: 1, reason: 'L0 逐字字典，不做注释密度考核' },
      { glob: 'apps/zcode-cli/packages/i18n/src/locales/en-US.ts', expect: 1, reason: 'L0 逐字字典，不做注释密度考核' },
      { glob: 'apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts', expect: 1, reason: 'L0 逐字字典，不做注释密度考核' },
    ],
  },
};

// ---------------------------------------------------------------------------
// glob → RegExp
//   支持 `**`（跨目录，含零层）、`*`（单层）、`?`；路径统一用 `/`。
//   `**/` 编译为 `(?:.*/)?`，因此 `src/**/*.c` 能匹配 `src/foo.c`。
// ---------------------------------------------------------------------------
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

// ---------------------------------------------------------------------------
// 枚举与匹配
// ---------------------------------------------------------------------------
function walk(root, exts, skipDirs) {
  const out = [];
  const skip = new Set(skipDirs);
  (function rec(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`无法读取目录 ${dir}: ${err.message}`);
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        rec(full);
      } else if (e.isFile() && exts.includes(path.extname(e.name))) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  })(root);
  return out.sort();
}

function classify(files, entries, kind) {
  const owners = new Map(); // rel -> [entryIndex...]
  const matches = entries.map((entry) => {
    const re = globToRegExp(entry.glob);
    return files.filter((rel) => re.test(rel));
  });
  matches.forEach((list, idx) => {
    for (const rel of list) {
      if (!owners.has(rel)) owners.set(rel, []);
      owners.get(rel).push({ kind, idx, glob: entries[idx].glob });
    }
  });
  return { owners, matches };
}

function runRepo(name, cfg) {
  const errors = [];
  if (!fs.existsSync(cfg.root) || !fs.statSync(cfg.root).isDirectory()) {
    return { name, fatal: `仓库目录不存在: ${cfg.root}` };
  }

  const rawFiles = walk(cfg.root, cfg.exts, cfg.skipDirs);
  const files = cfg.fileExcludes && cfg.fileExcludes.length
    ? rawFiles.filter((rel) => !cfg.fileExcludes.some((re) => re.test(rel)))
    : rawFiles;
  const total = files.length;
  if (total === 0) {
    return { name, fatal: `按扩展名 ${cfg.exts.join(',')} 枚举到 0 个文件，口径失效` };
  }

  const scope = classify(files, cfg.scope, 'scope');
  const excluded = classify(files, cfg.excluded, 'excluded');

  const owners = new Map();
  for (const [rel, list] of scope.owners) owners.set(rel, [...list]);
  for (const [rel, list] of excluded.owners) {
    if (!owners.has(rel)) owners.set(rel, []);
    owners.get(rel).push(...list);
  }

  const excludedSet = new Set(excluded.owners.keys());
  const scopeSet = new Set(
    [...scope.owners.keys()].filter((rel) => !(cfg.excludedWins && excludedSet.has(rel))),
  );

  // A. 未归类
  const unlisted = files.filter((rel) => !owners.has(rel));
  // B. 清单失效（匹配 0 文件）
  const stale = [];
  cfg.scope.forEach((entry, i) => {
    if (scope.matches[i].length === 0) stale.push({ kind: 'scope', glob: entry.glob, expect: entry.expect });
  });
  cfg.excluded.forEach((entry, i) => {
    if (excluded.matches[i].length === 0) stale.push({ kind: 'excluded', glob: entry.glob, expect: entry.expect });
  });
  // C. 重复计入（同一文件被 2 条及以上条目命中，含 scope↔excluded 交叉）
  //    excludedWins 时，scope 与 excluded 的交集只归 excluded，不算重复；
  //    但同一侧内部仍必须互斥。
  const duplicates = [...owners.entries()].filter(([rel, list]) => {
    if (cfg.excludedWins && excludedSet.has(rel)) {
      return list.filter((o) => o.kind === 'excluded').length > 1;
    }
    return list.length > 1;
  });

  // 计数漂移：磁盘实际匹配数与文档声明不一致
  const drift = [];
  cfg.scope.forEach((entry, i) => {
    const actual = scope.matches[i].length;
    if (actual !== entry.expect) drift.push({ kind: 'scope', glob: entry.glob, expect: entry.expect, actual });
  });
  cfg.excluded.forEach((entry, i) => {
    const actual = excluded.matches[i].length;
    if (actual !== entry.expect) drift.push({ kind: 'excluded', glob: entry.glob, expect: entry.expect, actual });
  });

  const scopeFiles = scopeSet.size;
  const excludedFiles = excludedSet.size;
  const balanced = scopeFiles + excludedFiles === total;
  const ok = balanced && unlisted.length === 0 && stale.length === 0 && duplicates.length === 0 && drift.length === 0;

  if (!ok) {
    if (!balanced) {
      const diff = total - scopeFiles - excludedFiles;
      errors.push(`总账不平: scope(${scopeFiles}) + excluded(${excludedFiles}) = ${scopeFiles + excludedFiles} != total(${total})，差额 ${diff}`);
    }
    if (unlisted.length) errors.push(`未归类文件 ${unlisted.length} 个`);
    if (stale.length) errors.push(`清单失效条目 ${stale.length} 条`);
    if (duplicates.length) errors.push(`重复计入文件 ${duplicates.length} 个`);
    if (drift.length) errors.push(`计数漂移条目 ${drift.length} 条`);
  }

  return {
    name,
    total,
    scopeFiles,
    excludedFiles,
    balanced,
    ok,
    scope: { ...scope, entries: cfg.scope },
    excluded: { ...excluded, entries: cfg.excluded },
    unlisted,
    stale,
    duplicates,
    drift,
    errors,
  };
}

function printRepo(r) {
  console.log(`\n=== ${r.name} ===`);
  if (r.fatal) {
    console.log(`  FATAL: ${r.fatal}`);
    return;
  }
  const status = r.ok ? 'PASS' : 'FAIL';
  const eq = `${r.scopeFiles} + ${r.excludedFiles} = ${r.scopeFiles + r.excludedFiles} (total ${r.total})`;
  console.log(`  ${status}  scopeFiles + excludedFiles = 全仓源码数  →  ${eq}`);

  const printEntries = (title, entries, matches) => {
    console.log(`  ${title}:`);
    entries.forEach((e, i) => {
      const actual = matches[i].length;
      const flag = actual === e.expect ? 'OK' : `DRIFT(expect ${e.expect})`;
      console.log(`    ${String(actual).padStart(4)}  ${e.glob}  [${flag}]${e.reason ? '  # ' + e.reason : e.note ? '  # ' + e.note : ''}`);
    });
  };
  printEntries('scope', r.scope.entries, r.scope.matches);
  printEntries('excluded', r.excluded.entries, r.excluded.matches);

  if (r.unlisted.length) {
    console.log(`  A. 既不在范围也不在排除清单 (${r.unlisted.length}):`);
    r.unlisted.slice(0, 50).forEach((f) => console.log(`    - ${f}`));
    if (r.unlisted.length > 50) console.log(`    ... 其余 ${r.unlisted.length - 50} 个省略`);
  }
  if (r.stale.length) {
    console.log(`  B. 清单里已不存在 (${r.stale.length}):`);
    r.stale.forEach((s) => console.log(`    - [${s.kind}] ${s.glob} (声明 ${s.expect})`));
  }
  if (r.duplicates.length) {
    console.log(`  C. 重复计入 (${r.duplicates.length}):`);
    r.duplicates.forEach(([rel, list]) => {
      console.log(`    - ${rel}  ← ${list.map((o) => `[${o.kind}] ${o.glob}`).join(' , ')}`);
    });
  }
  if (r.drift.length) {
    console.log(`  D. 计数漂移 (${r.drift.length}):`);
    r.drift.forEach((d) => console.log(`    - [${d.kind}] ${d.glob}: 文档 ${d.expect} / 实际 ${d.actual}`));
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const [name, cfg] of Object.entries(REPOS)) {
    const se = cfg.scope.reduce((n, e) => n + e.expect, 0);
    const ee = cfg.excluded.reduce((n, e) => n + e.expect, 0);
    console.log(`${name}: ${cfg.root}  exts=${cfg.exts.join(',')}  scope=${se} excluded=${ee} total=${se + ee}`);
  }
  process.exit(0);
}

const requested = argv.filter((a) => !a.startsWith('--'));
const names = requested.length ? requested : Object.keys(REPOS);
const unknown = names.filter((n) => !REPOS[n]);
if (unknown.length) {
  console.error(`未知仓库: ${unknown.join(', ')}；可选: ${Object.keys(REPOS).join(', ')}`);
  process.exit(2);
}

let fatal = false;
const results = [];
for (const name of names) {
  const r = runRepo(name, REPOS[name]);
  if (r.fatal) fatal = true;
  results.push(r);
  printRepo(r);
}

const failed = results.filter((r) => r.fatal || !r.ok);
console.log('\n=== 汇总 ===');
for (const r of results) {
  if (r.fatal) {
    console.log(`  ${r.name}: FATAL ${r.fatal}`);
  } else {
    console.log(`  ${r.name}: ${r.ok ? 'PASS' : 'FAIL'}  scope=${r.scopeFiles} excluded=${r.excludedFiles} total=${r.total}`);
  }
}
console.log(failed.length ? `\n结果: FAIL (${failed.length}/${results.length})` : `\n结果: PASS (${results.length}/${results.length})`);

if (fatal) process.exit(2);
process.exit(failed.length ? 1 : 0);
