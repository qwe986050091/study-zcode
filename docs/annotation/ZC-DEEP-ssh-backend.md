# ZC-DEEP-ssh-backend（一档 A 组 · 远程控制与鉴权文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3.1 取小者与抽样规则、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/server/src/remote/ssh-backend.ts`（落盘后 1,051 行，351 个可注单元）。
> 判据：「改错或删掉会不会被发现」，不是「这条是不是声明」——构造器参数行、接口字段行照写。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\SSH-deep-b01\_uncovered.txt`（`deep-quality --uncovered` 生成，非人工挑选） |
| 起始状态 | units 351 / covered 46 / **13.1%** / `R = 305` |
| 阈值判定 | `R = 305 > 120` → 按 §5.3.1 第 2 条先抽 60 条 |
| 抽样结果 | 首轮 60 条**全部命中真缺口**（该文件的未覆盖单元是连续代码行，不存在「已覆盖却进箱」的浪费） |
| 升级依据 | 抽 60 条后剩余 `R = 238`，若继续抽样需 `≥ 4 × 60 = 240` 次确认才能给上界，成本已超过剩余全读 → 按 §5.3.1 转为 `read-all` |
| 停止规则 | 转全读后以末轮 `UNCOVERED units=0` 为停止条件，不再报抽样上界 |
| R 取值时点 | 每批插入并重测后取当轮值；不沿用上一轮 |
| 归属判据 | 改写/删除任何一行前先查基线快照 `SSH-deep-b01/orig/`（= `git show HEAD:`）；快照里存在即上游，只许新增，不许删改（§2.6） |

## 2. 实际执行（按函数边界分批）

每批写完立即落盘并重跑 `deep-quality` 重生成 uncovered（插入后行号必然漂移，第 3 批锚点全部按第 2 批落盘后的新行号重新取，未复用旧行号）。下表行数取自 `git diff -U0` 的 added 行按成员边界求和，合计 423。

| 区域（成员边界） | 代表成员 | 新增整行 `//` |
| --- | --- | ---: |
| 文件头 | 职责边界、INV-01…INV-20 不变量表 | 29 |
| `SSHBackendOptions` … `dispose` 前段（第 1 批，pre-compaction） | 接口字段、四个内部函数、类字段、构造函数、`onClientError/Close/End`、`ensureConnected`、`reportDisconnect`、`detect` 前段 | 155 |
| `exec` 后段 … `exists` 前段（第 2 批，78 锚点） | handleReady/handleConnectError、`detect` 后段、`upload` 全段、`exec`、`openDirectTcpChannel`、`exists` | 78 |
| `readFile` … `dispose`（第 3 批，160 锚点 / 161 行） | `readFile`、`execSimple`、`resolveHomeDir`、`shouldFallbackToExecUpload`、`describeUploadFailure`、`uploadViaSftp`、`uploadViaExec`、`resolveRemotePath`、`dispose` | 161 |
| **合计** | — | **423** |

分段明细（同一口径，便于核对区域与函数的对应）：

| 成员 | 新增行 | 成员 | 新增行 |
| --- | ---: | --- | ---: |
| 文件头 | 29 | `exec` | 23 |
| `SSHBackendOptions` | 14 | `openDirectTcpChannel` | 9 |
| `normalizeUnknownError` | 6 | `exists` | 6 |
| `markSSHUploadFailure` | 8 | `readFile` | 5 |
| `shouldLogSSHDebugMessage` | 2 | `execSimple` | 24 |
| `createUploadAbortError` | 4 | `resolveHomeDir` | 5 |
| `throwIfUploadAborted` | 4 | `shouldFallbackToExecUpload` | 3 |
| 类头与字段 | 24 | `describeUploadFailure` | 4 |
| 构造函数 | 23 | `uploadViaSftp` | 72 |
| `assertNotDisposed` | 6 | `uploadViaExec` | 59 |
| `ensureConnected` | 28 | `resolveRemotePath` | 5 |
| `reportDisconnect` | 10 | `dispose` | 8 |
| `detect` | 12 | | |
| `upload` | 30 | **合计** | **423** |

起点 13.1% → 终点 **100.0%**；`git diff --numstat` = **+423 / −0**。

## 3. 定格表述

**`R = 0`（351/351 全读收口）**，形式记为 `read-all（由抽样升级）`。

- 抽样只用于确认「未覆盖单元是否都是真缺口」，从未用于外推：首轮 60 条全命中后即升级为全读，因此**不报抽样误差上界**。
- 全读的判定物是 uncovered 文件本身：末轮 `UNCOVERED units=0`。

## 4. 数量对账（三个总数必须自洽）

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 351 | `deep-quality --metric-version v3` |
| 文件内注释行（当前） | 470 | 同上 `comments`；与逐行统计 `//` 468 + 块注释 2 一致 |
| 本次新增注释行 | 423 | `git diff --numstat` = `zc-verify added` = `zc-gate addedCommentLines` |
| 上游原有注释行 | 47 | 470 − 423；与 `git show HEAD:` 直接统计的 `//` 45 + 块注释 2 一致 |

闭合：**423（新增） + 47（上游） = 470（现状）**。`check-upstream-comments` 本文件报 `upstreamComments=47`、`missing=0`，与上式同源（该脚本的计数缺陷只在含 JSDoc 多行块的文件上放大，本文件只有两个单行块注释，未触发）。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 351 / coverage **100.0%** / branch 100% / field 100% / substance 99.6% / explain 100.0% / filler 0.0% / weak 0.0% |
| 映射 | 同上 `MAP` | mappedStrict 351 / mappedBlock 439 / unmapped 31（import 29、structural 2） |
| 代码与上游 | `zc-verify.mjs SSH-deep-b01` | deletedNonZero **0** / nonCommentAdded **0** / starSlash **0** / syntaxErrorFiles **0** / added 423 |
| 注水 | `zc-gate.mjs --file packages/server/src/remote/ssh-backend.ts` | badFiles **0** / waterLines **0**（addedCommentLines 423） |
| 近重复 | `deep-boilerplate.mjs --diff --baseline SSH-deep-b01\orig` | groups 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0**（upstreamComments 47，与 §4 一致） |

基线取 `git show HEAD:` 写入 `SSH-deep-b01/orig/`，只能支撑「相对 HEAD 的纯新增」：本批无任何代码行变更（`−0`），`codeTokenDiff=0`、`stringContentDrift=0`。

## 6. 清理与记账

1. **注水清零**：`zc-gate` 首轮报 14 行 `W 单行无信息` / `L 无信息列举`，分布为文件头与 INV 表 4 行、第 1 批遗留 6 行、本轮新增 4 行。全部**原位置改写**：补真实标识符（`resolveRemotePlatform`、`console.log`、`execUploadOnly`、`forwardOut`、`abortOnce`）或补谓词与失败后果（`会`、`必须`、`否则`），**不新增行、不删除行**；末轮 `waterLines=0`。
2. **基线换行符修正（工具侧，非源码改动）**：`orig/` 快照最初由 `git show HEAD:` 直接落盘，是 LF；工作区在 `core.autocrlf=true` 下是 CRLF。首次 `zc-verify` 因此把整文件 423 行报成 `NON-COMMENT ADDED`。把快照统一为 CRLF（内容逐字未变）后重跑，`added=423`、`deletedNonZero=0`。这是基线侧格式问题，不是代码被改写；后续一批应在取快照时就按工作区换行符落盘。
3. **归属判据（§2.6）的实证**：本轮第 3 批 161 行全部是新增行（快照中不存在）。两把尺子同时为 0——`zc-verify` 的 `deletedNonZero=0/nonCommentAdded=0` 与 `check-upstream-comments` 的 `missing=0`；只要碰一行上游注释，后者立即报 `missing≥1`。
4. **行号漂移**：三批之间行号相差最多 200 行以上（第 2 批锚点 300–511，落盘后第 3 批锚点 593–887），第 3 批文案先定、锚点后取，没有出现按旧行号写错位置的情况。
5. **未做**：`weak=0.0%` 无需处理；`mappedBlock` 高于 `mappedStrict` 属块注释跨行的正常现象。

## 7. 遗留

- 只做了 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试，不得据此宣称「构建通过」（DEEP-SPEC v2.1 (d)）。
- 本文件第 1 批在压缩前的上下文里完成，其逐批覆盖率快照未留存；表中只有「插入后行数」这一确定值，不用估算填补。
- `orig/` 快照的换行符问题见 §6.2，修复只作用于基线目录，未改任何源码或脚本。
