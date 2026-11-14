# ZC-DEEP：packages/desktop/src/main/desktopHostProcess.ts

> 状态：**已完成**（b1–b9，440 单元全覆盖，五道门禁全零）
> 文件规模：原始 950 行 + 已插入 381 行 = 当前 1,331 行 / **440 可注单元** / 起始 59 covered（13.4%）/ 收口 100.0%
> 风险档：A（不可逆证据：进程启动 `fork`、鉴权 `isPathInside` 系授权回调）
> 口径：`deep-quality.mjs --metric-version v3`；批次目录 `_annot_baseline/DHP-deep-b01/`

## 1. 批次清单

§2.7 作为不变量（`_ssh-insert.mjs` 单锚点单行 + `commentAbove` 一条注释计一个单元）成立后，`Δuncovered = −插入行数` 是构造保证，不是测量；不设 Δ 列。

**b1–b9 期间 §2.7 不变量未被破坏，无一批回滚。** 任何一批出现不等，该批作废、查锚点、不得提交。

| 批次 | 区域（原行号） | 插入行数 | 落盘后 UNCOVERED | 提交 |
| --- | --- | ---: | ---: | --- |
| b1 | 884–950 `disposeHostProcessAndWait` 等待与超时 | 30 | 351 | `ad14e680` |
| b2 | 827–883 `disposeHostProcess` 优雅退出与 3.5s 强杀 | 20 | 331 | `63e7cc93` |
| b3 | 738–826 InitLocal 投递、ServicePort 与 exit 清理 | 33 | 298 | `b9906070` |
| b4 | 660–737 cron/off-peak 结算转发、运行计数 | 31 | 267 | `e3d96774` |
| b5 | 530–659 CUA 投影、日志归档、browser 执行、agent 进程事件 | 64 | 203 | `a672893b` |
| b6 | 400–529 资源采样、遥测转发、媒体授权、插件沙箱 | 56 | 147 | `e6654edf` |
| b7 | 296–399 spawn 参数、fork env、消息监听首段 | 25 | 122 | `10016860` |
| b8 | 213–295 spawn 签名与依赖契约 | 58 | 64 | `d67d3d66` |
| b9 | 98–212 类型契约与 `loadWindow`，并入 10 处区间漏锚（§2.9 逐条模式） | 64 | 0 | `cea5a675` |

**合计插入 381 行**（= 新增覆盖单元 381 个，见 §2）。

**区间漏锚记录（b9 由来）**：b4/b5/b6 三个区间各漏了若干 `if (result.data.type === ...)` 条件行——b4 1 处、b5 3 处、b6 6 处，共 10 处。原因是建批时按「有意义的语句」挑锚点，把条件行当成已有注释的下挂行；但工具把 `if` 行本身计为单元，其上方注释落在 `if` 上才算覆盖。**结论已升为 DEEP-SPEC §2.9.1：覆盖集合只能由工具输出决定，锚点必须从当批 `_uncovered.txt` 逐行取，不能按语句类型筛。** 这 10 处在剩余 64 单元时按 §2.9 转逐条模式，一次列全、一次落盘补齐。

## 2. 单元最终归属分布

| 归属 | 数量 | 占比 | 说明 |
| --- | ---: | ---: | --- |
| 已写注释（新增） | 381 | 86.6% | b1–b9 共插入 381 行，与新增覆盖单元数相等 |
| 起始已是上游注释 | 59 | 13.4% | orig 快照内已有，按 §2.6 只新增不改写 |
| 豁免 | 0 | 0% | 结构性不可注的 42 条属「非单元行」（import 33 / continuation 9），不计入单元分母 |
| 未覆盖 | 0 | 0% | `UNCOVERED units=0` |
| **合计** | 440 | 100% | `covered=440`，覆盖率 100.0% |

`commentMap.strict=439` 比 `units=440` 少 1：第 188 行 `loadUrl: Date.now(), // T3` 是**行尾注释**，覆盖了单元但不计入 `mappedStrict`。**这是工具口径，不是漏注（DEEP-SPEC §2.13a）**——行尾注释只统计在覆盖率里，不统计在整行锚定注释里。遇到 `mappedStrict < units` 先数行尾注释，不要去补注；补出来就是重复注释。本文件仅此一处。

## 3. 文件分段表

后来的人查「Main 怎么 fork Host、某条 Host 消息在哪收口」从这里进。行号为插入完成后的当前值（950 + 381 = 1,331 行）。

| 行号（当前） | 段 | 内容 |
| --- | --- | --- |
| 1–98 | 模块头 | 职责边界、**INV-01…INV-19 不变量表**、两条维护约定 |
| 99–116 | 类型 | `WindowBootstrapOptions`：renderer 启动 query 契约 |
| 117–151 | 类型 | `HostInitMessage`：InitLocal 字段契约 |
| 152–176 | 类型 | `SpawnHostProcessOptions`：端口/广播/实时路由开关 |
| 177–190 | 模块状态 | `exitedHostProcesses`（WeakSet）、`disposingHostProcesses`（Set）、`listDisposingHostProcesses` |
| 191–267 | 装载 | `loadWindow`：query 序列化、T3 launch mark、dev `loadURL` 与打包 `loadFile` |
| 268–509 | spawn 签名 | `spawnHostProcess` 的全部依赖注入契约（含 cron/off-peak 结果与 browser handler） |
| 510–1123 | **消息收口** | `child.on("message")`：schema 校验 + 15 类 `HostResponseTypes` 分支，逐分支 `return` |
| 1124–1160 | 退出清理 | `child.on("exit")`：标记 exited → 通知 CUA → flush 日志 → 注销资源表与广播 |
| 1161–1237 | 优雅退出 | `disposeHostProcess`：幂等判定、Dispose 消息、3.5s 强杀下限 |
| 1238–1331 | 等待退出 | `disposeHostProcessAndWait`：`settled` 门闩、可选等待超时、复用 dispose |

**消息分支索引**（当前行号 → 类型 → 去向）：

| 行号 | `HostResponseTypes` | 去向 |
| --- | --- | --- |
| 522 | `DatabaseStartupState` | `databaseStartupRelay.receive` |
| 530 | `Log` | `hostLogRelay.onStructuredLog` |
| 540 | `NetworkTelemetryBatch` | `ingestHostNetworkObservations` |
| 547 | `NetworkCaptureBatch` | `ingestHostNetworkCapture` |
| 556 | `AgentResourceSample` | `ingestCliResourceSample` |
| 568 | `HostResourceSample` | `ingestHostSelfResourceSample` |
| 576 | `ResourceUsageSnapshotResult` | `resolveHostResourceUsageResult` |
| 584 | `ToolExecResource` | `ingestToolExecResource` |
| 592 | `McpResourceSamples` | `ingestMcpResourceSamples` |
| 606 / 614 / 622 | `McpTelemetry` / `PluginTelemetry` / `SessionCreateTelemetry` | 三个注入回调 |
| 633 | `LocalMediaPreviewPathAuthorizeRequest` | 授权后回 `LocalMediaPreviewPathAuthorizeResult` |
| 686 | `PluginSandboxRegisterRequest` | 校验 owner 后回 `PluginSandboxRegisterResult` |
| 734 | `CuaOperationState` | `onCuaOperationStateChanged` |
| 744 | `FeedbackLogArchiveRequest` | 归档后回 `FeedbackLogArchiveResult` |
| 785 | `BrowserExecuteRequest` | `handleBrowserExecuteRequest`，回 `BrowserExecuteResult` |
| 868 | `AgentProcessSpawned` | `registerHostAgentProcess` + 回调 |
| 891 | `AgentProcessReady` | `onAgentProcessReady` |
| 901 | `AgentProcessExited` | `unregisterHostAgentProcess` + 回调 |
| 911 / 919 | `AgentProcessError` / `AgentProcessException` | 对应回调 |
| 930 / 953 | `CronRunResult` / `OffPeakRunResult` | scheduler 结算（只搬字段） |
| 977 / 985 | `CronSchedulerWakeRequest` / `OffPeakSchedulerWakeRequest` | 唤醒回调 |
| 996 | `AgentRunningTaskCountChanged` | `hostRunningTaskCountMap` 的 set/delete |
| 1017 | `WorkspaceRunningTaskCountChanged` | `onWorkspaceRunningTaskCountChanged` |

> 行号会随插入漂移；查分支以类型名为准，行号只作入口。

## 4. 门禁记录（每批跑，全零才提交）

`zc-gate`（W/L/B/POEM）、`zc-verify`（deletedNonZero / nonCommentAdded / starSlash / syntaxErrorFiles）、`deep-boilerplate --diff`、`check-upstream-comments`（missing 必须为 0）。

- b1–b9 每批：`waterLines 0`、`deletedNonZero 0`、`nonCommentAdded 0`、`starSlash 0`、`syntaxErrorFiles 0`、`dups 0 / dupLines 0`、`upstream missing 0`。
- **W 前置门禁（`_ssh-insert.mjs`）拦下 1 行**：b3 的 anchor 811「计数表删除：0 与不存在语义不同…」缺 ASCII 标识符，`exit 1`、文件零落盘；改为 `hostRunningTaskCountMap 删除…` 后一次通过。累计拦截 1 行、返工 0 行。
- **b1 首次 `zc-verify` 报 `deletedNonZero=1`**：不是代码删行，而是 `orig` 快照用 PowerShell `Out-File -Encoding utf8` 写入时带了 BOM。改用 `git show` 原始字节重写快照后为 0。**规则：orig 快照必须字节级复制，不能用带编码转换的文本写入。**

**收口终态（b9 后）**：`UNCOVERED units=0`、`coverage 100.0%`、`branch 100.0%`、`field 100.0%`、`substance 99.7%`、`explain 100.0%`、`filler 0.0%`、`weak 0.0%`；`MAP mappedStrict=439 / mappedBlock=552 / unmapped=42`（import 33、continuation 9）；`zc-gate waterLines 0`、`zc-verify deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0`、`deep-boilerplate dups 0 / dupLines 0`、`check-upstream-comments missing 0`。

**收口原始输出（DEEP-SPEC §2.10，直接粘贴，不转述）**

```text
$ node _annot_baseline/deep-quality.mjs d:\code\ZCode --files packages/desktop/src/main/desktopHostProcess.ts --metric-version v3 --field-mode ast --quiet --json ... --uncovered ...
UNCOVERED units=0 out=d:\code\_annot_baseline\DHP-deep-b01\_uncovered.txt
SUMMARY metric=v3 files=1 units=440 coverage=100.0% branch=100.0% field=100.0% comments=594 substance=99.7% explain=100.0% filler=0.0% weak=0.0%
MAP comments=594 mappedStrict=439 mappedBlock=552 unmapped=42 reasons=import:33,structural:0,continuation:9,gap:0,eof:0,other:0
```

```text
$ git log --oneline -1 cea5a675
cea5a675 注释(desktop): desktopHostProcess.ts b9 — 类型契约、loadWindow 与剩余分支逐条补完（+64 行）
$ git cat-file -t cea5a675
commit
```

```text
$ node _annot_baseline/zc-gate.mjs --scan ...\_files.txt
SUMMARY files=1 badFiles=0 addedCommentLines=0 waterLines=0 waterRate=0.00%
$ node _annot_baseline/zc-verify.mjs DHP-deep-b01
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=381
$ node _annot_baseline/deep-boilerplate.mjs d:\code\ZCode --diff --files packages/desktop/src/main/desktopHostProcess.ts
SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
$ node _annot_baseline/check-upstream-comments.mjs d:\code\ZCode ...\_files.txt HEAD
SUMMARY files=1 checked=1 upstreamComments=592 missing=0
```

> 上列是**提交后复跑**的原文，所以 `zc-gate` 的 `addedCommentLines=0`（工作区已无新增行）；b9 落盘当时该值为 `64`。

**遗留项**：只做语法 fail-closed 校验（TS 解析诊断 `syntaxErrorFiles=0`），未执行 `tsc --noEmit` 与单元测试；不得据此宣称「构建通过」。
