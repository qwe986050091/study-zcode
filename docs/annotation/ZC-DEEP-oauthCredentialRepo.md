# ZC-DEEP-oauthCredentialRepo（一档 A 组 · 凭据/令牌文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3.1 取小者与抽样规则、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/services/src/oauth/repo/oauthCredentialRepo.ts`（落盘后 743 行，229 个可注单元；HEAD 快照 472 行）。
> 判据：按「改错或删掉会不会被发现」写，接口字段行、对象字面量属性行、分支行照写。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\CREDREPO-deep-b01\_uncovered.txt`（`deep-quality --uncovered` 生成，非人工挑选） |
| 起始状态 | units 229 / covered 121 / **52.8%** / `R = 108`（branch 51.3%、field 10.0%） |
| 阈值判定 | `R = 108 ≤ 120`，按 §5.3.1 直接全读，**无需抽样** |
| 停止规则 | 末轮 `UNCOVERED units=0` |
| 归属判据 | 改写任何一行前先查 `CREDREPO-deep-b01/orig/`（= `git show HEAD:` 转 CRLF）；快照中存在即上游，只许新增（§2.6） |
| 批次前状态 | 工作区已有 **163 行未提交注释**（本工程前序工作，含 INV-01…INV-05 表头），orig 中全部 absent，非上游；与本次新增分列 |

## 2. 实际执行（**从文件尾部向头部**倒序分批，6 批）

每批只影响已处理区域（尾段），上部行号永不失效；每批落盘即 `zc-gate` 清零并单独提交。新增行数取自插入器输出，合计 108。

| 批次 | 区域（成员边界，行号自尾向头递减） | 新增整行 `//` | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | `clearAll`、`clearCorruptOAuthSession`、`saveUserProfile`、`loadUserProfileFromKey` 尾段 | 18 | 139（60.7%） |
| b2 | `loadCachedSessionTokens`、`saveTokenSet`、`loadUserProfile`、`loadUserProfileFromKey` 头段 | 16 | 155（67.7%） |
| b3 | `loadTokenSet`、`clearActiveSession`、`loadLoginAttribution` | 20 | 175（76.4%） |
| b4 | active 系列读写、`saveLoginAttribution`、`loadLoginAttribution` 头段 | 19 | 194（84.7%） |
| b5 | 头像归一（`toBase64ImageDataUrl`/`normalizeStoredZaiAvatarUrl`）、构造区、`saveActiveProvider` | 20 | 214（93.4%） |
| b6 | `OAuthCredentialRepoOptions` 字段、`userInfoKey`、`collectKnownOAuthProviderIds`、魔数分支 | 15 | 229（100.0%） |
| **合计** | — | **108** | — |

起点 52.8% → 终点 **100.0%**；`git diff 56b767fd --numstat` = **+271 / −0**（其中 163 行为批次前已存在，108 行为本次新增）。

提交（一批一提交，批间可断）：`fd77731e` b1、`767fa4de` b2、`a2c502d6` b3、`596d2806` b4、`37956299` b5、`1031bb2f` b6。

## 3. 定格表述

**`R = 0`（229/229 全读收口）**，形式记为 `read-all`：108 个未覆盖单元全部写了注释，没有「采样后外推」的成分。

## 4. 数量对账（三个总数必须自洽）

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 229 | `deep-quality --metric-version v3` |
| 文件内注释行（`//` 开头，当前） | 288 | 直接计数（`/^\s*\/\//`） |
| 相对基线新增行 | 271 | `git diff 56b767fd --numstat` = `+271 / −0` = `zc-verify added` |
| 其中：批次前已存在 | 163 | 预登记时工作区已有，非上游 |
| 其中：本批新增 | 108 | 6 批插入行数之和，等于起始未覆盖数 |
| 上游原有 `//` 行 | 17 | orig 中直接计数；288 − 271 = 17 |

闭合：**17（上游） + 163（批次前） + 271 − 163 = 288（现状）**，即 17 + 271 = 288。

> 注：`deep-quality` 的 `comments=290` 与「`//` 行数 288」口径不同（前者按映射单元统计），`check-upstream-comments` 的 `upstreamComments=274` 又是另一套计数；本表只用可直接复核的 288 / 271 / 17 三数闭合，不混用。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 229 / coverage **100.0%** / branch 100%（39/39）/ field 100%（10/10）/ substance 98.6% / explain 100.0% / filler 0.0% / weak 0.0% / **UNCOVERED units=0** |
| 映射 | 同上 `MAP` | mappedStrict 229 / mappedBlock 269 / unmapped 21（import 14、structural 1、continuation 6） |
| 代码与上游 | `zc-verify.mjs CREDREPO-deep-b01` | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 271 |
| 注水 | `zc-gate.mjs --file packages/services/src/oauth/repo/oauthCredentialRepo.ts` | badFiles **0** / waterLines **0** / waterRate 0.00% / addedCommentLines 15（该命令按当前未提交差量计） |
| 近重复 | `deep-boilerplate.mjs --diff --baseline CREDREPO-deep-b01\orig` | groups 0 / lines 0 / files 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0** |

**为什么是普通批而不是 `--rewrite`**：本文件相对基线只有新增（`+271/−0`），普通模式即可满足 `deletedNonZero=0`。

## 6. 清理与记账

1. **注水清零**：b4 首次落盘时报 1 行 `L`（2 个逗号、无谓词）——第 363 行「解密错误降级为 null，其它 error 继续上抛……」。原位置改写为「分支条件：只有 isCredentialDecryptError 命中才降级，其余错误类型直接走 throw。」，不增删行；同时避免与上一行既有注释重复。末轮 `waterLines=0`。
2. **行号策略**：全程**从尾（第 617 行）向头（第 42 行）**倒序分批，每批只动已处理区域，上部行号永不失效。与 `bigmodelProviderAdapter` 事故后的新规则一致（见该文档 §6.2）。
3. **§2.6 归属判据的落点**：上游 17 行一处未碰（`missing=0`）；批次前 163 行与本次 108 行都是新增，未改写任何上游行。
4. **双写与重述规避**：该文件上游已有 INV-01…INV-05 表头与大量函数级块注释，本批按单元补的是分支条件、字段取舍与失败后果，没有把块注释原话搬到单元上方。
5. **未做**：只做 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试。

## 7. 遗留

- 批次目录 `CREDREPO-deep-b01/` 保留 `_uncovered.txt`（末轮为空）、`_quality.json`、`orig/` 与 b1–b6 锚点 JSON。
- 下一个 A 组文件：`oauthUnauthorizedRequest.ts`（77/61），其后 `sshAuth.ts`（58/52）。C 组判据定稿前不动。
