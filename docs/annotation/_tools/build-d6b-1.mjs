import fs from 'node:fs';

const file = 'crates/uv-distribution/src/source/mod.rs';
const items = [];
const add = (line, lines) => items.push({ line, lines });

add(11, [
  '模块职责只有两件事：把来源收敛成缓存中的 revision，再把 revision 变成 wheel 与元数据。',
  '对外入口是 download_and_build、download_and_build_metadata、resolve_revision 与 prune，其余都是内部阶段。',
  '阶段顺序固定：解析来源 → 取或刷新 revision → 校验哈希 → 构建 → 原子落盘；任一步失败都不留下半成品。',
]);

add(50, [
  '内部依赖方向：ManagedClient 统一凭据与离线策略，Error 汇总本模块的失败面，Metadata 负责 workspace 视角的拼装。',
  '这些辅助模块不允许反向依赖本模块，否则来源解析与构建会形成循环依赖。',
]);

add(66, [
  '静态元数据通道：不选定构建解释器，只读 pyproject.toml 或 PKG-INFO。',
  '独立成库的原因是顺序依赖：工具解释器的选择依赖 requires-python，不能反过来依赖构建环境。',
  '只支持目录与 GitDirectory；归档必须先解包，收益低于直接构建元数据。',
]);

add(76, [
  '物化结果只保留一个路径；所有权范围就是临时目录的清理边界。',
]);

add(83, [
  '三个借用字段的生命周期由调用方保证：client_builder 负责网络，git 负责仓库解析，cache 决定落盘位置。',
  '该结构不缓存解析结果，重复调用会产生重复 IO，调用方应把它当作轻量句柄。',
]);

add(101, [
  '目录来源不需要搬运：install_path 在 workspace 发现阶段已经算好。',
  'Git 来源必须先 fetch 到 Git 缓存，再把 subdirectory 拼到检出根；这里不校验存在性，由构建阶段统一报 MissingSubdirectory。',
]);

add(140, [
  '只读 pyproject.toml，不读 PKG-INFO：源码树里的 PKG-INFO 可能已经过期。',
  'requires-python 为 dynamic 时返回 None，交给构建阶段判定，避免静态通道给出错误结论。',
]);

add(162, [
  '公开入口保持「没有可直接物化的来源就返回 None」的语义，调用方无需为其它来源类型写分支。',
]);

add(174, [
  'fetch 使用 Git 缓存桶；reporter 可为空，静态元数据通道没有进度条。',
  '子目录缺失与 LFS 未就绪都提前失败，避免把不完整的检出当成源码树去构建。',
]);

add(210, [
  '构建器的字段都是借用或可空配置：build_stack 为空表示不使用构建栈，reporter 为空表示静默。',
  'metadata_first_party_packages 只影响 metadata 通道的 first-party 判定，不影响 wheel 构建。',
]);

add(218, [
  '远程分发的 revision 指针；文件内容带 HTTP 缓存策略包装，读取必须经过 DataWithCachePolicy。',
  'prune 依赖这个文件名判断哪些子目录已经悬空。',
]);

add(221, [
  '本地归档与源码树的 revision 指针，绑定 CacheInfo（mtime 或目录快照），内容变化即产生新 revision。',
]);

add(224, [
  'Git 归档只缓存哈希，不缓存 revision：commit 本身已经唯一。',
]);

add(227, [
  '构建产出的元数据缓存；复用前必须校验 name 与 version，防止把别的包当成命中。',
]);

add(230, [
  '解包后的源码目录名；与 revision 子目录同级，便于整目录删除。',
]);

add(233, [
  'with_* 采用值语义返回新实例，避免对共享的 builder 做可变借用。',
]);

add(257, [
  'first-party 判定同时看来源类型与显式包名单：禁用构建时两者都可以放行。',
]);

add(283, [
  '分发入口：按来源类型选缓存分片与下载方式，最终收敛到 archive、url、source_tree 或 git_* 之一。',
  '分片决定复用粒度：registry 按「索引 + 包 + 版本」，直链按 URL 哈希，本地按路径哈希。',
  'file 协议只出现在 registry 分发上，直接走本地归档，不经过 HTTP 客户端。',
]);

add(291, [
  'registry 分片包含索引名，避免同一个包在不同索引下互相污染。',
]);

add(338, [
  '直链按 URL 分区；带 subdirectory 时先解包，再在该子目录内构建。',
]);

add(359, [
  '源码树形态：检出后原地构建，不生成归档，也不计算归档哈希。',
]);

add(370, [
  'Git 仓库内的归档路径：先 fetch，再在检出根下定位文件。',
]);

add(375, [
  '本地目录：editable 只影响 wheel 的缓存目录与重建策略，不影响来源解析。',
]);

add(380, [
  '本地归档按路径哈希分区，与 direct URL 的归档共用 archive 实现。',
]);

add(395, [
  'Url 形态与 Dist 形态最终复用同一套 url 实现，区别只在来源描述与哈希来源。',
]);

add(416, [
  'GitDirectory 的 Url 形态，与 Dist 形态等价。',
]);

add(421, [
  'GitPath 的 Url 形态，与 Dist 形态等价。',
]);

add(426, [
  'Directory 的 Url 形态，直接对本地目录构建。',
]);

add(431, [
  'Path 的 Url 形态，走本地归档。',
]);

add(448, [
  'metadata 入口与构建入口一一对应；区别是 Git 与目录来源可以先尝试静态元数据。',
  '不接收 tags：元数据与平台无关，缓存分片因此不含标签。',
]);

add(455, [
  'metadata 通道仍按包与版本分片，保证与 wheel 缓存同构。',
]);

add(499, [
  '直链元数据按 URL 分区，subdirectory 直接透传。',
]);

add(519, [
  'GitDirectory 优先静态元数据，失败再回退构建。',
]);

add(530, [
  'GitPath 的元数据同样要先 fetch 定位归档。',
]);

add(535, [
  '目录来源允许 workspace 视角的元数据拼装。',
]);

add(545, [
  '本地归档的元数据按路径哈希分区。',
]);

add(554, [
  'Url 直链的元数据路径与 Dist 直链一致。',
]);

add(574, [
  'Url 形态的 GitDirectory 元数据。',
]);

add(585, [
  'Url 形态的 GitPath 元数据。',
]);

add(590, [
  'Url 形态的本地目录元数据。',
]);

add(600, [
  'Url 形态的本地归档元数据。',
]);

add(615, [
  '包级设置合并在全局设置之上：全局提供默认，包级覆盖；返回 Cow 以便无覆盖时零拷贝。',
]);

add(632, [
  '额外构建依赖只按包名精确匹配；未命名来源没有包名可查，直接返回空。',
]);

add(643, [
  '构建变量同理；返回 Option 以区分「未配置」与「配置为空表」。',
]);

add(648, [
  'url 的骨架是其余变体的模板：加锁 → 取 revision → 校验哈希 → 进入 revision 分片 → 构建信息分片 → 命中 wheel → 修复 → 构建 → 写元数据。',
  '锁必须在 revision 之前拿，否则并发进程可能同时写同一个 revision 目录。',
  '进入 revision 分片后不再检查新鲜度，revision 本身已经代表一次内容快照。',
]);

add(662, [
  'revision 同时承担标识与哈希来源两个角色，远程来源会在这里顺带处理 HTTP 缓存。',
]);

add(667, [
  '哈希不符必须在构建前失败，避免把错误内容产出的 wheel 写进缓存。',
]);

add(676, [
  '之后的 entry 都挂在 revision 下，命中即说明内容一致。',
]);

add(681, [
  'URL 被假定不可变，因此不记录 CacheInfo，也不做过期判断。',
]);

add(685, [
  '只有存在构建配置时才多分一层；没有配置时复用 revision 根，减少目录层级。',
  '构建分片必须覆盖 config settings、额外依赖与构建变量三者，缺一都会导致产物串用。',
]);

add(699, [
  'wheel 命中要同时满足标签兼容与 name/version 匹配，防止历史产物被误用。',
]);

add(713, [
  '源码目录缺失通常意味着缓存被清理或上次构建中断；修复后沿用原 revision 的哈希约束。',
  '修复只重新下载并解包，不新建 revision，因此下游缓存仍然有效。',
]);

add(730, [
  '子目录只校验存在性，路径合法性交给构建后端。',
]);

add(745, [
  '构建先写临时目录再原子搬入缓存，失败不会留下半个 wheel。',
]);

add(762, [
  '元数据与 wheel 同生命周期写入，供 metadata 通道直接复用。',
]);

add(782, [
  '与 url 的差异：静态元数据优先，其次缓存元数据，最后才是 prepare_metadata 或整轮构建。',
  '静态命中不写缓存：结果可重复推导，写缓存只会增加失效面。',
  'dynamic 标记必须一路透传到最终元数据，否则解析器会把动态字段当静态值使用。',
]);

add(809, [
  '缓存元数据可能来自旧版本产物，name/version 不匹配时只记日志并继续构建。',
]);

add(814, [
  '静态元数据在这里直接返回，连 revision 分片都不需要。',
]);

add(827, [
  '动态元数据与 wheel 必须使用同一套构建设置，否则两者落在不同分片，无法互相复用。',
]);

add(841, [
  '反序列化失败只降级为未命中，不视为错误：缓存格式升级后允许自然重建。',
]);

add(860, [
  '需要 prepare_metadata 或构建时，源码必须已经解包；缺失时先修复。',
]);

add(877, [
  '子目录校验与 url 保持一致。',
]);

add(887, [
  'prepare_metadata 成功就跳过 wheel 构建；后端不支持时返回 None，由下面回退。',
]);

add(909, [
  '写缓存前先建目录；单文件写入本身是原子的，不需要目录级切换。',
]);

add(928, [
  '不支持 prepare_metadata 时整轮构建，用 wheel 里的 METADATA 作为结果。',
]);

add(945, [
  '同样要按 dynamic 标记修正结果。',
]);

add(955, [
  '最终写回缓存，下次可直接命中。',
]);

add(967, [
  '在线模式才做新鲜度检查；离线模式一律允许使用过期缓存。',
  '索引级 Cache-Control 覆盖全局新鲜度，镜像源可以借此控制缓存。',
  '下载回调负责新 revision、解包与哈希计算；回调失败时不会写 revision 指针。',
  '第二次 skip_cache 只在哈希或大小缺失时触发，因为首次响应可能来自不完整缓存。',
]);

add(979, [
  '缓存控制优先级：索引覆盖 > 全局新鲜度 > 离线允许过期。',
]);

add(999, [
  '回调内的 revision 是全新建的，不复用任何旧 id。',
]);

add(1012, [
  '大小在解包时顺带记录，供 registry 的权威大小校验使用。',
]);

add(1019, [
  '请求固定 identity 编码，原因见下方 request 的说明。',
]);

add(1035, [
  '只有 registry 与 direct URL 提供权威大小时才校验，避免对不可信来源误报。',
]);

add(1052, [
  '哈希齐全且大小可判定才算完成，否则强制刷新一次。',
]);

add(1077, [
  '本地归档的 revision 由 CacheInfo 决定，文件时间或大小变化即产生新 revision。',
  '归档不重复下载，只重复解包；解包结果仍按 revision 分片。',
]);

add(1087, [
  '本地归档没有 HTTP 层，revision 直接绑定文件快照。',
]);

add(1095, [
  '哈希校验与 url 路径一致。',
]);

add(1104, [
  '进入 revision 分片后不再判断文件是否更新。',
]);

add(1109, [
  '构建配置分片规则与 url 完全相同。',
]);

add(1123, [
  '命中 wheel 的判定与 url 相同。',
]);

add(1137, [
  '源码目录缺失时只重新解包，不改变 revision。',
]);

add(1145, [
  '构建回调只用于进度展示，失败不影响构建结果。',
]);

add(1166, [
  '元数据写回同一 revision，供下一次 metadata 请求命中。',
]);

add(1186, [
  '本地归档的 metadata 与构建共用 revision 与构建信息分片。',
]);

add(1195, [
  '这里只需要 revision，CacheInfo 只用于判断新鲜度。',
]);

add(1214, [
  '静态元数据优先，与 url_metadata 的判定顺序一致。',
]);

add(1226, [
  '动态结果需要同一套构建设置，保证与 wheel 分片一致。',
]);

add(1240, [
  '缓存命中要求 name 与 version 同时匹配。',
]);

add(1259, [
  '需要构建前先确保源码已解包。',
]);

add(1267, [
  'prepare_metadata 可用时不构建 wheel。',
]);

add(1297, [
  '回退整轮构建。',
]);

add(1319, [
  '按 dynamic 修正结果后写回。',
]);

add(1341, [
  '本地归档 revision 只看 CacheInfo 与哈希是否齐全，不做时间窗口判断。',
]);

add(1348, [
  '文件不存在是硬错误，说明用户传入的路径已经失效。',
]);

add(1353, [
  'CacheInfo 来自文件的 mtime 与大小，任何变化都视为内容变化。',
]);

add(1356, [
  '指针存在且哈希齐全时直接复用，不必重新解包。',
]);

add(1369, [
  '新建 revision 后整目录解包，哈希与大小一起计算。',
]);

add(1401, [
  '源码树的哈希校验没有意义：目录内容无法与声明哈希对应，因此直接拒绝。',
  'editable 只影响缓存目录名，构建流程与非 editable 相同。',
]);

add(1408, [
  '需要哈希校验时提前失败，避免构建完才发现无法验证。',
]);

add(1422, [
  '源码树也要加锁：并发构建会争用同一份临时目录。',
]);

add(1425, [
  'revision 由目录快照决定，快照未变则复用已有 wheel。',
]);

add(1451, [
  '命中判定与归档路径一致。',
]);

add(1465, [
  '构建时把整个源码树交给后端，不额外复制。',
]);

add(1508, [
  '源码树的 metadata 需要考虑 workspace 视图：成员路径与 editable 策略都来自 build_context。',
  '静态元数据命中时也要经过 from_workspace，以补全成员与 sources 信息。',
]);

add(1515, [
  '哈希校验规则与 source_tree 相同。',
]);

add(1520, [
  'editable 策略由调用场景决定：项目解析倾向 editable，工具解析尊重显式选择。',
]);

add(1528, [
  '静态命中直接返回，不进入缓存分片。',
]);

add(1550, [
  '缓存分片按 editable 区分，避免两种形态互相覆盖。',
]);

add(1559, [
  '加锁后才写 revision。',
]);

add(1562, [
  'revision 只与目录快照有关。',
]);

add(1571, [
  '构建设置分片与 wheel 保持一致。',
]);

add(1585, [
  '缓存命中后仍要重新拼装 workspace 元数据。',
]);

add(1624, [
  'prepare_metadata 可用时不构建 wheel。',
]);

add(1669, [
  '回退整轮构建，用 wheel 内的 METADATA。',
]);

add(1723, [
  '源码树 revision 不做内容哈希，只用 CacheInfo 近似判断是否变化。',
  '新鲜度检查先于指针读取，避免每次构建都反序列化。',
]);

add(1729, [
  '目录不存在是硬错误。',
]);

add(1734, [
  '目录快照包含文件列表与 mtime，比单文件信息更敏感。',
]);

add(1740, [
  '指针存在且 CacheInfo 相等时才复用，否则新建 revision。',
]);

add(1775, [
  '仅当 pyproject.toml 的 requires-dist 可静态推导时才返回，否则交给构建。',
  'workspace 成员需要 from_project_maybe_workspace 补全路径与 sources。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6b-1.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
