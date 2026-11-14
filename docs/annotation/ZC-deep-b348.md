# ZC-deep-b348

> 批次：b348 ｜ 28 行 / 4 文件 ｜ 提交 `4833f139`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 28 行（尾部批：4 文件合计 28，25–32 区间）

- 候选前 4 个均为 `7/7`、全在 `packages/ui`：7×4 = **28**，落在尾部区间，不触发合批。
- `TALLY {"ownIn":28,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":28,"planOut":0}` / `plan=28 ownOutAllow=0` / `files=4/4`。
- 属**形状 A** 段（b1–b349），`批墙钟` 只进 A 段序列。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/previewPaneOfficeXlsxContent.tsx` | 7 | 0 | 7 | 0 |
| `packages/ui/src/project-sidebar/useProjectRemoteSync.tsx` | 7 | 0 | 7 | 0 |
| `packages/ui/src/remote-connection-flow/index.ts` | 7 | 0 | 7 | 0 |
| `packages/ui/src/settings/PluginStoreListView.tsx` | 7 | 0 | 7 | 0 |
| **合计** | **28** | **0** | **28** | **0** |

- 目录/功能域分布：`packages/ui/src`（预览）1、`project-sidebar` 1、`remote-connection-flow` 1、`settings` 1。
  四个文件同包不同子域，阅读主线是「远程连接 + 预览 + 设置列表」三类界面状态，未跨包。

## 2. 改动内容

- `previewPaneOfficeXlsxContent.tsx`：`(index + delta + count) % count` 回绕；`sheetNames.length === 1` 不渲染 tab bar；
  切换记录 `sheetNames[index]`；`ArrowLeft/ArrowRight` 换算下标、`null` 表示不接管；`preventDefault` 后再移焦点；
  `wrapper` 撑满父级并 `overflow: hidden`。
- `useProjectRemoteSync.tsx`：`deps` 含派生值；`cleanup` 只重置本地 `selection`；不用 `setInterval` 轮询；
  `useEffect` 无 `cleanup` 因重置幂等；`actionId` 含 `rootIndex`；`label` 仅在 `roots.length > 1` 时加根路径；
  点击只写 `selection`，同步由 `onConfirm` 触发。
- `remote-connection-flow/index.ts`：日志按 `phase` 三选一；`form`/`intent` 重置；`form` 阶段直接放行；
  `confirm` 与 `execute` 两段式中间夹 `epoch` 复核；通知 `continue` 需 `epoch` 与 `phase` 同时命中；
  清理时机在 `applyPreferredTarget` 换目标时；按 `errorCode` 再分一次类。
- `PluginStoreListView.tsx`：`retired` 条目只从商店投影剔除；分组按 `locale` 比较、按 `mode` 权重排序；
  `fallback title` 只取一次；`toggleGroup` 不包 `useCallback`；搜索分支无 `loading` 态；两列断点用 `container query`；
  `isEmpty` 空态用虚线提示块。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-12T02:22:48.046Z pre-weak=b347-repo-post.txt
gate: PASS scope     n=0 plan=28 allow=0 diff_old=28 diff_new=28 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=4833f139 files=4/4 numstat=28/28 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=28 added=0 allowed=37 auto_self_clear=0
gate: PASS order     total=132.0s controllable=102.0s
```

## 4. 首轮命中与返修（`fix=` 首用）

`fix=1/2/不可分`

- 首轮 **1 hit**：`W 单行无信息` 落在 `useProjectRemoteSync.tsx:114`
  「点击只写入选择，实际同步由对话框中的确认触发」。
- 根因不是文案，而是**改错了行**：计划是 102–105 + **112–114**，我把 112–114 写成了 111–113，
  既漏了 114、又越界改了 111。
- 修正：把 111 还原为「主机不在线时直接返回空数组，避免生成不可执行项」，114 改为
  「点击只写 selection，实际同步由对话框中 onConfirm 触发」；复判 `hits=0`，`scope` 与 `numstat` 都回到 28/28。
- **耗时第三列本批不可分**：两次 `judge` 前后没有留时间戳，回改时间含在 `controllable=102.0s` 内。
  b349 起在 `judge` 首跑/复判前后各记一次时间戳，`fix=` 第三列改为实测，不再写 `不可分`。

## 5. 自清（本批 0 行；累计 9 行 / 9 文件）

- `pool-diff removed=28 added=0 auto_self_clear=0`，与 plan 完全重合；`POOL-SELF-CLEAR.tsv` 无新增。
- 累计仍为 **9 行 / 9 文件**（自动 4、人工 5），全部未回读，距阈值 20 行差 11 行。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b347 4,545` → `post-b348 4,517`（**−28**），文件 `1,715 → 1,711`（四个文件全清）。
- **句子级口径**：`done 6,146 / remain 1,275`，`6,146 + 1,275 = 7,421`，**82.8%**。
- **逐行口径**：`remain ≈ 1,275 + 1,046 = 2,321`，`done ≈ 5,100 / 7,421`，约 **68.7%**。
- 池外：`4,517 − 1,275 = 3,242`，永久不排期。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b348`：`done files=487 (+4) / lines=6,146 (+28)`，
  `REMAIN 520 files / 1,275 lines`，`ALIGNED acct_remain=1275 pool_remain=1275 diff=0`，分档合计 261 批。
- `ledger-assert`：`487 + 520 = 1,007`、`6,146 + 1,275 = 7,421` → **PASS**。
- 白名单重跑到 `4833f139`，**524 行**（开批前 522 行 + 本批两条）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b347-repo-post.txt
node _annot_baseline/pick-generic.mjs b348 d:/code/_annot_baseline/b348-files.txt d:/code/_annot_baseline/b347-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b348 --start
node _annot_baseline/judge-generic.mjs b348
node _annot_baseline/gate-run.mjs --batch b348 --subject "注释清水 b348：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b348-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b348-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b347-guard-post.txt --post d:/code/_annot_baseline/b348-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b348-repo-post.txt --pre-weak d:/code/_annot_baseline/b347-repo-post.txt --batch b348
```

## 9. 计时口径（A 段序列）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `17e4469a`） | 批次提交 `4833f139` | 132.0s | 4.71s |
| `controllable` | `--start`（02:22:48.046Z） | 批次提交 | 102.0s | 3.64s |
| 起草段 | `b348-files.txt`（10:22:45） | `--start` | 3s | — |
| 收口段 | 批次提交（10:24:30） | 台账提交（10:25:27） | 57s | — |
| `批墙钟` | 本批最早可观测产物（10:22:45） | 台账提交 `c92adb62`（10:25:27） | 162s | 5.79s |

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，522 行） | `17e4469a` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `4833f139` | `+28/−28` |
| `ZC-deep-b348-rewrite.tsv` + 白名单 524 行 + 本台账 + INDEX 同步 | `c92adb62` | — |

- 收口判据：A1 `remain=1,275≠0`；A2 `6,146 + 1,275 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `6,146 + 0 + 1,275 = 7,421` 成立。
