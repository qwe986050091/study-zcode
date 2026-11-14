# ZC-DEEP-b25

> 批次：B25（计划 12 文件 / 缺口 1,889 行，本批取缺口前 8 个，含 B24 顺延的 3 个）。
> 覆盖四条链路：浏览器能力清单与 guest 宿主、额度重置的跨入口对账、Lexical mention 与 Provider 卡片表单、
> 以及 App 装配、文件活动投影与手机远控弹窗。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b25\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b25
SUMMARY files=8 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1388

deep-density --baseline ZC-deep-b25/orig --ext .ts,.tsx --threshold 30 --mode code
31.47   768   572  180  173  apps/zcode-cli/packages/core/src/browser-client/manifest.ts
31.41  1291   936  294  178  packages/ui/src/browser-use/UnifiedBrowserView.tsx
31.45  1074   779  245  176  packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts
31.50   762   565  178  173  packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx
31.52   918   660  208  174  packages/ui/src/mentions/MentionPlugin.tsx
31.44  1696  1282  403  180  apps/zcode-cli/packages/bootstrap/src/app/create-app.ts
31.54   770   539  170  168  packages/ui/src/lib/treemappingActivity.ts
31.48   791   575  181  166  packages/ui/src/web-remote-control/WebRemoteControlDialog.tsx
SUMMARY files=8 coreBelow30=0 needLines=0 min=31.41 median=31.47 newComments=1388
PASS: all 8 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
每个文件 `// INV-` 均为 20 条。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/browser-client/manifest.ts` | 浏览器 API manifest、能力策略与 Proxy 门面的唯一事实源 | INV-01~20；FALLBACK 必须覆盖 Agent→Browsers→Browser→Tabs→Tab 五层；FALLBACK.version 必须与插件 api.json 同值；`isManifest` 只校验 version/objects；`loadBrowserApiManifest` 永不抛错；解析失败回退而非空对象；`supports()` 对未声明成员返回 true；`apiSupportOverrides` 最后裁决；declarations 用 some 不用 every；members 构造后冻结；`updateDescriptor` 先赋值再重建；能力集合 `clear()` 复用同一 Set；先判 `unsupportedByDefaultIn` 再判 `requiresCapabilities`；无 scope 的 capability 回退双集合；scope 分隔符取首个冒号；Proxy 必须同时拦 get/has/getOwnPropertyDescriptor/ownKeys；ownKeys 与描述符过滤一致；隐藏只针对 string 键；strict facade 方法必须 bind(current)；隐藏成员 get 返回 undefined；objectName 必须与 manifest key 一致 | 173 |
| `packages/ui/src/browser-use/UnifiedBrowserView.tsx` | webview guest 的统一宿主：导航、事件接线与 guest 生命周期 | INV-01~20；隐藏 pane 只移出布局不卸载 webview；guest 必须在 did-attach 立即上报；residency 恢复时 attach 后撤销 src；上报指纹必须含 workspace/session/residency；webContentsId 只经 `safeWebviewCall`；只有 guest 或 active 变化才重报；必须等 detach ACK 才递增 generation；重建前清空三个去重 ref；外部导航回执必须等替代 guest 完成一次 loadURL；同一 view 只保留一个 pending 句柄；卸载必须完成 pending 句柄；dom-ready 消费 pendingUrl 后 return；src 只在首挂生效、后续一律 loadURL；自由尺寸模式 zoom 固定 1；只有退出自由尺寸才恢复 desktopZoomFactor；截图用临时 responsive 不写回用户偏好；`isEmptyBrowserState` 不含 addressValue；加载失败与 guest 崩溃必须区分；ERR_ABORTED(-3) 忽略；权限请求按 guestWebContentsId 过滤 | 178 |
| `packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts` | 额度重置的 UI 投影、跨入口对账与轮询订阅 | INV-01~20；/status 缓存键必须含 `authSessionSeq`；`STATUS_FRESHNESS_MS` 内复用缓存；in-flight 按 service 分表且结束删空表；history/read 去重键只按 usedAt；history/read 是全局共享游标；标记已读早于 entitlement 刷新；手动轨迹按 service+scope+类型隔离；共享轨迹只归属第一次 used_at 变化；reset 放行必须用 `hasUsableCodingPlanQuotaResetOpportunity`；跨入口防双核销先 `refreshStatus(true)`；放行判定与 startedAt 共用同一时刻；只有 `useAccepted` 之前失败才清轨迹；对账延迟固定 4 档；手动核销中不调 /opportunity；本轮刚完成不调 /opportunity；/status 之后必须再调 /opportunity；轮询身份不依赖 `onEntitlementRefresh`；四入口共享一个 Coordinator；ticker 只在有可核销机会时启动；所有 setEntry 必须带 `authSessionSeq` | 176 |
| `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx` | 供应商卡片的头部、连接、密钥与模型列表区块 | INV-01~20；`renameRequestedRef` 由 onSelect 置位、onCloseAutoFocus 消费；菜单可见性同时看 nameEditable 与 onDelete；只读走 `renderReadOnlyField`；只读 baseUrl 取 `provider.config.api`；只读格式缺省与可编辑一致；`createEmptyModel` 不写档位/能力；`addSavingRef` 与 state 成对；开/关弹窗都重置草稿与错误；必须等 `onAddModel` 完成才关弹窗；失败路径经 finally 复位 saving；字段错误文案只在字段错误时拼接；resolve 回调固化 providerId；`onResolveDraft` 必须克隆 personalConfig；行 key 是 providerId+modelId；只有非 builtin 才传 onDelete；`onModelEnabledChange` 的 rejection 必须吞掉；完整性判定覆盖 7 维；modelIds 与 models 同源同序；新增弹窗挂在列表之后；只读与可编辑复用同一组 i18n key | 173 |
| `packages/ui/src/mentions/MentionPlugin.tsx` | Lexical 输入框内 @/#/$ 触发面板与键盘选择面 | INV-01~20；`activeTokenRef` 只在 `editorState.read` 内写；`dismissedSignatureRef` 只在签名变化/插入/失焦时清；setActiveTrigger 同 trigger+query 返回原对象；isOpen 只由 disabled 与三种 trigger 决定；deferredActiveQuery 只用于候选派生；provider enabled 必须是 isOpen 与 trigger 的合取；selectedIndex 随签名归零；flatItems 变化必须经 `coerceEnabledMentionIndex`；上下键走 `getNextEnabledMentionIndex` 不取模；handler 返回 true 前必须 preventDefault + stopPropagation；Enter 与 Tab 共用 `selectOption`；定位/替换/插入必须在同一次 `editor.update`；token 与尾随空格同批插入并 selectEnd；whiteboard 分支先删原文再回调宿主；isOpen=false 时命令 effect 提前返回；effect 依赖含 flatItems/selectedIndex/selectOption；六个 unregister 成对清理；IME 冻结只对非 Android；disabled 与 Blur 同时清两个 ref；空态/加载态只来自 provider 结果 | 174 |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | CLI/bootstrap 进程内单会话 App 的唯一装配入口 | INV-01~20；Provider Registry 由调用方注入且早于 modelFactory；装配严格自上而下串行；runtimeConfig 只在 AgentRuntime 前合并一次；`configuredMcpServers` 与 `runtimeConfig.mcp.servers` 同源改写；modelFactory 全进程一份；只有 owns 为真的资源才能 close；AgentRuntime 最后构造、runtime 回调惰性；dwf run service 先于 AgentRuntime；journal 缺失不构造 run 端口；模型选择恢复只恢复保存意图；模型校验失败只影响绑定；失败回收只释放本函数创建的资源；catch 原样 throw；`startupTimer.fail` 只记账；附件解码保留 text/plain；附件 ref 优先不可变 artifact；close 顺序 session→recorder→provider runtime→telemetry；三层 try/finally 链不可简化；三个门面只是 runtime 读写适配；browser broker 只在注入且 browserUse 开启时创建 | 180 |
| `packages/ui/src/lib/treemappingActivity.ts` | 把 assistant message 的 toolCalls 投影成文件/目录活动模型 | INV-01~20；事件拼装顺序 writable→structured→fallback→read；structured 与 fallback 只在 writable 为空时执行；read 始终追加不参与互斥；先聚合 Map 再排序输出；kind 只升不降；added/removed 按事件累加；views 只在 view 动作 +1；pendingToolCallIds 去重后 push；lastTouchedAt 取 max；路径只规范化一次；workspace 前缀剥离必须带分隔符；workspacePath 先去尾斜杠；绝对路径去前导斜杠仍按相对处理；目录路径去尾斜杠；search 无结果按目录记账；search 命中只取 output 候选；读动作先看 identity 再看语义词；mutation 只信结构化字段不信 title；无路径的活跃调用只计数不建行；输出按 path 的 localeCompare 排序 | 168 |
| `packages/ui/src/web-remote-control/WebRemoteControlDialog.tsx` | 手机远控弹窗的展示与本地交互层 | INV-01~20；status 只能由平台结果写入；打开同步 effect 的 cancelled 覆盖所有 setState；只有同目标或可复用会话才沿用状态；auth-required 不触发 start；start 返回 cancelled 归一为 idle；启动失败先复查 auth-required 再报错；catch 内复查请求自带 catch；轮询保持 1s 固定间隔；轮询只接受 target 匹配/可复用/auth-required/idle/error；状态相同返回原对象；轮询单次失败静默；qrUrl 为空清空 qrDataUrl；二维码生成后判 cancelled；二维码失败只记日志；复制前判 connectUrl 存在；停止成功后先置 idle 再关弹窗；loading 由 finally 复位；关闭弹窗不调用 stop；登录必须指定当前渠道；Bot 总入口先清空 provider | 166 |

合计 **1,388**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 「隐藏能力」必须在四个 Proxy trap 上同时成立

`manifest.ts` 的 Proxy 拦截 `get` / `has` / `getOwnPropertyDescriptor` / `ownKeys` 四个 trap。
只改 `get` 是新手最常犯的错：成员虽然读不到，但 `'x' in api` 与 `Object.keys(api)` 仍会泄露。
两条更细的约束：`ownKeys` 的过滤条件必须与 `getOwnPropertyDescriptor` 完全一致，否则触发 Proxy invariant 的 TypeError；
隐藏只针对 **string** 键，隐藏 symbol 键会切断内部符号通道。
另外 `supports()` 对未声明成员返回 **true**，改成 false 会让 manifest 漏项变成静默的能力消失。

### 2. guest 重建的代际必须等 detach ACK

`UnifiedBrowserView.tsx` 在 `render-process-gone` 后先等 detach ACK 再递增 generation：
提前递增会让 DevToolsSession 访问已析构的 client（UAF）。
配套的三条：重建前必须清空 request/initial/guest 三个去重 ref（否则新 guest 被旧键拦截、导航静默丢失）；
外部导航回执必须等替代 guest 完成一次 `loadURL`（否则上层 navigationRequest 永久挂起）；
同一 view 只能有一个 pending 导航句柄（被覆盖的 Promise 会永久悬空）。
`ERR_ABORTED(-3)` 必须忽略，否则正常导航被打断时会误报加载失败。

### 3. 429 保护靠「不并发」而不是「重试」

`useCodingPlanQuotaResetUi.ts` 的四档延迟与两条互斥规则（手动核销中不调 /opportunity、本轮刚完成不调 /opportunity）
都是为了避免与 `/use` 抢发卡锁。缓存键必须含 `authSessionSeq`，否则换账号后沿用上个会话的额度快照；
所有 `setEntry` 都要带 `authSessionSeq`，否则迟到的旧会话响应会覆盖新会话状态。
`history/read` 是 **全局共享游标**、请求不带 target scope——按 scope 拆分反而会让其他窗口持续重复播放。

### 4. 装配顺序与所有权回收是同一件事

`create-app.ts` 的二十条 INV 里，一半是顺序（runtimeConfig 只合并一次、AgentRuntime 最后构造、dwf run service 先于 runtime），
另一半是所有权（只有 `owns` 为真的资源才能 close、失败回收只释放本函数创建的对象）。
两者共同保证「失败时不留半成品、成功时不误关注入资源」。`close` 的顺序
（session → recorder → provider runtime → telemetry）与三层 try/finally 不可简化：任一前置失败都会跳过遥测 shutdown。

### 5. 事件记账必须先互斥再聚合

`treemappingActivity.ts` 让 writable→structured→fallback→read 四类事件互斥优先级明确，
一次编辑才不会被记成三份；`kind` 只升不降（deleted > written > modified > viewed），
否则删除会被后续 view 覆盖回可编辑态。路径规范化只做一次且 workspace 前缀剥离必须带分隔符——
少了分隔符，`workspace2` 会被误当成 `workspace` 的子路径。

### 6. 「投影层不推断权威状态」

`WebRemoteControlDialog.tsx` 的三处 `setStatus` 只接受平台返回值；关闭弹窗 **不调用 stop**（否则一关 UI 手机端就掉线）。
`ProviderCardSections.tsx` 的只读与可编辑是两条完整渲染分支，不能靠 `disabled` 合并——
合并后只读 provider 仍能改 baseUrl。两处都是同一条原则：UI 只投影，不持有权威。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| Proxy 只拦 get | `in` 与 `Object.keys` 泄露被隐藏的成员 |
| ownKeys 与描述符过滤不一致 | 触发 Proxy invariant TypeError |
| 隐藏 symbol 键 | 内部符号通道被切断，框架内部报错 |
| `supports()` 对未声明成员返回 false | manifest 漏项变成静默能力消失 |
| `loadBrowserApiManifest` 抛错 | 文档目录损坏导致整个 agent 启动失败 |
| guest 重建不等 detach ACK | UAF，DevToolsSession 访问已析构 client |
| 重建前不清去重 ref | 新 guest 被旧键拦截，导航静默丢失 |
| 同一 view 多个 pending 句柄 | 被覆盖的 Promise 永久悬空，上层 await 不返回 |
| 不忽略 ERR_ABORTED | 正常导航被打断时误报加载失败 |
| /status 缓存键缺 authSessionSeq | 换账号后沿用上个会话的额度快照 |
| 手动核销中并发调 /opportunity | 与 /use 抢发卡锁，稳定触发 429 |
| history/read 按 scope 拆分上报 | 游标清不掉，其他窗口重复播放完成提示 |
| 只读/可编辑用 disabled 合并 | 只读 provider 仍可改 baseUrl |
| 保存互斥用 state 而非 ref | 连点两次产生两个 in-flight 请求 |
| mention 插入拆成两次 editor.update | 选区被中间态重置，token 落到错误节点 |
| flatItems 变化不收敛 selectedIndex | 首次 Enter 落到 disabled 项，被吞键 |
| 命令 effect 依赖不全 | 闭包捕获旧候选，键盘选中已消失的项 |
| close 时不按 owns 判断 | 关掉注入 store，连坐宿主其他会话 |
| close 顺序颠倒 | 关闭期间仍向已关 store 追加事件，或跳过遥测 shutdown |
| workspace 前缀剥离不带分隔符 | `workspace2` 被当成 `workspace` 子路径 |
| kind 允许降级 | 删除被后续 view 覆盖回可编辑态 |
| 关闭远控弹窗时调用 stop | 一关 UI 手机端立即掉线 |
| status 在本地推断 | 用户看到一条实际未建立的连接 |

## 顺延

本批从 B25 计划清单的 12 个文件中取缺口前 8 个（含 B24 顺延的 3 个），
以下 4 个顺延到下一批：

- `packages/ui/src/components/ai-elements/image-preview-dialog.tsx` — 157
- `packages/ui/src/project-sidebar/ProjectComposerMenu.tsx` — 156
- `packages/ui/src/root/useRootWorkspaceActions.ts` — 156
- `packages/ui/src/project-sidebar/grouped/view.ts` — 155

> 说明：本批开工前对 8 个目标文件逐一做了基线校验（`newComments=0`），确认无半插入残留；
> 全部插入均经 `zc-insert.mjs` 原子批写入。`treemappingActivity.ts` 首稿文件头含 `*/` 字面量被插入器拒绝，
> 整批未落盘，改写措辞后重插成功（未产生回滚）。
