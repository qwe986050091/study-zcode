# ZC-deep-b346

> 批次：b346 ｜ 28 行 / 4 文件 ｜ 提交 `b3baa8c0`
> 尺子：`deep-quality.mjs` v2.0（句子级口径）、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`（十一闸）

## 0. 本批 28 行（尾部批：4 文件合计 28，25–32 区间）

- 候选前 4 个都是 `7/7`，且全在 `packages/ui`：7×4 = **28**，落在尾部区间（25–32），无需下探、不触发合批。
- `TALLY {"ownIn":28,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":28,"planOut":0}` / `plan=28 ownOutAllow=0` / `files=4/4`。
- 本批仍属**形状 A**（b1–b349），`批墙钟` 只进 A 段序列（§6.2 第 6 条）。

## 1. 选行

| 文件 | 池内 | 池外 | 本批 | 批后 weak |
| --- | ---: | ---: | ---: | ---: |
| `packages/ui/src/WorkspaceFileTree.tsx` | 7 | 0 | 7 | 0 |
| `packages/ui/src/components/ai-elements/image-preview-dialog.tsx` | 7 | 0 | 7 | 0 |
| `packages/ui/src/components/ai-elements/inline-citation.tsx` | 7 | 0 | 7 | 0 |
| `packages/ui/src/components/ui/pptx-preview-viewer.tsx` | 7 | 0 | 7 | 0 |
| **合计** | **28** | **0** | **28** | **0** |

- 目录/功能域分布：`packages/ui/src`（文件树）1 个、`packages/ui/src/components/ai-elements` 2 个、
  `packages/ui/src/components/ui` 1 个——同一包内、同一阅读域，符合 §6.1 第 5 条的聚类要求。

## 2. 改动内容

- `WorkspaceFileTree.tsx`：`ResizeObserver` 决定 `isNarrow`、仅挂载时绑定；宽屏读 `workspace store` 偏好；
  `navigationOnly` 用 Panel 折叠替代样式隐藏、`useLayoutEffect` 提前布局；两个面板共用 `navigationOnly`；
  导航前补目标工作区；自动收起只改临时覆盖 `state` 不回写偏好。
- `image-preview-dialog.tsx`：`blob` 原样交给 `createObjectURL`；后缀集由 `imageExtensionByMediaType` 推导；
  `maxX/maxY` 的 0 下限；空 `src` 的 anchor 导航；`imageDownloadFilename` 以 `blob.type` 协商；
  `activeItemIsVideo` 同帧派生；`pointer` 先 `delete` 再取剩余值。
- `inline-citation.tsx`：`InlineCitation` 组件族总述；`openDelay` 缺省 0；`openDelay` 与 `open` 同属契约；
  `InlineCitationCarousel` 宽度由外层决定；`InlineCitationCarouselNext` 与上页对称；
  `InlineCitationSource` 纯展示；`InlineCitationQuote` 的 `children` 原样透传。
- `pptx-preview-viewer.tsx`：`Thumbnail` 仅 `onSelect`；`buttonRef` 兼作观测与定位目标；
  未挂载分支无 `cleanup`；复位 `pageIndex`/`scale`/`selection`/`editDraft`；
  只豁免 `INPUT`/`TEXTAREA`/`contentEditable`；`fitScale` 先适配再乘 `zoom`；`referenceNavigation` 先清 `selection`。

## 3. 门禁读数

```text
gate: PASS start     n=0 t-start=2026-11-11T16:58:29.558Z pre-weak=b345-repo-post.txt
gate: PASS scope     n=0 plan=28 allow=0 diff_old=28 diff_new=28 out_of_scope_edits=0
gate: PASS record    n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify    n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit    n=0 sha=b3baa8c0 files=4/4 numstat=28/28 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=28 added=0 allowed=37 auto_self_clear=0
gate: PASS order     total=151.0s controllable=119.0s
```

## 4. 首轮命中与返修

- 判据首轮 **3 hit**，全部是 **L 无信息列举**（顿号/逗号成串但缺谓词）：
  `image-preview-dialog.tsx:9`（补 `会原样交给`）、`:143`（补 `会导致位移越界`）、
  `pptx-preview-viewer.tsx:645`（补 `会把…复位`）。改后 `hits=0`。
- `numstat` 四文件各 7 行 = 28，与 plan 一致；无越界。

## 5. 自清（本批 0 行；累计 9 行 / 9 文件，其中自动 4）

- `pool-diff removed=28 added=0 auto_self_clear=0`，与 plan 完全重合。
- 累计表见 INDEX §12.7：现有 9 条（b307/b310/b311/b312/b313 人工，b325/b331/b341/b345 自动），
  均为 1 行/条、9 个不同文件，**尚无一条被回头读过**；距阈值 20 行还差 11 行。
- 阈值（§12.7）：累计 >20 行 或 >剩余行数 2%（当前 2% × 1,322 = 26 行）即触发回填重读。

## 6. 池外对账（两个口径）

- 全仓（句子级）weak：`post-b345 4,592` → `post-b346 4,564`（**−28**），文件 `1,720 → 1,716`（四个文件全清）。
- **句子级口径**：`done 6,099 / remain 1,322`，`6,099 + 1,322 = 7,421`，**82.2%**。
- **逐行口径**：`remain ≈ 1,322 + 1,046 = 2,368`，`done ≈ 5,053 / 7,421`，约 **68.1%**。
- 池外：`4,564 − 1,322 = 3,242`，永久不排期。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0 max=8` → **PASS**。
- `capacity-estimate --batch b346`：`done files=479 (+4) / lines=6,099 (+28)`，
  `REMAIN 528 files / 1,322 lines`，`ALIGNED acct_remain=1322 pool_remain=1322 diff=0`，分档合计 265 批。
- `ledger-assert`：`479 + 528 = 1,007`、`6,099 + 1,322 = 7,421` → **PASS**。
- 白名单重跑到 `b3baa8c0`，**510 行**（开批前 508 行 + 本批两条）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node _annot_baseline/cand-generic.mjs d:/code/_annot_baseline/b345-repo-post.txt
node _annot_baseline/pick-generic.mjs b346 d:/code/_annot_baseline/b346-files.txt d:/code/_annot_baseline/b345-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b346 --start
node _annot_baseline/judge-generic.mjs b346
node _annot_baseline/gate-run.mjs --batch b346 --subject "注释清水 b346：4 文件 1→1 改写"
node _annot_baseline/deep-quality.mjs d:/code/ZCode --root packages,apps,docs/knip --list-weak > _annot_baseline/b346-repo-post.txt
node _annot_baseline/deep-quality.mjs d:/code/ZCode --file-list d:/code/_annot_baseline/b254-802-files.txt --list-weak > _annot_baseline/b346-guard-post.txt
node d:/code/ZCode/docs/annotation/_tools/weak-guard.mjs --pre d:/code/_annot_baseline/b345-guard-post.txt --post d:/code/_annot_baseline/b346-guard-post.txt
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak d:/code/_annot_baseline/b346-repo-post.txt --pre-weak d:/code/_annot_baseline/b345-repo-post.txt --batch b346
```

## 9. 计时口径（A 段序列）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `f3d1459b`） | 批次提交 `b3baa8c0` | 151.0s | 5.39s |
| `controllable` | `--start`（16:58:29.558Z） | 批次提交 | 119.0s | 4.25s |
| 起草段 | `b346-files.txt`（00:58:26） | `--start` | 3s | — |
| 收口段 | 批次提交（01:00:28） | 台账提交（01:01:37） | 69s | — |
| `批墙钟` | 本批最早可观测产物（00:58:26） | 台账提交 `85a3b9c8`（01:01:37） | 191s | 6.82s |

- 本批属**形状 A** 段，只与 A 段比较；b350 起另起 B 段。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，508 行） | `f3d1459b` | 2 文件 |
| 批次本体（4 文件 1→1 改写） | `b3baa8c0` | `+28/−28` |
| `ZC-deep-b346-rewrite.tsv` + 白名单 510 行 + 本台账 + INDEX（含 §12.7 累计表） | `85a3b9c8` | — |

- 收口判据：A1 `remain=1,322≠0`；A2 `6,099 + 1,322 = 7,421` 成立；A3 `ledger-assert PASS`；
  A4 `6,099 + 0 + 1,322 = 7,421` 成立。
