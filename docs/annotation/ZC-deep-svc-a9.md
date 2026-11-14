# ZC-deep-svc-a9（调度与单例生命周期）注释补深结果

## 结果表

| 文件 | 代码行 | 内文前→后 | 净增行 |
| --- | ---: | ---: | ---: |
| packages/services/src/highspeed/highspeedCardService.ts | 217 | 13.82% (30) → 31.80% (69) | +39 |
| packages/services/src/session/automationCron.ts | 226 | 8.41% (19) → 30.97% (70) | +51 |
| packages/services/src/project/autoArchiveScheduler.ts | 60 | 3.33% (2) → 40.00% (24) | +22 |
| packages/services/src/cua-permission-broker/cuaAgentAdmissionGate.ts | 66 | 0.00% (0) → 43.94% (29) | +29 |
| packages/services/src/cua-permission-broker/stableCuaTransport.ts | 31 | 0.00% (0) → 35.48% (11) | +11 |
| packages/services/src/model-provider/providerRuntime.ts | 138 | 8.70% (12) → 31.88% (44) | +32 |

函数级最低值 16.7%（applyDrawResponse，1/6），`below15=0`；文件级最低 30.97%（automationCron）。

## 补深方式

按「语句组 / 分支 / 字段」逐处插入整行中文注释，只解释不重复：

- highspeedCardService：缓存与过期的双判据（`<=` 同毫秒即过期）、in-flight draw 引用相等的清理、双 JWT 各自 trim 与 TEAM 组织/项目前置、401 之前「先模型目录再套餐」的判定顺序。
- automationCron：minute/hourly/daily/weekly/monthly/yearly 各自的正推起点与边界（36600、5220 周、400 年）、anchorWeek 的周一对齐、steps 的 `max(0,…)`、跨夏令时按毫秒推进的墙钟偏移。
- autoArchiveScheduler：首轮 `scanInBackground()` 先于 setInterval、runOnce 在 await 之后复查 `disposed`、dispose 只清定时器不等待进行中的扫描。
- cuaAgentAdmissionGate：recovery 期间 epoch 单调递增与迟到 commit/fail 的拒绝、waiter 先登记后挂 abort、逐条 reject 后再 clear。
- stableCuaTransport：管道名与配方的 `??=` 单例缓存、catch 返回 null 不重抛、三个模块级状态必须一起复位。
- providerRuntime：多实例共享 ConfigRuntime、Registry 的两个 Source 与合并顺序、`allSettled` 下账号失败延后到 refresh 之后抛出。

## 四条命令真实输出

```
node zc-verify.mjs --rewrite ZC-deep-svc-a9
SUMMARY files=6 rewrittenSegments=14 deletedOwnCommentLines=15 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node zc-gate.mjs --scan .../_files.txt
SUMMARY files=6 badFiles=0 addedCommentLines=315 waterLines=0 waterRate=0.00%

node zc-inner.mjs ... --threshold 15 --fns 30
SUMMARY files=6 innerCode=738 innerZh=247 below15=0 min=30.97 median=35.48

node deep-quality.mjs D:/code/ZCode --files ... --quiet --top 20
SUMMARY files=6 units=537 coverage=47.9% branch=56.9% field=18.2% comments=482 substance=82.8% explain=99.4% filler=0.0% weak=0.6%
```

gate 首轮曾报 15 条水行（W/L），逐条核对 `git show HEAD:<file>` 后确认它们**不在 HEAD**（是更早批次的注释），已在原文件中改写而非删除；改写后 waterLines=0，且 `upstreamCommentDeleted=0`。

## 锚定不变量

- anchor 取「整行 trim 后全文精确相等」，重复行用 `nth`（`expireCard(this.now())` nth1、`} catch {` nth1/2、`kind: "accelerated"` nth2、`return true;` nth1/2、`waiters.clear()` nth1/2 等）。
- 插入行整行 `//` 中文，文本不含 `*/`（首轮两条因 `` `*/N`` 被拒，已改写）。
- 不锚多行模板字符串内部；唯一涉及的 `cronExpr: \`${…} *\`,` 是单行模板。
- 不删任何代码行、不改 token：verify `codeTokenDiff=0 codeDeletion=0`。

## 看似该改其实不能改

- `upstreamCommentDeleted`：HEAD 中已有的注释不能删/不能改，否则 verify 直接失败；本轮 15 条改写全部落在「HEAD 之外的前批次新增」上。
- highspeed 的 `expiresAt <= now` 不能改成 `<`，否则边界同毫秒的卡会多放行一轮；`isModelCovered` 与 `isCodingPlanSupported` 的顺序也不能互换，否则先解析凭据会白白多打一次外部调用。
- automationCron 的 `anchorWeek.getDay() + 6) % 7` 不能简化为 `getDay() - 1`，周日（0）会落到上一周；hourly 的毫秒推进在夏令时会偏移一小时，但改成墙钟推进会让长周期跨月漂移。
- autoArchiveScheduler 的 `dispose` 不能等待进行中的扫描，`runOnce` 在 await 之后依赖 `disposed` 判活，强行 await 会拖住窗口销毁。
- cuaAgentAdmissionGate 的 `waiters.add` 不能挪到 `addEventListener` 之前，否则同步 abort 时删除落空造成泄漏；`releaseWaiters` 也不能在 for 循环里 clear。
- stableCuaTransport 的 catch 不能重抛，重抛会让所有并发等待者一起失败。
- providerRuntime 的 `allSettled` 不能换成 `all`，账号刷新失败必须延后到 `refresh` 之后再抛，避免本地快照与远端状态不一致。
