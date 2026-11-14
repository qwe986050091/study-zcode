# ZC-deep-b347

> 批次：b347 ｜ 19 行 / 4 文件 ｜ 提交 `04513902` + 补修 `694b6a16`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 19 行（**碎尾批**：15–24 区间第二例）

- 候选只有 1 个 `7/7`，其后三个都是 `4/…`：7 + 4 + 4 + 4 = **19**。第 5 个候选也只有 3 行，
  5 文件合计 22 仍低于 25，按规则保持 4 文件结构。
- `TALLY {"ownIn":19,"ownOut":0,"upIn":0,"upOut":12,"pending":0,"planIn":19,"planOut":0}` / `plan=19 ownOutAllow=12` / `files=4/4`。
- 属**形状 A** 段（b1–b349），`批墙钟` 只进 A 段序列。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/git-branch-switcher/display.ts` | 7 | 0 | 7 | 0 |
| `packages/ui/src/lib/workspaceSidePane.ts` | 4 | 5 | 4 | 5（上游） |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowsSection.tsx` | 4 | 4 | 4 | 4（上游） |
| `packages/shared/src/conversation-share.ts` | 4 | 3 | 4 | 3（上游） |
| **合计** | **19** | **12** | **19** | **12** |

- 目录/功能域分布：`packages/ui` 3 个（git 分支展示、侧栏模型、已存工作流设置）、`packages/shared` 1 个（会话分享）。
  形状 A 不强制聚类，本批跨 2 个包，但 3 个 `ui` 文件同属设置/侧栏域。

## 2. 改动内容

- `display.ts`：`normalizedBranchName` 空串与 `undefined` 收敛到 `fallback`；判空用 `.length`；
  展示取 `options.currentBranchName` 原值；空白路径先 `trim().length` 过滤再 `slice`；`paths` 缺失按空数组；
  `normalizedPaths` 保留上游顺序。
- `workspaceSidePane.ts`：`PluginMarketSidePaneTab` 内层导航自管；`DeveloperToolsSidePaneTab` 不参与恢复；
  按 `parent` 分组回填最小可用 `ordinal`；三元组未命中 `current scope` 时后台挂载 `guest`。
- `SavedWorkflowsSection.tsx`：入口可见性与 `dynamicWorkflowConfig` 同源；只有全局组触发 `handleMoved`；
  `emptyCardTarget` 只挑项目档；`allProjectsEmpty` 忽略全局组空满。
- `conversation-share.ts`：逐个 `artifact type` 收窄进 `supported`；`unsupportedArtifactTypes` 去重回报；
  丢弃只对产不出的类型无损；`access mode` 同理不进口能力表。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T17:03:49.429Z pre-weak=b346-repo-post.txt
gate: PASS scope     n=0 plan=19 allow=0 diff_old=19 diff_new=19 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=04513902 files=4/4 numstat=19/19 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=18 added=0 allowed=28 auto_self_clear=0
gate: PASS order     total=88.0s controllable=82.0s
```

## 4. 首轮命中与返修

- 判据首轮 `hits=0`（本批首例「门禁全过但质量未达标」）：
  `pool-diff removed=18` 比计划 19 少 1，查快照发现 `conversation-share.ts:249` 仍被判 **空泛提醒**
  （「注意…必须补齐」是提醒句式，判据表里没有，`judge` 也不查这一项）。
- 改写为「丢弃只对客户端确实产不出的类型无损，可产出的类型漏配会静默消失」后单独提交补修 `694b6a16`，
  重拍快照后 weak `−19`、`removed` 补齐。
- 本批由此**有两个批次提交**（本体 + 补修），属例外：`numstat` 合计 `+20/−20`，唯一行数仍是 19；
  台账按 19 行登记，`done +19`。

## 5. 自清（本批 0 行；累计 9 行 / 9 文件）

- `pool-diff removed=18`（补修后 19）`added=0 auto_self_clear=0`；无新增登记。
- 累计表见 INDEX §12.7：9 行 / 9 文件（自动 4、人工 5），全部未回读，距阈值 20 行差 11 行。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b346 4,564` → `post-b347 4,545`（**−19**），文件 `1,716 → 1,715`。
- **句子级口径**：`done 6,118 / remain 1,303`，`6,118 + 1,303 = 7,421`，**82.4%**。
- **逐行口径**：`remain ≈ 1,303 + 1,046 = 2,349`，`done ≈ 5,072 / 7,421`，约 **68.3%**。
- 池外：`4,545 − 1,303 = 3,242`，永久不排期。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0 max=8` → **PASS**（补修后重跑一次，读数不变）。
- `capacity-estimate --batch b347`：`done files=483 (+4) / lines=6,118 (+19)`，
  `REMAIN 524 files / 1,303 lines`，`ALIGNED acct_remain=1303 pool_remain=1303 diff=0`，分档合计 263 批。
- `ledger-assert`：`483 + 524 = 1,007`、`6,118 + 1,303 = 7,421` → **PASS**。
- 白名单重跑到 `694b6a16`，**516 行**（开批前 513 行 + 本批三条）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b346-repo-post.txt
node _annot_baseline/pick-generic.mjs b347 d:/code/_annot_baseline/b347-files.txt d:/code/_annot_baseline/b346-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b347 --start
node _annot_baseline/judge-generic.mjs b347
node _annot_baseline/gate-run.mjs --batch b347 --subject "注释清水 b347：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b347-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b347-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b346-guard-post.txt --post d:/code/_annot_baseline/b347-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b347-repo-post.txt --pre-weak d:/code/_annot_baseline/b346-repo-post.txt --batch b347
```

## 9. 计时口径（A 段序列）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `39f94892`） | 补修提交 `694b6a16` | 129.0s | 6.79s |
| `controllable` | `--start`（17:03:49.429Z） | 补修提交 | 123.0s | 6.47s |
| 起草段 | `b347-files.txt`（01:03:40） | `--start` | 9s | — |
| 收口段 | 补修提交（01:05:52） | 台账提交（01:06:53） | 61s | — |
| `批墙钟` | 本批最早可观测产物（01:03:40） | 台账提交 `17bd4079`（01:06:53） | 193s | 10.16s |

- 门禁打印的 `total=88.0s / controllable=82.0s` 只到本体提交 `04513902`；补修多花 41s，
  本表按最终批次状态记账。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，512 行） | `39f94892` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `04513902` | `+19/−19` |
| 补修 `conversation-share.ts:249`（空泛提醒） | `694b6a16` | `+1/−1` |
| `ZC-deep-b347-rewrite.tsv` + 白名单 516 行 + 本台账 + INDEX 同步 | `17bd4079` | — |

- 收口判据：A1 `remain=1,303≠0`；A2 `6,118 + 1,303 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `6,118 + 0 + 1,303 = 7,421` 成立。
