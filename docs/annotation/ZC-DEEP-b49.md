# ZC-DEEP-b49

> 批次：B49（12 文件，复算缺口 1,009 行；按当前工作树复算，优先同类/同目录：`ui/src` 6 个、`ui/src/ToolCallBlocks` 2 个、`ui/src/app-shell`、`ui/src/AssistantPreviewCards.tsx`、`ui/src/quickpick`、`ui/src/store` 各 1 个，另取 `shared/src/zcode-protocol-v4`、`server/src/remote` 各 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b49\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b49
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1060

node check-batch.mjs ZC-deep-b49 ZC-deep-b49-files.txt
TOTAL added=1060 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.23   385   285    89   87  packages/ui/src/feedback/FeedbackSupplementComposer.tsx
31.30   501   361   113   87  packages/ui/src/store/offPeakTaskStore.ts
31.33   613   450   141   90  packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx
31.35   407   303    95   88  packages/ui/src/ToolCallBlocks/renderers/changes-group.tsx
31.37   444   322   101   87  packages/ui/src/AssistantPreviewCards.tsx
31.37   414   306    96   87  packages/ui/src/app-shell/WorkflowWorkspaceCardBody.tsx
31.41   375   277    87   87  packages/ui/src/settings/MigrationCandidatesCard.tsx
31.43   473   350   110   89  packages/ui/src/browser-use/EmbeddedBrowserPermissionPrompts.tsx
31.47   477   340   107   88  packages/ui/src/quickpick/TaskFindDialog.tsx
31.51   406   292    92   90  packages/server/src/remote/remoteAssetDeployDecision.ts
31.53   411   295    93   91  packages/shared/src/zcode-protocol-v4/controller.ts
31.53   454   333   105   89  packages/ui/src/ToolCallBlocks/renderers/mcp.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.23 median=31.39 newComments=1060
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/browser-use/EmbeddedBrowserPermissionPrompts.tsx` | 内嵌浏览器权限请求的弹层 | INV-01~20；一次请求只消费一次、选择表按 requestId 索引；媒体类型标签走 i18n 不内联；订阅在挂载期建立、卸载期整体 dispose；监听回调用函数式更新避免 stale closure；缺少平台能力时整体降级为空渲染；拒绝与允许都必须回传 resolution；未选择时按钮禁用；重复 requestId 不覆盖既有选择 | 89 |
| `ui/feedback/FeedbackSupplementComposer.tsx` | 反馈补充说明输入与附件 | INV-01~18；提交中整表单只读且按钮禁用；附件与正文的长度上限在提交前校验；FileReader 结果异步回填必须带取消标记；卸载后不再 setState；空正文且无附件不可提交；错误只保留最近一条；草稿不跨会话残留 | 87 |
| `ui/settings/CodingPlanEmbeddedWebviewDialog.tsx` | Coding Plan 内嵌 webview 弹窗 | INV-01~19；webview URL 在打开瞬间冻结、重载不重新计算；auth 注入脚本按 locale 生成且只注入一次；IPC 监听绑定与解绑严格配对；origin 校验失败不静默放行；加载失败保留错误并可重试；关闭即卸载；不接管 Esc 与焦点归还；提前 return 不得改变 hooks 调用顺序 | 90 |
| `ui/settings/MigrationCandidatesCard.tsx` | 会话迁移候选卡片 | INV-01~18；候选 sessionId 全局唯一并同时充当 React key 与勾选键；全选是整体替换而非增量；`selectedCount` 与视图同源；`supportState` 与行级 `isImporting` 两道闸门不对称；父层无防重入，连点会重复发起；三桶互斥且部分失败单独呈现；`lastImportResult` 跨扫描会残留 | 87 |
| `ui/ToolCallBlocks/renderers/changes-group.tsx` | 一组文件变更的渲染 | INV-01~18；分组聚合顺序稳定且 key 唯一；增删行统计口径与二进制文件分支分离；折叠状态不进入持久化；超长列表截断但保留总计；空变更不渲染容器；跳转目标路径归一后再解析；大小写差异不合并为同一文件 | 88 |
| `ui/ToolCallBlocks/renderers/mcp.tsx` | MCP 工具结果渲染 | INV-01~20；content 数组逐项分派、未知 type 忽略而非抛错；文本与图片可混排；图片走体积判定与降级占位；server 与 tool 名分别展示；参数与结果展示统一截断；错误结果与成功结果共用骨架但语义色不同；缺字段兜底为空而非崩溃 | 89 |
| `ui/app-shell/WorkflowWorkspaceCardBody.tsx` | 工作流节点结果卡片主体 | INV-01~19；状态到视觉的映射单点化；运行中优先于暂停、暂停优先于终态展示；节点计数与列表长度同源；结果行数上限 200 行后再截断；加载态不渲染旧结果；错误与结果互斥；复制按钮只在有内容时出现；时长格式化对缺失值返回空 | 87 |
| `ui/AssistantPreviewCards.tsx` | assistant 预览卡片集合 | INV-01~18；kind 分派单点化、未知 kind 走通用图标兜底；key 禁止用下标；单行内容截断依赖 min-w-0 与 truncate 成对出现；图标加载失败二次降级；点击目标唯一；空数组不渲染外层容器；图片 alt 置空并 aria-hidden | 87 |
| `ui/quickpick/TaskFindDialog.tsx` | 任务检索快速选择弹窗 | INV-01~19；过滤结果按 trim 归一、空查询显示全量；选中索引在过滤或切范围后重置；上下键与 Shift 语义分离；回车不直接提交；IME 组合态回车让位给输入法；Esc 尊重 defaultPrevented；监听在卸载时清理；聚焦请求用 id 重放避免重复 | 88 |
| `ui/store/offPeakTaskStore.ts` | 闲时任务状态存储 | INV-01~18；状态机单向迁移、终态不再回退；initialize 单飞、并发调用共享同一 Promise；eligibilityGeneration 单调递增，旧响应按代丢弃；创建与取消都以 operationId 防重入；额度与支持状态成对发布；快照不可变，订阅者拿到的是新对象；跨窗口可见性由持久层保证 | 87 |
| `shared/zcode-protocol-v4/controller.ts` | v4 协议控制器契约 | INV-01~18；快照携带 protocolVersion 与 logEpoch；delta op 为封闭集合，未知 op 拒绝而非忽略；frame 的 fromSeq 为 0、seq 单调；sentAt 不参与排序；task address 作为去重键；membership 四视图判定互斥；订阅分 base 与 visibility 两段语义；gap 用三元组判定 | 91 |
| `server/remote/remoteAssetDeployDecision.ts` | 远程资产部署决策（纯函数） | INV-01~18；同输入必须同决策，不读时间与随机源；快照一次读取后不再回读磁盘；版本比较双向归一；force > 缺失 > 版本 > meta 的判定优先级固定；meta 缺失或串组件、串架构一律视为需部署；installFile 成功后才写 meta；本地资产缺失只告警；manifest 拉取单飞且原样抛错 | 90 |

合计 **1,060**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. webview URL 必须在打开瞬间冻结

`CodingPlanEmbeddedWebviewDialog.tsx` 用 `frozenWebviewUrlRef` 在首次打开时固定 URL，之后重载复用同一值。
若每次渲染重算，locale 或登录态变化会让 webview 在用户操作中途跳到另一页面，已填表单全部丢失。

### 2. 全选是整体替换，不是增量勾选

`MigrationCandidatesCard.tsx` 的全选直接把选择集合替换为「所有可选候选」。
写成增量会让「先全选、再取消一项、再点全选」出现永远无法收敛的勾选状态。

### 3. 旧代响应必须按代丢弃

`offPeakTaskStore.ts` 的 eligibility 请求带 `eligibilityGeneration`，回填前比对当前代。
少这一比，快速切换账号或工作区时旧账号的额度会覆盖新账号的展示。

### 4. 决策函数不得读时间与随机源

`remoteAssetDeployDecision.ts` 的输出只由入参快照决定。
引入 `Date.now()` 会让同一份资产在不同时刻得到不同的部署结论，缓存与灰度都失去可复现性。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 权限弹层未按 requestId 建索引 | 同一页面两个权限请求互相覆盖，其中一个永远悬空 |
| 反馈附件 FileReader 回填不判卸载 | 关闭弹窗后 React 警告，附件数量跳到错误值 |
| webview IPC 只绑不解绑 | 弹窗多次开关后同一消息被处理 N 次 |
| 全选写成增量 | 勾选状态无法通过再次点击全选复原 |
| MCP content 未知类型抛错 | 一个未知块导致整条工具结果白屏 |
| 变更分组用下标做 key | 折叠状态在列表刷新后错位到别的文件 |
| 任务卡片加载态仍渲染旧结果 | 切换节点后短暂显示上一节点的输出 |
| 预览卡片用下标做 key | 删除中间项后图标与内容错配 |
| 搜索防抖不丢弃过期响应 | 慢请求后到，覆盖新查询的结果列表 |
| 闲时任务终态回退 | 已完成任务被重复执行或永久卡在 running |
| 协议 delta 忽略未知 op | 新服务端对旧客户端静默丢事件，状态长期不一致 |
| 资产决策读 Date.now() | 同一资产在不同节点反复重装 |

## 顺延

B49 复算清单共 20 个候选，本批按同类同目录取 12 个，其余 8 个顺延到 B50，开工前用更新后的工作树重新测量后确定：

- `apps/zcode-cli/packages/i18n/src/types.ts`（89）
- `packages/stream-animate/src/server/deepseekRunner.ts`（88）
- `apps/zcode-cli/packages/bootstrap/src/plugins.ts`（86）
- `packages/e2e-report/src/viewer/App.tsx`（86）
- `packages/desktop/src/main/localTtftExporter.ts`（85）
- `apps/zcode-cli/packages/node-repl-host/src/server.ts`（84）
- `apps/zcode-cli/packages/adapters/src/mcp/index.ts`（83）
- `packages/zcode-server-cli/src/server-core/http.ts`（83）

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.23%~31.53%。
