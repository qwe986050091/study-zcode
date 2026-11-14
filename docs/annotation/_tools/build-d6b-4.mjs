import fs from 'node:fs';

const file = 'crates/uv-distribution/src/source/mod.rs';
const items = [];
const cur = (old) => (old < 1818 ? old + 281 : old + 445);
const add = (old, lines) => items.push({ line: cur(old), lines });

add(664, [
  'revision 已包含哈希与大小，后续阶段不再访问网络或源文件。',
  'satisfies 只比较调用方要求的算法，未要求的算法不参与判定。',
  '修复分支沿用 revision id，新建分支会换 id，这是两者唯一的行为差异。',
]);
add(687, [
  '构建设置读三次：配置、额外依赖、构建变量，全部按包名查找。',
  '三者合并成 BuildInfo 后才决定是否追加一级分片。',
]);
add(715, [
  '只有源码目录缺失才修复；哈希不符更早返回，不会走到这里。',
  '修复失败整体失败，不会退化成用空目录构建。',
]);
add(731, [
  '子目录校验在构建前完成，错误信息同时带 URL 与子目录，便于定位。',
]);

add(794, [
  '元数据入口同样先锁分片：metadata.msgpack 与构建产物共用同一把锁。',
]);
add(816, [
  '静态读取不取锁，因为它只读源码目录，不写缓存。',
  '静态结果直接返回，哈希仍取自 revision，保证与源码绑定。',
]);
add(829, [
  '动态元数据的构建设置必须与 wheel 完全一致，包括额外依赖与构建变量。',
]);
add(862, [
  '需要构建时源码必须存在，这里的修复逻辑与 url 完全一致。',
]);
add(890, [
  'prepare_metadata 只生成 dist-info，不生成 wheel，因此不需要 tags。',
  '返回 Some 时直接落缓存并返回，不再走下面的整轮构建。',
]);
add(930, [
  '回退构建会生成完整 wheel；这里只取元数据，wheel 留给安装阶段复用。',
]);

add(1089, [
  '本地归档的 revision 读取包含文件存在性检查，缺失直接报 NotFound。',
]);
add(1111, [
  '与 url 相同：构建配置变化会产生新的子分片，旧 wheel 自然失效。',
]);
add(1139, [
  '修复只重新解包本地文件，不改变 revision id。',
]);
add(1152, [
  '本地归档没有 subdirectory，构建根就是解包目录。',
]);

add(1197, [
  'metadata 只需要 revision 与 CacheInfo，后者用于新鲜度判断。',
]);
add(1217, [
  '静态读取先于缓存查询：静态结果无需缓存，也不会失效。',
]);
add(1261, [
  '需要 prepare_metadata 或构建前，先确保解包目录存在。',
]);
add(1270, [
  'prepare_metadata 的结果仍要按 dynamic 修正后再写缓存。',
]);
add(1305, [
  '回退构建的 wheel 留在缓存，供安装阶段直接复用。',
]);

add(1362, [
  '指针命中要求 CacheInfo 相等且哈希覆盖所需算法，缺一都要重算。',
]);
add(1376, [
  '解包前先建 revision 子目录；失败时由上层清理。',
]);

add(1427, [
  '源码树 revision 只依赖目录快照，不受构建配置影响。',
]);
add(1440, [
  '构建配置同样参与分片，避免不同设置下的 wheel 互相覆盖。',
]);
add(1473, [
  '源码树直接构建，不复制到临时目录；只读访问由后端负责。',
]);

add(1531, [
  '静态元数据需要 workspace 拼装，不能像 url 那样直接返回裸元数据。',
]);
add(1565, [
  'revision 读取后才进入构建设置分片，顺序与构建入口一致。',
]);
add(1576, [
  '配置分片对 editable 与非 editable 都生效。',
]);
add(1627, [
  'prepare_metadata 成功后仍要经过 from_workspace 补全成员信息。',
]);
add(1678, [
  '回退构建的输入是整个 install_path，而不是 subdirectory。',
]);

add(1743, [
  '新鲜度检查只看缓存时间窗口，内容是否变化仍由 CacheInfo 判定。',
]);

add(1785, [
  '只有静态 requires-dist 才返回 Some；动态字段交给构建阶段。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6b-4.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
