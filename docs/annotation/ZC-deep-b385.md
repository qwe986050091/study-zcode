# ZC-deep-b385

> 批次：b385 ｜ **20 行 / 10 文件** ｜ 提交 `3623176e`

## 0. 普通批；`fix=0`；**判据类 0 / 格式类 0 / lint 0**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | 0 | 20 行一次过（锚点 / 分隔符 / 代词） |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 0 | `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/services/src/session/claude-native/sessionHistoryJsonl.ts` | 2 | 0 |
| `packages/services/src/session/controllerRemoteIdentityMigration.ts` | 3 | 1 |
| `packages/services/src/setting/settingService.ts` | 2 | 0 |
| `packages/services/src/terminal/terminalProfileMacOs.ts` | 2 | 0 |
| `packages/ui/src/git-graph/GitGraphDialog.tsx` | 2 | 0 |
| `packages/ui/src/GitActionMenu.tsx` | 3 | 1 |
| `packages/ui/src/highspeed/highspeedTurnStore.ts` | 2 | 0 |
| `packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts` | 3 | 1 |
| `packages/ui/src/hooks/useModelProviders.ts` | 2 | 0 |
| `packages/ui/src/hooks/useSubagents.ts` | 2 | 0 |
| **合计** | **22** | **3** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **10** | **7** | **0** | 1,494 → 1,487 | 1,398 | **89** | `1,494 − 7 + 0 = 1,487` ✔；`1,398 + 89 = 1,487` ✔ |

- 未全仓清零的 3 个：`controllerRemoteIdentityMigration.ts`、`GitActionMenu.tsx`、`useCodingPlanQuotaResetUi.ts`，
  各留 **1 行池外上游残留**，与 `pick` 的 `upOut=3` 一致。
- **四个数同批闭合**：集合 1,487 = ACTIVE 1,398 + 表外 89，差 0；表内 1,520 = ACTIVE 1,398 + CLEARED 122。
- **表外差集（b386 起固定两列）**：`b384 → b385` 新增 **0** / 移除 **0**，名单落盘
  [`ZC-deep-b385-outside-diff.tsv`](ZC-deep-b385-outside-diff.tsv)（空表也提交）。
  只有差集为空，`新进 0` 才是测出来的；「表外总量单调不升」单独不构成证据。
- 表外 `99 → 89`：b376–b384 九批里无一批上升；「新进 0」成立，但表外始终 89–99，说明 1,520 快照本就没采全。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=3623176e files=10/10 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=34 auto_self_clear=0
gate: PASS order n=0 total=408.0s controllable=92.0s
GATE ALL PASS batch=b385 sha=3623176e
```

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
```

## 3. 进度

- 全仓 weak：**3,556 → 3,536**（−20）；weak 文件 **1,494 → 1,487**。
- 池内：**299 行 / 249 文件**（`7,122 + 299 = 7,421`、`758 + 249 = 1,007`、`ALIGNED OK`）。
- **行侧进度 96.0%**（7,122 ÷ 7,421）；文件侧 `758 ÷ 1,007 = 75.3%`（辅助）。
- **残留两列**：池内可写 **299 行** / 池外残留 **3,237 行**（`3,536 − 299`）。
- 剩余批数（cap 10）：**25 批**（249 ÷ 10）。形状：`299 ÷ 25 = 12.0 行/批`、`249 ÷ 25 ≈ 10 文件/批`。

## 4. 计时（一位小数，S0–S4 之和 = 收口）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `3fad6173`（16:54:04） | `3623176e`（17:00:52） | 408.0 |
| `controllable` | `--start`（16:59:20） | 批次提交 | **92.0** |
| **S0** 提交 → closeout | 17:00:52 | 17:00:55 | **3.0** |
| **S1** 扫描 + 1b/1c（末次 closeout 分步） | — | — | **7.3** |
| **S2** rewrite.tsv + 白名单 + capacity | — | — | **1.3**（0.0 + 0.2 + 1.1） |
| **S1′** 返修：第二次 closeout（修「收口情景取错批」） | 17:01:03.6 | 17:01:12 | **8.4** |
| **S3** 台账 | 17:01:12 | 17:02:15 | **63.0** |
| **S4** 提交 | 17:02:15 | 17:02:16 | **1.0** |
| **收口 S0–S4** | 17:00:52 | 17:02:16 | **84.0**（3.0 + 7.3 + 1.3 + 8.4 + 63.0 + 1.0） |
| **批墙钟** | 16:59:20 | 17:02:16 | **176.0**（92.0 + 84.0） |

**`[1b 校验]` / `[1c allowed]` 原文**：

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
[1b 校验] batch=b385 pre=b384 weak=d:/code/_annot_baseline/b385-repo-post.txt weak_rows=3536 plan=20 head_added=20
```

## 5. 点估计（主报）

```
[窗口] b385 / b383 / b382（b381、b384 标事故，中位与包络同时剔除）
[点估计] 1.09h = 25批 × 61.4 + 299行 × 3.45 + 25批 × 53.6s → 3906.6s
[点估计] 1.30h（收口维持 b385 的 84.0s）→ 4666.6s
[点估计] 0.93h（收口回到窗口最低 b383 的 31.0s）→ 3341.6s
[观测包络] 0.67–1.22h（同窗口 min 96s / max 176s；参考，不进主报）
[表外差集] 新增 0 / 移除 0（b384 → b385，ZC-deep-b385-outside-diff.tsv）
```

- **主报 = `1.09h`**（收口中位 53.6s）；收口维持本批 `84.0s` 则 `1.30h`，回到 `31.0s` 则 `0.93h`。
  两端差 `0.37h`，**全部由收口造成**——这就是「唯一剩余杠杆」的量化说法。
- 收口中位与包络取自**同一窗口** `b385 / b383 / b382`；b381（40s 顺序错）与 b384（解析返修）都带
  `ACCIDENT_TIMING`，中位与包络两处同时剔除，没有选择性剔除。
- 形状：`25 批 × 10 文件、每批约 12 行`；出现 5 文件批时须重述模型适用性。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `3623176e` | `+20/−20` |
| rewrite.tsv + 本台账 + 白名单 685 行 | `c3061480` | — |
| outside-diff.tsv + b386 口径修正（事故标记 / 窗口 / 分段） | `7d8866d3` | — |
