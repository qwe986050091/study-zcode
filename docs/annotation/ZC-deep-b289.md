# ZC-deep-b289：6 文件 / 90 行（全池内）+ 3 行邻行自清

> 批次：b289 ｜ 提交 `a307ec35` ｜ 代码 `+90/−90` ｜ 零代码行
> 尺子：`deep-quality.mjs` v2.0（`756bea66122a`）、`zc-commit.mjs` v13（`f02be471a849`）、
> `precheck-assert.mjs`（第 8 行门禁改取 `--start` 实盘基准 / `SAME` 进门禁后的首批）、
> `capacity-estimate.mjs`、`weak-guard.mjs`、`ledger-assert.mjs`。

## 0. 交代

1. 本批 6 文件 / **90 行，全部池内**（own，无池外 own）。
2. `--start`（`2026-11-11T03:49:04.840Z`）先于起草，落 `<batch>-lines.json`（6 文件 / 1,823 行实盘逐行基准）。
3. 流程：`--start` → 起草 → 改写 → 判据预判（2 轮）→ `--scope`（`plan=90 diff_old=90 diff_new=90 out_of_scope=0`）
   → `--record`（**首跑即过**：`SAME 0` / `INDENT 0/0` / `hits=0`，`record_runs=1`）→ `--verify` → `zc-commit v13` → `--order`。
4. 七行门禁：`expected=6 staged=6`，`+90/−90`；顺序断言 `t-start < t-record ≤ t-verify < commit`。
5. 与 b288 的差别：**没有第 8 行门禁返修**。b288 的 `eolChanged=15` 是基准依赖 git 配置造成的假阳性，
   本批起「替换前」取 `--start` 的实盘快照，同一批 `eolChanged=0` 一次通过。

## 1. 计划表

| 文件 | 池内 | 池外 own | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-activities.ts` | 15 | 0 | 15 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` | 15 | 0 | 15 | 0 |
| `packages/provider/src/config/schema.ts` | 15 | 0 | 15 | 0 |
| `packages/server/src/remote/docker-detect.ts` | 15 | 0 | 15 | 0 |
| `packages/shared/src/remoteUsageTelemetry.ts` | 15 | 0 | 15 | 0 |
| `packages/ui/src/lib/patchDiffPreview.ts` | 15 | 0 | 15 | 0 |
| **合计** | **90** | **0** | **90** | **0** |

## 2. 批后池

```text
done files=230（+6）  remain files=777
done lines=3394（+90） remain lines=4027（−90）
ALIGNED acct_remain=4027 pool_remain=4027 diff=0
```

- 登记 90 行 == `done +90`，无池外 own 差额。
- `done 3,394` 的台账口径：**「已写入 3,394 行，其中 10 行经 N/P 双读，fail 1」**；
  抽检 fail 率**不参与 `remain` 计算**，只回答这个数可信到什么程度（见 `ZC-semantic-audit-01.md` §6）。
- 另有 **3 行上游**（`script-workflow-activities.ts:61`、`:184`、`remoteUsageTelemetry.ts:185`）因相邻改写自动转强，
  由 `capacity-estimate` 记为 `SELF-CLEAR n=3 / out-of-pool`，不进 `done`。

## 3. 计时（新口径 n=4，仍单列）

```text
t-start    2026-11-11T03:49:04.840Z
t-record   2026-11-11T03:50:56.173Z  sha=1a652f241e86  record_runs=1
t-verify   2026-11-11T03:51:00.808Z
commit     2026-11-11T11:51:34+08:00  a307ec35

batch_wall_total        = 208.0 s（上一提交 ca2cfb85 11:48:06 → 本提交）
batch_wall_controllable = 149.2 s（含起草时间）
落笔段                  = 116.0 s（含起草时间）
tail                    =   4.6 s
s/行（新口径，端到端）  = 1.66（149.2 / 90）
```

- 新口径累计 **n=4**（3.26、1.62、2.57、1.66），**仍不做与旧口径 1.59 的快慢比较**；
  n≥5 前不取中位数、不做新口径内部结论。
- `batch_wall_total` 含批间非改写动作（本批为第 8 行门禁改造的提交 `ca2cfb85`），不得除以行数当改写成本。

## 4. 度量前后

| 文件 | weak 前→后 |
| --- | ---: |
| `script-workflow-activities.ts` | 15 → 0 |
| `auth-login.ts` | 15 → 0 |
| `schema.ts` | 15 → 0 |
| `docker-detect.ts` | 15 → 0 |
| `remoteUsageTelemetry.ts` | 15 → 0 |
| `patchDiffPreview.ts` | 15 → 0 |
| **合计** | **90 → 0** |

- 全仓：`post-b288 7380 / 1918` → `post-b289 7287 / 1912`（−93 行 / −6 文件）。
- 池内：`post-b288 done 3304 / remain 4117` → `post-b289 done 3394 / remain 4027`（−90），完成度 **45.7%**。
- 池外：`post-b289 7287 − 4027 = 3260`；`post-b288` 为 `3263`，减少 **3**（3 行邻行自清）；
  `90 + 3 = 93`，与全仓减少量闭合。

## 5. 门禁

```text
删本线注释 n=90   删代码 n=0   删上游注释 n=0
新增非注释行 n=0  原行搬移 n=0  标点级改写 n=0
新增注释行 n=90   判据命中 0   嵌套注释 0
numstat: +90 −90
PRECHECK SAME same_rewrites=0（record / verify 各一次）
PRECHECK SCOPE plan=90 allow=0 diff_old=90 diff_new=90 out_of_scope_edits=0
PRECHECK INDENT indentChanged=0 eolChanged=0
PRECHECK MTIME  touched_restored=0
ORDER GATE PASS
```

- **第 8 行门禁新基准首批**：`--record` 首跑 `eolChanged=0`，`record_runs=1`。
  b288 同场景（实盘 LF、`.gitattributes` 强制 `eol=crlf`）旧实现报 15、新实现报 0，
  负控见 `INDEX.md` §2.5（`_nc_b289` 临时仓，481 行全 LF / 改 15 行注释）。
- **`SAME` 门禁首批**：`same_rewrites=0`，b288 的 2 处空替换未复发。
- 首轮预判 `hits=7`（1 W + 6 L），第二轮 `hits=0`：
  - W：`remoteUsageTelemetry.ts:35` 正文改为 `URL 与路径…`，补 ASCII 锚点。
  - L：`docker-detect.ts:40`、`schema.ts:51`（实为 W）、`script-workflow-activities.ts:62/188/266`、
    `auth-login.ts:86`——均为 `、`/`,` 达 2 个且无谓词，改写为带「先/再/返回」的句式。
  - `b289-apply.mjs` 报 `SAME 0`。

## 6. 收口

```text
GUARD 15文件 pre=4 post=4 新增=0 max=8 → PASS
ACCT files 230 + 777 = 1007 OK
ACCT lines 3394 + 4027 = 7421 OK
ALIGNED acct_remain=4027 pool_remain=4027 diff=0
ledger-assert ASSERT PASS（CLOSE 802 = 802，EXEMPT 2）
OWNCOMMITS rows=301 generated=301 missing=0 extra=0 text=same
WHITELIST OK head=a307ec351646 rows=301
PARTIAL 1：cuaDetails.tsx 基线 23 → 现 1
SELF-CLEAR n=3（可写桶 0 / 池外 3 / 上游桶 0 / 未解析 0）
```

## 7. 首轮命中率（逐批）

| 批 | 首轮 hits | 登记行 | 命中率 |
| --- | ---: | ---: | ---: |
| b283 | 3 | 96 | 3.1% |
| b284 | 7 | 100 | 7.0% |
| b285 | 1 | 70 | 1.4% |
| b286 | 8 | 97 | 8.2% |
| b287 | 2 | 92 | 2.2% |
| b288 | 6 | 90 | 6.7% |
| **b289** | **7** | **90** | **7.8%** |

- 七批均值约 5.2%。b289 的 7 条里 6 条是 L（列举行），集中在 3 个纯中文说明块；
  返修只做句式（补谓词 / 去并列），未改语义，第二轮即清零。

## 8. 剩余工作量（按 post-b289 更新）

| 口径 | 单位耗时 | 4,027 行折算 | 说明 |
| --- | ---: | ---: | --- |
| `controllable`（新口径 n=4） | 3.26 / 1.62 / 2.57 / 1.66 s/行 | 13,128 / 6,524 / 10,349 / 6,685 s ≈ 1.8–3.6 h | 只作区间，不取单点 |
| 端到端（b286 实测） | 5.67 s/行 | 22,833 s ≈ **6.3 h** | 含门禁、返修、快照、台账 |
| 批次折算 | 90 行/批 | **约 45 批** | `4,027 / 90 ≈ 45` |

- 结论不变：剩余工作量**小时级（约 4–7 小时可控时间 + 约 45 批固定动作）**，不是天级。
- 新口径四样本离散（3.26 / 1.62 / 2.57 / 1.66），b289 的 1.66 无返修，仍是单批读数，不做归因。

## 9. 池外对账

| 快照 | 提交 | weak | files | remain | 池外 |
| --- | --- | ---: | ---: | ---: | ---: |
| post-b288 | `e5da2497` | 7380 | 1918 | 4117 | 3263 |
| post-b289 | `a307ec35` | 7287 | 1912 | 4027 | 3260 |

- `3263 − 3260 = 3` = 三行邻行自清（`script-workflow-activities.ts:61/184`、`remoteUsageTelemetry.ts:185`，均上游 blame）；
  池内 `4117 − 4027 = 90`；`90 + 3 = 93` = `7380 − 7287`。
- 本批无池外 own 行，池外减少量等于 `SELF-CLEAR` 数，不存在「登记 90 而全仓减 95」那类差额。
