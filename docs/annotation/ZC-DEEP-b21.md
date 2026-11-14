# ZC-DEEP-b21

> 批次：B21（计划 9 文件 / 缺口 1,948 行）。
> 覆盖四条链路：UI 工作台分组状态、桌面 Host 物理连接管理、CLI 协议服务端与冷恢复、远控传输与远端工作区持久化、侧栏项目编辑与模型选择器。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b21\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b21
SUMMARY files=9 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1999

deep-density --baseline ZC-deep-b21/orig --ext .ts,.tsx --threshold 30 --mode code
31.76  1073   762  242  221  packages/ui/src/v4/workbenchGroupStore.ts
31.60  1801  1329  420  227  packages/desktop/src/host/sourceServerConnectionManager.ts
32.95  1322   962  317  230  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts
31.77  1008   746  237  215  packages/ui/src/project-sidebar/grouped/group-item.tsx
32.20  2593  1885  607  242  apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts
32.29   983   706  228  217  packages/shared/src/web-remote-control-rpc-transport.ts
32.05  1057   752  241  216  packages/ui/src/lib/remoteWorkspaceHistory.ts
32.34   940   708  229  217  packages/ui/src/project-sidebar/ProjectEditor.tsx
32.24  1036   760  245  214  packages/ui/src/ModelConfigSelect.tsx
SUMMARY files=9 coreBelow30=0 needLines=0 min=31.60 median=32.24 newComments=1999
PASS: all 9 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/v4/workbenchGroupStore.ts` | 工作台分组 store：pane 分组、session 绑定、持久化与恢复 | INV-01~18；replayable 模式不落 localStorage；session key 全局唯一归属；primary pane 不可删；`restoredUnvalidated` 只留内存；panes 键集与 root leaf 集一致；不可变替换靠对象身份短路；sessionIndex 只能全量重建；split ratio 区间夹取；持久化失败不影响内存态；解析失败等同无数据；hydrate 只在首次 configure | 221 |
| `packages/desktop/src/host/sourceServerConnectionManager.ts` | Host 侧 Source 物理连接管理：按 Source/Profile 复用、握手、自动恢复 | INV-01~18；`onlineBySourceServerId` 是当前代际唯一定义；同 Source 多 Profile 共用连接；同 profile 并发 connect 只握手一次；finally 只删自己的 flight；显式断开在 await 后仍生效；未发布连接必须 dispose 并屏蔽 close；重试只认结构化 retryable；终态失败截断恢复；2/4/8 秒节奏与 2 分钟探测；同 Source 单 retry timer；更新先失效旧代际 | 227 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` | Agent 协议服务端：请求分派、反向请求、驻留池、关停 | INV-01~18；入站消息先 `assertServing()`；response/error 不进 request 分派；pending 全路径清理；重发多 requestKey 全删；reannounce 指数退避封顶 10s；断开终止全部反向请求；shutdown 幂等且不走 `session/close`；request 全程持 lease；id 复用不吃旧 outbox；post-response 帧按序提交；两张取消表隔离；未知方法 -32601 | 230 |
| `packages/ui/src/project-sidebar/grouped/group-item.tsx` | 项目侧栏分组项：折叠、重命名、拖拽、菜单 | INV-01~18；重命名期间禁拖拽；系统分组不可改名/解散；标题走本地化；先关菜单再聚焦；迟到 blur 不提交；IME 组字 Enter 不提交；Esc 阻止冒泡；空白标题回退原标题；标题未变不回调；非编辑态跟随外部标题；ResizeObserver 编辑结束即断开；折叠延迟 180ms 卸载；两个 focus guard 定时器卸载清理 | 215 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts` | 会话记录冷恢复水合：从 transcript 合成事件流 | INV-01~18；reduce(transcript) 与 reduce(events) 同构；合成确定性无时间/随机源；事件 id 恒 `hydrate-N` 且严格单调；`sourceTimestamp` 不参与全序；guide steer 内联当轮；model-only 独立开轮；workflow 启动轮先于 real-user 识别；历史 pending/running 收口为 cancelled；providerContextOnly 整条跳过；compact 同 operationId 只发一次；goal verify 跨源去重；anchor 失配落末尾不丢 | 242 |
| `packages/shared/src/web-remote-control-rpc-transport.ts` | 远控 RPC 物理分片与重组：schema、字节计量、base64、assembly 状态机 | INV-01~18；物理 seq 严格 +1；同 messageSeq 的片间元数据一致；完成消息只留 digest tombstone；terminal fault 后不再推进；foreign identity 先于事务检查；单帧字节不超上限；片预算随片数单调收敛；空消息不可编码；分片数不超上限；重组长度与 crc32 必须匹配；messageSeq 不跳号；MAX_SAFE_INTEGER 只能换代；assembly 超时基于 firstSeenAt；上限只能调小；envelope strict；输出帧冻结 | 217 |
| `packages/ui/src/lib/remoteWorkspaceHistory.ts` | 远端 workspace 持久化投影：session 列表、凭据引用、路径映射、legacy 别名 | INV-01~18；session key 统一 identity 或路径；只清理 `remote-workspace:` 命名空间；引用不转移所有权；快照不存明文；已有快照 key 必须复用；仅本次提供明文才写凭据；失败不重建快照；换代先剔 currentEntry 再 upsert；容量上限 20 且排序后裁剪；路径归一化先于身份拼接；SSH host 小写化 username 原样；缺省端口参与 identity；别名只在唯一候选生效 | 216 |
| `packages/ui/src/project-sidebar/ProjectEditor.tsx` | 项目编辑器弹层：表单状态、设备切换、目录选择、保存编排 | INV-01~19；异步结果必须过 `current(request)`；设备切换与浏览取消都自增 epoch；卸载 alive=false；suspended 期间不提交；单 save flight；创建成功后保留 created；远端项目恰好一个 root；`fixedFolder` 不可改 Host/root；切设备需确认并清空四项状态；本机按路径去重、远端只取第一个；primary 必须属于 roots；恢复候选取所属 Host 树；legacySingleRoot 禁写；信任确认只 resolve 一次 | 217 |
| `packages/ui/src/ModelConfigSelect.tsx` | 模型选择器：触发器、模型项、provider 连接方式子菜单、焦点恢复 | INV-01~19；受控与否只由 controlledOpen 决定；pending 期间冻结展示快照但提交取当前 owner；打开前按真实按钮宽度测量；openRequestKey 只在递增非零时触发；disabled 禁快捷键；选中态唯一由 normalizedValue 推导；锁定项不可选；锁定提示吞指针事件；合并模式下选模型不关菜单；非合并选中即关；焦点恢复受触屏能力约束；菜单打开时关闭 Tooltip | 214 |

合计 **1,999**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 物理连接的「代际」是唯一定义

`sourceServerConnectionManager.ts` 里 `onlineBySourceServerId` 不是缓存，而是**当前物理连接代际的唯一权威**。
`getFileTransfer` 返回的闭包每次使用前都要复核 owner，`disconnectSource` 必须先捕获全部 profileId 再删索引。
任何「先删索引再逐个断开」的写法都会让断开回调在索引已空的情况下走到恢复分支，把刚断开的连接复活。
自动恢复只认结构化的 `retryable`/`code`，不解析错误文案；终态失败必须截断 timer，否则会对一个已判定不可恢复的设备无限重试。

### 2. 冷恢复必须与实时流同构

`transcript-hydration.ts` 的硬契约是 `reduce(transcript) === reduce(events)`。
合成过程不得调用 `Date.now()` 或随机数，否则同一段历史两次冷启动得到不同快照，diff 层会误判为「有新消息」。
`hydrate-N` 的 id 与严格单调的 `sequenceNumber` 是下游去重与增量合并的锚点；`sourceTimestamp` 只能影响展示时间。
最容易被误改的是 `workflow 启动轮必须早于 real-user 分支识别`：顺序一换，启动轮会被吞进上一轮，用户看到的第一条消息消失。

### 3. 分片重组的内存与正确性双约束

`web-remote-control-rpc-transport.ts` 用两组不变量守住同一个状态机：
`settledFrameFingerprintsBySeq` 只保留 digest tombstone（否则内存随消息数线性增长直至 OOM），
而 `stagedBytes`/`crc32WireBytes` 必须在完成时精确等于分片携带值（否则损坏消息被交付上层）。
`foreign identity 先于事务检查` 是最隐蔽的一条：身份校验放在装配之后，外片会先把 owning assembly 清空，表现为「偶发长消息丢失」。
`boundedPositive` 的夹取方向也只能调小——协议上限是双方共同发布的线上约定。

### 4. UI 的「编辑态」与「外部事实」必须单向

`group-item.tsx` 与 `ModelConfigSelect.tsx` 共享同一类陷阱：本地编辑态不能覆盖外部事实。
前者在非编辑态才跟随外部标题更新（编辑中回写会打断输入），后者在 pending 期间冻结的是**展示快照**，
而 `onValueChange` 必须仍取当前 owner（把回调一起冻结，提交的模型会被旧快照覆盖）。
`ProjectEditor.tsx` 则用 `epoch` 统一处理「切设备/取消浏览/卸载」三类并发，任何一处漏自增 epoch，
迟到的旧目录就会被写进新设备的表单。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| `disconnectSource` 先删索引再断开 | 断开回调走恢复分支，刚断开的连接被复活 |
| 自动恢复匹配错误文案 | 文案国际化后恢复失效，或对不可恢复错误无限重试 |
| 水合里调用 `Date.now()` | 同一段历史两次冷启动快照不同，diff 层持续误报新消息 |
| workflow 启动轮晚于 real-user 判定 | 启动轮被并进上一轮，用户首条消息消失 |
| 历史 pending 工具不收口为 cancelled | 冷启动后大量工具永远转圈 |
| assembly 身份校验放在装配之后 | 外片清空 owning assembly，长消息偶发丢失 |
| 完成消息不保留 digest 而去重 | 内存随消息数线性增长，长连接最终 OOM |
| 分片上限允许放大 | 与 relay 约定不一致，对端按旧上限分片被判超限 |
| workbench replayable 模式读 localStorage | 手机远控恢复链路被桌面持久态污染 |
| `restoredUnvalidated` 写回持久 schema | 未校验的 pane 在下一次启动变成「合法」数据 |
| 分组标题未变仍回调 onRenameGroup | 每次 blur 触发一次落盘与列表重排 |
| 模型 pending 期间连回调一起冻结 | 提交的模型是旧快照，用户选择被丢弃 |
| 切设备漏自增 epoch | 迟到的旧目录写进新设备表单，保存到错误路径 |
| 保存不做单 flight 守卫 | 连点创建出两个项目 |

## 顺延

无。B21 计划内 9 个文件全部达标；下一批按 `ZC-DEEP-CORE-PLAN.md` 复算清单推进。
