# ZC-deep-b378

> 批次：b378 ｜ **10 行 / 10 文件（全 1 行文件批）** ｜ 提交 `6507ed19`

## 0. 普通批；`fix=0`；**判据类 0.0% / 格式类 0 / lint 0**

- `plan_lines_covered=10/10`；`removed=10 added=0 allowed=22 auto_self_clear=0`。
  `allowed=22 = plan 10 + POOL-SELF-CLEAR 12`，验证了 INDEX §6.2 第 25 条的公式（plan 变 10，`allowed` 就变 22）。
- 首轮 **0 行命中**（判据类 0 / 格式类 0 / lint 0），六闸一次过（`record_runs=1`）。
- **`0` 只表示写盘后没返工**，不表示一次写对；本批连 lint 都没触发，是因为 10 行都是单句改写。
- **本批不是普通排期批，是测量批**：刻意取装箱的**最后一批（全 1 行文件）**，
  用来实测「每文件固定成本」，对应 INDEX §6.2 第 23 条的双参数估计器。

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/v4/ConversationShareSuccessDock.tsx` | 1 | 0 |
| `packages/ui/src/v4/conversationTurnWorkSegments.ts` | 2 | 1 |
| `packages/ui/src/v4/featureSuggestedPrompts.ts` | 1 | 0 |
| `packages/ui/src/v4/sessionsIndexStore.ts` | 1 | 0 |
| `packages/ui/src/v4/telemetry/localTtftObserver.ts` | 1 | 0 |
| `packages/ui/src/web-remote-control/WebRemoteControlDialog.tsx` | 1 | 0 |
| `packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts` | 1 | 0 |
| `packages/ui/src/workspace-plugin-preview/WorkspacePluginPreview.tsx` | 1 | 0 |
| `packages/ui/src/WorkspaceHelpMenuButton.tsx` | 1 | 0 |
| `packages/web/src/web-remote-control/domain/webRemoteControlScreenCopy.ts` | 1 | 0 |
| **合计** | **11** | **1** |

**固定对账列（§6.2 第 24 条，每批必报）**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 可清 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | --- |
| **10** | **9** | **0** | 1,547 → 1,538 | **18** | `1,547 − 9 + 0 = 1,538` ✔ |

- 唯一未全仓清零的是 `conversationTurnWorkSegments.ts`：池内改写 1 行，仍留 1 行池外上游残留（`2 → 1`），
  与 `pick` 的 `upOut=1` 一致。**无新进 weak，无质量问题**。
- 顶层目录 **2 个**（`packages/ui` 9 个 + `packages/web` 1 个）。

## 2. 改动内容

- `ConversationShareSuccessDock.tsx`：模块职责三段（链接 / 警告 / 三个动作）。
- `conversationTurnWorkSegments.ts`：被剔除行不回填 `segmentFollowingRows`。
- `featureSuggestedPrompts.ts`：`tianyancha` 的输出是尽调清单，须带日期与来源。
- `sessionsIndexStore.ts`：`applySessionsIndexFrame` 是纯函数，可脱生命周期单测。
- `localTtftObserver.ts`：满 `LOCAL_TTFT_MAX_PENDING` 只回收已收口观察。
- `WebRemoteControlDialog.tsx`：`REMOTE_CONTROL_BOT_ENTRIES` 不补占位项。
- `useWorkspaceFileTreeData.ts`：`gitStatusRequestVersionRef` 只在单处读写。
- `WorkspacePluginPreview.tsx`：`selectPlugin` 只转发，不记最近使用、不持久化。
- `WorkspaceHelpMenuButton.tsx`：动作表只创建一次并复用。
- `webRemoteControlScreenCopy.ts`：`desktop-bootstrap-timeout` 的下一步先查桌面端状态。

## 3. 六闸

```
gate: PASS scope n=0 plan=10 allow=0 diff_old=10 diff_new=10 out_of_scope_edits=0 plan_lines_covered=10/10
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=6507ed19 files=10/10 numstat=10/10 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=10 added=0 allowed=22 auto_self_clear=0
gate: PASS order n=0 total=861.0s controllable=91.0s
GATE ALL PASS batch=b378 sha=6507ed19
```

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` 数据行仍 **12 条**。

## 5. 进度

- 全仓 weak：**3,703 → 3,693**（−10）；filler 89 不变；weak 文件 **1,547 → 1,538**（末行 `files=`）。
- 池内：**454 行 / 314 文件**（`ACCT files 693 + 314 = 1,007`、`ALIGNED diff=0`、`ASSERT PASS`）。
  文件侧减少 **10**（池内清零），全仓集合只少 **9**。
- `done 6,967 / remain 454`；`6,967 + 454 = 7,421`。
- **行侧进度 93.9%**（6,967 ÷ 7,421）；文件侧 `693 ÷ 1,007 = 68.8%`（辅助）。
- 可清 **18**（1,538 − 1,520）；含不可写残留 **1,520** 未变。
- 剩余批数（cap 10）：**32 批**（314 ÷ 10），行/批均值 `454 ÷ 32 = 14.2`。

## 6. 计时（分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `e61bcb23`（15:19:05） | `6507ed19`（15:35:26） | 861.0 |
| `controllable` | `--start`（15:33:55） | 批次提交 | **91.0**（`s/行 = 9.10`、`s/文件 = 9.10`） |
| **S0** 提交 → 收口第一条命令 | 15:35:26 | 15:35:43 | **17** |
| **S1** 全仓扫描 | 15:35:43 | 15:35:51 | **8** |
| **S2** 集合对账 + rewrite.tsv + `own-commits-gen` + `capacity` | 15:35:51 | 15:36:10 | **19** |
| **S3** 台账 | 15:36:10 | 15:36:30 | **20** |
| **S4** `git add` + `commit` | 15:36:30 | 15:36:31 | **1** |
| **合计** | 15:35:26 | 15:36:31 | **65s** |
| `批墙钟` | 15:33:55 | 15:36:31 | **156s** |

- `s/行 = 9.10` 是全线最高，但它不是质量问题：**本批只有 10 行，固定成本占比最大**。
  它真正说明的是「10 个文件的底价约 91s」，这一点见 §7。

## 7. 双参数估计器（本批的主要产出）

两个实测点（同为 10 文件，行数不同）：

| 点 | 文件 | 行 | `controllable` | `s/行` |
| --- | ---: | ---: | ---: | ---: |
| P1 = b377 | 10 | 30 | 163.0 | 5.43 |
| P2 = b378 | 10 | 10 | 91.0 | 9.10 |

解 `controllable = c_f × 文件 + c_l × 行`：

- `c_l = (163 − 91) ÷ 20 = **3.6 s/行**`
- `c_f = (91 − 10×3.6) ÷ 10 = **5.5 s/文件**`（截距归零后并入）

~~即**每批起草底价 ≈ `5.5 × 10 = 55s`，与行数几乎无关**；每行只再加 3.6s。~~
**⚠ 作废（b380 订正）**：这个「55s 底价」是 `c_f × 10 = 5.5 × 10` 的乘积，**不是独立测出来的固定项**。
`c_f` 被 b380 的反向对照否掉（`F=5/L=15` 与 `F=10/L=16` 同为 118s）后，55s 失去来路；
当前有效的每批固定项是**过定拟合的 `a = 61.4s`**（四点、最大残差 5.0s），两个数**不能并存**。
再加实测收口 `68s`，得单批墙钟 `68 + 55 + 3.6 × 行`：

- 复算 b377：`68 + 55 + 108 = 231s`（实测 231）✔
- 复算 b378：`68 + 55 + 36 = 159s`（**实测 156s**，误差 3s）。
  **口径订正（b379）**：这不是「参数得到验证」。两个点解两个未知数，残差恒为 0，
  所以 `159 vs 156` 只检验了 **`墙钟 = 起草 + 收口` 的可加性**，与 `c_f`/`c_l` 准不准无关。
  b379 用第三个不同形状的点（`F=5, L=15`）外推，得到 **118s 对预测 81.5s（+45%）**，
  **把 `c_f = 5.5` 证伪了**；三点解出 `c_f ≈ −1.8`、`a = 73s/批`、`c_l = 3.6`，
  正确结论是「每文件成本 ≈ 0，成本按批 + 按行」。
- **本批形状不是随机批**：`10 个文件各 1 行`是装箱的**最后一批**，即「最省形状」（每文件只读一两行上下文）。
  它给出的 `c_f` 天生偏小，**不得当作平均形状引用**；尾段真实批是 `1.4 行/文件`但上下文更长。

**⚠ 以下这段点估计已被 b379 证伪，保留原文只作对账**：`c_f = 5.5` 不成立（三点解 ≈ 0），
`1.54h` 也不是「双参数估计」，它只是两点解的顺推；当前有效的估计见 INDEX §6.2 第 23 条。

~~剩余 32 批（314 文件 / 454 行）：`32 × 68 + 314 × 5.5 + 454 × 3.6 = 5,537s ≈ 1.54h`。~~

**滚动中位（窗口移到 b376–b378）**：中位 `s/行 = 7.00`（7.00 / 5.43 / 9.10）、
中位收口 `68s`、中位墙钟 `231s` → 下沿 `32 × (14 + 14.2×7.00 + 68) = 5,805s = 1.61h`、
上沿 `32 × 231 = 7,392s = 2.05h`，即 **1.6–2.1h**。

两个方法给出 **1.54h 对 1.6–2.05h**：双参数法贴下沿且不越界，说明下沿偏低已被修正到同一量级。
主报取窗口法 **1.6–2.1h**（口径不变），双参数法只作交叉验证，不另立区间。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `6507ed19` | `+10/−10` |
| `ZC-deep-b378-rewrite.tsv` + 本台账 + 白名单（656 行） | `a3c85968` | — |
