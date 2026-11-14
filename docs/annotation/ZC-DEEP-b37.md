# ZC-DEEP-b37

> 批次：B37（12 文件，跨 5 个模块；本批优先消化 B36 顺延的 6 个文件，再补 6 个）。
> B37-A：`core/runtime` 1 + `office-runtime` 2 + `shared` 2（+570 行）；
> B37-B：`shared` 1 + `ui` 5 + `desktop/main` 1（+788 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b37\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b37
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1358

node check-batch.mjs ZC-deep-b37 ZC-deep-b37a-files.txt
TOTAL added=570 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b37 ZC-deep-b37b-files.txt
TOTAL added=788 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28   515   374  117  111  packages/shared/src/background-task-controls.ts
31.30   504   361  113  111  packages/shared/src/conversation-preview-artifacts.ts
31.30   486   361  113  112  packages/shared/src/index.ts
31.30   496   361  113  111  packages/ui/src/v4/useConversationTimelineFind.ts
31.33   539   399  125  112  packages/ui/src/v4/ConversationQueuePanel.tsx
31.36   571   405  127  112  packages/desktop/src/main/desktopMainIpcPlatform.ts
31.37   595   424  133  113  packages/ui/src/lib/chatAttachments.ts
31.42   727   541  170  114  apps/zcode-cli/packages/office-runtime/ui/shell/parts.tsx
31.44   602   439  138  114  packages/ui/src/hooks/useUsageEntitlement.ts
31.44   908   652  205  117  apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts
31.46   673   480  151  115  packages/ui/src/WelcomeScreen.tsx
31.48   711   521  164  116  apps/zcode-cli/packages/office-runtime/src/adapters/server.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.28 median=31.36 newComments=1358
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`；`zc-verify` 的 `added=1358`
与两组子批 `check-batch` 合计（570 + 788）一致，也与逐文件目标合计一致。
本轮 `suspicious=0`，未出现中文句以英文关键字开头的情况。`// INV-` 条数：13~20 条/文件。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `core/src/runtime/methods/file-rewind.ts` | 文件回滚方法：预览、写入与补偿 | INV-01~18；预览与写入共用同一计划；unsafe 全量阻断的原子性；逆序哈希校验；journal 先记后写与逆序补偿；`AggregateError` 上抛 | 117 |
| `office-runtime/src/adapters/server.ts` | Office 运行时服务端适配器 | INV-01~17；`register` 统一包装与 `readOnly` 默认；异常转 `isError`；导入四步事务；静态资源白名单防穿越；分块 token 归属 | 116 |
| `office-runtime/ui/shell/parts.tsx` | Office 外壳组件（菜单、查找栏、分页） | INV-01~14；Menu 监听清理与 `onClose` 稳定性；Esc 冒泡；三态 aria；PagePill 定时器释放与页码夹取；hooks 顺序 | 114 |
| `shared/src/index.ts` | shared 包的 barrel 汇总入口 | INV-01~16；显式导出与 `star` 的覆盖及歧义剔除；type/值导出分家；`.js` 后缀与目录 index；`#src` 映射；只增不删与求值顺序 | 112 |
| `shared/src/background-task-controls.ts` | 后台任务条目的归一化与排序 | INV-01~19；`jobId` 键序与回退 id；去重覆盖与插入顺序；状态归一化与未知兜底；可选字段三态；耗时取大不回退 | 111 |
| `shared/src/conversation-preview-artifacts.ts` | 会话预览产物的路径与范围归一 | INV-01~13；扩展名映射表顺序敏感；路径归一出口与 UNC/盘符；`protectedRanges` 五级优先级；`lastIndexOf` 偏移陷阱；15/10 双上限裁剪时机 | 111 |
| `ui/src/hooks/useUsageEntitlement.ts` | 用量权益查询与刷新 | INV-01~17；in-flight 合流与引用比较清理；超时只放弃等待不取消上游；`requestScope`+`requestVersion` 回包归属；silent 刷新 loading | 114 |
| `ui/src/lib/chatAttachments.ts` | 聊天附件的校验、序列化与恢复 | INV-01~15；MIME 归一化；图片/视频/PDF 三套上限不可合并；`atob` 前必须拦截；恢复三出口顺序；objectUrl 生命周期 | 113 |
| `ui/src/WelcomeScreen.tsx` | 欢迎页与登录四态机 | INV-01~18；active 早退；request id 幂等；attempt 生命周期；provider 严格匹配；seq 水位线；下降沿清理与渠道回退 | 115 |
| `ui/src/v4/ConversationQueuePanel.tsx` | 会话队列面板与拖拽排序 | INV-01~20；投影只读契约；行级锁与并发派发；reorder 锚点换算的 off-by-one；拖拽修饰器与 scale；`authority_ack` 排空事务 | 112 |
| `ui/src/v4/useConversationTimelineFind.ts` | 会话时间线查找 | INV-01~16；索引缓存分代与 running turn 不缓存；`globalIndex` 与 `matchCount` 一致；补齐幂等键与 1200 行上限；rAF 清理 | 111 |
| `desktop/src/main/desktopMainIpcPlatform.ts` | 主进程 IPC 通道平台层 | INV-01~16；通道唯一注册与重复注册崩溃；renderer 入参 zod 校验；对话框取消语义（null 与空数组）；成功位信封；窗口销毁时中性返回 | 112 |

合计 **1,358**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 补偿日志必须先记后写

`file-rewind.ts` 的 journal 在每次真实写入**之前**落盘，失败时按逆序补偿已写项。
顺序反过来（先写后记）时，进程在写入与记账之间崩溃，重启后既无法确认写了什么，也无法回滚，
用户看到的是「文件被改了一半，且回滚按钮说没有可回滚内容」。

### 2. 预览与执行必须共用同一份计划

同一文件的 `preview` 与 `apply` 都从同一个计划对象派生：预览会展示哪些条目，执行就只处理哪些。
两条路径各算一遍时，任何一条规则（忽略 Shell、not_found 哨兵、unsafe 阻断）的漂移都会造成
「预览说安全，执行却拒绝」或更糟的「预览没提到，执行却改了」。

### 3. 代理层只允许有一个响应信封

`office-runtime/src/adapters/server.ts` 的 `register` 把所有 handler 的返回值统一成
`text` + `structuredContent` + `isError`。包装一旦被绕过，错误会以裸异常抛出，
MCP 客户端只会拿到一个无结构的传输错误，前端拿不到 `corrupt_file` 之类的可判断码。

### 4. 上限不可合并，来源必须单一

`chatAttachments.ts` 的图片/视频/PDF 三套大小上限、`codingPlanUsageBarChart` 的 6 色上限，
都各自有产品语义。合并成一个常量后再按 MIME 分支判断，会让某一类的限制悄悄放宽；
而图例与柱体分别硬编码上限时，改数字必然只改一处。

### 5. barrel 只增不删，求值顺序不可重排

`shared/src/index.ts` 是跨包公共面：`export *` 与显式导出并存时，显式导出优先且同名歧义必须剔除。
把显式导出改回 `star`、或为「精简」删掉某个 `export`，会让下游包在编译期通过、运行期拿到 `undefined`。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| journal 先写后记 | 崩溃后无法回滚，文件停在半改状态 |
| 补偿不按逆序 | 同名路径多次改写后回滚到中间版本 |
| preview 与 apply 各算一遍计划 | 预览与执行结果不一致 |
| unsafe 条目部分应用 | 用户以为全部阻断，实际已改了一部分 |
| register 包装被绕过 | MCP 客户端只拿到裸传输错误，前端无法分类提示 |
| 静态资源白名单缺失 | 通过目录穿越读取工作区外文件 |
| 分块 token 不校验 owner | 他人会话的文件分块被读取 |
| Menu 监听不清理 | 组件卸载后菜单仍响应，触发对已卸载状态写入 |
| hooks 放在 JSX 条件分支后 | 分支切换时 hooks 数量变化，运行时崩溃 |
| barrel 用 `star` 替代显式导出 | 下游 `undefined`，编译期无报错 |
| 状态未归一化直接比对 | 未知状态条目不显示也不消失 |
| 耗时取小回退 | 任务耗时在刷新后回跳，进度条倒退 |
| 路径未归一即比较 | 同一附件/产物被判为两个，重复展示 |
| `atob` 前不校验体积 | 超大 base64 直接阻塞主线程 |
| 权益查询不校验 `requestScope` | 切换账号后显示上一个账号的权益 |
| 超时直接取消上游请求 | 多个组件共享的请求被其中一个调用方掐断 |
| reorder 锚点少减一 | 拖拽落点稳定偏移一格 |
| 查找缓存跨代复用 | 编辑后搜索结果指向旧位置 |

## 顺延

B37 复算清单为 19 文件，本批取 12 个（含 B36 全部 6 个顺延），其余 7 个顺延到 B38：
`packages/desktop/src/main/desktopOAuthDeepLink.ts`（缺口 106）、
`packages/server/src/remote/localTarGz.ts`（缺口 106）、
`packages/ui/src/chat-input-toolbar/display.tsx`（缺口 106）、
`packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx`（缺口 106）、
`packages/ui/src/settings/saved-workflows/SavedWorkflowDetailView.tsx`（缺口 105）、
`packages/ui/src/ToolCallBlocks/renderers/node-repl.tsx`（缺口 105）、
`packages/desktop/src/main/networkTelemetryAggregator.ts`（缺口 104）。

> 说明：按防超限规则执行，每文件单独 spec（≤150 行），5~7 文件一组并行，逐文件密度校验。
> 本批 `suspicious=0`，无需返工改写。
