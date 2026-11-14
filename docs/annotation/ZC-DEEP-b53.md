# ZC-DEEP-b53

> 批次：B53（12 文件，复算缺口 927 行；按当前工作树复算，优先同类/同目录：`packages/ui/src` 7 个（`project-sidebar`/`app-shell`/`feedback`/`lib`/`rewards`）、`packages/desktop` 2 个、`packages/shared`/`packages/client`/`apps/zcode-cli/packages/i18n` 各 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b53\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b53
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=969

node check-batch.mjs ZC-deep-b53 ZC-deep-b53-files.txt
TOTAL added=969 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   336   256    80   79  packages/desktop/scripts/mcp-apps-host-fixture/managed-lifecycle-checks.ts
31.27   352   259    81   79  packages/desktop/src/main/rendererActionTraceBroker.ts
31.34   500   367   115   80  packages/ui/src/app-shell/useWorkspaceTaskNavigation.ts
31.37   357   271    85   79  packages/ui/src/rewards/RewardsWebview.tsx
31.37   349   255    80   80  packages/shared/src/workspace-hook-digest.ts
31.40   345   258    81   79  packages/ui/src/app-shell/SidePaneTabOverview.tsx
31.40   362   258    81   79  packages/ui/src/lib/usageEntitlementRefreshPolicy.ts
31.43   486   350   110   81  packages/ui/src/lib/uiPerfArmsTelemetry.ts
31.43   370   280    88   81  packages/ui/src/project-sidebar/ProjectCreation.tsx
31.44   397   299    94   93  apps/zcode-cli/packages/i18n/src/types.ts
31.44   395   299    94   80  packages/client/src/remoteServiceAccess.ts
31.44   363   264    83   79  packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.25 median=31.40 newComments=969
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/project-sidebar/ProjectCreation.tsx` | 新建项目外层编排 | INV-01~20；设备来源二选一（Source 快照 vs `directory.hosts`）；设备 id 必须由 `buildServerRemoteWorkspaceIdentity` 反算；workspaceKey 去空白 identity 优先；`currentScope` 每渲染刷新；每个 await 后复检 active/isCurrent；Host 准入集与 membershipId 变化判 host-removed；登记成功后才 prepend；接管需同时满足 tab/工作区/草稿版本未变且无活跃任务 | 81 |
| `ui/app-shell/SidePaneTabOverview.tsx` | 页签概览弹层 | INV-01~19；空态与列表共用同一长度判断；两个分组独立判空；关闭弹层必须清空 query；`shouldFilter=false` 防止 cmdk 二次过滤中文标题；选中态只比 `tab.id`；行内关闭在 pointerdown/click 双阻断冒泡；时间基准定时器只在打开期间存在；memo 依赖逐字段列出 labels | 79 |
| `ui/app-shell/useWorkspaceTaskNavigation.ts` | 任务/自动化/插件商店共享浏览器式历史 | INV-01~20；选择任务先激活 tab 再读 activeTab；目标匹配用路径+identity 组合 key；未读清理是 compare-and-clear 且与回滚严格配对；远程服务缺失时放弃清理；`setActiveTaskId` 是最后一步；历史不可变只能 push/back/forward；不存在目标先移除再继续同向查找且必须终止 | 80 |
| `ui/feedback/FeedbackBackgroundUploadIndicator.tsx` | 反馈后台上传浮层 | INV-01~19；进度夹在 0~100 且未知时不渲染百分比；状态唯一来源是 job 快照；只有成功态排期自动隐藏；订阅只在挂载建立并必须 dispose；无任务返回 null；多任务各自独立定时器；工单目标先开详情再移除卡片；不确定进度只走脉冲占位；宽度受视口约束 | 79 |
| `ui/lib/uiPerfArmsTelemetry.ts` | ui_perf 埋点唯一出口 | INV-01~18；未注入 reporter 即视为关闭；上报失败完全内部消化；模型名只在本文件脱敏且空串落 undefined；事件名与 `ui_perf` 分组成对；启动七段共享一份 properties；六段之和必须等于 total 且越界整批丢弃；可选字段无效省略而非补 0；exit_code 保留符号；流式停顿以 per-task 上一 chunk 为基线 | 81 |
| `ui/lib/usageEntitlementRefreshPolicy.ts` | 额度共享快照与失败退避 | INV-01~19；快照与退避必须挂在同一 service 实例；购买/鉴权切换让同身份在途请求全部失效；未标记 invalidate 不推进代数；`isCurrent` 不持快照不读时钟；去重窗口 60 秒且边界放行；请求键覆盖全部选项且字段顺序固定；成功发布同时清零失败计数并清退避；冷却截止只能单调推后；失效的可用性判断不得顺手续期 | 79 |
| `ui/rewards/RewardsWebview.tsx` | 积分页 webview | INV-01~19；每次注入前递增 generation 且回包比对 epoch；只在受信 URL 注入；加载中 ready 置假、stop 后补注入；只有主框架非 -3 才展示错误条；关闭顺序固定为递增 generation→撤销登录态→onClose；卸载同样撤销；四个监听器必须全部解绑；authSnapshot.revision 仅在指纹变化时递增；固定 REWARDS_PARTITION | 79 |
| `shared/workspace-hook-digest.ts` | 工作区钩子声明摘要 | INV-01~20；条目顺序由四级笛卡尔积唯一确定；事件顺序取自常量数组而非对象键序；reviewItemId 只由下标拼接；摘要不覆盖运行时开关；未设置与显式 false 产出不同字节；shell 三态独立编码；路径折斜杠并先 resolve 再取相对；空条目返回 undefined；快照深度冻结；摘要链路不读环境变量/时钟/文件系统/模块缓存 | 80 |
| `client/remoteServiceAccess.ts` | 远端服务访问装配 | INV-01~18；惰性代理语义与服务能力位；可选绑定缺失时的降级路径；窗口目录 / 文件服务 / Agent 服务字段的注入顺序；构造完成前不得暴露半成品实例；host-only 代理使用不可枚举属性防泄漏；命令服务与 genUi 服务的边界 | 80 |
| `desktop/scripts/mcp-apps-host-fixture/managed-lifecycle-checks.ts` | MCP apps 宿主受管生命周期自检夹具 | INV-01~19；窗口创建/销毁的时序断言；重试与第二次创建的幂等；作用域隔离；资源释放顺序；故障注入下的期望失败路径；断言失败即整段退出非零 | 79 |
| `desktop/main/rendererActionTraceBroker.ts` | 渲染端动作 trace 中转 | INV-01~18；队列与批量 drain 单消费者；重试与续排；enqueue 各拒收分支；flush/forceFlush 的 deadline 语义；shutdown 三阶段顺序；`settleWithinDeadline` 与 `exportSpansWithDeadline` 的失败路径；hrTime 差值不越界 | 79 |
| `apps/zcode-cli/packages/i18n/src/types.ts` | CLI 侧 i18n 类型契约 | INV-01~19；ZCodeCopy 与 CliCopy 的领域边界；TuiCopy 各分区（copy/effort/input/loginSetup/model/sidebar/status/run/sections/transcript/selection/fileMention/slash）键集合必须与字典完全一致；缺键时的回退策略；插值参数类型安全；Record 状态穷尽 | 93 |

合计 **969**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 设备 id 不能手拼

`ProjectCreation.tsx` 的新建与登记必须共用 `buildServerRemoteWorkspaceIdentity` 的反算结果。
手拼字符串会让新建与登记落到不同 host id，项目写进去但在列表里永远看不到。

### 2. 未读清理是 compare-and-clear

`useWorkspaceTaskNavigation.ts` 以行快照或 query cache 的 `unreadAt` 作为 `expectedUnreadAt`。
无条件清零会把并发到达的新未读一起抹掉，用户漏看消息却没有任何可见提示。

### 3. 摘要不能读环境

`workspace-hook-digest.ts` 的摘要链路禁止读环境变量、时钟、文件系统与模块级缓存。
一旦引入，同输入在另一进程算出不同值，快照无法跨设备对账，用户会收到全量「配置已变更」。

### 4. 额度代数只增不减

`usageEntitlementRefreshPolicy.ts` 的 generation 只在显式 invalidate 时推进。
未标记 invalidate 的只读请求也推进代数，会让同一 freshnessKey 的并发请求互相判过期，后台刷新被自己打断。

### 5. 积分页注入必须按 epoch 作废旧回包

`RewardsWebview.tsx` 每次注入前递增 generation 并记住 epoch，凭据异步返回后 epoch 不匹配即丢弃。
漏掉这一步，切账号后旧账号 token 会被写进新页面，积分页显示上一个用户的余额。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 设备 id 手拼字符串 | 新建项目不在列表出现 |
| workspaceKey 不去空白 identity | 草稿归属串台，选中项目跳错 |
| await 后不复检 active | 取消创建后留下孤儿 Host 条目 |
| 概览弹层关闭不清 query | 重开后页签被静默过滤成「少了」 |
| 未读无条件清零 | 新消息到达不显示蓝点 |
| 摘要读时钟/环境 | 跨设备对账全量报变更，钩子配置反复失效 |
| 额度代数在只读请求上推进 | 额度长期停在加载态 |
| 退避下标不夹取 | 冷却截止变 NaN，刷新判断永久失真 |
| 积分页不比对 epoch | 切账号后显示上一用户余额 |
| 注入前不校验受信 URL | 第三方页面拿到 token |
| trace 队列多消费者 | span 顺序错乱、批量导出重复 |
| i18n 键集合与字典不一致 | 缺键处显示原始 key |

## 顺延

B53 复算清单共 20 个候选，本批按同类同目录取 12 个，其余顺延到 B54，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.25%~31.44%。
