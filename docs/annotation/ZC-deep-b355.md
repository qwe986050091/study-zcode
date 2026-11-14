# ZC-deep-b355

> 批次：b355 ｜ **34 行 / 6 文件** ｜ 提交 `5dac0cb4`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`、`preflight.mjs`

## 0. 窗口收口批（方案 ① 第一个 5 批窗口的第 3 批）

- `TALLY {"ownIn":34,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":34,"planOut":0}` / `plan=34` / `files=6/6`。
- 选行来自全量重算后的 `PLAN#1`（6 文件 / 34 行，`writable=34`）。
- `fix=0/0/0s`（`judge` 首跑 `hits=0`，`record_runs=1`）。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/store/commandsStore.ts` | 6 | 6 | 0 | ui/store |
| `packages/ui/src/store/zcodeSessionStoreSelectors.ts` | 6 | 6 | 0 | ui/store |
| `packages/ui/src/TaskListItemContextMenu.tsx` | 6 | 6 | 0 | ui |
| `packages/ui/src/WorkspaceSidebarFooter.tsx` | 6 | 6 | 0 | ui |
| `packages/desktop/src/host/taskRealtimeBridge.ts` | 5 | 5 | 0 | desktop/host |
| `packages/desktop/tsup.config.ts` | 5 | 5 | 0 | desktop |
| **合计** | **34** | **34** | **0** | — |

- **目录分布**：**2 个顶层目录**（`packages/ui` 4、`packages/desktop` 2），在 ≤4 内；两组各自同域。

## 2. 改动内容

- `commandsStore.ts`：模块职责指向 `commandsStore`；`commands` 引用即渲染依据；`listKey` 的唯一构造点；
  写回前调 `currentListKey(get)`；`inflightLists` 复用同一 promise；`loadedWorkspacePath` 与 `commands` 同批落定。
- `zcodeSessionStoreSelectors.ts`：`resolveWorkspaceStateKey` 只 trim；`collectIdentityTaskIds` 的两处判等；
  种子迁移的三条边界；`updateWorkspaceState` 先解析键。
- `TaskListItemContextMenu.tsx`：`disabledReason` 由调用方给出；`Item`/`Separator` 注入；可选动作与轨迹入口的条件；
  `disableTaskActions` 整体下传。
- `WorkspaceSidebarFooter.tsx`：职责边界改为「谁持有、谁执行」；`profileContent` 的只读复用；
  `onDesktopZoomLevelChanged` 可缺失与 `dispose?.()`；清理顺序与同步性。
- `taskRealtimeBridge.ts`：返回 `null` 时跳过注册；`seenEventIds` 命中即返回；
  `while` 按 `seenEventLimit` 淘汰并同步删索引；`dispose` 的幂等入口。
- `tsup.config.ts`：`copyGenUiRuntimeAssets` 只在 `onSuccess` 用；`createBuildTimeConfigDefines` 的常量注入；
  `KEY=VALUE` 解析；覆盖率构建的例外；`ZCODE_ENV` 与 `buildMetadata` 的来源。

## 3. 六闸

```
gate: PASS scope n=0 plan=34 allow=0 diff_old=34 diff_new=34 out_of_scope_edits=0 plan_lines_covered=34/34
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=5dac0cb4 files=6/6 numstat=34/34 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=34 added=0 allowed=44 auto_self_clear=0
gate: PASS order n=0 total=125.0s controllable=122.0s
```

## 4. 窗口收口：全量重算与三批对账

- **白名单重生成**：560 行（`15c011a5…`）。
- **产能重算**：`REMAIN 480 files / 1,046 lines`，`PLAN 80 批 / 6.0 文件 / 13.1 行`。
- **`ALIGNED acct_remain=1,046 pool_remain=1,046 diff=0` / `ASSERT PASS`**。
- **三批对账**（窗口起点 `post-b352 = 1,145`）：

  | 批 | 实写 | 池内自清 | done 增量 | 全仓 weak | 池内 remain |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | b353 | 35 | 0 | 35 | −35 | 1,145 → 1,110 |
  | b354 | 30 | 0（1 行自清属**池外**，不进 done） | 30 | −31 | 1,110 → 1,080 |
  | b355 | 34 | 0 | 34 | −34 | 1,080 → **1,046** |

  三批 `done 增量` 合计 99，`1,145 − 99 = 1,046`，与 `ALIGNED` 一致；`全仓 weak` 合计 −100，多出的 1 行即 b354 的池外自清。

- **结论**：窗口内的增量记账在 b354 多算了 1 行，根因是**池外自清**（`toolbarShortcuts.ts:218`）；
  全量重算判定 `diff=0`，已按 §6.2 第 13 条订正 `done 6,341 / remain 1,080`。
  b353、b355 的增量与全量完全一致。
- 差 1 行既不是「不可写行」也不是「漏改」，是**记账口径**（`removed` 含池外自清）。

## 5. 自清

- 本批 `auto_self_clear=0`；累计仍 **10 行 / 10 文件**（自动 5、人工 5），距阈值 20 行差 10。

## 6. 池外与进度

- 全仓 weak：`4,321 → 4,287`（**−34**），文件 `1,683 → 1,677`。
- **句子级**：`done 6,375 / remain 1,046`，`6,375 + 1,046 = 7,421`，**85.9%**。
- **逐行**：`remain ≈ 1,046 + 1,046 = 2,092`，`done ≈ 5,329 / 7,421`，约 **71.8%**。
- 池外：`4,287 − 1,046 = 3,241`。

## 7. 计时（B 段第 6 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `068d3ec7`） | 批次提交 `5dac0cb4` | 125.0s | 3.68s |
| `controllable` | `--start`（11:25:56） | 批次提交（11:27:58） | 122.0s | 3.59s |
| 起草段 | `b355-files.txt`（11:25:42） | `--start` | 14s | — |
| 收口段 | 批次提交（11:27:58） | 台账提交（11:28:58） | **60s** | — |
| `批墙钟` | 最早产物（11:25:42） | 台账提交 `7d2ab5da`（11:28:58） | 196s | 5.76s |

- 本批是**窗口收口**，收口段含全量重算（白名单 0.2s + 产能 1s 记账/23s 规划 + 快照 8.1s + 对账写作），
  属 §6.2 第 14 条的「收口样本」，**与 b353/b354 的普通收口不混算**。
- 监控：收口 60s（阈值 150s）、可控 3.59 s/行（阈值 8），均未触发。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（窗口收口前，558 行） | `068d3ec7` | 2 文件 |
| 批次本体（6 文件 1→1 改写） | `5dac0cb4` | `+34/−34` |
| `ZC-deep-b355-rewrite.tsv` + 白名单 560 行 + 本台账 + INDEX | `7d2ab5da` | — |
