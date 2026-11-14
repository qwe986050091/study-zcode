# ZC-DEEP-b36

> 批次：B36（12 文件，跨 5 个模块；本批优先消化 B35 顺延的 5 个文件，再补 7 个）。
> B36-A：`ui/lib` 1 + `ui/v4` 1 + `desktop/main` 2 + `server/remote` 1（+583 行）；
> B36-B：`desktop/main/browserView` 1 + `ui` 6（+800 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b36\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b36
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1383

node check-batch.mjs ZC-deep-b36 ZC-deep-b36a-files.txt
TOTAL added=583 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b36 ZC-deep-b36b-files.txt
TOTAL added=800 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28   517   390  122  114  packages/ui/src/components/marketing-touch/MarketingTouchProvider.tsx
31.28   528   390  122  116  packages/ui/src/v4/ConversationFileSummaryPanel.tsx
31.28   511   374  117  113  packages/ui/src/settings/usage-stats/CodingPlanUsageBarChart.tsx
31.33   556   399  125  115  packages/desktop/src/main/desktopZCodeDataSizeTelemetry.ts
31.33   523   383  120  114  packages/ui/src/feedback/FeedbackSubmitForm.tsx
31.35   542   386  121  114  packages/desktop/src/main/browserView/browserPlaywrightDomSnapshot.ts
31.36   744   523  164  117  packages/server/src/remote/ssh-backend.ts
31.36   925   660  207  119  packages/desktop/src/main/desktopWindowChrome.ts
31.38   535   392  123  116  packages/ui/src/lib/conversationShareError.ts
31.38   537   392  123  115  packages/ui/src/settings/McpServerForm.tsx
31.44   605   404  127  115  packages/ui/src/workspace-file-tree/model.ts
31.52   537   387  122  115  packages/ui/src/TaskSearchDialog.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.28 median=31.35 newComments=1383
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`；`zc-verify` 的 `added=1383`
与两组子批 `check-batch` 合计（583 + 800）一致，也与逐文件目标合计一致。
`// INV-` 条数：12~20 条/文件。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/lib/conversationShareError.ts` | 会话分享错误的归一化与用户文案映射 | INV-01~16；路径与协议头脱敏白名单；issue 清洗与截断计数；顶层/details 双源读取；`reason` 优先于 `kind` | 116 |
| `ui/src/v4/ConversationFileSummaryPanel.tsx` | 会话文件变更摘要面板 | INV-01~15；聚合值与明细重算边界；`requestKey`/`settled` 跨轮串用防护；迟到响应丢弃；撤销「预检→应用」幂等 | 116 |
| `desktop/src/main/desktopWindowChrome.ts` | 窗口外壳、guest 附着与导航策略 | INV-01~20；preload 三选一与偏好加固；popup/导航白名单与 Coding Plan 身份粘性；guest 队列配对；三处缩放落点 | 119 |
| `desktop/src/main/desktopZCodeDataSizeTelemetry.ts` | 数据体积遥测上报 | INV-01~18；24 小时限流的预占-回滚顺序；空闲/忙碌双闸门；TOCTOU 复查；定时器 unref | 115 |
| `server/src/remote/ssh-backend.ts` | SSH 远程执行后端 | INV-01~20；连接生命周期与提前取消的二次校验；ready/dispose 竞态；SFTP→exec 负缓存；上传取消与流释放 | 117 |
| `desktop/src/main/browserView/browserPlaywrightDomSnapshot.ts` | Playwright DOM 快照采集 | INV-01~16；CDP 会话解绑与 abort 时序；injected world 去重；objectId 释放；iframe 预算与可见性过滤 | 114 |
| `ui/src/settings/McpServerForm.tsx` | MCP 服务器编辑表单 | INV-01~18；表单/JSON 双模式草稿所有权；模式切换事务与解析失败回滚；`canSave` 只读闸门；协议版本哨兵 | 115 |
| `ui/src/TaskSearchDialog.tsx` | 全局任务搜索弹窗 | INV-01~16；未打开时零订阅；会话 key 跨工作区去重；9 条上限与 1-9 快捷键同口径；回调先于清空查询 | 115 |
| `ui/src/workspace-file-tree/model.ts` | 工作区文件树数据模型 | INV-01~18；路径归一唯一口径；Git 状态优先级归并；写时复制增量更新；压缩链 depth 与展开态一致 | 115 |
| `ui/src/components/marketing-touch/MarketingTouchProvider.tsx` | 营销触达上下文与轮询 | INV-01~14；运行时工厂与 poller 声明顺序；素材释放幂等；claim 四态；轮询可见性与 effect 清理顺序 | 114 |
| `ui/src/feedback/FeedbackSubmitForm.tsx` | 反馈提交表单 | INV-01~12；提交状态机与 job 生命周期；草稿应用用引用相等判定；取消的双语义；自动关闭判定 | 114 |
| `ui/src/settings/usage-stats/CodingPlanUsageBarChart.tsx` | 套餐用量柱状图 | INV-01~20；6 色上限与截断；`barKeys` 与 `chartData` 字段成对；Y 轴取单模型最大值；空态必须在 hooks 之后 | 113 |

合计 **1,383**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 迟到的异步结果只能丢弃，不能覆盖

`ConversationFileSummaryPanel.tsx` 用 `requestKey` + `settled`、`MarketingTouchProvider.tsx` 用
poller 代际、`desktopZCodeDataSizeTelemetry.ts` 用扫描序号，三处是同一模式：await 之后先比对当次请求身份再写状态。
少了这一步，快速切换会话/账户时旧响应会盖掉新状态，而且最终画面「看起来正常」，只在数值上悄悄错。

### 2. 双模式编辑器的「模式切换」必须是事务

`McpServerForm.tsx` 的表单态与 JSON 态各自持有草稿，切换时先解析再提交，解析失败必须整体回滚到切换前。
若先清空再解析，一次手误的非法 JSON 就会让用户丢掉整段配置，且撤销不回来。

### 3. 限流要先预占再回滚，顺序不能反

`desktopZCodeDataSizeTelemetry.ts` 的 24 小时窗口在发起上报前预占配额，失败时按同一次标记回滚。
反过来（先上报成功再记账）会在并发上报时突破窗口上限；只预占不回滚则一次网络抖动就吃掉整天配额。

### 4. 资源释放必须是幂等的

`browserPlaywrightDomSnapshot.ts` 的 CDP 会话、`ssh-backend.ts` 的连接与 SFTP channel、
`MarketingTouchProvider.tsx` 的素材对象，都在正常结束、abort、异常三条路径上被释放。
释放函数不幂等时，第二条路径会二次释放并抛错，把原始失败原因掩盖掉。

### 5. 共享的「上限」只能有一个来源

`TaskSearchDialog.tsx` 的 9 条结果与 1-9 快捷键、`CodingPlanUsageBarChart.tsx` 的 6 色与图例截断，
都必须由同一个常量/同一段截断逻辑导出。分头硬编码时，数字一旦改动，UI 与快捷键就会对不上，
表现为「按 9 没反应」或「图例缺一色」。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 分享错误不清洗 `issue` 文本 | 用户可见区域泄漏本地绝对路径与内部协议头 |
| 摘要面板不校验 `requestKey` | 切换会话后显示上一个会话的文件列表 |
| preload 三选一被改成叠加 | 两套 IPC 桥同时注入，`window.zcode` 被后注入者覆盖 |
| popup 白名单放宽为任意 URL | 外部页面继承 Coding Plan 身份，可反向调用本机能力 |
| 限流先记账后上报 | 并发上报突破 24 小时窗口 |
| 限流预占不回收 | 一次失败吃掉整天配额，遥测整天缺失 |
| SSH 提前取消不再校验 | 已 abort 的调用继续建连，泄漏一条常驻连接 |
| SFTP 负缓存无失效点 | 远端恢复 SFTP 后仍永久走 exec 降级 |
| DOM 快照不释放 objectId | 长开页面 heap 持续增长直至 DevTools 断开 |
| 双模式切换先清空后解析 | 非法 JSON 导致整段配置丢失 |
| `canSave` 允许空名称提交 | 生成不可寻址的 MCP 服务器条目 |
| 文件树路径未归一 | 同一文件出现两个节点，展开态互相覆盖 |
| 压缩链 depth 与展开态脱节 | 折叠中间目录后子目录永久不可见 |
| 搜索未打开仍订阅 | 隐藏弹窗持续接收任务事件并触发重渲染 |
| 表单切换未取消在途提交 | 旧 job 完成后把新表单置为已完成 |
| 柱状图 `barKeys` 与数据字段错位 | 图例有色但柱体为空 |
| 空态判断放在 hooks 之前 | 条件渲染导致 hooks 顺序变化，运行时报错 |
| 命令/预览类注释里出现 `;` 或箭头 | 自查判为误写代码，需返工 |

## 顺延

B36 复算清单为 18 文件，本批取 12 个（含 B35 全部 5 个顺延），其余 6 个顺延到 B37：
`apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts`（缺口 108）、
`packages/shared/src/index.ts`（缺口 108）、
`packages/ui/src/hooks/useUsageEntitlement.ts`（缺口 108）、
`packages/ui/src/lib/chatAttachments.ts`（缺口 108）、
`packages/ui/src/WelcomeScreen.tsx`（缺口 108）、
`apps/zcode-cli/packages/office-runtime/src/adapters/server.ts`（缺口 109）。

> 说明：按防超限规则执行，每文件单独 spec（≤150 行），5~7 文件一组并行，逐文件密度校验。
> 本批出现 2 处自查 `suspicious`，均为中文句子以英文关键字（`type`/`catch`）开头被误判，
> 已就地改写为中文表述，`deletedNonZero` 仍为 0。
