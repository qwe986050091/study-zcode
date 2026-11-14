# ZC-DEEP-oauthService（一档 A 组 · 校准批 2）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§5.3 取小者、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/services/src/oauth/oauthService.ts`（落盘后 2,107 行，659 个可注单元）。
> 判据：「改错或删掉会不会被发现」，不是「这条是不是声明」——声明区不自动豁免。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\_oauth-uncovered.txt`（`deep-quality --uncovered` 生成，非人工挑选） |
| 起始状态 | units 659 / covered 137 / **20.8%** / `R = 522` |
| 阈值判定 | `R = 522 > 120` → 按 §5.3.1 第 2 条应抽 60 条 |
| 分层 | 16 个函数/块按未覆盖数配比（最大余数法），块内等距取点 |
| 停止规则 | 补掉每个真缺口后重抽 60 条，直到连续 60 条无缺口；上界只对最后一轮 0/60 计（4.88%） |
| R 取值时点 | 每批插入并重测后取当轮值；不沿用上一轮 |
| 判定标准 | 每条问「写错/删掉是否会被发现」；携带契约的参数行、字段行照写，不因「是声明」跳过 |

## 2. 实际执行（按函数边界分批）

按 §5.3.1 第 6 条，每批只覆盖一个函数或一个块，写完立即落盘并重测，中断点不落在函数体中间：

| 批 | 范围 | 插入行 | 覆盖率 | R |
| --- | --- | ---: | ---: | ---: |
| 起点 | — | — | 20.8% | 522 |
| A | 文件头不变量 + 常量 + 顶层纯函数 | 70 | 31.4% | — |
| B | `restoreCachedSessionState` 前段 | 118 | 55.7% | — |
| C | `restoreCachedSessionState` 后段 | 33 | 60.8% | — |
| D | `restoreSession` + `startOAuth` | 45 | 67.7% | — |
| E | `startOAuthWithPolling` | 59 | 75.6% | — |
| F | `pollPendingOAuth` + `handleCallback` 前段 | 45 | 82.4% | 116 |
| G | `handleCallback` 尾部 | 17 | 85.0% | 99 |
| H | `refreshToken` | 21 | 88.2% | 78 |
| I | `logoutIfCurrentCredentialRequest` | 17 | — | — |
| J | `logout` / `logoutAll` | 23 | — | — |
| K | `cancelPending` / `clearPendingState` / `notify*` | 19 | — | — |
| L | 适配器查询 / 错误归一 / 工厂 | 20 | **100.0%** | **0** |

A–E 批与 I–K 批未逐批留存覆盖率/R 快照，只记观测到的检查点；这是记录缺口，不用估算填补。行数为本批实际插入的整行 `//` 数，末值以 `git diff --numstat` 的 875 为准（含收口期补写的 1 行）。

## 3. 定格表述

**`R = 0`（659/659 全读收口）**，形式记为 `read-all（手动升级）`。

按 §5.3.1 第 1 条，`R ≤ 120` 走全读；本文件在 F 批之后 R 已降到 116，此后一律按全读推进，未启用 60 条抽样上界，因此不存在「连续 60 条无缺口」的定格结论，也不报 4.88% 上界（没有抽样，就没有抽样误差可报）。

## 4. 分母口径修正

units 由 662 降为 **659**：`import {` 的续行（3 处）不再计单元，脚本已对齐 §4.1。本文件的实际结论是「**659 个可注单元全部有解释**」——尺子改不改都是这个结论，不得把覆盖率变化归因于本次修尺。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 659 / coverage **100.0%** / branch 100% / field 100% / substance 96.6% / explain 100.0% / filler 0.0% / weak 0.0% |
| 映射 | 同上 `MAP` | mappedStrict 659 / mappedBlock 913 / unmapped 31（import 21、continuation 9、structural 1） |
| 代码与上游 | `zc-verify.mjs --rewrite _cad-oauth` | deletedOwnCommentLines 0 / upstreamCommentDeleted **0** / codeTokenDiff **0** / codeDeletion 0 / nonCommentAdded 0 / syntaxErrorFiles 0 |
| 注水 | `zc-gate.mjs --file …` | badFiles **0** / waterLines **0**（addedCommentLines 875） |
| 近重复 | `deep-boilerplate.mjs` | groups 0 / dups 0 / dupLines 0 |
| 上游反向 | `check-upstream-comments.mjs … HEAD` | upstreamComments 887 / missing **0** |

基线取 `git show HEAD:` 写入 `_cad-oauth/orig/`，未经权威校验，只能支撑「相对 HEAD 的纯新增」：本批 `git diff --numstat` = **+875 / -0**。

## 6. 清理与记账

1. **双写清理**：插入过程中有 12 处新行复述了紧邻块注释（同一事实写两遍，§2.4）。处置方式是**在原行内改写为补充事实**（顺序、后果、契约），删除重复行 8 行；没有整段替换任何注释块（§2.5）。
2. **误改上游注释 2 处**：`刷新写回若绕过会话队列…` 与 `合并边界：清理前保留原账号身份…` 两行在上游已存在，我一度按「自己新增的重复行」改写/删除。`zc-verify --rewrite` 报 `upstreamCommentDeleted=2`、`check-upstream-comments` 同时报 `missing=2`，两道门禁一起命中后逐字还原。**这是 §2.5「两个方向必须同时为 0」的实例**：只跑其中一道会漏。
3. **弱行清理**：`zc-gate` 首轮报 85 行 W/L（早期批次未过门禁）。逐行**原位置改写**，补标识符或补前置条件/后果，不新增行、不删行；末轮降至 0。
4. **重复条件行 1 处**：`this.oauthSessionGeneration !== generation ||` 在改写过程中出现两遍，`zc-verify` 的 `codeTokenDiff=1` 抓住（多一层括号节点），已删除。

## 7. 遗留

- 只做了 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试，不得据此宣称「构建通过」（DEEP-SPEC v2.1 (d)）。
- `mappedBlock`（913）明显高于 `mappedStrict`（659）之外的余量来自函数级块注释覆盖多行，属正常；unmapped 31 全部落在 import/续行/结构行，无需补注释。
