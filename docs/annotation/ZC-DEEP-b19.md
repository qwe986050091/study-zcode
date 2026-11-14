# ZC-DEEP B19 索引（core & apps）

日期：2026-11-07
基线快照：`d:\code\_annot_baseline\ZC-deep-b19\orig`
范围：`apps/zcode-cli` + `packages/{desktop,ui,shared}`（不含 `packages/services`）

## 1. 批次数据

| 指标 | 值 |
| --- | --- |
| 文件数 | 8 |
| 计划缺口 | 1,834 |
| 实际新增注释行（`added`） | 1,952 |
| 最低密度 | 31.10%（`taskQueryCacheStore.ts`） |
| 最高密度 | 32.14%（`exportLogs.ts`） |
| 校验 | `deletedNonZero=0` / `nonCommentAdded=0` / `starSlash=0` / `syntaxErrorFiles=0` |

累计：85 文件 / 35,097 行，相对基线 141,590 行完成度 24.8%，剩余缺口 106,493 行。

## 2. 文件清单（路径｜职责｜注释主题｜+行数）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts` | 会话分叉：identity 映射、bundle 事务提交、选型派生 | stable fork 必须走 `commitForkBundle` 单事务；子会话全部实体换新 id 且两遍分配；局部引用必须全部命中映射（`strictLocalReferences`）；加速 Provider 不得成为 child 常驻选型；选型 entry id 由 childSessionId 派生；权限取父会话创建时快照 | +250 |
| `packages/desktop/src/host/sourceServerDirectory.ts` | 远端目录服务：设置持久化、串行队列、身份握手 | 所有写操作经 `enqueue` 串行；`onDidChange` 只在确有写入后触发；initialize 失败不缓存 rejected promise；initialize 与业务写入共用同一队列；identity 冲突未确认时严格零写入；身份替换必须换新 profileId | +254 |
| `packages/ui/src/store/taskQueryCacheStore.ts` | 任务列表查询结果缓存（按 queryKey 索引 + 未读 overlay） | store 不解析 key 语义；缺 meta 的 key 走占位分支；unread overlay 只在 query 发布同值后释放；overlay 键存在（null）与键不存在语义不同；内容等价时保留旧引用；三者未变时 `setState` 返回原 state | +243 |
| `packages/desktop/src/main/exportLogs.ts` | 日志导出：脱敏、归档收集、打包 | 文本日志必须脱敏后落包；只有无法识别编码的二进制才 `copyFile`；敏感键名 = 子串族 + 白名单例外；白名单不得放宽到任意 `*_tokens`；连接串按值形态脱敏并保留 scheme/host；凭据文件名在收集阶段就跳过 | +250 |
| `packages/ui/src/lib/conversationTelemetryLegacyParityE2E.ts` | 旧版对话遥测对齐 E2E 桥 | 仅 desktop 且 bridge 被授权时才写 window 桥；卸载只在仍是自己这份 bridge 时 delete；每个 case 开始前重置 message telemetry；scope 惰性创建且 now 只由带 now 的操作推进；seed 以 commandId 幂等 | +240 |
| `packages/ui/src/TaskListItem.tsx` | 任务列表行（memo 比较 + 行内动作） | memo 必须覆盖全部影响渲染的 props（含 intl 与回调引用）；task 按白名单字段比较；JSON 字段比较前把 undefined 归一为 null；自动化身份兼容 cronAutomationId / automationId；禁用态由 actionsDisabled 与只读态合成 | +244 |
| `packages/shared/src/web-remote-control.ts` | Web 远程控制协议常量与类型 | 重连超时与出站缓冲超时是两个独立常量；auth state change 只接受 signed-in / signed-out 且 schema 为 strict；renderer 只通知状态变化，凭据由 main 重新读取；failure reason 是跨端枚举，增删需同步所有消费者；恢复超时不得映射为 desktop-disconnected | +236 |
| `packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx` | 工作区文件树（搜索态 / 树态、git 过滤） | workspace 切换必须重置选中项、搜索词与 changedOnly；git 状态不可用时强制关闭 changedOnly；只有根目录未加载时错误才阻塞整棵树；非阻塞错误按消息去重；visibleRows 在搜索态只取 searchRows | +235 |

## 3. 本批发现的关键不变量

- **分叉**：`strictLocalReferences: true` 是「可读但错误」与「明确失败」之间的分界；关掉它，漏映射的引用会静默指向父会话实体。
- **目录服务**：initialize 的 rejected promise 一旦被缓存，整个 Host 生命周期的所有读写都会立即失败，必须在 catch 里清空 `initializePromise`。
- **查询缓存**：overlay 的 `null` 与「键不存在」是两种语义；用 `undefined` 表达清除会让下次回包把未读状态恢复。
- **日志导出**：只有无法识别编码的文件才允许 `copyFile`；对文本文件走拷贝会让整套脱敏失效。
- **遥测桥**：卸载时必须校验 `window[bridge] === 自己`，否则新实例会被旧实例的 cleanup 删掉。
- **列表行**：memo 不能做 task 对象身份比较；服务端每次回包都是新对象，必须按白名单字段比较，否则整列表每轮轮询重渲染。
- **远程控制协议**：failure reason 是跨端枚举，新增值时两端必须同步，否则 renderer 展示未知原因。
- **文件树**：git 状态不可用时必须强制关闭 changedOnly，否则列表永远为空且没有解释。

## 4. 故障模式（改错会出现什么）

| 错误改法 | 现象 |
| --- | --- |
| 分叉关闭 strictLocalReferences | 子会话出现指向父会话的悬空引用，编辑/删除跨会话污染 |
| 缓存 initialize 的 rejected promise | 一次 IO 故障后 Host 永久不可用，只能重启 |
| 用 undefined 清除未读 overlay | 下一次回包把已读恢复成未读，红点反复出现 |
| 文本日志走 copyFile 分支 | token/apiKey 原样进入反馈包 |
| 遥测桥卸载不校验归属 | 新实例的桥被旧 cleanup 删除，事件全丢 |
| TaskListItem 直接比较 task 对象 | 每次轮询整列表重渲染，长列表掉帧 |
| web-remote-control 新增 failure reason 只改一端 | 另一端展示未知失败原因或空白 |
| 文件树在 git 不可用时不关 changedOnly | 列表恒空，用户以为没有改动 |

## 5. 阻塞与需要决定的事项

- 无阻塞。
- 待决定（累计第 3 批）：超密文件（B17 `V4ComposerToolbar.tsx` 42.48%、B18 `remoteAssetInstaller.ts` 36.07%）
  是否需要统一瘦身；本批全部落在 31.10%~32.14%，无新增超密文件。

## 6. 校验输出

```
deep-density (8 files, mode=code)
31.22  session-fork.ts
31.55  sourceServerDirectory.ts
31.10  taskQueryCacheStore.ts
32.14  exportLogs.ts
31.63  conversationTelemetryLegacyParityE2E.ts
31.77  TaskListItem.tsx
31.14  web-remote-control.ts
31.50  WorkspaceFileTree.tsx

zc-verify ZC-deep-b19
deletedNonZero=0  nonCommentAdded=0  starSlash=0  syntaxErrorFiles=0  added=1952
```
