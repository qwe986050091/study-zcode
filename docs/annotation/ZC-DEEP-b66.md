# ZC-DEEP-b66

> 批次：B66（12 文件，按 31.4% 口径计算目标 787 行；按当前工作树复算，优先同类：`packages/ui` 9 个（components/ui、ToolCallBlocks、app-shell、hooks、root、store、根目录）、`apps/zcode-cli` 2 个（dynamic-workflow/testing、tui）、`packages/shared` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b66\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=748）。

## 校验

```
node zc-verify.mjs ZC-deep-b66
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=787

node check-batch.mjs ZC-deep-b66 ZC-deep-b66-files.txt
TOTAL added=787 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   287   208    65   64  packages/ui/src/store/whiteboardStore.ts
31.27   383   275    86   65  apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-reads.ts
31.28   306   211    66   64  packages/ui/src/components/ui/smooth-metric-value.tsx
31.28   535   390   122   67  apps/zcode-cli/packages/tui/src/app-events.ts
31.28   542   374   117   66  packages/shared/src/usage-stats.ts
31.32   388   281    88   65  packages/ui/src/hooks/useZCodeTaskService.ts
31.36   498   354   111   67  packages/ui/src/ToolCallBlocks/renderers/list-models.tsx
31.46   367   267    84   65  packages/ui/src/root/remoteWorkspaceSessionPersistence.ts
31.51   318   238    75   66  packages/ui/src/WorkspaceHeader.tsx
31.55   281   206    65   65  packages/ui/src/app-shell/SubagentDirectorySidePane.tsx
31.58   303   209    66   66  packages/ui/src/components/ui/carousel.tsx
31.60   349   250    79   67  packages/ui/src/WebRemoteControlMobileShell.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.25 median=31.34 newComments=787
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/components/ui/carousel.tsx` | embla 轮播组件族 | INV-01~18；canScrollPrev 与 canScrollNext 只能由 onSelect 写入；首帧实例可能未就绪；滚动轴由 orientation 推导；子组件只经 useCarousel 取 context；context 为空显式抛错；onSelect 早于事件登记执行一次 | 66 |
| `ui/ToolCallBlocks/renderers/list-models.tsx` | ListModels 聊天卡渲染 | INV-01~18；先走 display 通道且 kind 为 list_models 才收口；display.models 逐字段重建并拷贝数组；JSON 候选只接受 { 或 [ 开头；readResultRecord 形状不符回 null；逐条校验三个非空字符串；视图字段按白名单拷贝不展开 | 67 |
| `ui/WebRemoteControlMobileShell.tsx` | 手机远控外壳 | INV-01~18；历史态判据唯一落在 isWebRemoteControlMobileChatHistoryState；入栈前先挡 typeof window；入栈判重留在函数开头；刷新恢复只读 history 兜底；初始页优先级为显式意图、history、home；页面事实源只有 currentPage | 67 |
| `ui/WorkspaceHeader.tsx` | 工作区头部外壳 | INV-01~18；只做顶栏布局与分发不持有工作区事实；侧栏可见时不预留浮层留白；留白以类名而非像素表达；更新徽标占额外宽度；macOS 全屏与窗口态分开取值；variant 默认必须是 task | 66 |
| `dynamic-workflow/testing/journal-contract-reads.ts` | journal 读面契约用例 | INV-01~18；两个实现共用同一份读面断言；每条用例独占一个 store；kinds 过滤保持插入序；kinds 的 all 与空数组语义分明；未知 run 一律返回空；二次 upsert 不挪行位 | 65 |
| `tui/src/app-events.ts` | TUI 事件归约入口 | INV-01~18；事件到状态映射只存在于 applySessionEventToState；只写状态不发 I/O；payload 统一经 asRecord 归一；default 静默忽略保持空；新事件必须显式登记；turnId 成对写入与清空 | 67 |
| `shared/src/usage-stats.ts` | 用量统计协议契约 | INV-01~18；估算比例只有一处定义；quota 契约只从 usage-quota 来；两套区间词汇不可合并；数据源必须显式声明；指定来源与禁止回退成对传；环境变量覆盖密钥可关闭 | 66 |
| `ui/app-shell/SubagentDirectorySidePane.tsx` | 子代理目录侧栏 | INV-01~18；目录项收敛为 DirectoryItem 联合；打开请求只替换三个字段其余继承 tab；workspaceIdentity 与 remoteSessionId 用条件展开；StatusIcon 覆盖七态且不留 default；memo 收益有限；时间戳用 in 判别后取 endedAt 或 startedAt | 65 |
| `ui/hooks/useZCodeTaskService.ts` | task 服务按实例代理 | INV-01~18；三个类型别名由方法签名推导；三张 WeakMap 都以 service 实例为键；service 不是对象时原样返回；同键并发合流到同一 Promise；inflight 清理先确认条目仍是本次 Promise；去重键含四个维度 | 65 |
| `ui/root/remoteWorkspaceSessionPersistence.ts` | 远程工作区会话持久化 | INV-01~18；身份键统一取 workspaceIdentity 的 trim 结果；project 只做读侧投影并单列 updatedEntries；只有原 purpose 不是 conversation 才进回写；canonical 路径比较用全等；身份解析必须经 parseRemoteWorkspaceIdentity；三种返回必须区分 null 与空对象 | 65 |
| `ui/store/whiteboardStore.ts` | 白板内存状态源 | INV-01~18；workspace 键唯一来源是 buildWhiteboardWorkspaceKey；boardIds 与 boardsById 同一次 set 更新；createBoard 先快照算名再以最新 state 追加；返回与落库同一引用；兜底对象每次新建且只读；updateBoard 缺失时返回原引用 | 64 |
| `ui/components/ui/smooth-metric-value.tsx` | 数字滚动展示 | INV-01~18；数值归一化只在 normalizeSmoothMetricTarget 收口；null 表示尚不可解析并直接展示原值；每帧必须有确定收尾；cancelMetricFrame 同时取消与归零；metricKey 变化先取消旧帧再整体重置；负间隔不推进 | 64 |

合计 **787**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 轮播滚动状态只能由 onSelect 写入

`carousel.tsx` 只在 onSelect 回调里更新 canScrollPrev 与 canScrollNext。
在滚动事件里另写一份会让按钮可用态与实际位置分叉，出现「还能点但没反应」。

### 2. 视图字段按白名单拷贝，不对 entry 展开

`list-models.tsx` 逐字段重建视图并复制 reasoningLevels。
展开会把宿主私有字段带进渲染层，卡片之间还会共享同一份可变数组。

### 3. 页面事实源只有 currentPage 一处

`WebRemoteControlMobileShell.tsx` 不在局部变量另存当前页。
另存一份会让视图与浏览器历史立刻分叉，返回键跳错页面。

### 4. 事件归约只写状态

`app-events.ts` 的 switch 内只调用 setter 或同目录 reducer。
在此发起请求或落盘，事件重放会产生重复外部副作用。

### 5. inflight 清理必须先确认条目仍是本次 Promise

`useZCodeTaskService.ts` 在 finally 里做恒等比较后再删除。
无条件删除会把后发请求的条目抹掉，重复 RPC 重新出现。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 轮播按钮态在滚动事件另写 | 按钮可用态与实际位置分叉 |
| 模型视图展开 entry | 私有字段进入渲染层，卡片共享可变数组 |
| 远控页另存 currentPage | 返回键跳到错误页面 |
| 事件归约内发请求 | 事件重放产生重复副作用 |
| inflight 无条件删除 | 重复 RPC 重新出现 |
| 白板只写 boardsById | 新块不出现在列表，默认名撞名 |
| 持久化混淆 null 与空对象 | 上次活动项永远清不掉 |
| 目录项 switch 留 default | 新状态渲染空白图标 |
| 动画帧漏置空 frameId | 后续再也启不了帧，数字停住 |
| 用量区间合并 custom | 自定义区间被当作 all，统计被放大 |

## 顺延

B66 复算清单共 20 个候选，本批取 12 个，其余顺延到 B67，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.25%~31.60%，`suspicious=0`。
