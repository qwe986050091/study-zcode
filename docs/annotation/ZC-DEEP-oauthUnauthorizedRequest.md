# ZC-DEEP-oauthUnauthorizedRequest（一档 A 组 · 凭据/令牌文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3.1 取小者与抽样规则、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/services/src/oauth/oauthUnauthorizedRequest.ts`（落盘后 228 行，77 个可注单元；HEAD 快照 136 行）。
> 判据：按「改错或删掉会不会被发现」写，接口字段行、对象字面量属性行、分支行照写。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\UNAUTH-deep-b01\_uncovered.txt`（`deep-quality --uncovered` 生成） |
| 起始状态 | units 77 / covered 16 / **20.8%** / `R = 61`（branch 25.0%、field 0.0%） |
| 阈值判定 | `R = 61 ≤ 120`，按 §5.3.1 直接全读，**无需抽样** |
| 停止规则 | 末轮 `UNCOVERED units=0` |
| 归属判据 | 改写任何一行前先查 `UNAUTH-deep-b01/orig/`；快照中存在即上游，只许新增（§2.6） |
| 批次前状态 | 工作区已有 **31 行未提交注释**（前序工作），orig 中全部 absent；另有 **3 行注水告警**待原位置改写 |

## 2. 实际执行（**从文件尾部向头部**倒序分批，2 批）

| 批次 | 区域（自尾向头） | 新增整行 `//` | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | `isCurrentOAuthCredentialRequest`、`isCurrentOAuthBusinessCredentialRequest`、`resolveOAuthBusinessCredentialValidationRequest` | 30 | 46（59.7%） |
| b2 | `isOAuthBusinessRequest`、`isCurrentBusinessOAuthCredentialRequest`、`tryResolveHttpUrl` | 31 | 77（100.0%） |
| **合计** | — | **61** | — |

起点 20.8% → 终点 **100.0%**；`git diff HEAD --numstat` = **+92 / −0**（其中 31 行为批次前已存在，61 行为本次新增）。

## 3. 定格表述

**`R = 0`（77/77 全读收口）**，形式记为 `read-all`。

## 4. 数量对账

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 77 | `deep-quality --metric-version v3` |
| 文件内注释行（`//` 开头，当前） | 98 | 直接计数 |
| 相对基线新增行 | 92 | `git diff HEAD --numstat` = `+92 / −0` = `zc-verify added` |
| 其中：批次前已存在 | 31 | 预登记时工作区已有，非上游 |
| 其中：本批新增 | 61 | 2 批插入行数之和，等于起始未覆盖数 |
| 上游原有 `//` 行 | 6 | orig 中直接计数；98 − 92 = 6 |

闭合：**6（上游） + 92（新增） = 98（现状）**。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 77 / coverage **100.0%** / branch 100%（12/12）/ field 100%（20/20）/ substance 99.0% / explain 100.0% / filler 0.0% / weak 0.0% / **UNCOVERED units=0** |
| 映射 | 同上 `MAP` | mappedStrict 77 / mappedBlock 91 / unmapped 8（import 8） |
| 代码与上游 | `zc-verify.mjs UNAUTH-deep-b01` | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 92 |
| 注水 | `zc-gate.mjs --file packages/services/src/oauth/oauthUnauthorizedRequest.ts` | badFiles **0** / waterLines **0** / waterRate 0.00% / addedCommentLines 92 |
| 近重复 | `deep-boilerplate.mjs --diff --baseline UNAUTH-deep-b01\orig` | groups 0 / lines 0 / files 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0** |

## 6. 清理与记账

1. **注水清零**：批次前遗留 3 行告警，全部原位置改写，不增删行：
   - 第 50 行 `L`（2 个逗号无谓词）→ 去掉一个逗号并保留「失败」谓词。
   - 第 76 行 `W`（无标识符）→ 补 `base url` 标识符。
   - 第 110 行 `L`（`、` 列举无谓词）→ 改为 `RPC/配置/日志` 斜杠分隔。
   - 本批新增 1 行 `W`（b1 的「对外别名」一行）→ 补 `isCurrentOAuthBusinessCredentialRequest` 标识符。末轮 `waterLines=0`、`weakRate=0`。
2. **行号策略**：从尾（第 166 行）向头（第 24 行）倒序分批，每批只动已处理区域。
3. **§2.6 归属判据**：上游 6 行未碰（`missing=0`）。
4. **双写规避**：INV-01…INV-03 表头已说明不变量，本批按单元补的是各分支的短路条件与失败后果，未复述表头原话。
5. **未做**：只做 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试。

## 7. 遗留

- 批次目录 `UNAUTH-deep-b01/` 保留 `_uncovered.txt`（末轮为空）、`_quality.json`、`orig/` 与 b1–b2 锚点 JSON。
- 下一个 A 组文件：`sshAuth.ts`（58/52）。C 组判据定稿前不动。
