# b395 · cap 20 试验第 5 批（20 文件 / 20 行，首轮全绿，连续两批）

> 提交：`bf951d79`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b394-repo-post.txt`；批后快照：`b395-repo-post.txt`
> 口径：`CLOSING.md` §5（含 §5.5）、`_tools/INDEX.md` §5.3 与 §6.2

## 0. 三列

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset-assert` missing=0 extra=0） | **首轮 3 → 修后 0** |

- 首轮 3 条：1 条禁用词（「其他」写成「其它」，命中 `它`）、2 条分隔符 `≥2`（`contract` 的 `、`+`，`）。
  改法是换分号/换词，**只改草稿脚本再重跑，未落盘返工**。

## 0.1 cap 20 第五批：三项全过，按预登记规则升级「稳定」

| 判据 | 阈值/公式 | b392 | b393 | b394 | b395 |
| --- | --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | **3** | 0 | 0 | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 23 − 3 = 20 | 20 − 0 = 20 | 20 − 0 = 20 | **20 − 0 = 20** |
| `controllable` | **≤ 181.5（冻结）** | 150.0 | 118.0 | 121.0 | **110.0** |

- 阈值按 b394 冻结值 `181.5s` 执行，本批窗口变化不影响。
- **「稳定」的判据原文（预登记，b394 前写定）**：连续两批首轮同时满足
  ① `pool-diff n=0`；② `removed − selfclear_batch == plan.tsv 行数`；③ `controllable ≤ 冻结阈值 181.5s`。
  **b394 与 b395 均满足 → cap 20 记为「稳定」**。首轮干净率 `4/5`。
  一旦出现首轮不干净，立即退回「净收益为正、判据不稳定」，不保留「历史稳定」的说法。

## 1. 逐文件（批前 → 批后，合计 20 → 5 行上游）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/services/src/session/automationCronValidation.ts` | 1 | 0 |
| `packages/services/src/session/automationService.ts` | 3 | 2 |
| `packages/services/src/session/continuousStreamCoalescer.ts` | 1 | 0 |
| `packages/services/src/session/offPeakRuntimeModel.ts` | 1 | 0 |
| `packages/services/src/session/offPeakServerClient.ts` | 2 | 1 |
| `packages/services/src/session/offPeakTaskRepo.ts` | 2 | 1 |
| `packages/services/src/session/offPeakWorkspaceIdentityMigration.ts` | 1 | 0 |
| `packages/services/src/session/sessionModeOptions.ts` | 1 | 0 |
| `packages/services/src/session/taskIndexRepo.ts` | 2 | 1 |
| `packages/services/src/session/tasksDatabase/migrations.ts` | 1 | 0 |
| `packages/services/src/session/zcodeTaskListTypes.ts` | 1 | 0 |
| `packages/services/src/session/zcodeTaskService.ts` | 2 | 1 |
| `packages/services/src/skill-sync/skillSync.ts` | 1 | 0 |
| `packages/services/src/storage/app/storageService.ts` | 1 | 0 |
| `packages/services/src/storage/domain/cleanPlan.ts` | 1 | 0 |
| `packages/services/src/storage/domain/usageAggregate.ts` | 1 | 0 |
| `packages/services/src/task-groups/contract.ts` | 1 | 0 |
| `packages/services/src/usage-stats/providers/bigmodelUsageMonitorMapper.ts` | 1 | 0 |
| `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts` | 1 | 0 |
| `packages/services/src/usage-stats/usageStats.ts` | 1 | 0 |

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **15** | **15** | **0** | **0** |

- **交叉核对（独立）**：`1,380 − 15 + 0 = 1,365`（全仓 weak **文件数**），与 `deep-quality` 末行 `files=1365` 一致。
- **交叉核对（独立）**：全仓 weak **行数** `3,352 → 3,332`，差 `20`，与本批改写行数 `20` 相等，新进 `0`。
- `全仓清零 15 = 表内 +4 + 表外 +11`：`CLEARED 193 → 197`、表外 `53 → 42`。
  5 个文件各留 1 行上游（`automationService` 3→2 等），所以 20 个文件里 15 个整文件清零。
- **表外差集**：新增 **0** / 移除 **11**，11 行 `cause` 全为 `annotation`；`mixed` 仍未观测到。
- **池外残留本批不动**：`3,233 → 3,233`（本批无「无计划行的块尾 `*/` 位移」）。

## 2. 六闸原文（同一次跑，无二段）

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=bf951d79 files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 total=328.0s controllable=110.0s
GATE ALL PASS batch=b395 sha=bf951d79
```

- 收口侧：`[cap 判据] removed=20 − selfclear_batch=0 = 20，plan.tsv=20 → OK`。
- `allowed = 20 计划 + 18 已登记 + 0 自动 = 38`。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **99**（done 7,322 / 7,421 = **98.7%**） |
| 池内文件 | **99**（done 908 / 1,007 = 90.2%），辅助 |
| 全仓 weak | **3,332 行 / 1,365 文件** |
| 池外残留 | **3,233 行**（3,332 − 99，本批未动） |
| 集合 | `1,365 = ACTIVE 1,323 + 表外 42`（**定义恒等，非校验**） |
| 表内 | `1,520 = ACTIVE 1,323 + CLEARED 197`（**定义恒等，非校验**） |

- `ALIGNED OK`：`acct_remain 99 == pool_remain 99`（独立校验）。
- 剩余形状 **99 文件 × 1 行**，cap 20 下 `ceil(99 / 20) = 5` 批。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `controllable` | `--start`（20:10:08.8） | 批次提交（20:11:58） | **110.0** |
| **S0** 收口准备 | 20:11:58 | 20:12:18 | **20.0** |
| **S1** 失败诊断 | — | — | **0.0** |
| **S2** 人工登记 + 第二段六闸 | — | — | **0.0** |
| **S3a+S3b** 台账与快照 + CLOSING/INDEX 数据行 | 20:12:18 | 20:13:11.8 | **53.8**（**合并计时**；两段连做，无独立打点，b396 起分开） |
| ~~S3b~~ | — | — | 不单独列（**不是 0 工作**，已并入上一行） |
| **S4** 提交（数据行，`cb641377`） | 20:13:11.8 | 20:13:17.3 | **5.5** |
| **收口 S0–S4（分段和）** | 20:11:58 | 20:13:17.3 | **79.3**（20.0 + 0 + 0 + 53.8 + 0 + 5.5） |
| **批墙钟（实测端点）** | 20:10:08.8 | 20:13:17.3 | **188.5** |
| **S5** 回填（计时/主报复算 + 回填提交） | 20:13:17.3 | 20:14:03 | **45.7**（**计入主报常数 `57.0`**；本批略低于常数，不改常数） |

TOOL_TRIP: 0.0（无重复执行；lint 首轮 3 条只改草稿脚本）
S5_PER_BATCH: 57.0
- 净收口 = 收口；净墙钟 = 实测墙钟。

## 5. 主报

- 剩余 99 行 / 99 文件 → cap 20 下 `5` 批。
- 窗口 `b395 / b394 / b393`，净收口 `79.3 / 98.0 / 287.0` → 中位 **`98.0s`**（唯一无扣减的自然是 b394；b393 的 287.0 是 `307.0 − 20.0` 构造值）。
- **主报 `0.40h`**：`5 × (61.4 + 57.0) + 99 × 3.45 + 5 × 98.0 = 592 + 341.55 + 490 = 1423.55s`；区间 `0.29–0.47h`；包络 `0.26–0.56h`。
- 参考档：收口维持 `79.3s` → `0.37h`。
- **敏感度兑现**：b394 批报里预演过「中位回落到 98 → 0.32h（不含 S5）」，本批实际 `0.40h`，差异全部来自 `S5_PER_BATCH`；
  说明收口已是主变量，**对外数必须带窗口构成**，不能只给一个 0.40h 让人当成稳定值。
- 本批**无口径变更**；执行的是 b394 已定稿的 `S5_PER_BATCH=57.0`、`TOOL_TRIP` 仪器化、冻结阈值 `181.5`。
