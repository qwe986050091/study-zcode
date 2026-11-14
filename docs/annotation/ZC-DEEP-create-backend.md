# ZC-DEEP-create-backend（一档 A 组 · 凭据/远程执行入口）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§2.7 分批覆盖核对、§5.3.1、§2.4 双写）。
> 范围：单文件 `packages/server/src/remote/create-backend.ts`（落盘后 60 行，23 个可注单元；HEAD 快照 37 行）。

## 1. 预登记

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\CREATEBK-deep-b01\_uncovered.txt` |
| 起始状态 | units 23 / covered 0 / **0.0%** / `R = 23`（≤120，全读） |
| 归属判据 | 改写前查 `CREATEBK-deep-b01/orig/`；上游 0 行注释 |
| 停止规则 | `UNCOVERED units=0` |

## 2. 实际执行（1 批）

| 批次 | 区域 | 新增整行 | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | 全文件：工厂分支、SSH 私钥读取、三种后端构造 | 23 | 23（100%） |

**§2.7 核对**：落盘前 `UNCOVERED=23`，插入 23 行，落盘后 `UNCOVERED=0`，`Δ=−23` 精确相等。

## 3. 门禁（末轮）

| 门禁 | 结果 |
| --- | --- |
| `deep-quality` | units 23 / coverage 100.0% / branch 100%（6/6）/ field 无 / substance 100.0% / explain 100.0% / filler 0 / weak 0 / UNCOVERED 0 |
| `zc-verify` | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 23 |
| `zc-gate` | badFiles 0 / waterLines 0 / waterRate 0.00% / addedCommentLines 23 |
| `deep-boilerplate` | 全 0 |
| `check-upstream-comments` | upstreamComments 0 / missing 0 |

## 4. 数量对账

单元 23；`//` 行 23；新增 23；上游 0。闭合：**0 + 23 = 23**。

## 5. 记账

- 单批即收口，无注水告警，无需改写上游行。
- 未跑 `tsc --noEmit` 与单元测试，只做解析级校验。
