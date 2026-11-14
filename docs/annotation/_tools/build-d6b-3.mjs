import fs from 'node:fs';

const file = 'crates/uv-distribution/src/source/mod.rs';
const items = [];
const cur = (old) => (old < 1818 ? old + 147 : old + 311);
const add = (old, lines) => items.push({ line: cur(old), lines });

add(232, [
  '缓存布局（SourceDistributions 桶）如下，任何改动都要同步 prune：',
  '<分片>/revision.http                远程来源的 revision 指针，带 HTTP 缓存策略',
  '<分片>/revision.rev                 本地来源的 revision 指针，带 CacheInfo',
  '<分片>/<revision-id>/src/           解包后的源码，目录名固定为 SOURCE',
  '<分片>/<revision-id>/<build-digest>/ 存在构建设置时追加的子分片',
  '<分片>/<revision-id>/*/metadata.msgpack 构建产出的元数据',
  '分片键由调用方决定，revision 之后的部分全部由本模块管理。',
]);

add(285, [
  '来源矩阵有 12 个分支，但物理形态只有三种：归档、源码树、Git 检出。',
  'Dist 与 Url 的差别只在元数据：Dist 已带包名与版本，Url 需要从文件推导。',
  '每个分支都必须给出缓存分片与哈希策略，否则无法复用或校验。',
]);
add(291, [
  'registry 的哈希由索引提供，只有 size_is_authoritative 时才做强大小校验。',
  'file 协议走本地归档分支，不构造任何 HTTP 请求。',
]);
add(301, [
  'URL 解析失败是硬错误：索引里的文件名无法映射成地址，说明数据已损坏。',
]);
add(304, [
  'file 协议常见于本地索引或离线镜像，直接复用本地归档路径。',
]);
add(338, [
  '直链没有索引，哈希只能来自锁文件或命令行 --hash。',
  'subdirectory 只对归档有意义；Git 目录形态由 GitDirectory 分支处理。',
]);
add(345, [
  '直链的缓存分片按 URL 哈希，subdirectory 不参与分片，避免同一 URL 多份解包。',
]);
add(359, [
  '检出目录直接作为构建根，LFS 与子目录校验已在 fetch 阶段完成。',
]);
add(370, [
  '归档路径是相对检出根的相对路径，分片按 commit 而不是按路径。',
]);
add(375, [
  '目录形态同样受 no-build 与 requires-python 约束，豁免判定发生在 build_distribution 内。',
]);
add(380, [
  '本地归档的 revision 由 mtime 与大小决定，改文件即触发重建。',
]);
add(395, [
  'Url 形态无法提前知道包名，包级构建设置只能在拿到元数据后应用。',
]);
add(416, ['GitDirectory 与 Dist 形态共用实现。']);
add(421, ['GitPath 与 Dist 形态共用实现。']);
add(426, ['Directory 与 Dist 形态共用实现。']);
add(431, ['Path 与 Dist 形态共用实现。']);

add(448, [
  '这条通道在每个分支都先尝试静态元数据，失败才构建，因此返回点比构建入口更多。',
  'metadata 不接收 tags，也不产生 wheel，缓存分片只到 revision 与构建信息两级。',
]);
add(455, [
  'registry 元数据同样按包与版本分片，便于与 wheel 缓存对照排查。',
]);
add(467, [
  'file 协议直接读本地归档的 pyproject.toml，不经过下载。',
]);
add(519, [
  'GitDirectory 的静态元数据可能来自 GitHub 快路径，也可能来自本地检出。',
]);
add(530, ['GitPath 需要 fetch 后才能读归档内的静态元数据。']);
add(535, ['目录来源允许 workspace 成员参与元数据拼装。']);
add(545, ['本地归档与远程归档的元数据判定顺序一致。']);
add(554, ['Url 直链与 Dist 直链共用 url_metadata。']);
add(574, ['Url 形态的 GitDirectory 元数据。']);
add(585, ['Url 形态的 GitPath 元数据。']);
add(590, ['Url 形态的目录元数据。']);
add(600, ['Url 形态的本地归档元数据。']);

add(615, [
  '合并不是覆盖：包级设置与全局设置按字段合并，同名字段以包级为准。',
  '构建后端只看到最终结果，不感知来源层级。',
]);
add(632, ['包名缺失时返回空切片，避免调用方处理 Option。']);
add(643, ['构建变量与额外依赖分开存储，因为变量不参与依赖解析。']);

add(648, [
  '阅读提示：本函数可按注释锚点分成五段——取 revision、校验、分片、命中、构建。',
]);
add(660, [
  'advisory lock 跨进程生效；同一分片的构建因此串行，锁粒度就是复用粒度。',
]);
add(678, [
  'revision.id 是内容指纹，不是 commit 或 URL；修复后 id 不变。',
]);
add(700, [
  '命中查询只做只读扫描，不校验文件完整性；完整性由 revision 的哈希保证。',
]);
add(740, [
  '进度回调可能为空；构建失败时也要保证 on_build_complete 被调用。',
]);
add(746, [
  '构建目录与 subdirectory 一起传入，后端负责最终定位 pyproject.toml。',
]);
add(768, [
  'target 是解包后 wheel 的目标目录，用 stem 去掉扩展名。',
]);

add(782, [
  '入口先尝试静态元数据，这是与 url 唯一的语义差异。',
]);
add(793, [
  '锁与构建入口相同：元数据写入同样是写入，必须串行。',
]);
add(815, [
  'dynamic 表示 pyproject.toml 声明了动态字段，最终结果需要打上同样的标记。',
]);
add(843, [
  '缓存元数据读取失败只降级，不阻塞构建。',
]);
add(889, [
  'prepare_metadata 的结果仍然要经过 validate_metadata，不能直接信任后端。',
]);
add(929, [
  '回退构建时使用与 wheel 相同的构建目录与 no-sources 设置。',
]);
add(960, [
  '返回的哈希来自 revision，保证 metadata 与源码内容绑定。',
]);

add(967, [
  'revision 是所有后续分片的根，必须先于任何写入确定。',
]);
add(1019, [
  '请求只做 GET；鉴权、重试与缓存策略都由 cached_client 注入。',
]);
add(1042, [
  '大小比较只在期望值与实际值都存在时进行，避免把未知当不匹配。',
]);

add(1077, [
  '本地归档与远程归档共享构建骨架，只是 revision 来源不同。',
]);
add(1085, [
  '锁顺序与 url 一致，先锁分片再读 revision。',
]);
add(1119, [
  '构建信息分片对归档与远程完全一致，保证同一包的不同来源不会互相命中。',
]);
add(1150, [
  '构建目录是解包结果，subdirectory 恒为 None：本地归档没有子目录概念。',
]);
add(1172, [
  'CacheInfo 来自源文件，随 wheel 一起返回给调用方做失效判断。',
]);

add(1186, [
  'metadata 路径与构建路径共享 revision，命中即说明源码内容一致。',
]);
add(1193, [
  '这里只需要 revision，CacheInfo 仅用于新鲜度判断。',
]);
add(1215, [
  '静态元数据优先于任何缓存，因为它的推导成本最低且不会过期。',
]);
add(1268, [
  'prepare_metadata 成功时不需要 wheel，但仍要把源码解包到 revision 目录。',
]);
add(1303, [
  '回退构建的产物只取元数据，wheel 仍会被写入缓存供后续安装复用。',
]);

add(1341, [
  '本地 revision 的判定完全由 CacheInfo 与哈希策略驱动。',
]);
add(1361, [
  '指针存在但哈希不全时也要重新解包，不能只信 CacheInfo。',
]);
add(1374, [
  '解包目标在 revision 子目录下，失败时该目录可整体删除。',
]);
add(1390, [
  '指针最后写入：只有解包与哈希都成功，其他进程才可能看到新 revision。',
]);

add(1401, [
  '源码树形态不产生归档，因此哈希校验直接拒绝而不是忽略。',
]);
add(1413, [
  'editable 决定缓存目录（Editable 或 Path），但两者构建流程相同。',
]);
add(1435, [
  'revision 内的所有产物都随目录快照失效，不需要逐文件判断。',
]);
add(1471, [
  '构建根是 install_path，subdirectory 恒为 None：目录来源没有子目录。',
]);

add(1508, [
  'workspace 视角是本函数与 url_metadata 的主要差异。',
]);
add(1516, [
  '源码树不做哈希校验，与 source_tree 保持一致。',
]);
add(1523, [
  'editable 决策必须与 wheel 构建一致，否则两者会落在不同分片。',
]);
add(1587, [
  '缓存元数据本身不含 workspace 信息，命中后要重新拼装。',
]);
add(1625, [
  'prepare_metadata 失败返回 None，随后回退整轮构建。',
]);
add(1675, [
  '构建产物只取元数据，wheel 仍写入缓存供安装复用。',
]);

add(1723, [
  '快照比较比内容哈希便宜，代价是可能漏掉内容相同但 mtime 变化的目录。',
]);
add(1735, [
  '目录快照读取失败是硬错误，不能当作「没有变化」。',
]);
add(1748, [
  '指针解析失败只记日志并重建，避免格式升级导致永久失效。',
]);

add(1782, [
  '静态 requires-dist 只覆盖 PEP 621 的静态字段；动态字段一律返回 None。',
]);
add(1801, [
  '依赖解析错误、动态字段、字段缺失都降级；只有未知错误才上抛。',
]);

add(1827, [
  'LFS 检查在哈希计算前：缺 LFS 时算出的哈希没有意义。',
]);
add(1851, [
  '哈希缓存的命中条件是「存在且覆盖调用方要求的算法」。',
]);
add(1888, [
  'fetch 的 reporter 来自本模块 reporter，转成 Git 专用接口。',
]);
add(1902, [
  '短哈希只用于目录名，精确 commit 仍是缓存语义的唯一依据。',
]);
add(1967, [
  '进度回调与构建入口一致，失败路径也要收尾。',
]);
add(1974, [
  '元数据写回同一构建分片，metadata 通道可直接命中。',
]);

add(1997, [
  '即使只取元数据也要 fetch，因为静态读取依赖已检出的文件。',
]);
add(2034, [
  '静态命中同样要经过 from_metadata23，保证与构建路径的数据形状一致。',
]);
add(2095, [
  'prepare_metadata 的结果先落缓存再返回，避免重复构建。',
]);
add(2141, [
  '最终写回同样按 dynamic 修正。',
]);

add(2165, [
  'fetch_git_source_tree 会校验 subdirectory 是否存在，并把 LFS 状态一并处理。',
]);
add(2185, [
  '源码树不写 revision 指针，缓存键就是 commit 本身。',
]);
add(2210, [
  '空哈希不影响 wheel 命中：Git 来源的完整性由 commit 保证。',
]);
add(2242, [
  '写回位置与 wheel 相同，便于 prune 按分片清理。',
]);

add(2275, [
  '分片预判只是优化：即使分片存在，也要走下面的缓存元数据校验。',
  '分片不存在时才值得尝试 GitHub 快路径。',
]);
add(2287, [
  '快路径是纯网络探测，不写入任何缓存。',
]);
add(2352, [
  '快路径的任何失败都在这里被吞掉，常规 fetch 才是权威路径。',
]);
add(2371, [
  '加锁范围覆盖 revision 读取与元数据写入。',
]);
add(2413, [
  'Git 来源同样要按构建配置分片，否则 config settings 变化不会触发重建。',
]);
add(2470, [
  'prepare_metadata 的输入是检出根与 subdirectory，不是拼好的 path。',
]);
add(2523, [
  '回退构建与 source_tree 的差别只是多传了 GitWorkspaceMember。',
]);

add(2578, [
  '匹配的是「来源描述」，不是构建形态；四种 Git 来源都要解析。',
]);
add(2589, [
  'get_precise 只查解析缓存，不发网络请求。',
]);
add(2594, [
  'GitHub 快路径失败时返回 Ok(None)，不会中断解析。',
]);
add(2609, [
  'fetch 是最后兜底，返回的 precise 可能是 None，需要调用方处理。',
]);

add(2646, [
  'GitHubRepository::parse 只识别 github.com 形式，其它托管直接放弃。',
]);
add(2658, [
  'raw.githubusercontent.com 返回的是原始文件，不经过 HTML 包装。',
]);
add(2683, [
  '语法错误与 schema 错误都视为「没有可用的 pyproject.toml」。',
]);
add(2697, [
  '依赖字段无法静态解析时降级；未知错误仍上抛。',
]);
add(2719, [
  'sources 检查放在最后：只有元数据本身可用时才需要判断能否直接采用。',
]);

add(2736, [
  '修复路径不改变 revision id，因此已有下游缓存仍然有效。',
]);
add(2774, [
  '缓存控制与 url_revision 相同，区别只是最终调用 skip_cache。',
]);
add(2835, [
  '流式解包的好处是内存占用与包大小无关。',
]);
add(2855, [
  '解包器的校验顺序：路径安全 → 哈希 → 大小，任一步失败都不落盘。',
]);
add(2888, [
  '本地文件句柄直接交给解包器，不需要先读入内存。',
]);

add(2926, [
  '本函数是所有来源形态的最终汇合点，上游已完成 revision 与哈希校验。',
]);
add(2950, [
  '临时目录位于缓存内，保证 rename 尽量在同一文件系统完成。',
]);
add(2982, [
  '基础解释器在 Unix 上要解析 symlink，Windows 上直接取当前解释器。',
]);
add(3020, [
  '复用构建环境时先取出再放回，避免借用冲突。',
]);
add(3066, [
  '文件名解析同时完成规范化，后续校验都基于规范化结果。',
]);

add(3088, [
  'metadata 构建不产出 wheel，因此不需要 tags 与 wheel 目标目录。',
]);
add(3113, [
  'requires-python 只检查下界，上界由解释器选择阶段负责。',
]);
add(3202, [
  '后端返回 None 表示不支持 prepare_metadata，这不是错误。',
]);
add(3221, [
  'identity 编码的原因：压缩会改变字节流，使内容哈希不可复现。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6b-3.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
