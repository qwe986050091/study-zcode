# ZC-deep-b386

> 批次：b386 ｜ **20 行 / 10 文件** ｜ 提交 `8a89fb64`

## 0. 普通批；`fix=0`；**判据类 0 / 格式类 0 / lint 2（写盘前）**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | **2** | `webElementContext.ts:131` 与 `ModelTrajectoryPaneParts.tsx:503` 各有两个 `，`，改冒号 / 去逗号后通过 |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 0 | `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/lib/conversationShareError.ts` | 2 | 0 |
| `packages/ui/src/lib/nodeReplToolDisplay.ts` | 2 | 0 |
| `packages/ui/src/lib/planModeTool.ts` | 2 | 0 |
| `packages/ui/src/lib/promptInputTriggers.ts` | 2 | 0 |
| `packages/ui/src/lib/remoteWorkspaceHistory.ts` | 2 | 0 |
| `packages/ui/src/lib/taskModelRecovery.ts` | 2 | 0 |
| `packages/ui/src/lib/webElementContext.ts` | 2 | 0 |
| `packages/ui/src/lib/zcodeSessionProjection.ts` | 2 | 0 |
| `packages/ui/src/lib/zcodeUiError.ts` | 2 | 0 |
| `packages/ui/src/ModelTrajectoryPaneParts.tsx` | 2 | 0 |
| **合计** | **20** | **0** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **10** | **10** | **0** | 1,487 → 1,477 | 1,388 | **89** | `1,487 − 10 + 0 = 1,477` ✔；`1,388 + 89 = 1,477` ✔ |

- **10 个文件全部全仓清零**，本批没有池外残留遗留。
- **表外差集**：`b385 → b386` 新增 **0** / 移除 **0**，名单落盘
  [`ZC-deep-b386-outside-diff.tsv`](ZC-deep-b386-outside-diff.tsv)（空表也提交）。
- 表内 1,520 = ACTIVE 1,388 + CLEARED 132；表外 89 连续三批不变。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=8a89fb64 files=10/10 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=34 auto_self_clear=0
gate: PASS order n=0 total=99.0s controllable=98.0s
GATE ALL PASS batch=b386 sha=8a89fb64
```

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
```

## 3. 进度

- 全仓 weak：**3,536 → 3,516**（−20）；weak 文件 **1,487 → 1,477**。
- 池内：**279 行 / 239 文件**（`7,142 + 279 = 7,421`、`768 + 239 = 1,007`、`ALIGNED OK`）。
- **行侧进度 96.2%**（7,142 ÷ 7,421）；文件侧 `768 ÷ 1,007 = 76.3%`（辅助）。
- **残留两列**：池内可写 **279 行** / 池外残留 **3,237 行**（`3,516 − 279`）。
- 剩余批数（cap 10）：**24 批**（239 ÷ 10）。形状：`279 ÷ 24 = 11.6 行/批`、`239 ÷ 24 ≈ 10 文件/批`。

## 4. 计时（一位小数，S0–S4 之和 = 收口）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `86801c98`（17:12:34） | `8a89fb64`（17:14:13） | 99.0 |
| `controllable` | `--start`（17:12:35） | 批次提交 | **98.0** |
| **S0** 提交 → closeout | 17:14:13 | 17:14:16 | **3.0** |
| **S1** 扫描 + 1b/1c | — | — | **7.3** |
| **S2** rewrite.tsv + 白名单 + capacity | — | — | **1.3**（0.0 + 0.2 + 1.1） |
| **S3** 台账 | 17:14:24.6 | 17:15:06.3 | **41.7** |
| **S4** 提交 | 17:15:06.3 | 17:15:07 | **0.7** |
| **收口 S0–S4** | 17:14:13 | 17:15:07 | **54.0**（3.0 + 7.3 + 1.3 + 41.7 + 0.7） |
| **批墙钟** | 17:12:35 | 17:15:07 | **152.0**（98.0 + 54.0） |

**`[1b 校验]` / `[1c allowed]` 原文**：

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
[1b 校验] batch=b386 pre=b385 weak=d:/code/_annot_baseline/b386-repo-post.txt weak_rows=3516 plan=20 head_added=20
```

## 5. 点估计（主报）

```
[窗口] b385 / b383 / b382（b384 标事故，中位与包络同时剔除）
[点估计] 1.03h = 24批 × 61.4 + 279行 × 3.45 + 24批 × 53.6s → 3722.6s
[点估计] 1.24h（收口维持 b385 的 84s）→ 4452.1s
[点估计] 0.88h（收口回到窗口最低 b383 的 31s）→ 3180.2s
[观测包络] 0.64–1.17h（同窗口 min 96s / max 176s；参考，不进主报）
[表外差集] 新增 0 / 移除 0（b385 → b386）
```

- **主报 = `1.03h`**；收口维持 `84s` 则 `1.24h`，回到 `31s` 则 `0.88h`。差 `0.36h` 全部由收口造成。
- 收口中位与包络同源：`b385 / b383 / b382`；b381 与 b384 两处同时剔除。
- 形状：`24 批 × 10 文件、每批约 12 行`；出现 5 文件批时须重述模型适用性。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `8a89fb64` | `+20/−20` |
| rewrite.tsv + outside-diff + 本台账 + 白名单 690 行 | `24b7a490` | — |
