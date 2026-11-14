import fs from 'node:fs';

const file = 'crates/uv-distribution/src/source/mod.rs';
const items = [];
const cur = (old) => (old < 1818 ? old + 318 : old + 482);
const add = (old, lines) => items.push({ line: cur(old), lines });

add(293, [
  '分片由索引、包名、版本三段拼成；包名用 as_ref 避免额外的归一化分配。',
  '版本用 to_string 而不是 Display：目录名需要稳定且可排序。',
  '调试时可以直接按这个路径在缓存里定位到具体分片。',
]);
add(341, [
  '直链分片只按 URL，不带版本；这建立在「URL 内容不可变」的假设上。',
  '若 URL 指向可变内容，锁文件里的哈希会在校验阶段失败，而不是静默复用。',
]);
add(400, [
  'Url 形态与 Dist 形态的直链分片规则保持一致，subdirectory 不参与分片。',
]);
add(507, [
  'metadata 与构建共享分片规则，两边的缓存因此可以互相复用。',
]);
add(562, [
  'Url 直链的 metadata 分片与构建入口完全一致。',
]);
add(1107, [
  '源码目录固定命名 SOURCE，与 revision 同级。',
  '修复与构建都使用同一个 entry，避免出现两份解包结果。',
]);
add(1212, [
  'metadata 路径同样以 SOURCE 为解包目标，命中时直接读取。',
]);
add(1436, [
  '源码树也进入 revision 分片；即使不写 revision 指针，目录层级仍保持一致。',
]);
add(1569, [
  'metadata 通道与构建通道进入同一 revision 分片，缓存可交叉复用。',
]);
add(1911, [
  'Git 归档的源码目录同样固定为 SOURCE，位置在 commit 分片下。',
]);
add(2031, [
  'metadata 通道读取同一 SOURCE 目录，不需要额外的检出。',
]);
add(2192, [
  '空哈希是 Git 来源的约定：完整性由 commit 保证，不重复计算归档哈希。',
  '下游看到空哈希时不会误判为「缺少校验」，而是理解为「不需要校验」。',
]);
add(2424, [
  'metadata 文件位于构建分片下，因此更换构建设置会自然失效。',
]);
add(2949, [
  '临时目录由缓存统一分配，构建失败时残留可被后续 prune 清理。',
]);
add(3186, [
  '后端返回的 dist_info 是相对路径，可能为空表示不支持 prepare_metadata。',
]);
add(3252, [
  'HTTP 指针存在说明该分片由远程来源创建，可以安全删除其它 revision。',
]);
add(2870, [
  'persist 返回的哈希与大小是解包时实际算出的值，而不是响应头声明的值。',
]);
add(2901, [
  '本地归档只返回哈希；大小由 CacheInfo 负责，不需要在这里重复记录。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6b-5.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
