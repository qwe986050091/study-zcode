# ZC-deep-b373

> 批次：b373 ｜ **39 行 / 10 文件** ｜ 提交 `a0f2b891`

## 0. 普通批；`fix=2`；`hit_rate=5.1%`；`auto_self_clear=1`

- `plan_lines_covered=39/39`；`removed=40 added=0`（**39 计划行 + 1 条 `AUTO-SELF-CLEAR`**）。
- 首轮 **2 行命中**：`2 ÷ 39 = **5.1%**`。
  - `slashCommandHelpers.ts:111`：`L 无信息列举` —— 反引号里的正则 `/^\/+/, ""` **自带逗号，被算作分隔符**，`seps=2`。
    改成 `replace` 配 `/^\/+/` 后过。
  - `RemoteMcpSyncDialog.tsx:151`：`L 无信息列举` —— 「只读入参、无副作用，不复制…」顿号 + 逗号 = 2 处分隔。
    改成「只读入参且不复制 …，无副作用」后过。
- **新口径发现（写进 §5.3 第 3 条的补充位，台账只记录）**：分隔符统计**穿透反引号**，
  代码片段里的 `,` / `，` / `、` 照样计入 `seps`——带参函数调用写进注释会意外触发 L。
- `AUTO-SELF-CLEAR packages/ui/src/side-pane-full-view/model.ts:131 reason=adjacent`：
  131 行是 JSDoc 续行（` * 从这个角缩放…`），因 132 行改写后整句转强，属闸自动登记的池外自清，
  **不需手工登记**（与 b367 的 `startup-marks.ts:37` 不同：那条 `reason=` 是 `out-of-pool`）。

## 1. 选行与目录分布

| 文件 | 本批 | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/settings/PluginStoreSourcesDialog.tsx` | 4 | 0 |
| `packages/ui/src/settings/RemoteMcpSyncDialog.tsx` | 4 | 0 |
| `packages/ui/src/side-pane-full-view/model.ts` | 4（+1 自清） | 0 |
| `packages/ui/src/slashCommandHelpers.ts` | 4 | 0 |
| `packages/ui/src/v4/ConversationDraftSuggestedPromptsContainer.tsx` | 4 | 0 |
| `packages/ui/src/v4/ConversationFileSummaryPanel.tsx` | 4 | 0 |
| `packages/ui/src/v4/pendingCommandRegistry.ts` | 4 | 0 |
| `packages/ui/src/v4/SessionPane.tsx` | 4 | 0 |
| `packages/ui/src/v4/telemetry/conversationTelemetryParityE2E.ts` | 4 | 0 |
| `apps/zcode-cli/packages/cli/src/command-center/handlers/plugins.ts` | 3 | 0 |
| **合计** | **39** | **0** |

- 10 个文件全部清零；顶层目录 **2 个**（packages / apps），是本段第一次跨到 `apps/`。
- 全仓 weak 文件 `1,584 → 1,577`（−7）。

## 2. 改动内容

- `PluginStoreSourcesDialog.tsx`：`isPublicStoreMarketplaceId` / `DEFAULT_MARKETPLACE_ID` 不可移除；
  弹窗只列 `marketplaces`；`sortMarketplaceSources` + `locale`；`formatSourceTime` 走 `toLocaleString()`。
- `RemoteMcpSyncDialog.tsx`：`resolveDefaultRemoteMcpSyncSelection` 的调用频次；空串 vs `undefined`；
  `buildRemoteMcpSyncImportParams` 无副作用；`complete` 态直接放行关闭。
- `model.ts`：`FLOATING_ANCHORS` 七点契约；`resolveFloatingTransformOrigin`；`DEFAULT_FLOATING_ANCHOR` + `Math.hypot`；
  `seenTurnKey` 基线。
- `slashCommandHelpers.ts`：`normalizeSlashCommandValue` 的丢弃与去斜杠语义；`replace` + `/^\/+/`；
  `selection.isCollapsed()`。
- `ConversationDraftSuggestedPromptsContainer.tsx`：`onboardingRecordService?.` 可选链；`requestVersionRef`；
  `activeOperationRef` 接管；`flow.stage` 落地后才确认。
- `ConversationFileSummaryPanel.tsx`：`context.onOpenCodeViewer` 可缺失；`setDialogOpen(true)` 先于预检；
  `Collapsible` + Fragment；`item.patches` / `onOpenCodeViewer` 决定审阅入口。
- `pendingCommandRegistry.ts`：`this.now()` 只读一次；`rejectCommand` 顺序；`load()` 不发请求；
  `expiresAt <= now` 且不持草稿。
- `SessionPane.tsx`：`pendingShareRowIds` 的排除源回退；`onSendWorkflowSaveRequest` 不含芯片；
  `markDraftProviderNotReady()`；`shareSelectionPanelVisible` 禁确认。
- `conversationTelemetryParityE2E.ts`：`compareScenarioResults`；`operationCount` 字段名即口径；
  `caseId` / `stateAssertions` 缺失即破坏；内层跑完 `operations`。
- `plugins.ts`：按 `id` 排序；`command` 现算 toggle；`keywords` 覆盖展示字段。

## 3. 六闸

```
gate: PASS scope n=0 plan=39 allow=0 diff_old=39 diff_new=39 out_of_scope_edits=0 plan_lines_covered=39/39
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=a0f2b891 files=10/10 numstat=39/39 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
AUTO-SELF-CLEAR packages/ui/src/side-pane-full-view/model.ts:131 reason=adjacent
gate: PASS pool-diff n=0 removed=40 added=0 allowed=51 auto_self_clear=1
gate: PASS order n=0 total=401.0s controllable=124.0s
GATE ALL PASS batch=b373 sha=a0f2b891
```

## 4. 自清

- `auto_self_clear=1`（`model.ts:131`，`reason=adjacent`，闸自动登记）；`POOL-SELF-CLEAR.tsv` 数据行仍 **11 行**。

## 5. 进度

- 全仓 weak：**3,863 → 3,823**（−40，含 1 条自清）；filler 113 → 107；weak 文件 **1,584 → 1,577**（−7）。
- 池内：**584 行 / 364 文件**（`ALIGNED diff=0`、`ASSERT PASS`）。
- `done 6,837 / remain 584`；`6,837 + 584 = 7,421`。
- **行侧进度 92.1%**（6,837 ÷ 7,421）——唯一进度分母；文件侧 `643 ÷ 1,007 = 63.9%`（辅助）。
- 可清到零文件 **57**（64 − 7）；含不可写残留 **1,520** 未变。
- `PARTIAL` 3 个文件仍有池内 weak（`cuaDetails.tsx` 23→1、`script-workflow-process.ts` 13→1、
  `CoveragePanel.tsx` 13→2），已按剩余行回池排期——**它们不是「已清」，是「还剩几行」**。
- 剩余批数（cap 10）：**37 批**（364 文件 ÷ 10），需重跑装箱确认 `min/avg/max`。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `57844662` | `a0f2b891`（14:06:53） | 401.0s | 10.28s |
| `controllable` | `--start`（14:04:49） | 批次提交（14:06:53） | 124.0s | **3.18s** |
| 收口段 | 14:06:53 | 台账提交 `7b91e523`（14:07:40） | **47s** | — |
| `批墙钟` | 14:04:49 | 台账提交（14:07:40） | 171.0s | 4.38s |

- `s/行 = 3.18`，是本段最低；与 b372 的 4.20 同档下降，仍不外推（n=2）。
- **收口 47s，未触发三批规则**（b371 416s → b372 332s → b373 **47s**）。
  本轮唯一改动是 **INDEX 增量延后到每 3 批一次**，收口窗口里只剩：批后扫描 → 白名单 → 容量 → 写台账 → 提交。
- **对 b372「扫描 95s」的订正**：这一整组命令（扫描 + `own-commits-gen` + `capacity` + 写台账 + 提交）
  全部落在 **47s** 内，说明 `deep-quality` 全仓扫描远低于 95s（约 25–30s）。
  即 b372 的 332s **主要来自写作轮次，不是工具**；那条分解里的「其它 37s」应重读为写作隐性开销。
- 对时长模型的意义：**只记为 1 个观测点，不改结论**（§5.3 第 6 条「一个巧合不许升格成规律」）。
  主报维持 **2.6–4.5h**；滚动中位窗口 b371–b373 读 **4.2–5.1h**；
  **连续三批收口 ≤60s 才下修到 1.2–1.5h**，判定点在 b375（窗口 b373–b375）。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `a0f2b891` | `+39/−39`（+1 自清行） |
| `ZC-deep-b373-rewrite.tsv` + 本台账 + 白名单（636 行） | `7b91e523` | — |
