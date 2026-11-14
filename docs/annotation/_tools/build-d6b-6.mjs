import fs from 'node:fs';

const file = 'crates/uv-distribution/src/source/mod.rs';
const items = [];
const cur = (old) => (old < 1818 ? old + 341 : old + 505);
const add = (old, lines) => items.push({ line: cur(old), lines });

add(334, [
  '直链与 registry 的差别：没有索引可回退，哈希策略完全由调用方提供。',
  '调用方未提供哈希时，revision 会在首次下载后自行计算一份。',
  '因此直链的完整性取决于锁文件或命令行，而不是索引元数据。',
]);
add(372, [
  'path 是仓库内的相对路径，可以指向子目录里的归档。',
  '分片仍只按 commit，因此同一 commit 下的不同 path 共享一个分片。',
  '这也是归档 revision 只缓存哈希、不缓存路径的原因。',
]);
add(377, [
  '目录形态的 install_path 就是源码根，没有 subdirectory 概念。',
  '是否需要 editable 安装由锁文件与 CLI 决定，这里不参与判断。',
  '目录内容的任何变化都会通过 CacheInfo 反映到 revision。',
]);
add(452, [
  'metadata 通道同样接收哈希策略：静态命中前仍要先通过 revision 校验。',
  '不接收 tags 是因为元数据与平台无关，换平台不应触发重新构建。',
  '返回值 ArchiveMetadata 与构建入口只差 wheel 路径。',
]);
add(697, [
  'build_info.cache_shard 返回 Option：只有存在非默认配置时才有值。',
  '没有值时沿用 revision 分片，避免为默认配置多建一层空目录。',
  '有值时追加一级，保证不同构建配置的产物不会互相覆盖。',
]);
add(835, [
  '这里重复读取构建设置是必要的：dynamic 与 wheel 必须共用同一份配置。',
  '读取本身是廉价的哈希查找，不会产生 IO。',
  '配置为空时 BuildInfo 走默认值，分片逻辑与不配置时等价。',
]);
add(1125, [
  '归档的 wheel 命中同样要匹配 name/version，防止同目录历史产物误用。',
  '标签过滤在 find_in_cache 内完成，这里只补名称与版本。',
  '命中后直接返回，不再检查源码目录是否仍然存在。',
]);
add(1454, [
  '目录来源没有哈希，命中判定完全依赖标签与 name/version。',
  '因此 editable 与非 editable 必须使用不同分片，否则会互相命中。',
  '命中后仍返回 CacheInfo，供调用方判断是否需要重新构建。',
]);
add(1939, [
  'Git 归档的命中判定不涉及哈希，因为哈希为空。',
  '命中意味着同一个 commit 与同一套构建配置已经构建过。',
  '若构建配置变化，分片会变，旧 wheel 自然不再命中。',
]);
add(2213, [
  '源码树的命中判定与目录来源一致，只比标签与名称版本。',
  'Git 来源还隐含 commit 一致，因为分片路径里已经包含 commit。',
  '命中后返回的哈希为空，调用方不应据此做完整性校验。',
]);
add(3241, [
  '关闭构建时目录可能不存在，直接返回空 Removal 而不是报错。',
  'prune 是尽力而为的清理，单个分片损坏不应中断整个流程。',
  '删除动作由 cache.remove_path 统一记账，便于汇总统计。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6b-6.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
