# ZC-DEEP-providerAdapter（一档 A 组 · 凭据/令牌契约）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§2.7 分批覆盖核对、§5.3.1、§2.4 双写）。
> 范围：单文件 `packages/services/src/oauth/providers/providerAdapter.ts`（落盘后 57 行，19 个可注单元；HEAD 快照 39 行）。

## 1. 预登记

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\PROVADP-deep-b01\_uncovered.txt` |
| 起始状态 | units 19 / covered 7 / **36.8%** / `R = 12`（≤120，全读） |
| 归属判据 | 改写前查 `PROVADP-deep-b01/orig/`；上游 4 行注释 |
| 批次前状态 | 工作区已有 6 行未提交注释（非上游），与本次新增分列 |
| 停止规则 | `UNCOVERED units=0` |

## 2. 实际执行（1 批）

| 批次 | 区域 | 新增整行 | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | `OAuthProviderContext` 字段、`OAuthProviderAdapter` 成员、`loadCredential` 形参 | 12 | 19（100%） |

**§2.7 核对**：落盘前 `UNCOVERED=12`，插入 12 行，落盘后 `UNCOVERED=0`，`Δ=−12` 精确相等。

## 3. 门禁（末轮）

| 门禁 | 结果 |
| --- | --- |
| `deep-quality` | units 19 / coverage 100.0% / branch 0/0（无分支）/ field 100%（8/8）/ substance 100.0% / explain 100.0% / filler 0 / weak 0 / UNCOVERED 0 |
| `zc-verify` | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 18 |
| `zc-gate` | badFiles 0 / waterLines 0 / waterRate 0.00% / addedCommentLines 18 |
| `deep-boilerplate` | 全 0 |
| `check-upstream-comments` | upstreamComments 4 / missing 0 |

## 4. 数量对账

单元 19；`//` 行 22；相对 HEAD 新增 18（其中批次前 6、本批 12）；上游 4。闭合：**4 + 18 = 22**。

## 5. 记账

- **注水清零**：第 2 行（批次前注释，orig 中不存在）报 `L` 列举无谓词，原位置改写为「provider 特例、网络调用与凭据存储都由实现承担」，补 `由` 谓词，不增删行。
- 未跑 `tsc --noEmit` 与单元测试，只做解析级校验。
