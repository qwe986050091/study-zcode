# b394 · cap 20 试验第 4 批（20 文件 / 20 行，首轮全绿）

> 提交：`a435f661`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b393-repo-post.txt`；批后快照：`b394-repo-post.txt`
> 口径：`CLOSING.md` §5 / `_tools/INDEX.md` §5.3 与 §6.2

## 0. 三列

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset-assert` missing=0 extra=0） | **首轮 3 → 修后 0** |

- lint 首轮 3 条：2 条分隔符 `≥2`（feishuGroupMessages / feedbackService）、1 条禁用词「据此」（projectMemoryStableRead）。
  改法是换冒号、拆并列、换同义——**只改脚本里的草稿文本再重跑，没有改动已落盘文件**，属本地规则返修。

## 0.1 cap 20 第四批：首轮全绿

| 判据 | 阈值/公式 | b391 | b392 | b393 | b394 |
| --- | --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | 0 | **3** | 0 | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 20 = 20 | 23 − 3 = 20 | 20 − 0 = 20 | **20 − 0 = 20** |
| `controllable` | **≤ 1.5 × 窗口中位** | 105.1 | 150.0 | 118.0 | **121.0** |

- 阈值在 b394 换代：`195.6s`（`1.5 × (61.4 + 20×3.45)`，用待检验模型自设标尺）作废，
  改 `1.5 × 窗口内 controllable 中位`。本批窗口 `b394/b393/b392` 的 controllable 为 `121.0 / 118.0 / 150.0`，中位 `121.0` → 阈值 `181.5s`。
- **首轮干净率 3/4**（b391 ✔ / b392 `n=3` / b393 ✔ / b394 ✔）。仍**不写「cap 20 立住」**，
  按规则要连续两批首轮干净才改口径；b394 是新的第一连，b395 再干净才可升级为「稳定」。

## 1. 逐文件（批前 weak → 批后 weak，合计 20 → 0）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/services/src/bots/providers/feishuGroupMessages.ts` | 1 | 0 |
| `packages/services/src/bots/topicResource.ts` | 1 | 0 |
| `packages/services/src/commands/commandFileParser.ts` | 1 | 0 |
| `packages/services/src/conversation-share/conversationShareInlineImages.ts` | 1 | 0 |
| `packages/services/src/feedback/feedbackService.ts` | 1 | 0 |
| `packages/services/src/git/gitCommitMessageGenerator.ts` | 1 | 0 |
| `packages/services/src/highspeed/highspeedMockTransport.ts` | 1 | 0 |
| `packages/services/src/index.ts` | 1 | 0 |
| `packages/services/src/marketing-touch/marketingTouchService.ts` | 1 | 0 |
| `packages/services/src/memory/projectMemoryStableRead.ts` | 1 | 0 |
| `packages/services/src/model-provider/accountProviderTeamPlanRequestKey.ts` | 1 | 0 |
| `packages/services/src/oauth/oauthProviderLogout.ts` | 1 | 0 |
| `packages/services/src/plugin-sync/pluginSyncService.ts` | 1 | 0 |
| `packages/services/src/process/processResourceSampler.ts` | 1 | 0 |
| `packages/services/src/project-storage/project-repository.ts` | 1 | 0 |
| `packages/services/src/project-workspace-navigation/index.ts` | 1 | 0 |
| `packages/services/src/providers/api/nodeApiClient.ts` | 2 | 1 |
| `packages/services/src/providers/codexConfigToml.ts` | 1 | 0 |
| `packages/services/src/providers/zaiBusinessTokenResolver.ts` | 1 | 0 |
| `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts` | 1 | 0 |

固定对账三列（含清零口径拆分）：

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **19** | **19** | **0** | **0** |

- **交叉核对**：`全仓清零 19 = 表内 +9 + 表外 +10`。`CLEARED 184 → 193`，表外 `63 → 53`。
  `nodeApiClient.ts` 批前 2 行、本批只改 `469`，`404` 仍是上游行（`own out`），所以 20 个文件里只有 19 个整文件清零。
- **表外差集**（`ZC-deep-b394-outside-diff.tsv`）：新增 **0** / 移除 **10**，10 行 `cause` 全为 `annotation`；`mixed` 仍未观测到。
- **池外残留本批不动**：`3,233 → 3,233`（本批无「无计划行的块尾 `*/` 位移」）。

## 2. 六闸原文（同一次跑，无二段）

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=a435f661 files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 total=490.0s controllable=121.0s
GATE ALL PASS batch=b394 sha=a435f661
```

- 收口侧判据：`[cap 判据] removed=20 − selfclear_batch=0 = 20，plan.tsv=20 → OK`。
- `allowed = 20 计划 + 18 已登记 + 0 自动 = 38`。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **119**（done 7,302 / 7,421 = **98.4%**） |
| 池内文件 | **119**（done 888 / 1,007 = 88.2%），辅助 |
| 全仓 weak | **3,352 行 / 1,380 文件** |
| 池外残留 | **3,233 行**（3,352 − 119，本批未动） |
| 集合 | `1,380 = ACTIVE 1,327 + 表外 53`（定义恒等，不作校验） |
| 表内 | `1,520 = ACTIVE 1,327 + CLEARED 193`（**定义恒等，非校验**：CLEARED = 1,520 − 扫描命中） |

- `ALIGNED OK`：`acct_remain 119 == pool_remain 119`。
- 剩余形状 **119 文件 × 1 行**，cap 20 下 `ceil(119 / 20) = 6` 批。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `ba39c654` 之后批间 | `a435f661`（20:00:30） | 待回填 |
| `controllable` | `--start`（19:58:29.2） | 批次提交（20:00:30） | **121.0** |
| **S0** 收口准备 | 20:00:30 | 20:00:52 | **22.0**（扫描 7.7 + own-commits 0.2 + capacity 1.2 + 其他 12.9） |
| **S1** 失败诊断 | — | — | **0.0**（首轮全绿） |
| **S2** 人工登记 + 第二段六闸 | — | — | **0.0**（`selfclear_batch=0`） |
| **S3a** 台账与快照 | 20:00:52 | 20:01:34 | **42.0**（两条工具调用边界，±5s） |
| **S3b** CLOSING + INDEX 填数 + 计时回填 | 20:01:34 | 20:02:04.1 | **30.0**（同上） |
| **S4** 提交（数据行，`b2f7706f`） | 20:02:04.1 | 20:02:08.0 | **4.0** |
| **收口 S0–S4（分段和）** | 20:00:30 | 20:02:08.0 | **98.0**（22.0 + 0 + 0 + 42.0 + 30.0 + 4.0） |
| **批墙钟（实测端点）** | 19:58:29.2 | 20:02:08.0 | **218.8** |
| **S5** 回填（§4/§5/CLOSING/INDEX 修正 + 回填提交） | 20:02:08.0 | 20:03:05 | **57.0**（**收口外**；含提交本身约 3s，±5s） |

TOOL_TRIP: 0.0（本批没有重复执行：lint 首轮 3 条只改草稿脚本，未落盘返工；白名单在文档提交后重建一次，已计入 S5）
S5_PER_BATCH: 57.0
- 净收口 = 收口；净墙钟 = 实测墙钟。

## 5. 主报

- 剩余 119 行 / 119 文件 → cap 20 下 `6` 批。
- 窗口 `b394 / b393 / b392`，净收口 `98.0 / 287.0 / 244.0`，中位 **`244.0s`**（b394 的 `98.0` 最低，不影响中位）。
- **主报 `0.62h`**：`6 × 61.4 + 119 × 3.45 + 6 × 244.0 = 368.4 + 410.55 + 1464.0 = 2242.95s`；区间 `0.45–0.74h`。
- 参考档（不进主报）：收口维持 `98.0s` → `0.38h`；观测包络 `0.36–0.67h`（净墙钟 `218.8 / 404.8 / 393.1`）。
- 上一批主报 `0.73h` 随窗口滚动与批数 `7 → 6`、剩余行 `139 → 119` 更新为 `0.62h`；**不是口径变更**，是同一公式的输入变化。
- 本批**无口径变更**：只按新流程跑（`TOOL_TRIP` / `S5` / 新阈值均为 b394 事前定稿，本批只是执行）。
- 收口顺序沿用 b393 台账 §5.5 的 13 步；本批首次把第 13 步记为 `S5`。
