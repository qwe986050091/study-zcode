# ZC-DEEP-oauth（一档 A 组 · 凭据/令牌契约）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§2.7 分批覆盖核对、§5.3.1、§2.4 双写）。
> 范围：单文件 `packages/services/src/oauth/oauth.ts`（落盘后 81 行，16 个可注单元；HEAD 快照 80 行）。

## 1. 预登记

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\OAUTH-deep-b01\_uncovered.txt` |
| 起始状态 | units 16 / covered 15 / **93.8%** / `R = 1`（≤120，全读） |
| 归属判据 | 改写前查 `OAUTH-deep-b01/orig/`；上游 36 行注释 |
| 停止规则 | `UNCOVERED units=0` |

## 2. 实际执行（1 批）

| 批次 | 区域 | 新增整行 | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | `IOAuthService` 服务描述符导出 | 1 | 16（100%） |

**§2.7 核对**：落盘前 `UNCOVERED=1`，插入 1 行，落盘后 `UNCOVERED=0`，`Δ=−1` 精确相等。

## 3. 门禁（末轮）

| 门禁 | 结果 |
| --- | --- |
| `deep-quality` | units 16 / coverage 100.0% / branch 0/0（无分支）/ field 100%（1/1）/ substance 64.9% / explain 100.0% / filler 0 / weak 0 / UNCOVERED 0 |
| `zc-verify` | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 1 |
| `zc-gate` | badFiles 0 / waterLines 0 / waterRate 0.00% / addedCommentLines 1 |
| `deep-boilerplate` | 全 0 |
| `check-upstream-comments` | upstreamComments 39 / missing 0 |

## 4. 数量对账

单元 16；`//` 行 37；新增 1；上游 36（37 − 1）。闭合：**36 + 1 = 37**。

> `deep-quality` 的 `comments=37` 与 `check-upstream-comments` 的 39 口径不同（后者按映射块统计），本表只用可直接复核的 37 / 1 / 36。

## 5. 说明

- 本文件 93.8% 的覆盖来自上游原有的 JSDoc 块注释；仅 `IOAuthService` 描述符导出缺单元注释，补一行即收口。
- `substance=64.9%` 是上游块注释与单元映射的比值，不是新增注释的质量指标；新增 1 行的 explain=100%、filler=0、weak=0。
- 未跑 `tsc --noEmit` 与单元测试，只做解析级校验。
