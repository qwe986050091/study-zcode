// UVR-B1 基线快照：把待注释文件原样复制到 UVR-B1/orig/<相对路径>，并打印清单。
// 只做复制与统计，不写任何文本文件；清单由调用方用 Write 工具落盘。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\uv';
const DST = 'd:\\code\\_annot_baseline\\UVR-B1\\orig';

const files = [
  'crates/uv-resolver/src/lib.rs',
  'crates/uv-resolver/src/candidate_selector.rs',
  'crates/uv-resolver/src/dependency_provider.rs',
  'crates/uv-resolver/src/exclusions.rs',
  'crates/uv-resolver/src/flat_index.rs',
  'crates/uv-resolver/src/fork_indexes.rs',
  'crates/uv-resolver/src/fork_urls.rs',
  'crates/uv-resolver/src/known_platform.rs',
  'crates/uv-resolver/src/manifest.rs',
  'crates/uv-resolver/src/marker.rs',
  'crates/uv-resolver/src/pins.rs',
  'crates/uv-resolver/src/preferences.rs',
  'crates/uv-resolver/src/prerelease.rs',
  'crates/uv-resolver/src/prioritized_distribution.rs',
  'crates/uv-resolver/src/python_requirement.rs',
  'crates/uv-resolver/src/redirect.rs',
  'crates/uv-resolver/src/resolution_mode.rs',
  'crates/uv-resolver/src/resolved.rs',
  'crates/uv-resolver/src/upgrade.rs',
  'crates/uv-resolver/src/version_map.rs',
  'crates/uv-resolver/src/yanks.rs',
  'crates/uv-resolver/src/pubgrub/mod.rs',
  'crates/uv-resolver/src/pubgrub/dependencies.rs',
  'crates/uv-resolver/src/pubgrub/package.rs',
  'crates/uv-resolver/src/pubgrub/priority.rs',
  'crates/uv-resolver/src/pubgrub/range.rs',
  'crates/uv-resolver/src/resolver/provider.rs',
];

let total = 0;
for (const rel of files) {
  const src = path.join(ROOT, rel);
  const dst = path.join(DST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/).length;
  total += lines;
  console.log(`${rel}\t${lines}`);
}
console.log(`TOTAL ${files.length} files ${total} lines`);
