# ZC-DEEP-bigmodelProviderAdapter（一档 A 组 · 凭据/令牌文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3.1 取小者与抽样规则、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/services/src/oauth/providers/bigmodelProviderAdapter.ts`（落盘后 480 行，162 个可注单元；工作区基线 361 行，HEAD 快照 310 行）。
> 判据：按「改错或删掉会不会被发现」写，接口字段行、对象字面量属性行、分支行照写。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\BIGMODEL-deep-b01\_uncovered.txt`（`deep-quality --uncovered` 生成，非人工挑选） |
| 起始状态 | units 162 / covered 34 / **21.0%** / `R = 128` |
| 阈值判定 | `R = 128 > 120`，§5.3.1 要求先抽 60 条再决定 |
| 实际执行 | **未抽 60 条，直接全读**：361 行、128 个未覆盖单元逐条核对，全部为真缺口。与 `zaiProviderAdapter`、`protocol` 同为对 §5.3.1 的流程偏离，记在此处，不写成「抽样后升级」 |
| 停止规则 | 末轮 `UNCOVERED units=0` |
| R 取值时点 | 每批插入后重生成 uncovered 再取；后批锚点不得复用前批行号 |
| 归属判据 | 改写任何一行前先查 `BIGMODEL-deep-b01/orig/`（= `git show HEAD:` 转 CRLF）；快照中存在即上游，只许新增（§2.6） |
| 批次前状态 | 工作区已有 **52 行未提交注释**（本工程前序工作，含 INV-01…INV-04 表头），非上游，与本次新增分列 |

## 2. 实际执行（按函数/分支边界分批，8 批）

每批写完立即落盘并重跑 `deep-quality` 重生成 uncovered；每批新增行数取自插入器输出，合计 128。

| 批次 | 区域（成员边界） | 新增整行 `//` | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | 信封字段 11、customer 字段 4、`log` | 16 | 50（30.9%） |
| b2 | `maskOAuthCode` 分支、`readTrimmedString`、`resolveBigModelDisplayName`、类字段与 `constructor` | 22 | 72（44.4%） |
| b3 | `parseCallbackParams`、`buildAuthorizeUrl`、`exchangeToken`、`exchangeZcodeJwtToken` 签名 | 19 | 91（56.2%） |
| b4 | 兑换请求日志体、`readApiJson` 调用与真实请求体 | 16 | 107（66.0%） |
| b5 | 业务码拒绝分支、`data.token` 缺失、业务 token 缺失、refreshToken 与返回 | 16 | 123（75.9%） |
| b6 | `catch` 诊断采样、`fetchUserInfo` 入参与 JWT 短路 | 16 | 139（85.8%） |
| b7 | 无 customer 兜底、成功 profile、`loadLegacyTokenSet` | 15 | 154（95.1%） |
| b8 | `normalizeError`、业务 token 优先级链 | 8 | 162（100.0%） |
| **合计** | — | **128** | — |

起点 21.0% → 终点 **100.0%**；`git diff HEAD --numstat` = **+180 / −0**（其中 52 行为批次前已存在，128 行为本次新增）。

## 3. 定格表述

**`R = 0`（162/162 全读收口）**，形式记为 `read-all`，不记抽样：128 个未覆盖单元全部写了注释，没有「采样后外推」的成分。

## 4. 数量对账（三个总数必须自洽）

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 162 | `deep-quality --metric-version v3` |
| 文件内注释行（当前） | 208 | 同上 `comments` |
| 相对 HEAD 新增行 | 180 | `git diff HEAD --numstat` = `+180 / −0` = `zc-verify added` = `zc-gate addedCommentLines` |
| 其中：批次前已存在 | 52 | 预登记时工作区已有，非上游 |
| 其中：本批新增 | 128 | 8 批插入行数之和，等于起始未覆盖数 |
| 上游原有注释行 | 28 | 208 − 180；与 `check-upstream-comments` 的 `upstreamComments=28` 一致 |

闭合：**28（上游） + 52（批次前） + 128（本批） = 208（现状）**。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 162 / coverage **100.0%** / branch 100%（9/9）/ field 100%（27/27）/ substance 99.0% / explain 100.0% / filler 0.0% / weak 0.0% |
| 映射 | 同上 `MAP` | mappedStrict 162 / mappedBlock 200 / unmapped 8（import 6、continuation 2） |
| 代码与上游 | `zc-verify.mjs BIGMODEL-deep-b01`（普通批） | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 180 |
| 注水 | `zc-gate.mjs --file packages/services/src/oauth/providers/bigmodelProviderAdapter.ts` | badFiles **0** / waterLines **0** / waterRate 0.00% / addedCommentLines 180 |
| 近重复 | `deep-boilerplate.mjs --diff --baseline BIGMODEL-deep-b01\orig` | groups 0 / lines 0 / files 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0**（upstreamComments 28，与 §4 一致） |

**为什么是普通批而不是 `--rewrite`**：本文件相对 HEAD 只有新增。过程中改写的 14 行注释（5 行批次前 + 9 行本批）在 HEAD 中都不存在，对 HEAD 的差异仍是 `+180/−0`，因此普通模式即可满足 `deletedNonZero=0`。

## 6. 清理与记账

1. **注水清零**：`zc-gate` 共报 14 行，全部**原位置改写**，不增删行：
   - 批次前遗留 5 行（现第 22、72、298、367、402 行），改写前用 `Select-String -SimpleMatch` 逐条查 `orig/`，5 条全部 absent，确认是自己写的才动；补标识符（`resolveBigModelBusinessAccessToken`、`readOptionalString`、`zcode`）或补谓词（`只能`、`否则`、`因为`）。
   - 本批新增 9 行：b2 两行 L（`shared` 段、`constructor` 段）、b3 一行 L（`exchangeToken` 转发）、b4 一行 W（`codeLength`）、b5 四行（`message`、`msg`、`payload.code`、`refreshToken`）、b7 一行 W（`loadCredential`）。
   - 末轮 `waterLines=0`。
2. **行号漂移事故（必须记）**：b5 首次落盘时复用了 b4 之前的 uncovered 行号，而 b4 已插入 16 行，导致 b5 的 16 条注释整体上移、其中 3 条插进已有两行块注释中间，把注释块切断。发现后按文本精确匹配整批删除 16 行（代码零改动），重跑 `deep-quality` 回到 66.0%，再用新生成的 uncovered 重新落位。**根因是从上往下插、批间复用旧行号**；后续文件改为**从文件尾部向头部倒序分批**，每批只影响已处理区域，行号不再失效。
3. **§2.6 归属判据的落点**：上游 28 行一处未碰（`missing=0`）；改写的 5 行批次前注释逐条查过 HEAD 快照，全部 absent。
4. **双写与重述规避**：该文件上游已有 `[字段映射]/[失败路径]/[权衡]/[资源]/[职责]/[兼容]` 块注释，本批按单元补的是字段优先级、分支互补与失败后果，没有把块注释原话搬到单元上方。b8 的 `resolveBigModelBusinessAccessToken` 注释只说明「四条读取由它统一维护」，未重复上方已写的优先顺序。
5. **未做**：只做 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试。

## 7. 遗留

- §1 的抽样偏离同前几批：若要求严格按 §5.3.1，需补一次随机 60 条复核留痕；本批已全读，补抽样不改变结论。
- 批次目录 `BIGMODEL-deep-b01/` 保留 `_uncovered.txt`（末轮为空）、`_quality.json`、`orig/` 与 b1–b8 锚点 JSON；`b5.json` 为二次落位的最终版本，`_drop-b5.mjs` 是误插回滚脚本。
