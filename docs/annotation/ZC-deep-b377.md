# ZC-deep-b377

> 批次：b377 ｜ **30 行 / 10 文件** ｜ 提交 `4291eea2`

## 0. 普通批；`fix=0`；**判据类 0.0% / 格式类 0 / lint 1**

- `plan_lines_covered=30/30`；`removed=30 added=0 allowed=42 auto_self_clear=0`。
- 首轮 **0 行命中**，六闸一次过（`record_runs=1`）。
- **`0` 只表示「写盘后没返工」，不表示「一次写对」**：lint 在写盘前拦下的那 1 条若直接落盘就会判否。
  三列口径见 INDEX §6.2 第 16 条。
- 落笔前文本级 lint 拦下 **1 条**：`previewPaneOfficeLegacyDocContent.tsx:64` 草稿写成
  「容差 0.001、尺寸容差半像素」——顿号 + 逗号共 2 个分隔符，命中 L「无信息列举」。
  改成「容差 0.001 与尺寸容差半像素」后通过。**lint 拦在写盘前，所以这批没有产生返工。**

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/DeleteAllArchivedTasksButton.tsx` | 3 | 0 |
| `packages/ui/src/feedback/FeedbackProcessView.tsx` | 3 | 0 |
| `packages/ui/src/git-graph/layout.ts` | 3 | 0 |
| `packages/ui/src/git-graph/layoutAlgorithm.ts` | 3 | 0 |
| `packages/ui/src/lib/codeCommentContext.ts` | 3 | 0 |
| `packages/ui/src/lib/codingPlanUsageSources.ts` | 3 | 0 |
| `packages/ui/src/mentions/components/MentionPanel.tsx` | 4 | 1 |
| `packages/ui/src/ModelTrajectorySearch.ts` | 3 | 0 |
| `packages/ui/src/plugin-ui/adapters/usePluginUiToolCallModel.ts` | 5 | 2 |
| `packages/ui/src/previewPaneOfficeLegacyDocContent.tsx` | 3 | 0 |
| **合计** | **33** | **3** |

**固定对账列（§6.2 第 24 条，每批必报）**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 恒等式 |
| ---: | ---: | ---: | --- | --- |
| **10** | **8** | **0** | 1,555 → 1,547 | `1,555 − 8 + 0 = 1,547` ✔ |

- 剩 3 行池外残留：`MentionPanel.tsx:186` 之外的 1 行、`usePluginUiToolCallModel.ts` 2 行，
  与 `pick` 的 `up/out=3` 完全一致；**无新进 weak，无质量问题**。
- 顶层目录 **1 个**（全部在 `packages/ui` 子树）。

## 2. 改动内容

- `DeleteAllArchivedTasksButton.tsx`：`inFlight` 与 `busy` 各管一层；拆两个状态的原因；`actionLabel` 只看 `busy`。
- `FeedbackProcessView.tsx`：三段编排；`timelineItems` 为空时 `latestItem` 为 undefined；`onSubmitted` 转发父级刷新。
- `git-graph/layout.ts`：五个像素项可选；`buildEdgePath` 用贝塞尔换平滑；`layoutGitGraph` 不做增量。
- `git-graph/layoutAlgorithm.ts`：`getWidthLaneIndex` 返回上界；`availableColours` 池尾追加；`determineMergePath` 命中即中断。
- `codeCommentContext.ts`：注释体也 `trim()`；`parseLineRange` 四种格式；`dispatchCodeCommentAddToChat` 的取消语义。
- `codingPlanUsageSources.ts`：`subscribedTeamProducts` 是唯一输入 / 决定返回顺序 / 去重不移动首次位置。
- `MentionPanel.tsx`：空态行不进 `flatOptionIndex`；`MentionPanel` 只做编排；`updateScrollMaskState` 不挡命中。
- `ModelTrajectorySearch.ts`：`TrajectorySearchRevealContext` 的语义与单键约束；`findTrajectoryTextMatches` 的终止条件。
- `usePluginUiToolCallModel.ts`：`toolSurfaceKey` 与面板键不可互替；`supportedScope` 是唯一闸门；`inlineActive` 为假只留记录。
- `previewPaneOfficeLegacyDocContent.tsx`：`isSameDocxPreviewFit` 的两档容差；组件只做三态渲染；成功态回调。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=4291eea2 files=10/10 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=42 auto_self_clear=0
gate: PASS order n=0 total=451.0s controllable=163.0s
GATE ALL PASS batch=b377 sha=4291eea2
```

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` 数据行 **12 条**（b379 复核：手工 6 + 自动 6；旧记 11 漏了 b373 的自动登记）。

## 5. 进度

- 全仓 weak：**3,733 → 3,703**（−30）；filler 92 → 89；weak 文件 **1,555 → 1,547**（末行 `files=`）。
- 池内：**464 行 / 324 文件**（`ACCT files 683 + 324 = 1,007`、`ALIGNED diff=0`、`ASSERT PASS`）。
  文件侧减少 **10**（池内清零），全仓集合只少 **8**。
- `done 6,957 / remain 464`；`6,957 + 464 = 7,421`。
- **行侧进度 93.7%**（6,957 ÷ 7,421）；文件侧 `683 ÷ 1,007 = 67.8%`（辅助）。
- 可清 **27**（1,547 − 1,520）；含不可写残留 **1,520** 未变。
- 剩余批数（cap 10）：**33 批**（324 ÷ 10），行/批均值 `464 ÷ 33 = 14.1`。

## 6. 计时（分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `9fa01291`（14:53:0x） | `4291eea2`（14:56:44） | 451.0 |
| `controllable` | `--start`（14:54:01） | 批次提交 | **163.0**（`s/行 = 5.43`） |
| **S0** 提交 → 收口第一条命令 | 14:56:44 | 14:56:53 | **9** |
| **S1** 全仓扫描 | 14:56:53 | 14:57:01 | **8** |
| **S2** 集合对账 + `own-commits-gen` + `capacity` | 14:57:01 | 14:57:33 | **32** |
| **S3** rewrite.tsv + 台账 | 14:57:33 | 14:57:51 | **18** |
| **S4** `git add` + `commit` | 14:57:51 | 14:57:52 | **1** |
| **合计** | 14:56:44 | 14:57:52 | **68s** |
| `批墙钟` | 14:54:01 | 14:57:52 | **231s** |

- S2 的 32s 里有一次 `capacity` 报 `MISMATCH diff=30`：因为 `ZC-deep-b377-rewrite.tsv` 还没落盘，
  工具按「出现在任一 rewrite.tsv 即算已排期」判定，b377 的 10 个文件被当成本批未排期。
  **重跑前必须先落 rewrite.tsv**——这条是本批新增的固定顺序，写进 §5.3 起草清单。

## 7. 滚动中位（窗口移到 b375–b377）

| 窗口 | 中位 `s/行` | 中位收口 | 中位墙钟 | 剩余批数 | 区间读数 |
| --- | ---: | ---: | ---: | ---: | --- |
| b374–b376（上轮主报） | 3.97 | 61s | 417s | 34 | 1.3–3.9h |
| **b375–b377（本轮）** | **5.43** | **68s** | **231s** | **33** | **1.5–2.1h** |

- 窗口移动：`451s`（b374）移出、`231s`（b377）移入 → 中位墙钟 `417 → 231s`；
  中位 `s/行 3.97 → 5.43`（7.00 的 b376 留在窗口内）；中位收口 `61 → 68s`。
- 下沿 `33 × (14 + 14.1×5.43 + 68) ≈ 5,233s = 1.45h`；上沿 `33 × 231s ≈ 7,623s = 2.12h`。
- **主报 = `1.5–2.1h`（唯一区间）**：上沿比上轮降 1.8h，因为 417s 那个离群值滚出窗口；
  下沿升 0.2h，因为中位 `s/行` 被两批「读文件多」的批次抬高到 5.43。两个方向都来自窗口替换，没有改口径。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `4291eea2` | `+30/−30` |
| `ZC-deep-b377-rewrite.tsv` + 本台账 + 白名单（652 行） | `a0d9aca6` | — |
