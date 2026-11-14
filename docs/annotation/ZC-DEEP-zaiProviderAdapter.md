# ZC-DEEP-zaiProviderAdapter（一档 A 组 · 凭据/令牌文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3.1 取小者与抽样规则、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/services/src/oauth/providers/zaiProviderAdapter.ts`（落盘后 710 行，226 个可注单元；基线快照 437 行）。
> 判据：按「改错或删掉会不会被发现」写，接口字段行、对象字面量属性行、分支行照写。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\ZAI-deep-b01\_uncovered.txt`（`deep-quality --uncovered` 生成，非人工挑选） |
| 起始状态 | units 226 / covered 39 / **17.3%** / `R = 187` |
| 阈值判定 | `R = 187 > 120`，§5.3.1 要求先抽 60 条再决定 |
| 实际执行 | **未抽 60 条，直接全读**：文件仅 437 行代码，通读全文时把 187 个未覆盖单元逐条核对了一遍，全部为真缺口（无「已覆盖却进箱」）。这是对 §5.3.1 的一次流程偏离，记录在此，不包装成「抽样后升级」 |
| 停止规则 | 以末轮 `UNCOVERED units=0` 为停止条件 |
| R 取值时点 | 每批插入并重测后取当轮值；7 批锚点全部按上一批落盘后的新行号重新取，未复用旧行号 |
| 归属判据 | 改写任何一行前先查基线快照 `ZAI-deep-b01/orig/`（= `git show HEAD:` 转 CRLF）；快照中存在即上游，只许新增（§2.6） |
| 批次前状态 | 工作区已有 **86 行未提交注释**（本工程前序工作，含 INV-01…INV-04 表头），非上游，与本次新增分列 |

## 2. 实际执行（按函数边界分批，7 批）

每批写完立即落盘并重跑 `deep-quality` 重生成 uncovered；每批新增行数取自插入器输出，合计 187。

| 批次 | 区域（成员边界） | 新增整行 `//` | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | `ZaiBackendTokenPayload`、`ZaiBackendUserPayload`、`ZaiUserInfoPayload` 三个接口的字段，`ZAI_BUSINESS_TOKEN_TIMEOUT_MS`、`log` | 29 | 68（30.1%） |
| b2 | `normalizeExpiresIn`、`inferBase64ImageMimeType`、`toBase64ImageDataUrl` | 22 | 90（39.8%） |
| b3 | `normalizeBackendAvatarUrl`、`toBackendUserProfile`、`hasMeaningfulBackendUser` | 22 | 112（49.6%） |
| b4 | `maskOAuthCode`、`maskAccessToken`、`sanitizeTokenPayloadForLog`、`logTokenResponseError` | 29 | 141（62.4%） |
| b5 | 类字段、`constructor`、`parseCallbackParams`、`buildAuthorizeUrl` | 32 | 173（76.5%） |
| b6 | `normalizePolledTokenSet`、`exchangeToken` | 34 | 207（91.6%） |
| b7 | `fetchUserInfo`、`normalizeError` | 19 | 226（100.0%） |
| **合计** | — | **187** | — |

起点 17.3% → 终点 **100.0%**；`git diff HEAD --numstat` = **+273 / −0**（其中 86 行为批次前已存在，187 行为本次新增）。

## 3. 定格表述

**`R = 0`（226/226 全读收口）**，形式记为 `read-all`，不记抽样：187 个未覆盖单元全部写了注释，没有「采样后外推」的成分。

## 4. 数量对账（三个总数必须自洽）

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 226 | `deep-quality --metric-version v3` |
| 文件内注释行（当前） | 300 | 同上 `comments`；逐行统计 `//` 298 + 块注释 2，一致 |
| 相对 HEAD 新增行 | 273 | `git diff HEAD --numstat` = `+273 / −0` = `zc-verify added` = `zc-gate addedCommentLines` |
| 其中：批次前已存在 | 86 | 预登记时工作区已有，非上游 |
| 其中：本批新增 | 187 | 7 批插入行数之和，等于起始未覆盖数 |
| 上游原有注释行 | 27 | 300 − 273；与 `git show HEAD:` 统计的 `//` 25 + 块注释 2 一致 |

闭合：**27（上游） + 86（批次前） + 187（本批） = 300（现状）**。`check-upstream-comments` 本文件报 `upstreamComments=27`、`missing=0`，与上式同源。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 226 / coverage **100.0%** / branch 100% / field 100% / substance 98.0% / explain 100.0% / filler 0.0% / weak 0.0% |
| 映射 | 同上 `MAP` | mappedStrict 225 / mappedBlock 290 / unmapped 10（全部 import） |
| 代码与上游 | `zc-verify.mjs --rewrite ZAI-deep-b01` | rewrittenSegments 0 / deletedOwnCommentLines 0 / codeTokenDiff 0 / headTokenDrift 0 / stringContentDrift 0 / codeDeletion 0 / upstreamCommentDeleted 0 / literalCommentDeletion 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 |
| 注水 | `zc-gate.mjs --file packages/services/src/oauth/providers/zaiProviderAdapter.ts` | badFiles **0** / waterLines **0**（addedCommentLines 273） |
| 近重复 | `deep-boilerplate.mjs --diff --baseline ZAI-deep-b01\orig` | groups 0 / lines 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0**（upstreamComments 27，与 §4 一致） |

**为什么用 `--rewrite` 而不是普通批**：本批含 13 行「批次前已存在」的注释需要原位置改写（见 §6.1），对工作区而言是删行；普通模式只允许纯新增。改写批下 `codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`，证明改的只是我们自己写过的注释行，代码 token 流与 HEAD 逐 token 一致。

## 6. 清理与记账

1. **注水清零**：`zc-gate` 共报 25 行 `W 单行无信息` / `L 无信息列举`，分布为批次前遗留 13 行（文件头 INV-03、超时说明、`toBase64ImageDataUrl` 说明等）+ 本批新增 12 行。全部**原位置改写**：补真实标识符（`exchangeToken`、`Buffer`、`tokenLength`、`OAuthUserProfile`、`constructor`、`hasMeaningfulBackendUser`）或补谓词（`必须`、`不能`、`只能`、`否则`、`因为`、`因此`），**不新增行、不删除行**；末轮 `waterLines=0`。
2. **归属判据（§2.6）的落点**：13 行批次前注释在改写前逐条用 `Select-String -SimpleMatch` 查过 `orig/` 快照，全部 absent，确认是自己写的才动；上游 27 行一处未碰，`missing=0`。
3. **双写与重述**：b6 初稿在 `hasMeaningfulBackendUser` 分支写了「写的是整体对象而不是合并字段」，与上方已有的「[并发] 写入是整体替换而非合并」重复，改为「此分支只写不清，清空由 else 分支负责」，补的是两分支的互补关系而不是原话再说一遍。
4. **行号漂移**：7 批之间累计插入 187 行，后批锚点全部按重生成的 uncovered 取（b1 锚点 33–79，b7 锚点 638–689），未出现按旧行号写错位置。
5. **未做**：`weak=0.0%` 无需处理；`mappedStrict` 低于 `mappedBlock` 属块注释跨行的正常现象。

## 7. 遗留

- 只做了 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试，不得据此宣称「构建通过」（DEEP-SPEC v2.1 (d)）。
- §1 的抽样偏离未回补：若后续要求严格按 §5.3.1，应补一次「随机抽 60 条」的复核记录；本批已全读，补抽样不改变结论，只是流程留痕。
- 批次目录 `ZAI-deep-b01/` 保留了 `_uncovered.txt`（末轮为空）、`_quality.json`、`orig/` 与 b1–b7 的锚点 JSON，可逐批复算。
