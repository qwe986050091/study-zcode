# ZC-deep-b354

> 批次：b354 ｜ **30 行 / 6 文件** ｜ 提交 `9059b7ad`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`、`preflight.mjs`

## 0. 方案 ① 第二执行批 + 判据返修 2 轮

- commit 不快照，`preflight --whitelist` 判 `STALE-OK docs-only`；产能沿用上次（83 批），下次重算 **b355**。
- `TALLY {"ownIn":30,"upIn":3,"ownOut":0,"pending":0,"planIn":30,"planOut":0}` / `plan=30` / `files=6/6`。
- **`fix=2/2`**：`judge` 首跑 `hits=2`（均为 L 无信息列举），回改 2 行后复判 `hits=0`；`record_runs=3`。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/GitBranchSwitcher.tsx` | 5 | 5 | 1（上游） | ui |
| `packages/ui/src/OpenSplitButton.tsx` | 5 | 5 | 1（上游） | ui |
| `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx` | 5 | 5 | 1（上游） | ui/settings/model-provider-section |
| `packages/ui/src/v4/composer/toolbarShortcuts.ts` | 5 | 5 | 0 | ui/v4/composer |
| `packages/services/src/bots/commandParser.ts` | 5 | 5 | 0 | services/bots |
| `packages/services/src/bots/workspaceHelpers.ts` | 5 | 5 | 0 | services/bots |
| **合计** | **30** | **30** | **3** | — |

- **目录分布**：**2 个顶层目录**（`packages/ui` 4、`packages/services` 2），在 ≤4 内；services 两文件同域。

## 2. 改动内容

- `GitBranchSwitcher.tsx`：`branchSearchFilter` 只做 0/1 判定；当前分支滚动条件；三个弹层的挂载条件；
  焦点归还的前置开关；创建弹层不复用 `Command` 内输入的理由。
- `OpenSplitButton.tsx`：`matchedOpenContext` 的推导来源；`getInstalledEditors` 只用 `target.path`；
  `await` 后按请求号丢弃过期结果；`renderContextActions` 只承载补充动作。
- `InlineEditableProviderCard.tsx`：草稿与保存事务在本组件闭环；`shouldApplyProviderSaveCompletion` 只决定提示；
  `handleModelCommit` 先定位 `originalModelId`；`handleDeleteModel` 只处理个人模型；`model.builtin` 直接跳过。
- `toolbarShortcuts.ts`：`getNextConfigSelectValue` 的回落规则；`hasAnyOption` 短路；
  `candidate.disabled` 跳过；录制态判断必须在 `handleWindowKeydown` 第一行。
- `commandParser.ts`：`slice(1)` 去斜杠；`leave` → `topic.leave`；`cancel` → `selection.cancel`；
  `reconnect`；`stop`——四类命令的双语映射与去向。
- `workspaceHelpers.ts`：`isAllWorkspacesAllowed` 的两种「全部」；`normalizeAllowedWorkspaces` 的 trim/filter；
  `isWorkspaceAllowed` 复用同一口径；`value` 可选链 trim；`workspace.id` 全等优先。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=3
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=3 verify_ok=true
gate: PASS commit n=0 sha=9059b7ad files=6/6 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=31 added=0 allowed=40 auto_self_clear=1
gate: PASS order n=0 total=206.0s controllable=198.0s
```

## 4. 判据返修（`fix=2/2`）

- 第 1 轮：`GitBranchSwitcher.tsx:224` 与 `:283` 判 L 无信息列举（两处都是「两三逗号 + 无 PREDICATE 词」）。
- 第 2 轮：`:283` 仍 L——`因此` 不在 L 的 PREDICATE 表里，改成 `由 ... 决定挂载` 才过。
  **新口径入册**：L 只认 PREDICATE 表内的词（`由/先/再/返回/必须/不能/…`），`因此/所以` 不算。
- 复判 `hits=0`，`record_runs=3`。

## 5. 自清（**本批触发停批**）

- `pool-diff auto_self_clear=1`：`packages/ui/src/v4/composer/toolbarShortcuts.ts:218`
  （与 219 改写行同一句元，218 行随整句转强）。已按 `auto-out-of-pool reason=adjacent` 登记。
- **累计 10 行 / 10 文件**（自动 5、人工 5），距阈值 20 行差 10；距 2% 阈值（≈22 行）差 12。
- 按 §12.7 规则「`auto_self_clear>0` 立即停批回报」，**b355 不在本批之后继续**，等确认。

## 6. 池外与增量记账

- 全仓 weak：`4,352 → 4,321`（**−31** = 30 改写 + 1 自清），文件 `1,686 → 1,683`（**−3**）。
- **两条独立计数**：`done += 31`（行）、`files -= 3`（清完的文件数）——三个文件各留 1 行上游 weak：
  `GitBranchSwitcher.tsx:345`、`OpenSplitButton.tsx:339`、`InlineEditableProviderCard.tsx:69`，均属 `upIn`，不可写。
- `remain 1,110 → 1,079`；`done 6,311 → 6,342`；`6,342 + 1,079 = 7,421`。
- 批数沿用 **83 批**；b355 做全量重算（白名单 + 产能 + `ALIGNED`）。

## 7. 计时（B 段第 5 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（`3daa96dd`） | 批次提交 `9059b7ad` | 206.0s | 6.87s |
| `controllable` | `--start`（11:15:35） | 批次提交（11:18:53） | 198.0s | 6.60s |
| 起草段 | `b354-files.txt`（11:15:26） | `--start` | 9s | — |
| 收口段 | 批次提交（11:18:53） | 台账提交（11:20:15） | **82s** | — |
| `批墙钟` | 最早产物（11:15:26） | 台账提交 `020ff365`（11:20:15） | 289s | 9.63s |

- **可控段 6.60 s/行 是本段最高**，主因是 2 轮判据返修（3 次 `--record`），不是写作本身。
- **收口 82s 高于 b353 的 45s**：本批多写 §12.7 一条 + 订正 b353「−5」口径 + 自清说明，属内容工作，不是新增固定开销。
- 监控：收口 82s（阈值 150s）、可控 6.60 s/行（阈值 8，**未触发**，但已接近）。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `9059b7ad` | `+30/−30` |
| `ZC-deep-b354-rewrite.tsv` + 本台账 + INDEX（§12.7 / §12.1） | `020ff365` | — |

- 本批无白名单提交（方案 ①，b355 重生成）。
