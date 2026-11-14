# ZC-DEEP-b79

> 批次：B79（6 文件，按 31.4% 口径计算目标 349 行，实际 +349，无补插）。
> 6 个 spec 并行编写（并发上限 5，最后一文串行补齐），逐文件自检后一次插入。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b79\orig`；开工前 6 文件均为 `newComments=0`（30% 口径 needLines=332）。

## 校验

```
node zc-verify.mjs ZC-deep-b79
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=349

node check-batch.mjs ZC-deep-b79 ZC-deep-b79-files.txt
TOTAL added=349 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   291   205    64   58  packages/ui/src/ToolCallBlocks/renderers/cron-create.tsx
31.35   265   185    58   58  packages/ui/src/ToolCallBlocks/renderers/goal.tsx
31.39   309   223    70   58  packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.tsx
31.44   591   423   133   61  packages/shared/src/zcode-protocol-v4/snapshot.ts
31.47   261   197    62   57  packages/desktop/src/renderer/src/desktopPlatform.ts
31.52   270   184    58   57  packages/ui/src/components/ai-elements/model-selector.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.22 median=31.42 newComments=349
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/ToolCallBlocks/renderers/cron-create.tsx` | 定时任务工具块 | INV-01~18；字段白名单与类型守卫；候选来源合并；表达式缺省；能力门控禁用；失败/空数据兜底分支 | 58 |
| `ui/src/ToolCallBlocks/renderers/goal.tsx` | 目标工具块 | INV-01~18；取值的嵌套路径读取；结果值归一化；主结果优先级；载荷构造；渲染回调身份稳定 | 58 |
| `desktop/src/renderer/src/desktopPlatform.ts` | 桌面平台能力工厂 | INV-01~18；能力清单只增不减；插件沙箱所有权；订阅 disposer 成对；日志桥接；浏览器桥展开顺序 | 57 |
| `shared/src/zcode-protocol-v4/snapshot.ts` | 协议快照 schema | INV-01~18；字段可选性与默认值；判别联合收敛；错误归因形状；交互挂起态；向后兼容边界 | 61 |
| `ui/src/components/ai-elements/model-selector.tsx` | 模型选择弹层 | INV-01~18；受控/非受控状态归属；键盘导航与焦点；弹层挂载生命周期；空态渲染；无障碍标题 | 57 |
| `ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.tsx` | 配额重置动作 | INV-01~18；成功提示最短展示窗；本地 processing 合成；完成时间对比回写；重复点击防护；卸载后回写抑制 | 58 |

合计 **349**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 平台能力对象只增不减

`desktopPlatform.ts` 的能力清单是渲染进程与主进程之间的契约面，新增字段要同步在类型与实现两侧补齐。
单边新增会让调用方拿到 undefined，在运行时才炸，且错误位置与真实原因相隔很远。

### 2. 订阅必须返回成对的 disposer

`onRemoteConnectionLog` 一类桥接把主进程事件转发给渲染进程，注册与注销必须成对。
只注册不返回释放句柄，会在热重载后累积监听器，日志被重复消费并拖慢通信。

### 3. 协议快照的判别联合必须收敛

`snapshot.ts` 用 status 判别多个运行态，任一分支新增字段都要落在对应分支内。
字段放错分支不会报类型错，只会让消费端在某个状态下永远读不到该字段。

### 4. 弹层的焦点所有权归弹层

`model-selector.tsx` 打开后焦点进入搜索框，关闭后归还触发元素。
把焦点放在调用方维护，会在快速连开连关时把焦点丢到 body，键盘用户直接失去位置。

### 5. 成功提示需要有最短展示窗

`CodingPlanQuotaResetAction.tsx` 的成功态至少展示数百毫秒，避免请求过快时提示一帧闪过。
去掉这个下限，用户会认为点击没有生效并重复提交。

### 6. 纯读取函数不得缓存跨调用状态

`goal.tsx` 的路径读取与归一化只依赖入参，不借用模块级可变容器。
一旦引入缓存，同一份结果在不同渲染周期可能给出不同值，排查成本极高。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 平台能力只在一侧新增 | 调用方拿到 undefined，运行时才报错 |
| 桥接未返回 disposer | 热重载后监听器累积，日志重复、性能下降 |
| 快照字段放错判别分支 | 某运行态下字段恒为默认值 |
| 弹层焦点未归还 | 关闭后焦点落到 body，键盘操作中断 |
| 成功提示无最短展示窗 | 提示一闪而过，用户重复点击 |
| 候选来源未去重 | 同一任务在列表中出现两次 |
| 类型守卫放宽到任意对象 | 非法表达式进入渲染路径，抛错打断整块 |
| 结果值未归一化 | 目标块展示嵌套对象字面量 |
| 重置成功后未比对完成时间 | 已刷新仍显示旧配额 |
| 卸载后仍回写状态 | 控制台出现卸载组件更新警告 |

## 断点报告（续跑基线）

- 最后完成批次：**B79**（6 文件 / +349 行 / 全绿）；`added=349`、硬校验全 0。
- 累计（core+apps）：**746 文件 / 100,453 行**。
- 半插入残留：无（B79 六份 spec 与插入结果逐文件行数吻合，无多余临时文件）。
- 剩余缺口：按基线推导 **2,478 个 coreBelow30 / 41,137 行**，完成度 **70.9%**；
  全仓实测 `files=5032 coreBelow30=2489 needLines=51371 median=30.13`（services 已收口）。

> 说明：每文件独立 spec，逐文件自检 `OK blocks / lines` 后统一插入。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.22%~31.52%，`suspicious=0`。
