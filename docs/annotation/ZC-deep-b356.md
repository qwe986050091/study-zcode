# ZC-deep-b356

> 批次：b356 ｜ **30 行 / 6 文件** ｜ 提交 `e5a0c62f`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`、`preflight.mjs`

## 0. 方案 ① 普通批（未重跑产能）

- `TALLY {"ownIn":30,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":30,"planOut":0}` / `plan=30` / `files=6/6`。
- `fix=1/1`：`judge` 首跑 `hits=1`（`previewPaneContent.tsx:373` 单行无信息），改写后复判 `hits=0`，`record_runs=1`。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/previewPaneContent.tsx` | 5 | 5 | 0 | ui |
| `packages/ui/src/v4/composer/modelTriggerDisplay.ts` | 5 | 5 | 0 | ui/v4/composer |
| `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx` | 5 | 5 | 0 | ui/settings/usage-stats |
| `packages/ui/src/hooks/useCodingPlanEntryPlanList.ts` | 5 | 5 | 0 | ui/hooks |
| `packages/ui/src/settings/BrowserSettingsSection.tsx` | 5 | 5 | 0 | ui/settings |
| `packages/ui/src/settings/CodingPlanUpgradeDialogProvider.tsx` | 5 | 5 | 0 | ui/settings |
| **合计** | **30** | **30** | **0** | — |

- **目录分布**：**1 个顶层目录**（`packages/ui`），5 个子域。

## 2. 改动内容

- `previewPaneContent.tsx`：`isSvgPath` 的 toLowerCase；image/pdf 两分支的加载态条件；三段式复用；`loadingInitial && !filePreview`。
- `modelTriggerDisplay.ts`：团队套餐标签分支；`selectedGroup`/`selectedItem` 缺失回落；`fullLabel` 复用同一解析；
  `modelLabel` 为最小可见单元；`providerPrefix` 的显隐归属。
- `CodingPlanUsagePanel.tsx`：空态只返回 `UsageEmptyState`；两张卡的可见性独立判断；趋势容器不取数；
  `subject` 默认 `"model"` 的理由；`grid-cols-3` 的堆叠与不等高。
- `useCodingPlanEntryPlanList.ts`：`credentials`/`subscriptionService` 来源；`missing` 的四类判据逐条写明。
- `BrowserSettingsSection.tsx`：`pending` 驱动图标与 aria；组件只 trim 归一；方法存在性判断；
  `pluginTogglePending` 与数据 pending 解耦；`pluginUnavailable` 的三项合并。
- `CodingPlanUpgradeDialogProvider.tsx`：模块职责；`opening` 单槽位；`funnelContext` 注入 `entryPlanList`；
  `onOpenResult` 指向当前观察者；Provider 外调用直接抛错。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=e5a0c62f files=6/6 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=40 auto_self_clear=0
gate: PASS order n=0 total=233.0s controllable=221.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**，距阈值 20 行差 10。

## 5. 池外与进度

- 全仓 weak：`4,287 → 4,257`（**−30**），文件 `1,677 → 1,671`（**−6**，六个文件全部清完）。
- **两条独立计数**：`done += 30`（实写，池内自清 0）、`files -= 6`。
- **句子级**：`done 6,405 / remain 1,016`，`6,405 + 1,016 = 7,421`，**86.3%**。
- 池外：`4,257 − 1,016 = 3,241`。

## 6. 计时（B 段第 7 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（`2375b58d`） | 批次提交 `e5a0c62f` | 233.0s | 7.77s |
| `controllable` | `--start`（11:30:56） | 批次提交（11:34:37） | 221.0s | **7.37s** |
| 收口段 | 批次提交（11:34:37） | 台账提交（11:35:16） | **39s** | — |
| `批墙钟` | `--start`（11:30:56） | 台账提交 `86421955`（11:35:16） | 260s | 8.67s |

- **可控段 7.37 s/行 是本段最高**，主因不是写作：开批时按 b350 候选表选的 6 文件在现快照里已无 weak 行，
  改从「池内 ∩ weak」重筛候选，多花了约 60s 探测；这批时间**不计入形状成本**，但如实记录。
- 监控：收口 39s（阈值 150s）、可控 7.37 s/行（阈值 8，**未触发**，已贴近）。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `e5a0c62f` | `+30/−30` |
| `ZC-deep-b356-rewrite.tsv` + 本台账 + INDEX | `86421955` | — |
