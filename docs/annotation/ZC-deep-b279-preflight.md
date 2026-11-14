# ZC-deep-b279-preflight：15 文件脏树判定与回滚

> 触发：b279 开工前 `git status --short` 列出 15 个 `M` 文件，numstat `+2,008/−285`，
> mtime 从 `2026-11-10 14:40` 横跨到 `2026-11-11 02:51`，不是任何一批的产物。
> 结论：**15 个文件全部回滚，不提交**；`done` 与 `remain` **都没有被虚高**——
> 盘上多出的 91 行 weak 全部落在池外（`git diff 8f7daaf0..HEAD` 的 `+` 行集合，实测 `inPool=0`），
> 不进 `remain`，也就不进 `done = 7,421 − remain`。受影响范围是 `WEAK` 总数与 `pool-out` 中间项，不是报表两列。

## 1. 判定方法

1. `git diff -U0` 逐行分类：以 `//`、`/*`、`*` 开头记为注释行，其余记代码行（不靠肉眼判断 `+`）。
2. 语义比对：把所有代码行的注释剥掉后取 token，比较删/增两侧的 token 多重集；
   只剩 `,` `(` `)` `;` 差异的是格式化（尾逗号/换行重排），有标识符差异才算代码改动。
3. 重复检测：新增注释正文（≥8 字）是否已存在于 HEAD 同文件，或在新增集合里出现两次以上。
4. `done` 影响：在 HEAD 干净 worktree 与磁盘上分别跑
   `deep-quality.mjs --file-list dirty-files.txt --list-weak`，逐文件比 weak 行，再看 HEAD 的弱行原文是否被改写。

## 2. 逐文件判定

| 文件 | 注释 +/− | 其余行 +/− | 去注释 token 差异 | 重复写入 | HEAD weak → 盘上 weak | 判定 |
| --- | ---: | ---: | --- | --- | ---: | --- |
| `adapters/.../migration-runner.ts` | 87 / 1 | 89 / 21 | 仅 `,` −7（格式化） | 无 | 0 → 27 | 回滚 |
| `adapters/.../sqlite-session-store.ts` | 280 / 2 | 17 / 4 | 仅 `,` −3（格式化） | 无；删 2 条注释（catch 内联、`session_input` 横幅） | 0 → 7 | 回滚 |
| `core/src/context/dynamic-sections.ts` | 38 / 0 | 7 / 2 | 仅 `,` −2（格式化） | 无 | 2 → 3 | 回滚 |
| `core/src/context/sections/skills.ts` | 32 / 3 | 1 / 4 | 仅 `,` +1（格式化） | 无；删 3 行 `// ====` 横幅 | 0 → 2 | 回滚 |
| `core/src/errors/error-payload.ts` | 105 / 0 | 3 / 8 | **等价** | 无 | 0 → 13 | 回滚 |
| `core/src/hooks/workspace-hook-trust-coordinator.ts` | 27 / 0 | 4 / 5 | 仅 `,` +1 / `;` −1（格式化） | 无 | 0 → 0 | 回滚 |
| `core/src/runtime/methods/background.ts` | 94 / 0 | 4 / 12 | 仅 `,` +2（格式化） | **2 句各写两次**（`不取消 local_agent…` / `在这里强停…`） | 0 → 2 | 回滚 |
| `core/src/runtime/methods/file-rewind.ts` | 196 / 0 | 3 / 8 | 仅 `(` `)` 各 +1（格式化） | 无 | 0 → 3 | 回滚 |
| `core/src/runtime/methods/model-streaming-event-queue.ts` | 25 / 0 | 2 / 7 | 仅 `,` +1（格式化） | 无 | 0 → 0 | 回滚 |
| `core/src/runtime/methods/rewind.ts` | 116 / 0 | 7 / 7 | **等价** | 无 | 0 → 22 | 回滚 |
| `core/src/runtime/methods/target.ts` | 115 / 0 | 4 / 2 | **等价** | 无 | 0 → 0 | 回滚 |
| `core/src/tool/executor/background-tasks.ts` | 212 / 5 | 39 / 27 | 仅 `,` −2（格式化） | **3 句与 HEAD 重复**（JSDoc 删后原样搬移） | 1 → 6 | 回滚 |
| `core/src/tool/scheduler.ts` | 95 / 0 | 4 / 2 | **等价** | 无 | 0 → 5 | 回滚 |
| `ios-simulator-plugin/src/providers/logs.ts` | 26 / 0 | 1 / 1 | 仅 `;` −1（格式化） | 无 | 0 → 2 | 回滚 |
| `services/src/mcp-sync/mcpSyncService.ts` | 205 / 0 | 53 / 164 | 仅 `,` +31 与 `(` `)` `;`（格式化） | 无 | 0 → 2 | 回滚 |
| **合计** | **1653 / 11** | **355 / 274**（numstat `+2008/−285`） | 无标识符增删 | 2 类 | **3 → 94（+91）** | **15/15 回滚** |

- 15 个文件的代码行差异全是 prettier 重排（尾逗号、括号换行），**没有一个语义 token 变化**。
- 不能提交的原因不是「看起来像代码」，而是它不满足任何一批的契约：
  15 文件 > 6、`+1653` 注释 ≠ 100 行 1→1、七行门禁会记「新增非注释行 355 / 删代码 274 / 删上游注释 11」。
  此外还有 2 处重复写入与 3 处注释搬移，属于同一段文字被写两次。
- 逐文件看，没有一个文件是「只加 100 行注释、可原样入批」的：最小的 `logs.ts` 也带 1 行代码格式化。

## 3. `done` 是否虚高

**结论：`done` 未虚高，`remain` 也未虚高。确定未计入，受影响行数 = 0。**

- HEAD 上这 15 个文件只有 3 行 weak（`dynamic-sections.ts:58/66` 的 `}`、`background-tasks.ts:38` 的一句话）；
  盘上是 94 行，净 **+91**。
- 关键判据是池：`remain` 只统计 `git diff 8f7daaf0..HEAD` `+` 行集合内的 weak。把盘上 94 行逐条对池，
  **`inPool=0`**——它们全部是未提交的新增行，不在池内，所以只增加 `pool-out`（中间项），
  不进 `remain`，也不进 `done = 7,421 − remain`。
- 逐行核对那 3 行 HEAD weak：`dynamic-sections` 的两行 `}` 在盘上仍以同样正文出现（行号 85/95，被上面插入的行推移），
  `background-tasks` 的那句话也在盘上同一位置（行号 60）仍是 weak。**3 行全部未被改写**；
  即使它们被清，也会进 `done`，但实测没有。
- 因此 `done = 2,396 / remain = 5,025` 不需要修正。回滚只让 `WEAK 8,500 → 8,309`
  （`pool-out 3,375 → 3,284`），报表两列不动；b279 收口直接从 `2,396 / 5,025` 走到 `2,496 / 4,925`
  （`+100` 全部是 b279 产出）。
- 上下界：对 `done` 是 `[0, 0]`，对 `remain` 是 `[0, 0]`（证明方式：94 条池内计数为 0 + 3 条 HEAD weak 正文未变）。

## 4. 处置

- 15 个文件 `git restore` 回滚到 HEAD，`git status --porcelain` 清空。
- 完整 diff 留档在仓库外：`d:\code\_annot_baseline\dirty-15-pre-revert.patch`
  （sha256 `DC3D8659214D556C2B8D0FC81DD407E9E3CABBC5984CC7A15FED3E0DC67A8B74`，`+2,008/−285`），不作为提交物，也未 `git stash`。
- 未混入 b279：b279 的 `--plan` 与 diff 只含新选文件。

## 5. 新增前置拦截（`--start` 树必须干净）

`precheck-assert.mjs` 的 `--start` 现在先跑 `git status --porcelain`：

- 非空 → 打印全部条目并 `exit 6`，不落 `t-start`；
- 放行路径只写在工具内的 `START_ALLOW`（相对 repo 的前缀），不写进文档；
- 负控：树里放 1 个未跟踪文件 → `PRECHECK START FAIL 工作树非空（1 项）` + `exit 6`；
- 正控：清空后 → `PRECHECK START ts=…` + `exit 0`。

理由：只要树可以带脏启动，`numstat` 越界检测与 weak 快照就都建立在不干净的地基上；
这 15 个文件已经躺了十几个小时，正好证明了后果。
