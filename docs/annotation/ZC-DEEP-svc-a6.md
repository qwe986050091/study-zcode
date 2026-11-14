# ZC-DEEP-SVC-A6（迁移 / checkpoint / 写队列，7 文件 / 200 行）

> 基线：`d:\code\_annot_baseline\ZC-deep-svc-a6\orig`（改写前工作树）。
> 范围：`git/repo/gitCheckpoint{Store,Helpers}.ts`、`setting/settingsWriteQueue.ts`、`project-storage/project-repository.ts`、`feedback/feedbackLocalTicketStore.ts`、`setting/legacyAccountConnectionSettings.ts`、`project-storage/default-workspace/migration.ts`。
> 约束：只新增整行中文 `//` 注释，未改动任何代码 token（`deletedNonZero=0`、`nonCommentAdded=0`）。

## 1. 结果表

| 文件 | 代码行（函数体内） | 内文前 → 后 | 新增行 |
| --- | ---: | --- | ---: |
| `git/repo/gitCheckpointStore.ts` | 75 | 0.00% (0/75) → 32.00% (24/75) | 24 |
| `git/repo/gitCheckpointHelpers.ts` | 161 | 10.56% (17/161) → 35.40% (57/161) | 40 |
| `setting/settingsWriteQueue.ts` | 45 | 11.11% (5/45) → 46.67% (21/45) | 16 |
| `project-storage/project-repository.ts` | 354 | 11.02% (39/354) → 32.20% (114/354) | 75 |
| `feedback/feedbackLocalTicketStore.ts` | 87 | 2.30% (2/87) → 31.03% (27/87) | 25 |
| `setting/legacyAccountConnectionSettings.ts` | 81 | 14.81% (12/81) → 32.10% (26/81) | 14 |
| `project-storage/default-workspace/migration.ts` | 15 | 6.67% (1/15) → 46.67% (7/15) | 6 |
| **合计** | **818** | **9.29%（76/818）→ 33.74%（276/818）** | **200** |

最低函数：`settingsWriteQueue` 内 `<anonymous>@50` 16.7%（1/6）、`legacyAccountConnectionSettings` 内 `<anonymous>@37` 18.8%（3/16）、`gitCheckpointStore` 内 `<anonymous>@86` 20.0%（1/5）。全部函数 ≥15%，全部文件 ≥30%。

## 2. 补深方式（按故障面）

- **checkpoint 元数据（gitCheckpointStore）**：`isGitCheckpointMeta` 先挡非对象再逐键校验、`Partial` 承接不用整体断言、`scope` 只认 `workspace`；`enqueueWrite` 以 `Map<filePath, Promise>` 串行，`previous.catch` 防止一次失败污染后续、`completion` 折平 rejected、`finally` 只在表项仍等于自身时删除；`save/load/delete` 共用 `checkpointFilePath` 作队列键；`writeManifestAtomic` 先写带 pid 与时间戳的 `tempPath` 再 `rename` 原子替换；`load` 先 `waitForPendingWrite` 再守卫校验，失败返回 `null`；`delete` 的 `rm(force)` 让重复删除幂等。
- **diff 解析（gitCheckpointHelpers）**：NUL 分段先过滤空段，`index` 推进步数由 `kind` 决定（rename 三段、普通两段）；`numstat` 的 `-` 落 0、`slice(2).join("\t")` 还原含制表符路径、缺失路径拒绝入表；`ls-tree` 以首个 `\t` 分界、`header` 不足三段跳过；`mergeCheckpointDiff` 以 name-status 为全集、numstat 只补行数；`buildAffectedRepoPaths` 用 `Set` 同时登记新旧路径。
- **设置写队列（settingsWriteQueue）**：超时值每次从 `ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS` 重读、`Number` 拒绝 `12s` 这类拼写、非正数回落；`commitPhaseEntered` 与定时器同源，进入提交后超时分支直接放弃；`timeoutHandle.unref` 不阻止进程退出；临时名 `pid+时间戳+随机数` 避免撞名。
- **项目仓（project-repository）**：`BEGIN IMMEDIATE` 先拿写锁、`isTransaction` 才回滚；roots 在内存按 `project_id` 拼装保序；`resolveDirectories` 用行内 `root_path` 并校验 `host_id`；`readTasks` 同时过滤 `deleted` 与 `cli_deleted`；`archiveInactive` 的 active 键与候选行同一序列化；`readTree` 按 Host 过滤并用只读事务取快照；`saveProject` 拒绝复活已删项目与跨 Host 改写、`Set` 去重 roots、主根必须属于 roots、名称去重与时间戳在事务内只算一次、ON CONFLICT 承担复活；`initializeProjectRoot` 已有根即跳过；`deleteProject` 复合 WHERE 保证重复删幂等；`moveTask` 校验两端 Host 与 cwd 归属、`handoff_pending` 用位或；`reserveCreatedTask` 幂等回读、`VALUES` 写 0 时间让占位行不进列表。
- **反馈本地票据（feedbackLocalTicketStore）**：`deviceMid` 为本地隔离维度、返回前剥除；读改写以 `deviceMid+id` 双键剔除并截断 200；每次 `read` 重读盘，顶层结构损坏返回空集合，`tickets.json` 单文件非原子写故不缓存；状态白名单未知值回落。
- **旧账号连接设置（legacyAccountConnectionSettings）**：`record` 收敛非字典值；缺 `providerFamilyConnectionSelections` 但有旧字段才迁移；`hasOwn` 而非真值判断；只保留实际存在的旧键；`apiKey` 模式跳过、`start-plan` 映射为新 kind；`...raw` 保序不丢未知项。
- **默认工作区迁移（default-workspace/migration）**：候选 SQL 的限定条件、单批共用一个 `now`、逐条更新使任务解绑与项目软删成对、失败时整体回滚即幂等。

## 3. 校验原文

`node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-a6`：

```text
SUMMARY files=7 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=200
```

`node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only ... --threshold 15 --fns 30`：

```text
SUMMARY files=7 innerCode=818 innerZh=276 below15=0 min=31.03 median=32.20

低于 15% 的文件（innerZh/innerCode）：

最差的 7 个文件（含函数明细前 3）：
31.03%	27/87	packages/services/src/feedback/feedbackLocalTicketStore.ts
	  <anonymous>@47  20.0% 1/5
	  isStoredFeedbackTicket@148  21.4% 3/14
	  isFeedbackTicketStatus@127  25.0% 4/16
	  migrateStoredFeedbackTicket@117  28.6% 2/7
	  read@85  29.4% 5/17
	  list@42  46.7% 7/15
	  upsert@69  50.0% 4/8
32.00%	24/75	packages/services/src/git/repo/gitCheckpointStore.ts
	  <anonymous>@86  20.0% 1/5
	  delete@141  33.3% 2/6
	  load@124  36.4% 4/11
	  isGitCheckpointMeta@13  37.5% 6/16
	  enqueueWrite@73  40.0% 6/15
	  writeManifestAtomic@98  42.9% 3/7
	  save@111  42.9% 3/7
32.10%	26/81	packages/services/src/setting/legacyAccountConnectionSettings.ts
	  <anonymous>@37  18.8% 3/16
	  record@12  20.0% 1/5
	  readLegacyAccountConnectionSettingsFile@62  25.0% 2/8
	  needsLegacyAccountConnectionMigration@75  25.0% 2/8
	  retainLegacyAccountConnectionFields@135  25.0% 2/8
	  readIncompleteLegacyTeamConnections@28  31.8% 7/22
	  migrateLegacyAccountConnectionSettings@89  40.0% 12/30
32.20%	114/354	packages/services/src/project-storage/project-repository.ts
	  requireProject@120  20.0% 1/5
	  readTask@130  20.0% 1/5
	  reorderProjects@526  20.0% 2/10
	  <anonymous>@530  20.0% 1/5
	  initializeProjectRoot@444  22.2% 4/18
	  <anonymous>@195  22.6% 7/31
	  readTasks@187  23.7% 9/38
	  <anonymous>@445  25.0% 4/16
	  <anonymous>@527  25.0% 2/8
	  readTree@296  27.6% 8/29
	  moveTask@485  27.6% 8/29
	  deleteProject@470  28.6% 2/7
	  <anonymous>@486  29.6% 8/27
	  readProjects@77  33.3% 10/30
	  resolveDirectories@148  33.3% 8/24
	  archiveInactive@248  33.3% 10/30
	  <anonymous>@249  35.7% 10/28
	  saveProject@342  39.4% 28/71
	  <anonymous>@343  40.6% 28/69
	  reserveCreatedTask@556  41.9% 18/43
	  <anonymous>@557  43.9% 18/41
	  transaction@56  45.5% 5/11
35.40%	57/161	packages/services/src/git/repo/gitCheckpointHelpers.ts
	  buildCheckpointEnv@270  22.2% 2/9
	  removeFileIfExists@285  33.3% 2/6
	  mergeCheckpointDiff@217  34.8% 8/23
	  parseLsTree@176  36.4% 8/22
	  mapNameStatusKind@51  38.5% 5/13
	  parseNameStatus@73  39.4% 13/33
	  buildAffectedRepoPaths@252  40.0% 4/10
	  <anonymous>@219  43.8% 7/16
	  parseNumstat@126  44.8% 13/29
46.67%	7/15	packages/services/src/project-storage/default-workspace/migration.ts
	  migrateDefaultWorkspaceTasks@20  46.7% 7/15
46.67%	21/45	packages/services/src/setting/settingsWriteQueue.ts
	  <anonymous>@50  16.7% 1/6
	  getSettingsWriteQueueTimeoutMs@10  40.0% 4/10
	  buildSettingsTempFile@27  40.0% 2/5
	  <anonymous>@69  44.4% 4/9
	  withSettingsWriteQueueTimeout@41  50.0% 15/30
	  <anonymous>@67  50.0% 6/12
```

`node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files ... --quiet --top 20`：

```text
SUMMARY files=7 units=498 coverage=48.4% branch=53.8% field=54.5% comments=499 substance=85.2% explain=100.0% filler=0.0% weak=0.2%
```

## 4. 锚定的不变量

- `INV-A6-1`：同一 checkpoint 的写、删必须经 `enqueueWrite` 串行，`Map` 表项只在仍等于自身 `completion` 时删除。
- `INV-A6-2`：元数据落盘必须 `tempPath` + `rename`，读者只见完整 JSON，不存在半截文件。
- `INV-A6-3`：`load` 必须先 `waitForPendingWrite` 再校验；校验失败返回 `null` 而不是抛错。
- `INV-A6-4`：diff 解析的索引推进：rename 三条 NUL 段后 `index += 2`，普通记录 `index += 1`。
- `INV-A6-5`：设置写队列一旦进入 commit 阶段，超时不再 reject；`commitPhaseEntered` 与定时器同源。
- `INV-A6-6`：项目 roots 在库内无唯一约束，写入前必须 `Set` 去重且主根必须属于 roots。
- `INV-A6-7`：`host_id` 写入后不可变；任何跨 Host 的保存/迁移一律拒绝。
- `INV-A6-8`：软删项目只能显式恢复，普通保存不得复活；`deleteProject` 重复调用为空操作。
- `INV-A6-9`：tasks 的 `deleted` 与 `cli_deleted` 是两位独立删除标记，查询必须同时考虑。
- `INV-A6-10`：默认工作区迁移逐行成对更新任务与项目，任一步失败整体回滚，重复执行结果一致。

## 5. 看似该改其实不能改

- 不动 `writeManifestAtomic` 的 `rename`：改成 `writeFile` 直接覆盖会暴露半写文件。
- 不把 `enqueueWrite` 的 `previous.catch` 去掉：一次失败会让后续同文件操作全部 rejected。
- 不在 `load` 里删掉 `waitForPendingWrite`：save 后立刻 load 会命中旧文件或 `ENOENT`。
- 不把 `isGitCheckpointMeta` 改成完整类型断言：损坏行会带着 `undefined` 流入调用方。
- 不把 `parseNumstat` 的 `fields.slice(2).join("\t")` 改成 `fields[2]`：含制表符路径被截断。
- 不在 `mergeCheckpointDiff` 反过来以 numstat 为全集：纯 rename 文件会丢失。
- 不把 `settingsWriteQueue` 的超时改成模块级常量：运行期改环境变量将不生效。
- 不在 `commitPhaseEntered` 为真后仍 reject：临界区被打断会让旧写晚到覆盖新设置。
- 不把项目 roots 改成增量 diff：替换整表才能让 `position` 与 `is_primary` 与入参一致。
- 不删除 `BEGIN IMMEDIATE` 换成 `BEGIN`：先查后写会在事务中途被并发提交插入。
- 不在 `readTasks` 的 WHERE 里去掉 `coalesce(cli_deleted,0)`：另一端发起的删除会漏掉。
- 不把 `resolveDirectories` 的 `root_path` 换成入参 `workspacePath`：目录迁移后 cwd 被改写。
- 不给 `feedbackLocalTicketStore` 加内存缓存：单 JSON 非原子写，缓存会放大外部改动的偏差。
- 不把 `upsert` 的剔除条件收窄为仅 `id`：会误删其他设备的同号票据。
- 不在 `legacyAccountConnectionSettings` 里用真值判断替代 `hasOwn`：空对象/空串也是旧版写过的证据。
- 不把 `migrateDefaultWorkspaceTasks` 合成一条 UPDATE：任务解绑与项目软删必须同批成对。
