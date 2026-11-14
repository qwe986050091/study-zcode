# b238 改写批（22 行档起步：`server.ts` 23 + `usage-stats-builder.ts` 23）

- 日期：2026-11-10
- base：`HEAD`（改写前 HEAD = `26a9beac`）
- 范围：整文件口径，2 文件
- 硬约束（本批起生效）：① 第一处编辑前先 `Get-Date` 留 T1；② 门禁只在全部编辑结束后跑一次

## 1. 选批依据：为什么是这两个文件

台账里的剩余排序是 `weak-own-by-file.tsv`（own weak 按文件降序，同数按路径字典序），不是
`ZC-SCOPE-TIERS.md` 的未覆盖单元降序。b229–b237 把 23–25 行档的 18 个文件做完（名单与批次的对应
见 `ZC-deep-b235.md` §9、`ZC-deep-b236.md`、`ZC-deep-b237.md`），本批接 22 行档的第一组：

```text
22  apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts
22  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts
22  apps/zcode-cli/packages/core/src/tool/handlers/grep.ts
...
```

实际快照复测为 23 + 23 = 46 行（口径：`deep-quality v1.9 --metric-version v3`，与 tsv 的 22 差 1 行/文件，
属快照与现行 v1.9 的度量差，分子分母以本批首跑为准）。

`remoteAssetInstaller.ts`（未覆盖 451 单元）不在这条排序里，是 `ZC-SCOPE-TIERS.md` §3 一档覆盖清单的条目；
本批不需要切它。若切到覆盖口径，它必须按「一批不超过 2 文件」的产能先切片再动，切点在 staging/下载/sha 校验
与清理三段之间，本批未动。

## 2. 文件与 numstat

| 文件 | weak 基线 | + | − |
| --- | --- | ---: | ---: |
| `apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts` | 23 | 3 | 26 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts` | 23 | 4 | 23 |
| 合计 | 46 | 7 | 49 |

删的是 6 段「一句话一行」的复述块（server 4 段 20 行 + usage-stats 4 段 22 行）以及被改写的 3 行旧注释；
新增的 7 行是补进 JSDoc 的后果句与实现依据，逐行有标识符或后果。

## 3. 首跑失败与两处返工

首次门禁（全部编辑完成后唯一一次正式跑）报 2 条违规，`exit=1`：

1. **删上游注释 n=1**：`usage-stats-builder.ts:47` 的单行 JSDoc `/** 用 Intl 计算 … 无法解析时回退 0。 */`
   blame 是 `feat: open source`——上游注释不能改写（DEEP-SPEC §2.6）。返工：原样恢复该行，把新增依据另起一行
   `//` 放在它下方。
2. **新增注释命中 L n=1**：`无 token 或 max 为 0 时一律记 0 级，不参与比例计算，避免空白天被显示成有数据的颜色。`
   ——两个逗号且无判据认可的谓词。返工：拆成两句，只留一个逗号。

复跑七行全绿。返工记在门禁段（段 3）单列，不混回段 2。

## 4. 门禁七行原文

```text
=== 改写门禁（base=HEAD）===
删本线注释    n=49  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=3  其中判据命中 0  （必须 0；已扣除搬移行）
```

登记表 `ZC-deep-b238-rewrite.tsv` 49 条，与「删本线注释 n=49」逐条对应；其中 46 条是 weak 行本体，
3 条是随块改写的旧注释（`server.ts:80-81` blame `10e9df51`、`usage-stats-builder.ts:87` blame `0f2ef80d`，
均为白名单内的本线提交）。

## 5. 改前/改后快照

```text
# 改前
SUMMARY metric=v3 files=2 units=304 coverage=14.1% branch=11.1% field=0.0% comments=173 substance=64.7% explain=87.9% filler=25.4% weak=26.6%
RATIOS weak=46/173 filler=44/173

# 改后
SUMMARY metric=v3 files=2 units=304 coverage=14.1% branch=11.1% field=0.0% comments=131 substance=80.2% explain=100.0% filler=0.0% weak=0.0%
RATIOS weak=0/131 filler=0/131
```

- `--list-weak`：改前 46 行（两文件各 23），改后 `WEAK lines=0 files=0`。
- 分文件 coverage 不变：`server.ts` 18.4%（158 单元）、`usage-stats-builder.ts` 9.6%（146 单元）。
- 覆盖差集：未覆盖单元前 261 行 / 后 261 行（去重 228 / 228），`onlyPre=0`、`onlyPost=0`。

## 6. 三段计时（三个真实时间戳）

| 段 | 起 | 止 | 秒 |
| --- | --- | --- | ---: |
| T0→T1 读文件 + 定改法（含 blame 归属预检） | 17:20:54 | 17:22:49 | 115 |
| T1→T2 全部编辑 | 17:22:49 | 17:23:21 | 32 |
| T2→T3 门禁（含 2 处返工）+ 提交 | 17:23:21 | 17:24:41 | 80 |
| 合计（=墙钟） | 17:20:54 | 17:24:41 | **227** |

分段 115 + 32 + 80 = 227 = 墙钟，相等。T1 在首次编辑前打点；门禁在编辑全部结束后才跑，中间无交错。
本批是**含返工样本（227 秒）**：两处返工没有单独打点，混在段 3 的 80 秒里，因此同口径值无法从本批拆出，
不冒充同口径样本。

## 7. 证据原文

```text
ruler=deep-quality v1.9 sha1=8042442fe198   zc-gate v3 sha1=f75c5e64246f   zc-commit v6 sha1=032283968d18
归属白名单 own-commits sha1=79dfdb7b63b3   OWN-COMMITS.md sha1=642c16355f93（23 条）
提交 c3f5fbc4 b238 改写 2 文件的水句 (+7/−49)
```

## 8. 下一批

`weak-own-by-file.tsv` 22 行档还剩 14 个文件，下一批取：
`apps/zcode-cli/packages/core/src/tool/handlers/grep.ts`、`packages/e2e-report/src/shared/types.ts`。
