# b400 · cap 20 收官批（19 文件 / 19 行，`plan=19`，池内归零）

> 提交：`685509c4`（代码 19 行 / 19 文件，+19/−19）
> 批前基准：`b399-repo-post.txt`（`pre_done=7402 prev_done=7,402 → OK`）
> 批后快照：`b400-repo-post.txt`（收口时刻全仓扫描）

## 0. 一页纸

**主数（含 `S5` 估算，覆盖 51 批）：`4.64h`** = `6,276.0 + 7,239.5 + 619.1 + 2,580.0 = 16,714.6s`
- `S5` 实测只有 **8 批**（b393–b400）共 `619.1s`；其余 **43 批**按 8 批实测中位 `60.0` 补 `2,580.0s`。
- **副数（全实测可见，S5 仅 8 批）：`3.93h`** = `6,276.0 + 7,239.5 + 619.1 = 14,134.6s`。
- `619.1 ÷ 60.0 ≈ 10.3` 只是比值直觉，不能当作批数：台账里 `S5` 数值只有 8 个，缺口 **43 批**。

`CLOSEOUT_BATCH: true`——本批含终表与总账，**不进建模窗口**；实测值保留，样本资格取消。

- **池内完成**：`7,421 / 7,421`（100%）。
- **全仓残留**：**`3,232` 行**（收口时刻实测 `3,232 − 0`）；**扫描归类量，不等于上游债余额**。
- **未清 8 条**：均为口径边界/工具近似（可清零 0、接受 8；见 §6 与 CLOSING §6）。
- **两种「小时」不混用**：`0.10h / 0.30h / 1.29h` 是「剩余批次」预估，`3.93h / 4.64h` 是「已完成 51 批」实测累计；前者已随剩余=0 失效。
- **A 段边界**：`b1–b349` **不计入、不外推**；本数不是全项目 400 批总耗时。

## 0.1 三列、`*_runs` 与 cap 20

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset` missing=0 extra=0） | **首轮 1 → 修后 0** |

- lint 首轮 1 条：`hooksStore.ts:337` 的「该条」命中禁用词；改「命中项」后过。
- **`record_runs=2`、`verify_runs=2`**：commit 首轮把 `Navigation.tsx:308` 判 `W 单行无信息`（仅 `lg` 两字符，无标识符锚点），
  补 `SettingsNavigation` 后重跑；额外约 `30.0s`，已计入 `controllable`。

| 判据 | 阈值/公式 | b397 | b398 | b399 | b400 |
| --- | --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | 0 | 0 | 0 | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 20 = 20 | 20 = 20 | 20 = 20 | **20 − 1 = 19** |
| `controllable` | **≤ 173.25（已封顶，不再换代）** | 128.0 | 102.0 | 167.0 | **126.0** |

- `selfclear_batch=1` 是 `savedWorkflowArgsForm.ts:60` 的 `adjacent` 自动自清；`removed=20` 含这一行，故 `20 − 1 = 19`。
- 首轮干净率 **8/10**；cap 20 收官，阈值固定 `173.25`。

## 1. 逐文件（批前 → 批后）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/ui/src/settings/model-provider-section/ModelConfigHelp.tsx` | 1 | 0 |
| `packages/ui/src/settings/model-provider-section/Navigation.tsx` | 1 | 0 |
| `packages/ui/src/settings/model-provider-section/ProviderFamilyModeHeader.tsx` | 1 | 0 |
| `packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts` | 1 | 0 |
| `packages/ui/src/settings/ModelProviderSection.tsx` | 1 | 0 |
| `packages/ui/src/settings/PluginStorePage.tsx` | 2 | 1 |
| `packages/ui/src/settings/saved-workflows/savedWorkflowArgsForm.ts` | 3 | 1 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowCard.tsx` | 1 | 0 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowDetailView.tsx` | 2 | 1 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowGlobalGroup.tsx` | 2 | 1 |
| `packages/ui/src/settings/settingsPageConfig.ts` | 1 | 0 |
| `packages/ui/src/settings/SkillsSection.tsx` | 1 | 0 |
| `packages/ui/src/store/hooksStore.ts` | 1 | 0 |
| `packages/ui/src/store/mcpStore.ts` | 2 | 1 |
| `packages/ui/src/store/pluginManagementStoreLoading.ts` | 1 | 0 |
| `packages/ui/src/store/whiteboardStore.ts` | 1 | 0 |
| `packages/ui/src/store/zcodeSessionStoreTaskSlice.ts` | 1 | 0 |
| `packages/zcode-server-cli/src/runtime/componentCache.ts` | 1 | 0 |
| `packages/zcode-server-cli/src/runtime/updateCommand.ts` | 1 | 0 |

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **19** | **14** | **14** | **0** | **0** |

- `全仓清零 14 = 表内 +6 + 表外 +8`：`CLEARED 231 → 237`、表外 `8 → 0`。
- **表外差集**：新增 **0** / 移除 **8**，8 行全 `annotation`。
- **池外残差触发异常报告**：`3,252 − 19 = 3,233`，实测 **`3,232`**，差 `1` 来自 `savedWorkflowArgsForm.ts:60` 的相邻自清；
  这是本期唯一一次非计划行进出，已在此解释。

## 2. 六闸原文（同一次跑）

```
gate: PASS scope n=0 plan=19 allow=0 diff_old=19 diff_new=19 out_of_scope_edits=0 plan_lines_covered=19/19
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=2
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=2 verify_ok=true
gate: PASS commit n=0 sha=685509c4 files=19/19 numstat=19/19 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=1 allowed=38 auto_self_clear=1
gate: PASS order n=0 elapsed_since_start=353.0s controllable=126.0s
GATE ALL PASS batch=b400 sha=685509c4
```

- `allowed = 19 计划 + 18 已登记 + 1 自动 = 38`（三项分列）。
- `elapsed_since_start=353.0s` 含一次 commit 返工与装箱等待；`controllable=126.0s`。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **0**（done 7,421 / 7,421 = **100%**） |
| 池内文件 | **0**（done 1,007 / 1,007 = 100%） |
| 全仓 weak | **3,232 行 / 1,283 文件**（收口时刻实测） |
| 集合 | `1,283 = ACTIVE 1,283 + 表外 0`（定义恒等，非校验） |
| 表内 | `1,520 = ACTIVE 1,283 + CLEARED 237`（定义恒等，非校验） |

- `ALIGNED OK`：`acct_remain 0 == pool_remain 0`。

## 4. 计时（`*_runs` 固定字段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `controllable` | `--start`（21:01:41.9） | 批次提交（21:03:47） | **126.0**（含 commit 返工 ≈30.0） |
| **S0** 收口准备（全量 closeout 11s） | 21:03:47 | 21:04:25.3 | **38.3** |
| **S1** 失败诊断 | — | — | **0.0** |
| **S2** 人工登记 + 二段闸 | — | — | **0.0** |
| **S3a** 台账写盘 | 21:04:25.3 | 21:04:49.3 | **24.0** |
| **S3b** CLOSING + INDEX 收口 | 21:04:49.3 | 21:11:57.6 | **428.3** |
| **S4** 提交（收口文档） | 21:11:57.6 | 21:12:11.5 | **13.9** |
| **收口 S0–S4** | 21:03:47 | 21:12:11.5 | **504.5** |
| **批墙钟** | 21:01:41.9 | 21:12:11.5 | **629.6** |
| **S5_closeout** 实测 | 21:12:11.5 | 21:13:47.9 | **96.4** |

TOOL_TRIP: 0.0（commit 返工在批次内，已计入 `controllable`）
S5_PER_BATCH: 60.0（**8 批实测中位**：160.0/57.0/45.7/58.0/84.0/56.0/62.0/96.4）

- **`record_runs=2`**：commit 首轮 `Navigation.tsx:308` 被 `judge` 判 `W`，补标识符后重跑，约 `30.0s`；`verify` 闸复用该计数，工具不产独立 `verify_runs`。
- **`S5_closeout` 预登记失效（不是「低于下界」）**：`S3b 428.3 + S5 96.4 = 524.7s`，超上界 `220.0s` 达 **138%**。
  触发原因：终表与 CLOSING 收口前置到 `S3b`、一次 `S5` 订正（`62.1 → 96.4`）、三个提交（收口文档 `d4ad2c79`、回填 `e5425c57`、订正 `5f07d9e4`）。
  只写「实测 96.4、低于预登记」会被读成比预期便宜，实际合计贵了一倍多，已改按合计口径记账。

## 5. 实测总计（主数）与模型值降级

**主数（含 `S5` 估算）：`4.64h`** = `6,276.0 + 7,239.5 + 619.1 + 2,580.0 = 16,714.6s`
**副数（全实测可见）：`3.93h`** = `6,276.0 + 7,239.5 + 619.1 = 14,134.6s`

| 项 | 秒 | 覆盖 | 说明 |
| --- | ---: | --- | --- |
| `controllable` | **6,276.0** | 51 批 | `gate: PASS order` 实测；b367 取 `157.0`（不是 `s/行 6.04`） |
| 收口 | **7,239.5** | 51 批 | 42 批实测 `6,202.5` + 9 批（b374–382）导出 `1,037.0`（端点各 `±0.5s`，合计 `±4.5s = 0.4%`） |
| `S5` 实测 | **619.1** | **8 批** | b393–b400；含 b400 的 `96.4` |
| `S5` 估算 | **2,580.0** | 43 批 | `43 × 60.0`，8 批实测中位 |
| **含估算合计** | **16,714.6** | 51 批 | **`4.64h`（主数）** |
| 全实测可见 | **14,134.6** | S5 仅 8 批 | **`3.93h`（副数）** |

- **`S5` 批数订正**：`619.1 ÷ 60.0 ≈ 10.3` 不成立为批数；实测 `S5` 只有 8 个数（b393–b400），缺 43 批按中位 `60.0` 补。
- **误差注脚**：`1,037.0s` 由 9 组 `±0.5s` 端点相减得到，误差 `±4.5s`（`0.4%`），对 `16,714.6s` 影响 `0.03%`。
- **覆盖边界**：A 段（b1–b349）无统一计时字段，**不计入、不外推**；本数不是全项目 400 批总耗时。
- **两种「小时」**：`0.10h / 0.30h / 1.29h` 是剩余批次预估，已被 `3.93h / 4.64h`（已完成累计）取代，不可相减比较。
- **`S5_closeout` 预登记失效**：合计 `524.7s`、超上界 `220.0s` 达 **138%**，详见 §4。

## 6. GATE-DEBT 最终结论

- 8 条全部「接受」，0 条转交，0 条清零；理由见 CLOSING §6（逐条 id）。本批未新增。
