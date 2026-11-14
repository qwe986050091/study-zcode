# b240 改写批（合并试跑：6 个 1–2 行档文件）

- 日期：2026-11-10
- base：`HEAD`（改写前 HEAD = `6179288f`）
- 范围：整文件口径，6 文件（一次门禁、一份登记表）
- 目的：验证「一批多文件」能否把 1–2 行档的固定成本摊薄

## 1. 本批选谁 / 障碍评估

按 `weak-own-by-file.tsv` 剩余排序，1–2 行档前 6 个：

| 文件 | tsv own weak | 实测 weak |
| --- | ---: | ---: |
| `apps/dev-docs/src/data/productCapabilityMap.ts` | 2 | 2 |
| `apps/dev-docs/src/feature-boundary-graph/FeatureBoundaryGraphView.tsx` | 2 | 6 |
| `apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts` | 2 | 2 |
| `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` | 2 | 11 |
| `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` | 2 | 18 |
| `apps/zcode-cli/packages/adapters/src/storage/session-target.ts` | 2 | 5 |

**合并没有障碍**，逐项核过：

- `zc-commit` 本来就吃文件清单（b229 起就是多文件），门禁按文件跑 blame/标点比对，七行是整批汇总；
- 登记表本来就是一行 `path:line + 行哈希 + 内容`，按文件分行，不需要合并计数；
- 归属预检是逐行 `git blame`，逐文件跑没有耦合；
- `--list-weak` 是整批聚合，但 `WEAK` 行带 `path:line` 前缀，可以按文件归位（下表的分文件 weak 就是这么取的）。

**口径发现（重要）**：tsv 的 own weak 是「本线可改」的计数，而 `--list-weak` 是全量 weak（含上游）。
6 个文件 tsv 合计 12 行，实测 44 行，差在 tsv 低估；逐行 blame 后 44 行全部落在本线提交
（`a8784b7e` 安全快照 / `522e851e` L2-B6 / `55f48e6d` 收尾提交），所以**这批能全改**。
结论：`capacity-estimate.mjs` 的 6902 行是**下界**，实际每批要处理的行数按实测走。

## 2. 归属白名单：新增一条

`55f48e6d docs(注释): 收尾提交 插件宿主与 dev-docs 纯注释增量`（2026-11-04）不在自动抽取范围里，
本批 4 行依赖它。按维护规则补进 `_tools/OWN-COMMITS.md` §2 手工表，白名单 23 → **27 条**。
补录后 `own-commits --check 55f48e6d` 返回「本线」。

## 3. 门禁七行原文（首跑即通过，无返工）

```text
=== 改写门禁（base=HEAD）===
删本线注释    n=45  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=13  其中判据命中 0  （必须 0；已扣除搬移行）
```

登记表 `ZC-deep-b240-rewrite.tsv` 共 45 条，与「删本线注释 n=45」逐条对应，分文件：

```text
 2  apps/dev-docs/src/data/productCapabilityMap.ts
 6  apps/dev-docs/src/feature-boundary-graph/FeatureBoundaryGraphView.tsx
 2  apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts
11  apps/zcode-cli/packages/adapters/src/model/model-execution.ts
18  apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts
 6  apps/zcode-cli/packages/adapters/src/storage/session-target.ts
```

## 4. 改前/改后快照

```text
# 改前
SUMMARY metric=v3 files=6 units=3265 coverage=17.5% branch=17.9% field=34.6% comments=1756 substance=82.2% explain=97.6% filler=0.0% weak=2.5%
RATIOS weak=44/1756 filler=0/1756

# 改后
SUMMARY metric=v3 files=6 units=3265 coverage=17.5% branch=17.9% field=34.6% comments=1750 substance=83.9% explain=100.0% filler=0.0% weak=0.0%
RATIOS weak=0/1750 filler=0/1750
```

- `--list-weak`：44 → 0（分文件 2 / 6 / 2 / 11 / 18 / 5）。
- 覆盖差集：未覆盖 2694 行 / 2694 行，`onlyPre=0`、`onlyPost=0`，coverage 17.5% 未变。

## 5. 三段计时（三个真实时间戳）+ 每文件均摊

| 段 | 起 | 止 | 秒 |
| --- | --- | --- | ---: |
| T0→T1 读 6 文件 + 定改法 + 逐行 blame | 17:30:12 | 17:31:57 | 105 |
| T1→T2 全部编辑（含一轮 weak 残留修正 4 行） | 17:31:57 | 17:33:01 | 64 |
| T2→T3 门禁（首跑通过）+ 提交 | 17:33:01 | 17:33:27 | 26 |
| 合计（=墙钟） | 17:30:12 | 17:33:27 | **195** |

105 + 64 + 26 = 195 = 墙钟，相等。

**每文件平均 32.5 秒**（195 ÷ 6）；对照 b239 的 58.5 秒/文件（117 ÷ 2），单文件成本降 44%。
本批 6 个文件都很小（每个 2–18 行 weak），门禁与快照是一次性摊掉的，所以均摊改善明显。

## 6. 按新口径重算估算

`capacity-estimate.mjs` 支持 `--per-batch-map`，逐档设合并倍数（≥20/10–19 仍 2 文件，5–9 用 3，3–4 用 4，1–2 用 6）：

```text
band    files  lines  perBatch  batches
>=20      48   1002      2        24
10-19    285   3938      2       143
5-9      146    963      3        49
3-4      159    543      4        40
1-2      341    456      6        57
SUM      979   6902      -       313
ASSERT PASS
```

- 批数 **493 → 313**；按 195 秒/批约 **17.0 h**（原 26.1 h），按 190 秒/批约 16.5 h。
- 1–2 档：174 批 / 9.2 h → **57 批 / 3.1 h**，是本轮唯一的实测档位。
- 5–9、3–4、10–19 三档的合并倍数**尚未实测**，是按「批时间 ≈ 固定成本 + 少量/文件」外推的，
  推进到该档时要先各挑一批验证，验证不过就退回 2 文件/批。

## 7. 证据原文

```text
ruler=deep-quality v1.9 sha1=8042442fe198   zc-gate v3 sha1=f75c5e64246f   zc-commit v6 sha1=032283968d18
归属白名单 own-commits sha1=79dfdb7b63b3   OWN-COMMITS.md sha1=8fed7e80dd67（27 条）
产能估算 capacity-estimate.mjs sha1=fce060a3b541
提交 477f5d6a b240 改写 6 文件的水句 (+39/−45)
```

## 8. 下一批

1–2 行档还剩 341 个文件。下一批继续合并，取 6 个（按路径序），并把「每文件平均秒数」继续与 32.5 秒对照；
若连续两批 >40 秒/文件，说明 6 文件已到边际，回落到 4–5 个。
