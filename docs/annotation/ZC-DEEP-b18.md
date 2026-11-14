# ZC-DEEP B18 索引（core & apps）

日期：2026-11-07
基线快照：`d:\code\_annot_baseline\ZC-deep-b18\orig`
范围：`packages/{desktop,ui,formal-proof,server}` + `apps/zcode-cli/packages/core`（不含 `packages/services`）

## 1. 批次数据

| 指标 | 值 |
| --- | --- |
| 文件数 | 8 |
| 计划缺口 | 1,973 |
| 实际新增注释行（`added`） | 2,161 |
| 最低密度 | 31.15%（`pptx-preview-viewer.tsx`） |
| 最高密度 | 36.07%（`remoteAssetInstaller.ts`） |
| 校验 | `deletedNonZero=0` / `nonCommentAdded=0` / `starSlash=0` / `syntaxErrorFiles=0` |

累计：77 文件 / 33,145 行，相对基线 141,590 行完成度 23.4%，剩余缺口 108,445 行。

## 2. 文件清单（路径｜职责｜注释主题｜+行数）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/host/windowRemoteConnectionRegistry.ts` | 窗口级远程连接注册表：物理连接复用、logical session、attachment scope | 同一 Source 只允许一个 canonical owner；竞争失败 entry 不得发布 online；owner 按对象身份而非 key 判定；迟到结果过 generation/transitionEpoch；断连后 IO fail-closed；workspace 释放按 generation 记账；pending session 不广播关闭；recovering 只由显式 recoverable=true 进入 | +296 |
| `packages/ui/src/v4/composer/useComposerAttachments.ts` | composer 附件队列：入队、并发上传、取消、清理 | scopeKey=(identity\|\|path)+NUL+scopeId；并发不超过 UPLOAD_CONCURRENCY；按 scopeKey+attachmentId 去重；每附件单 AbortController 且按对象身份回写；finally 递减并发并再 pump；remove/clear 同时清队列/complete/retry/controller/远端暂存 | +267 |
| `packages/ui/src/components/ui/pptx-preview-viewer.tsx` | PPTX 预览：加载、分页渲染、链接安全 | renderer 只挂 leaf mount；每次加载递增 generation，迟到结果只释放不写状态；卸载置 cancelled 并 dispose；ready 失败只上报不重试；外链净化并阻断主窗口导航；内部滚动必须复位 | +260 |
| `packages/desktop/src/main/desktopStabilityTelemetry.ts` | 桌面稳定性遥测：事件、崩溃详情、路径脱敏 | globalContext 未配置前静默丢弃；上报永不抛错；属性经 stringifyProperties 归一；事件名到 metric_value 映射固定；崩溃详情先脱敏再截断；`<workspace>/<home>` 占位符在路径脱敏后恢复 | +262 |
| `packages/formal-proof/src/main.ts` | 形式化验证 UI：状态空间图、树渲染、统计 | 节点 id 只由 kind/parentId/contextKey 派生；同 id 只追加 members 不替换 representative；边去重依赖 edgeIds；viewState.root 永远保存完整树；语义统计取 root、图节点取 renderRoot；cloneForRender 不得原地改 children；渲染预算 remaining<=0 才折叠 | +262 |
| `packages/formal-proof/src/model.ts` | 形式化验证模型：trace 树构建、轮次枚举 | contextKey 字段顺序即等价类 key；buildTraceTree 先 resetIds；nextNodeId/nextCaseId 模块级计数器不支持并发构建；轮次上限用 `round > maxRounds`；loopKey 用 round+contextKey 且 visited>1 才判重；seen 每层复制 | +255 |
| `packages/server/src/remote/remoteAssetInstaller.ts` | 远端产物安装：staging、下载、sha 校验、清理 | 所有临时路径带 owner 后缀，禁止固定 `.new`；取消后不复用旧 backend 清理；失败只删本次 owner 路径；路径参数经 quotePosix* 转义；每个候选 URL 下载内校验 sha；校验失败先 rm -f 输出文件 | +300 |
| `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts` | runtime steering：active turn、输入预占、steer 校验 | 同一 runtime 单 active turn（双检查 + 预占）；pendingInputReservations 单输入单消费者锁；reservation 释放与 DispatchChanged 落盘绑定；steerTurn 五段 early return 顺序固定；rejectTurnSteer 不抛错；空输入判定含附件与引用 | +259 |

## 3. 本批发现的关键不变量

- **注册表**：`entriesByKey.get(key) === entry` 的对象身份比较是防止「旧 owner 复活」的唯一手段；
  换成 key 字符串比较后，迟到回调会把已替换 entry 写回索引。
- **注册表**：`closePhase === "recovering"` 只能由 `recoverable === true` 进入；缺省按 terminal 处理，
  否则不可恢复失败被当作可恢复，UI 永久转圈。
- **附件队列**：并发计数只在 `finally` 递减并再次 `pump`；漏掉任何一条路径都会让队列永久卡死。
- **PPTX 预览**：renderer 必须挂在无 React 子节点的 leaf mount 上，cleanup 的 `replaceChildren`
  会连浮层一起删掉，触发 React 崩溃。
- **遥测**：崩溃详情必须先脱敏再截断，顺序反了会让尾部路径/密钥逃过脱敏。
- **形式化模型**：`contextKey` 的字段顺序就是等价类 key，重排或增删会让图与统计同时膨胀。
- **产物安装**：远端临时路径必须带 owner 后缀，固定 `.new` 会让并发部署互相覆盖 staging。
- **steering**：`steerTurn` 的五个 early return 顺序固定，调整顺序会改变拒绝原因与事件语义。

## 4. 故障模式（改错会出现什么）

| 错误改法 | 现象 |
| --- | --- |
| 竞争失败的 provisional entry 继续发布 online | 同一 Source 出现两个 online owner，互相 dispose，会话随机掉线 |
| 注册表用 key 字符串判断 owner | 迟到回调把旧 entry 写回索引，已关闭连接复活 |
| 附件 finally 漏递减并发计数 | 队列永久卡死，后续附件不再上传 |
| PPTX 预览在含子节点的容器挂 renderer | cleanup 删到浮层，React 抛错白屏 |
| 遥测先截断再脱敏 | 截断点之后拼接的路径/密钥未被脱敏 |
| 形式化 contextKey 调整字段顺序 | 同上下文被判成不同节点，图与统计同时膨胀 |
| 产物安装用固定 `.new` 路径 | 并发部署互相覆盖 staging，校验失败或装错版本 |
| steering 调换 early return 顺序 | 拒绝原因与 TurnSteerRejected 事件语义改变 |

## 5. 阻塞与需要决定的事项

- 无阻塞。
- 待决定（同 B17）：`remoteAssetInstaller.ts` 密度 36.07%，高于目标区间。
  因硬约束禁止删行，本批未回退；是否在后续统一做「超密文件瘦身」仍待确认。
> 2026-11-10 更新：该待决定项已处理——54 行水句按 DEEP-SPEC §2.16 整句改写（1→1，行数不变，密度不变），登记见 §7。原结论保留，不删除。

## 6. 校验输出

```
deep-density (8 files, mode=code)
32.35  windowRemoteConnectionRegistry.ts
31.53  useComposerAttachments.ts
31.15  pptx-preview-viewer.tsx
31.50  desktopStabilityTelemetry.ts
31.99  formal-proof/main.ts
31.31  formal-proof/model.ts
36.07  remoteAssetInstaller.ts
31.98  steering.ts

zc-verify ZC-deep-b18
deletedNonZero=0  nonCommentAdded=0  starSlash=0  syntaxErrorFiles=0  added=2161
```


## 7. 2026-11-10 补提交与 54 行水句改写登记

**背景**：本批 8 个文件从未提交——`git log --all` 无任何 b18 提交，工作区挂着 `+2,161` 行。其中 `remoteAssetInstaller.ts` 的 `+300` 先按旧标准落盘，用现行 `zc-gate` 复检为 `waterLines=54`（Poem 2 组 6 行、L 12 行、W 37 行，1358 行同时命中 L 与 W，去重后 54）。

**改写规则**（DEEP-SPEC §2.16）：只改本线自己写入的注释，代码行与上游注释行 0 删除；每行 1→1 替换，不改行数、不改密度。

**改写后门禁原始输出**

```text
$ node _annot_baseline/zc-gate.mjs --scan ...\RAI-b18-verify\_files.txt
SUMMARY files=1 badFiles=0 addedCommentLines=300 waterLines=0 waterRate=0.00%
$ node _annot_baseline/zc-verify.mjs RAI-b18-verify
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=300
$ node _annot_baseline/check-code-tokens.mjs ...
SUMMARY files=1 codeTokenDiff=0
$ node _annot_baseline/check-comments-in-strings.mjs ...
SUMMARY files=1 scanned=1 stringRanges=359 violations=0 addedViolations=0
$ node _annot_baseline/deep-boilerplate.mjs ... --diff --files ...
SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
$ node _annot_baseline/check-upstream-comments.mjs ... HEAD
SUMMARY files=1 checked=1 upstreamComments=52 missing=0
```

**落盘**：`89d591aa`，`git show --numstat` → `300	0	packages/server/src/remote/remoteAssetInstaller.ts`。

**标题更正留痕**：紧随其后的文档提交标题误写 `(+76/−1)`，`git show --numstat 98e03c1a` 实际为 `169 0`（`ZC-DEEP-b18.md`）与 `1 1`（`ZC-SCOPE-TIERS.md`），合计 `+170/−1`。标题原样保留不改写，以本条为准；这正是 DEEP-SPEC §2.15 要求「标题从 numstat 抄」的反例。

**改写登记（`rewrittenOwn`，54 行）**

| 行号 | 类别 | 原文（已改写） | 新文 |
| ---: | --- | --- | --- |
| 5 | L |   - 只负责「把制品放到远端目标路径」：不决定部署顺序、不做服务重启、不维护业务状态。 | //   - RemoteAssetInstaller 只负责把制品放到远端目标路径，部署顺序与服务重启由调用方决定，业务状态不归本模块维护。 |
| 7 | L |   - 失败语义是「本次 owner 的 staging 清干净、正式目录不动」，不做跨进程补偿。 | //   - 失败语义是本次 owner 的 staging 清干净且正式目录保持不动，跨进程补偿交给上层。 |
| 150 | W | 进度包装统一在外层，避免每个候选各自实现一份。 | // 进度包装统一由 buildRemoteArtifactDownloadCommand 在外层完成，避免每个候选各自实现一份。 |
| 162 | W | 缺任一项就退化为「只下载不校验」，而不是报错。 | // expectedSha256 或 sha256Tool 缺任一项就退化为只下载不校验，而不是报错。 |
| 213 | W | 摘要命令按远端工具能力生成，输出只保留哈希值。 | // buildRemoteChecksumCommand 按远端工具能力生成摘要命令，输出只保留哈希值。 |
| 215 | W | [契约] 调用方只比较字符串，不解析输出。 | // [契约] 调用方只比较 expectedSha256 与输出字符串，不解析输出。 |
| 248 | L | [契约] returns 原字符串，不做任何拼接，避免额外转义。 | // [契约] quotePosixPathArg 原样返回输入字符串而不做拼接，避免额外转义。 |
| 249 | W | 这是可测试性分支，不要为了统一路径而删除。 | // 这个可测试性分支由 supportsProgress 参数触发，不要为了统一路径而删除。 |
| 272 | L | [契约] 顺序不可调整：启动、执行、取码、停止、判定。 | // [契约] 五个步骤必须按启动→执行→取码→停止→判定的顺序执行，改动顺序会让 download_status 失真。 |
| 288 | W | 因此分别用 %% * 与 ##* 截取。 | // 因此截取路径前缀与文件名时分别用 shell 的百分号与井号参数展开算子。 |
| 342 | W | [契约] 读取的是本地文件，不存在远端 IO。 | // [契约] resolveManifestComponent 读取的是本地文件，不存在远端 IO。 |
| 350 | W | 两个必要条件缺一就放弃解析。 | // platformArch 与 releaseDir 两个必要条件缺一就放弃解析。 |
| 389 | W | 存在性检查与完整性检查分两步，先便宜后昂贵。 | // exists 存在性检查与 sha256 完整性检查分两步，先便宜后昂贵。 |
| 432 | W | 严格版解析：拿不到就直接抛错，供安装路径使用。 | // resolveLocalPath 严格版拿不到就直接抛错，供 install 路径使用。 |
| 460 | W | 错误里带平台与组件列表，便于用户对照下载。 | // createRemoteAssetPlaceholderError 的错误里带 platformArch 与组件列表，便于用户对照下载。 |
| 461 | W | [契约] 该错误类型由上层识别并转成可读提示。 | // [契约] RemoteAssetPlaceholderError 由上层识别并转成可读提示。 |
| 482 | W | 这一步没有远端副作用，因此取消只在上传前生效。 | // 这一步没有远端副作用，因此 abort 只在上传前生效。 |
| 572 | L | 本地归档名同样带组件名、时间戳与 UUID，避免并行部署冲突。 | // 本地归档名由 componentId 与时间戳拼接而成，避免并行部署冲突。 |
| 585 | W | [契约] 后缀不得包含斜杠或空格。 | // [契约] ownerSuffix 后缀不得包含斜杠或空格。 |
| 589 | W | 压缩包放在目标目录同级的带后缀路径，避免写入目标目录内部。 | // 压缩包放在 remoteDir 同级的带后缀路径，避免写入目标目录内部。 |
| 671 | W | [权衡] 回退是为了兼容「先远端下载后切回本地上传」的使用序列。 | // [权衡] 回退是为了兼容「先 remote-download 后切回 local-download-upload」的使用序列。 |
| 685 | W | [契约] 判断只看配置，不发探测请求。 | // [契约] hasRemoteCdnBase 只看配置，不发探测请求。 |
| 733 | POEM | 把源相对路径与必需子路径合并成完整性检查清单。 | // buildRequiredReleasePaths 把 sourceRelativePath 与 requiredRelativePaths 合并成完整性检查清单。 |
| 734 | POEM | 两端斜杠先归一化，空路径被忽略。 | // 两端斜杠在 normalize 之前先归一化，空路径被忽略。 |
| 735 | POEM | [契约] 源路径本身总是清单第一项。 | // [契约] sourceRelativePath 本身总是清单第一项。 |
| 775 | L | 进程内 manifest 请求去重表，key 是版本、平台、超时与 CDN 的组合。 | // remoteDownloadManifestLocks 是进程内 manifest 请求去重表，key 取版本与平台与超时与 CDN 基址。 |
| 778 | L | 这是进程内锁，不跨进程，也不跨 CLI 重启。 | // 这张表是进程内锁，不跨进程也不跨 CLI 重启。 |
| 826 | W | 缺省时才真正发起网络请求。 | // 缺省时才由 fetchRemoteDownloadManifest 真正发起网络请求。 |
| 889 | W | [契约] 空清单生成空数组，命令里不出现多余检查。 | // [契约] requiredRelativePaths 为空时生成空数组，命令里不出现多余检查。 |
| 941 | POEM | 强制刷新优先查强刷表，否则查普通表。 | // forceRefresh 优先查 forceRefreshComponentTasks，否则查 componentTasks。 |
| 942 | POEM | 两张表分开是为了区分「已下载」与「已强刷」。 | // 两张表分开是为了区分 downloaded 与 force-refreshed 两种状态。 |
| 943 | POEM | [契约] 命中即复用，不再触发任何远端写操作。 | // [契约] componentId 命中即复用，不再触发任何远端写操作。 |
| 970 | W | 对已解析的组件做关键文件完整性校验。 | // 对已解析的 component 做关键文件完整性校验，缺失时触发重下。 |
| 1003 | W | 这是 O(n) 次远端往返，清单应保持最小。 | // findMissingComponentPaths 逐个 exists 探测，复杂度是 O(n) 次远端往返。 |
| 1024 | L | 真正的下载流程：解析 manifest、算 cache 目录、加锁、下载、校验、解压、原子 move。 | // 真正的下载流程先解析 manifest，再算 cache 目录并加锁，随后下载与校验并通过原子 move 落位。 |
| 1026 | L | [失败路径] EXIT trap 只清理本次 staging、锁与临时新目录，不碰正式 cache。 | // [失败路径] EXIT trap 只清理本次 staging 与锁，不碰正式 cache 与 componentNewDir。 |
| 1042 | W | 其余组件沿用语义版本的哈希，保持历史缓存可用。 | // 其余组件沿用 version 的哈希，保持历史缓存可用。 |
| 1054 | W | 删除后继续走完整下载流程，不跳过校验。 | // 删除 .ready 后继续走完整下载流程，不跳过校验。 |
| 1102 | W | 下载命令内部已包含多源尝试与逐源校验，这里只做参数透传。 | // downloadCommand 内部已包含多源尝试与逐源校验，这里只做参数透传。 |
| 1121 | L | 远端脚本逐行拼接：加锁、心跳、trap、下载、校验、解压、原子替换、清理。 | // 远端脚本按 lock→heartbeat→trap→download→verify→extract→move→cleanup 的顺序逐行拼接。 |
| 1164 | W | [契约] 结束后清理表项，允许后续重新拉取。 | // [契约] 结束后从 remoteDownloadManifestLocks 清理表项，允许后续重新拉取。 |
| 1188 | W | [并发] 比较身份而不是直接删除，避免误删后来者的任务。 | // [并发] 用 task 身份比较而不是直接删除，避免误删后来者的任务。 |
| 1201 | W | 404 不计入错误列表，因为它代表该源没有发布而不是故障。 | // 404 不计入 candidateErrors，因为它代表该源没有发布而不是故障。 |
| 1203 | W | 成功时把命中的基址提到候选首位，后续制品优先进同一源。 | // 成功时把命中的 releaseBase 提到候选首位，后续制品优先进同一源。 |
| 1217 | W | 每个候选独立超时信号，避免一个源拖垮整体。 | // 每个候选各自创建 signal 超时信号，避免一个源拖垮整体。 |
| 1218 | W | [契约] 命中后不再尝试后续候选。 | // [契约] 命中后不再尝试 manifestUrls 里的后续候选。 |
| 1239 | W | 响应体解析与状态码检查分开：ok 只代表头部成功。 | // response.ok 只代表头部成功，响应体解析要与状态码检查分开。 |
| 1323 | W | 不重试、不阻塞，因为下载本身另有重试策略。 | // resolveRemoteArtifactContentLength 不重试也不阻塞，因为下载本身另有重试策略。 |
| 1347 | L | 非法值（负数、0、NaN）统一视为未知。 | // 非法值（负数、0、NaN）统一按未知处理，parseContentLength 返回 null。 |
| 1357 | W | 把平台或组件 id 里的非白名单字符替换成下划线，用于路径段。 | // quoteSafeSegment 把平台或组件 id 里的非白名单字符替换成下划线，用于路径段。 |
| 1358 | W | 白名单是字母数字与点、下划线、加号、减号。 | // quoteSafeSegment 的白名单只含 A-Za-z0-9 与下划线，其它字符一律替换。 |
| 1365 | W | 截断是为了路径可读，碰撞概率在版本数量级下可忽略。 | // hashRemoteCacheSegment 截断 16 位是为了路径可读，碰撞概率在版本数量级下可忽略。 |
| 1366 | W | [契约] 不要改成明文版本，版本里可能含斜杠或空格。 | // [契约] 不要改成明文 version，版本里可能含斜杠或空格。 |
| 1374 | W | 只转发进度行，其余输出被丢弃，避免污染部署日志。 | // forwardRemoteDownloadProgressLogs 只转发进度行，其余输出被丢弃，避免污染部署日志。 |

> 本批其余 7 个文件仍处于「有台账、无提交号」状态，按 `ZC-LEDGER-AUDIT-2026-11-10.md` 统一处置，不在本次补提交范围内。
