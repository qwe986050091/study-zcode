# ZC-DEEP-autoUpdater（一档 A 组 · 凭据/令牌之后的 IPC 入口文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3 取小者、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/desktop/src/main/autoUpdater.ts`（落盘后 3,693 行，1,168 个可注单元）。
> 判据：「改错或删掉会不会被发现」，不是「这条是不是声明」——声明区不自动豁免。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\_au-uncovered.txt`（`deep-quality --uncovered` 生成，非人工挑选） |
| 起始状态 | units 1,168 / covered 478 / **40.9%** / `R = 690` |
| 阈值判定 | `R = 690 > 120` → 按 §5.3.1 第 2 条先抽 60 条 |
| 实际路径 | 逐批回落；`R` 降到 116 以下后按 §5.3.1 第 1 条**手动升级为全读**，末段不再抽样 |
| 停止规则 | 补掉每个真缺口后重新取当轮 `R`；转全读后以 `units=0` 为停止条件 |
| R 取值时点 | 每批插入并重测后取当轮值；不沿用上一轮 |
| 判定标准 | 每条问「写错/删掉是否会被发现」；携带契约的参数行、字段行照写，不因「是声明」跳过 |
| 归属判据 | 改写/删除任何一行前先查基线快照 `AU-deep-b01/orig/`（= `git show HEAD:`）；快照里存在即上游，只许新增，不许删改（§2.6） |

## 2. 实际执行（按函数边界分批，区域口径）

每批只覆盖一个函数或一个块，写完立即落盘、重跑 `deep-quality` 重生成 uncovered（行号每批都会漂移，不复用旧行号）。下表按**插入后行号**汇总，行数取自 `git diff -U0` 的 added 行按区域求和；逐批覆盖率/R 快照未逐批留存，这是记录缺口，**不用估算填补**。

| 区域（行号） | 代表函数 | 新增整行 `//` |
| --- | --- | ---: |
| 1–602 | 文件头 INV-1…INV-20、常量、状态变量、类型声明、锁与恢复、开关/版本比较/轮询间隔/渠道推断 | 158 |
| 603–734 | `beginAutoUpdateCheck` / `completeAutoUpdateCheck` / `finishAutoUpdateCheck` / `settleAutoUpdateCheckResult` / stale 判定 / 两个状态构造器 | 28 |
| 735–870 | 强更无更新文案、`normalizeProgressPercent`、进度日志与分桶、进度态构造 | 37 |
| 871–1015 | `quitAndInstallUpdate` 余下、菜单 label/enabled 推导 | 34 |
| 1016–1201 | 菜单同步、状态去重、广播、监听器、窗口查找、标题推导、说明归一 | 46 |
| 1202–1398 | `normalizeLocalizedReleaseNotes`、`isRecord`、URL 脱敏、开关解析、feed 来源、渠道解析与同步 | 70 |
| 1399–1590 | provider 注册、说明兜底/日期/载荷、持久化、stale 判定 | 60 |
| 1591–1746 | 未来版本判定、`isDevSquirrelReadyError`、清理 pending、手动检查投递、四个 `clear*` | 49 |
| 1747–1904 | 持久化清理、取消识别与标记、`handleAutoUpdateFailure` 前段 | 42 |
| 1905–2114 | `handleAutoUpdateFailure` 后段、`isSkippedUpdateVersion`、自动下载判据、`skipAvailableUpdateVersion` | 70 |
| 2115–2213 | `clearSkippedUpdateVersionForManualCheck`、`publishDownloadedUpdate` | 30 |
| 2214–2740 | `downloadAvailableUpdate`、`cancelDownloadingUpdate`、locale、hydrate、ready 同步、状态读取、渠道刷新、说明 ack | 191 |
| 2741–3693 | `initAutoUpdater`、轮询、强更请求、无窗口检查、菜单点击 | 263 |
| **合计** | — | **1,078** |

起点 40.9% → 终点 **100.0%**；`git diff --numstat` = **+1,078 / −0**。

## 3. 定格表述

**`R = 0`（1,168/1,168 全读收口）**，形式记为 `read-all（手动升级）`。

- 前段确实按 60 条抽样推进，但抽样从未成为最终结论：`R` 在末段降到 120 以下后转为全读，因此**不报 4.88% 上界**（没有抽样，就没有抽样误差可报），也不存在「连续 60 条无缺口」的定格。
- 全读的判定物是 `uncovered` 文件本身：末轮 `UNCOVERED units=0`。

## 4. 数量对账（三个总数必须自洽）

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 1,168 | `deep-quality --metric-version v3` |
| 文件内注释行（当前） | 1,659 | 同上 `comments`；与逐行统计 `//` 1,652 + 块注释 7 一致 |
| 本次新增注释行 | 1,078 | `git diff --numstat` = `zc-verify added` = `zc-gate addedCommentLines` |
| 上游原有注释行 | 581 | 1,659 − 1,078；与 `git show HEAD:` 直接统计的 574 + 7 一致 |

三者闭合：**1,078（新增） + 581（上游） = 1,659（现状）**。§2.6 的归属判据因此可被数字复核，而不是靠语感。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 1,168 / coverage **100.0%** / branch 100% / field 100% / substance 95.7% / explain 99.9% / filler 0.0% / weak 0.1% |
| 映射 | 同上 `MAP` | mappedStrict 1,168 / mappedBlock 1,597 / unmapped 62（import 49、continuation 9、structural 4） |
| 代码与上游 | `zc-verify.mjs AU-deep-b01` | deletedNonZero **0** / nonCommentAdded **0** / starSlash **0** / syntaxErrorFiles **0** / added 1,078 |
| 注水 | `zc-gate.mjs --file packages/desktop/src/main/autoUpdater.ts` | badFiles **0** / waterLines **0**（addedCommentLines 1,078） |
| 近重复 | `deep-boilerplate.mjs --diff --baseline AU-deep-b01\orig` | groups 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0**（`upstreamComments` 报 1,619，该计数含误计，见 §6.3） |

基线取 `git show HEAD:` 写入 `AU-deep-b01/orig/`，只能支撑「相对 HEAD 的纯新增」：本批无任何代码行变更（`−0`）。

## 6. 清理与记账

1. **注水清零（本轮主要工作量）**：`zc-gate` 首轮报 116 行 `W 单行无信息` / `L 无信息列举`，第二轮仍余 103 行。全部**原位置改写**：补真实标识符（函数名/字段名/事件名）或补前置条件与失败后果，**不新增行、不删除行**；末轮 `waterLines=0`。
2. **双写清理 9 处**：`zc-gate` 改写过程中有 9 处新行与紧邻的上一条注释复述同一事实（如 `already ready / in progress` 的后续动作、`download-progress` 占位、取消原因二分、渠道一致性、`menuState` 空值回落等）。处置方式是**在原行内换成补充事实**（顺序、契约、INV 引用），没有整段替换任何注释块（§2.5）。行号：1975、2271、2318、2403、2426、2450、2610、2640、3505。
3. **`check-upstream-comments` 计数缺陷（工具侧，未改脚本）**：该脚本的 `inBlock` 分支先把行首 `*` 剥掉再判断是否含 `*/`，导致单独的 `*/` 行无法闭合块注释。从文件第一个 JSDoc（第 1,570 行）起，后续 **1,038 行代码**被当作「注释」计入 multiset。
   - 两侧同样受影响，且这 1,038 行代码在本批完全未变，因此 `missing=0` 的结论仍然成立；
   - 但 `upstreamComments=1,619` **不能当「上游注释条数」读**，真实值是 581（§4）。历史上所有带同样结构的文件，其 `ZC-DEEP-*` 文档里的这个数字都带同一个偏移，需要重扫时一并修。
4. **归属判据（§2.6）的实证**：本轮 103 行改写全部落在新增行上。证据是两把尺子同时为 0——`zc-verify` 的 `deletedNonZero=0` 与 `check-upstream-comments` 的 `missing=0`。只要改到一行上游注释，后者的 multiset 立刻报 `missing≥1`；只跑前者会漏。
5. **行号漂移**：每批插入后立即重生成 uncovered；本批多次出现同一函数在相邻两轮行号相差数十行的情况，从未复用旧行号写入。

## 7. 遗留

- 只做了 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试，不得据此宣称「构建通过」（DEEP-SPEC v2.1 (d)）。
- `weak=0.1%`（约 2 行）不是失败项，`zc-gate` 也未命中；保留原样，避免为凑指标改写已准确的句子。
- `mappedBlock` 1,597 高于 `mappedStrict` 1,168 属正常（块注释覆盖多行）；unmapped 62 全部落在 import/续行/结构行。
- `check-upstream-comments` 的 `inBlock` 闭合缺陷见 §6.3，修脚本会导致所有历史 `upstreamComments` 数字变化，需单独一批统一重扫，不在本文件范围内。
