# ZC-DEEP-b15

> 批次：B15（计划表为 6 文件 / 缺口 1,824 行）。实际拆成两个子批：
> b15a = `packages/ui` 的三个视图层（表格交互、模型供应商详情、只读分享时间线）；
> b15b = 远程连接字段层、Bot 渠道弹窗编排、debug 服务端跨源分析器。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b15a\orig`、`ZC-deep-b15b\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b15a
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=935

node zc-verify.mjs ZC-deep-b15b
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=925

deep-density --baseline ZC-deep-b15a/orig --only b15a 三文件
30.36  1472  1232  374  314  packages/ui/src/components/ai-elements/markdown-table.tsx
30.10  1383  1186  357  311  packages/ui/src/settings/model-provider-section/Detail.tsx
30.03  1491  1189  357  310  packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.03 median=30.10 newComments=935
PASS: all 3 file(s) >= 30% (mode=code)

deep-density --baseline ZC-deep-b15b/orig --only b15b 三文件
30.07  1472  1114  335  304  packages/ui/src/RemoteConnectionFields.tsx
30.14  1543  1128  340  297  packages/ui/src/BotsDialog.tsx
32.24  1945  1368  441  324  apps/zcode-cli/packages/debug/server/analyzer.ts
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.07 median=30.14 newComments=925
PASS: all 3 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/components/ai-elements/markdown-table.tsx` | Markdown 表格渲染与交互层：虚拟横向滚动条、吸底工具条、CSV 导出 | INV-01~18；scrollMax = tableWidth − 稳定槽宽；overflow 判定与 thumb 比例共用同一轮槽宽；左阴影看真实 scrollLeft、右阴影看虚拟进度；滚动条 thumb 与轨道双向同步；吸底三条件与避让量；容器 resize 只重算不重挂；CSV 公式注入降级 + BOM；只导出可见列；复制走同一序列化 | 314 |
| `packages/ui/src/settings/model-provider-section/Detail.tsx` | 模型供应商详情面板：权益分支、凭据状态、模型编辑与升级引导 | INV-01~18；导航分支顺序 preset → codingPlan/teamPlan → loading；查询失败 ≠ 未分配；凭据不可用原因不被 loading/error 改写；明确无权益才隐藏配置；升级面板打开时状态卡动作收敛；模型编辑回调五件套必须成对；保存中禁用与乐观列表分离 | 311 |
| `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` | 只读分享页时间线：内容块归并、工件/外链渲染、资源占位 | INV-01~18；内容块与 rows 三重交叉校验（rowId + productTurnId + kind）；claimed/claimedResources 双重去重；marker 未知一律返回 null；导入工件四段路径校验；外链只允许 http/https 且禁 localhost；只读页不得引入 Desktop 依赖 | 310 |
| `packages/ui/src/RemoteConnectionFields.tsx` | 新建/编辑远程连接表单字段层（ssh/server/wsl/docker 四类共用） | INV-01~18；受控组件零本地字段值；错误 id 与 aria-describedby 同源；别名 linked/advanced 互斥；docker select/manual 互斥且切换清另一侧；焦点修复按 key 变化而非 host 变化；粘贴解析成功才接管；wsl 空用户名合法；本文件零远程请求 | 304 |
| `packages/ui/src/BotsDialog.tsx` | Bot 渠道设置弹窗编排层：加载、保存、四类轮询、五个幂等闸 | INV-01~18；状态轮询 2s 串行 / 绑定码 2s / 飞书按 interval / 微信长等待必须串行；飞书 pending 必须返回值相等原对象；微信 pending/scanned 只更新 interval+status；工作区乐观更新 + previousBot 回滚；空工作区列表归一化为「全部」；名称提交时才写盘；IME Enter 不提交；Escape 只取消重命名 | 297 |
| `apps/zcode-cli/packages/debug/server/analyzer.ts` | debug 服务端唯一跨源关联层：trace 列表/详情、span、上下文快照、缓存报告、埋点建议 | INV-01~20；traceId 精确隔离；SQLite 无 traceId 只能按会话集合关联；首条用户消息取最早；span 配对必须晚于起始时间；只按 markdown 一/二级标题切分系统提示；percentTokens 除零保护；hitRate 分母为 inputTokens 且为 0 返回 null；缓存分段需 lastCacheHit + cachedMessages 已知 | 324 |

合计 **1,860**（935 + 925），与两次 `zc-verify` 的 `added` 之和一致。

## 关键不变量（抽取）

### 1. 虚拟滚动条只维护「一个进度」

`markdown-table.tsx` 里同时存在真实 `scrollLeft` 与虚拟 thumb 位置。两者的唯一桥接点是
`scrollMax = tableWidth − 稳定槽宽`：槽宽用同一轮的测量值计算，overflow 判定也用同一轮。
用不同轮次的宽度会让 thumb 比例与可滚动范围错位，表现是「拖到底但表格还差几像素」或
「内容很短却出现滚动条」。阴影的判定故意不对称：左阴影读真实 `scrollLeft`（受 DOM 约束），
右阴影读虚拟进度（不受四舍五入影响）——统一成一种会在右端出现 1px 的闪烁。

### 2. 弹窗里的「幂等闸」优先于 state

`BotsDialog.tsx` 的五个 ref 全部是**副作用次数**的闸门，不是展示状态。把
`autoQrStartedBotIdsRef` 换成 state、或在失败时删除集合，都会让自动流程与服务端限流
叠加成循环请求。`handledEntryProviderRef` 同理：快捷入口只能消费一次，否则配置刷新后
会再次触发跳转。飞书 pending 的「值相等返回原对象」是 React 层面的硬约束：返回新对象
会让下游 effect 重跑，重启二维码轮询，形成 RPC 风暴。

### 3. 只读分享页的信任边界

`ConversationShareReadonlyTimeline.tsx` 处理的是**外部链接**，不是本机数据。因此：
归并必须三重交叉校验，不能只凭 rowId（分享快照可被构造）；marker 未知一律返回 null
而不是降级渲染（未知节点可能是任意 HTML）；工件导入要求四段路径同时命中；外链只放行
http/https 且显式拒绝 localhost（避免分享页变成内网探测器）。这条边界一旦放宽，
分享页就成了 SSRF 与内容注入的入口。

### 4. 跨源关联的三条铁律

`analyzer.ts` 的所有输出都必须满足：

1. **traceId 精确隔离**：日志/事件带 traceId，直接按等值过滤；
2. **SQLite 没有 traceId**：只能先由日志/事件收集 `sessionIds`，再用会话集合关联
   DB 消息与片段。因此 `collectSessionsForTrace` 的返回集是后续全部 DB 视图的唯一依据，
   任何绕过它直接读 `db.messages` 的代码都会把别的会话混进来；
3. **缺失即降级**：单条坏记录产出 unknown/空值，不得中断整体返回；但读取层的失败必须
   体现在 `sources` 的 warning 上，不能被静默吞掉。

`hitRate` 与 `percentTokens` 的除零保护不是防御性编程，而是接口契约：返回 `null`
表示「分母未知」，返回 `0` 表示「确认为零」，前端据此选择 `—` 还是 `0%`。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 用不同轮次宽度算 scrollMax 与 overflow | 表格拖到底仍差几像素，或短内容出现幽灵滚动条 |
| 左右阴影统一读 scrollLeft | 右端 1px 闪烁 |
| 把 `autoQrStartedBotIdsRef` 改成 state | 开窗即重复拉起二维码，服务端限流 |
| 飞书 pending 返回新建对象 | 轮询自激，二维码接口被打爆 |
| 微信轮询用 setInterval | 长等待叠加，并发连接数持续上涨 |
| 工作区保存不做 previousBot 回滚 | UI 显示已授权，实际保存失败 |
| 分享页只按 rowId 归并 | 构造快照即可把内容挂到别的轮次 |
| 分享页放行 localhost 外链 | 分享页可探测内网服务 |
| DB 视图绕过 sessionIds 白名单 | 详情页出现其他会话的消息与用量 |
| `hitRate` 分母为 0 返回 0 | 前端显示「0% 命中」，与「无数据」混淆 |

## 顺延

无。B15 计划内 6 个文件全部达标；下一批按 `ZC-DEEP-CORE-PLAN.md` 复算清单推进。
