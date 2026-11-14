# ZC-deep-b349

> 批次：b349 ｜ 20 行 / 4 文件 ｜ 提交 `d14f8641`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 20 行（碎尾批：4 文件合计 20，15–24 区间）

- 快照只剩 2 个 `7/7`，其后 `3/3`、`3/3`、`2/2`……取前 4 文件合计 **7+7+3+3 = 20**。
- 4 文件结构下 20 是上界：第 5 个候选只有 2 行，补到 22 仍 <25，凑不到尾部区间，故按碎尾批推进，不加第 5 文件。
- `TALLY {"ownIn":20,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":20,"planOut":0}` / `plan=20 ownOutAllow=0` / `files=4/4`。
- 属**形状 A 段**最后一个批次，`批墙钟` 进 A 段碎尾组。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/settings/useShortcutRecording.ts` | 7 | 0 | 7 | 0 |
| `packages/ui/src/store/pluginStore.ts` | 7 | 0 | 7 | 0 |
| `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts` | 3 | 0 | 3 | 0 |
| `packages/ui/src/SettingsPage.tsx` | 3 | 0 | 3 | 0 |
| **合计** | **20** | **0** | **20** | **0** |

- 目录/功能域分布：`packages/ui/src/settings` 1、`packages/ui/src/store` 1、`packages/ui/src`（SettingsPage）1、
  `apps/zcode-cli/packages/adapters/src/model` 1。跨包但同属「设置 → 插件状态 → 流式适配」一条读链。

## 2. 改动内容

- `useShortcutRecording.ts`：`recording` 为 false 不挂 `window keydown`；`handleRecordingKeydown` 先 `preventDefault`；
  `Escape` 只调 `cancelRecording`；`Backspace` 恢复 `commandId` 默认键；组合判定交给 `recordShortcutBinding`；
  只与 `effective[commandId]` 比冲突；`mode === "add"` 或 `bindingIndex === null` 等价追加。
- `pluginStore.ts`：`set` 只写 `workspaceIdentity` 与保留策略；后台 `refresh` 期间旧列表仍展示；
  空输入不写 `error` 横幅；`updateMarket` 的 `marketId` 为空表示全部市场；`install` 兼容两种签名；
  `busyKey` 由 `scope` 与 `pluginName` 拼成；第三参按 `typeof` 布尔分流。
- `runner-stream.ts`：外层只消费 `visible`/`retryScheduled`/`terminal` 三个布尔；
  不 `cancel baseStream` 是「连续重试后卡在发送前」的根因；`toModelStreamEvent` 只做形态转换。
- `SettingsPage.tsx`：只持久化 `caCertPath` 并提示重启；更新开关只写偏好、不触发 `checkForUpdates`；
  调度由 `updateService` 负责。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-12T02:27:53.400Z pre-weak=b348-repo-post.txt
gate: PASS scope     n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=d14f8641 files=4/4 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=38 auto_self_clear=0
gate: PASS order     total=127.0s controllable=90.0s
```

## 4. 首轮命中与返修（`fix=`）

`fix=1/1/不可分`

- 首轮 **1 hit**：`L 无信息列举` 落在 `pluginStore.ts:538`
  「第三参为 enabled（旧）或 scope（新），按 typeof 布尔分流。」——顿号 + 逗号两处分隔。
- 改为「第三参为 enabled（旧）或 scope（新），按 typeof 布尔分流。」→ 仍是两处分隔，复判仍命；
  最终改为单逗号结构后 `hits=0`。
- 本批两次 `judge` 仍未留时间戳，第三列记 `不可分`；**b350 起在 judge 前后各写一次时间戳到 `bXXX-fix.tsv`**。

## 5. 自清（本批 0 行；累计 9 行 / 9 文件）

- `pool-diff removed=20 added=0 auto_self_clear=0`；累计仍 9 行 / 9 文件（自动 4、人工 5），距阈值 20 行差 11 行。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b348 4,517` → `post-b349 4,497`（**−20**），文件 `1,711 → 1,709`。
- **句子级口径**：`done 6,166 / remain 1,255`，`6,166 + 1,255 = 7,421`，**83.1%**。
- **逐行口径**：`remain ≈ 1,255 + 1,046 = 2,301`，`done ≈ 5,120 / 7,421`，约 **69.0%**。
- 池外：`4,497 − 1,255 = 3,242`，永久不排期。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b349`：`done files=491 (+4) / lines=6,166 (+20)`，
  `REMAIN 516 files / 1,255 lines`，`ALIGNED acct_remain=1255 pool_remain=1255 diff=0`，分档合计 259 批。
- `ledger-assert`：`491 + 516 = 1,007`、`6,166 + 1,255 = 7,421` → **PASS**。
- 白名单重跑到 `d14f8641`，**529 行**（开批前 524 行 + 本批五条）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b348-repo-post.txt
node _annot_baseline/pick-generic.mjs b349 d:/code/_annot_baseline/b349-files.txt d:/code/_annot_baseline/b348-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b349 --start
node _annot_baseline/judge-generic.mjs b349
node _annot_baseline/gate-run.mjs --batch b349 --subject "注释清水 b349：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b349-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b349-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b348-guard-post.txt --post _annot_baseline/b349-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b349-repo-post.txt --pre-weak d:/code/_annot_baseline/b348-repo-post.txt --batch b349
```

## 9. 计时口径（A 段 · 最后一批 · 已封存）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `31062e28`） | 批次提交 `d14f8641` | 127.0s | 6.35s |
| `controllable` | `--start`（02:27:53.400Z） | 批次提交 | 90.0s | 4.50s |
| 起草段 | `b349-files.txt`（10:27:45） | `--start` | 8s | — |
| 收口段 | 批次提交（10:29:23） | 台账提交（10:30:08） | 45s | — |
| `批墙钟` | 最早产物（10:27:45） | 台账提交 `ee6dc6e9`（10:30:08） | 143s | 7.15s |

### A 段封存表（b337–b349，13 批，形状 A / 4 文件）

| 组 | 区间 | n | 批号 | 中位数 | 极差 |
| --- | --- | ---: | --- | ---: | --- |
| 正常批 | ≥33 行 | **0** | — | — | — |
| 尾部批 | 25–32 行 | **10** | b337–b344、b346、b348 | **200.5s** | 162–379s |
| 碎尾批 | 15–24 行 | **3** | b345（258s）、b347（193s）、b349（143s） | 不报（n<4） | 143–258s |

- **A 段无正常批，行目标 33 达成 0/13**。
- **离群**：b341 的 379s 是唯一超 300s 的点（当批做过 scope 返修与重拍），剔除后 n=9 **中位 196s**、极差 162–257s。
  尾部批的 200.5s **不能当 A 段代表值**，A 段没有正常批可用作主读数。
- **b350 切形状 B 的依据即此——33 在 A 段从未填满**：13 批里 10 批落 25–32、3 批落 15–24，
  没有任何一批达到 33 行；4 文件结构的物理上界是 4×7=28，而快照后期只剩 7/6/5/4/3 档，上界进一步降到 20–25。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，524 行） | `31062e28` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `d14f8641` | `+20/−20` |
| `ZC-deep-b349-rewrite.tsv` + 白名单 529 行 + 本台账 + INDEX 同步 | `ee6dc6e9` | — |

- 收口判据：A1 `remain=1,255≠0`；A2 `6,166 + 1,255 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `6,166 + 0 + 1,255 = 7,421` 成立。
