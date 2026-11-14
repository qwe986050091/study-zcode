# ZC-deep-b376

> 批次：b376 ｜ **30 行 / 10 文件** ｜ 提交 `f06e7c91`

## 0. 普通批；`fix=0`；**判据类 0.0% / 格式类 0 / lint 1**

- `plan_lines_covered=30/30`；`removed=30 added=0 allowed=42 auto_self_clear=0`。
- 首轮 **0 行命中**：precheck `missing_anchor=0 missing_predicate=0`、`judge hits=0`、六闸一次过
  （`record_runs=1`，无复跑）。
- **`0` 只表示「写盘后没返工」，不表示「一次写对」**：本批 lint 在写盘前拦下 1 条（`预检` 计数见 §0 标题），
  若那条直接写盘，判据类就是 1。与历史 `34/330` 的关系见 INDEX §6.2 第 16 条三列口径。
- 口径收获：**`plan-new` 的前置自检可以在落笔前跑**——本批先把 30 条草稿当纯文本过一遍
  `[、,，]` 计数 + `ANCHOR` 正则，再落盘，于是 precheck 首轮全 0。这是第 1 次「零返工批」。

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/stream-animate/src/server/deepseekRunner.ts` | 3 | 0 |
| `packages/ui/src/AssistantPreviewCards.tsx` | 3 | 0 |
| `packages/ui/src/components/ai-elements/attachments.tsx` | 3 | 0 |
| `packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx` | 3 | 0 |
| `packages/ui/src/components/ai-elements/reasoning.tsx` | 4 | 1 |
| `packages/ui/src/components/cloud-content-dialog/CloudDialogDescription.tsx` | 3 | 0 |
| `packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.tsx` | 3 | 0 |
| `packages/ui/src/components/marketing-touch/marketingPopupAdapter.ts` | 3 | 0 |
| `packages/ui/src/components/marketing-touch/marketingResources.ts` | 4 | 1 |
| `packages/ui/src/components/ui/floating-particles.tsx` | 3 | 0 |
| **合计** | **32** | **2** |

**固定对账列（§6.2 第 24 条，每批必报）**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 恒等式 |
| ---: | ---: | ---: | --- | --- |
| **10** | **8** | **0** | 1,563 → 1,555 | `1,563 − 8 + 0 = 1,555` ✔ |

- 剩 2 行池外残留：`reasoning.tsx:237`（blame `872ad960`）、`marketingResources.ts:138`（`aac47556`），
  与 `pick` 的 `up/out` 完全一致；**无新进 weak，无质量问题**。
- 顶层目录 **3 个**（stream-animate / ui / 其余全在 ui 子树）。

**⚠ 计数口径订正（本批发现）**：`1,563` / `1,555` 取 `deep-quality.mjs` 末行 `WEAK lines=N files=M` 的 `M`。
此前记录的 `1,564`（b375）/ `1,572`（b374）/ `1,577`（b373）都比末行 **+1**，
来历已查不到（同期实际存在第二份计数，已弃用）。**差值不受影响**（−8 / −5 / −7 与末行一致），
只有绝对值偏 1。从本批起 `files=M` 为唯一真源，旧值在 §6.2 第 24 条作订正。

## 2. 改动内容

- `deepseekRunner.ts`：`buildMetrics` 是速率唯一计算点；分桶不回读 `TimedCharEvent`；`durationMs=0` 直接记 0 速率。
- `AssistantPreviewCards.tsx`：卡片形态只改 `buildAssistantPreviewPptxAutoOpenRequest` 一处；
  `visibleCards` 已是最终投影不再二次过滤；并集不拆早退，两处调用同源。
- `attachments.tsx`：`AttachmentsProps` 只透传 div 属性；`showMediaType` 不参与分类；`AttachmentEmpty` 不接管加载/错误态。
- `diagram-preview-dialog.tsx`：`handleKeyDown` 只认三键；`panDiagram` 两轴取负；`nextDistance / gesture.distance` 是本帧增量。
- `reasoning.tsx`：`useReasoning` 渲染期抛错；`useControllableState` 多渲染一次是既有行为；`startTimeRef` 结束后立即清空。
- `CloudDialogDescription.tsx`：`TAGS` 白名单；`BLOCK_TAGS` 行内降级；两者刻意分开维护。
- `CodingPlanQuotaResetAction.tsx`：`MANUAL_RESET_SUCCESS_DISPLAY_MS` 与撒花解耦；`previousCompletedAtRef` 识别跳变；
  `awaitingSuccessRender` 三条件合取。
- `marketingPopupAdapter.ts`：`visibilityState` 前置；两种 `role` 对话框都算打断；三类弹窗选择器来源。
- `marketingResources.ts`：`empty()` 自带空 `release`；`entitlements` 只取前 32；只累计 `model_usage`。
- `floating-particles.tsx`：`seededUnit` 的 `salt` 维度；`opacity` 按 `highlight` 分档；`createParticleSprite` 的辉光分支。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=f06e7c91 files=10/10 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=42 auto_self_clear=0
gate: PASS order n=0 total=640.0s controllable=210.0s
GATE ALL PASS batch=b376 sha=f06e7c91
```

- 一次通过，无复跑（`record_runs=1`）。

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` 数据行 **12 条**（b379 复核：手工 6 + 自动 6；旧记 11 漏了 b373 的自动登记）。

## 5. 进度

- 全仓 weak：**3,763 → 3,733**（−30）；filler 98 → 92；weak 文件 **1,563 → 1,555**（末行 `files=`）。
- 池内：**494 行 / 334 文件**（`ACCT files 673 + 334 = 1,007`、`ALIGNED diff=0`、`ASSERT PASS`）。
  **文件侧减少的是 10（池内清零），不是 8**——`673 − 663 = 10`、`344 − 334 = 10`；
  8 只作用在「全仓有 weak 的文件」那一列（1,563 → 1,555）。这正是两个口径必须分开记的原因。
- `done 6,927 / remain 494`；`6,927 + 494 = 7,421`。
- **行侧进度 93.3%**（6,927 ÷ 7,421）——唯一进度分母；文件侧 `673 ÷ 1,007 = 66.8%`（辅助）。
- 可清 **35**（1,555 − 1,520）；含不可写残留 **1,520** 未变。
- 剩余批数（cap 10）：**34 批**（334 ÷ 10），行/批均值 `494 ÷ 34 = 14.5`。

## 6. 计时（分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `7263c747`（14:29:08） | `f06e7c91`（14:39:48） | 640.0 |
| `controllable` | `--start`（14:36:18） | 批次提交 | **210.0**（`s/行 = 7.00`） |
| **S0** 提交 → 收口第一条命令 | 14:39:48 | 14:40:24 | **36** |
| **S1** 全仓扫描 + 集合对账 | 14:40:24 | 14:41:12 | **48**（扫描 8 / 对账 40） |
| **S2** `own-commits-gen` + `capacity` | 14:41:12 | 14:42:46 | **94** |
| **S3** rewrite.tsv + 台账 + INDEX 订正 | 14:42:46 | 14:43:14 | **28** |
| **S4** `git add` + `commit` | 14:43:14 | 14:43:15 | **1** |
| **合计** | 14:39:48 | 14:43:15 | **207s** |
| `批墙钟` | 14:36:18 | 14:43:15 | **417s** |

- `controllable 210s / 30 行 = 7.00` 是本线最高值，原因是**读文件**：30 行散在 10 个文件、
  其中 4 个文件需要读到上下文 30 行以上才敢改写，共 11 次 Read。这不是收口成本，是起草成本。
- **S2 的 94s 里有 86s 是废动作**：第一次 `capacity` 漏 `--weak`、第二次漏 `--repo`，两次都直接退出。
  有效执行只有 `own-commits-gen 1s` + `capacity 1s`。**这段不该记成「工具慢」**，是我的参数记忆成本。

## 7. 滚动中位（窗口移到 b374–b376）

| 窗口 | 中位 `s/行` | 中位收口 | 中位墙钟 | 剩余批数 | 区间读数 |
| --- | ---: | ---: | ---: | ---: | --- |
| b373–b375（上轮主报） | 3.73 | 55s | 174s | 35 | 1.2–1.7h |
| **b374–b376（本轮）** | **3.97** | **61s** | **417s** | **34** | **1.3–3.9h** |

- 窗口移动：`174s`（b375 墙钟）移出、`417s`（b376）移入 → 中位墙钟 `174 → 417s`；中位收口 `55 → 61s`（b374 的 61 顶上来）。
- 下沿 `34 × (14 + 14.5×3.97 + 61) ≈ 4,575s = 1.27h`；上沿 `34 × 417s ≈ 14,178s = 3.94h`。
- **本批把上沿从 1.7h 推到 3.9h 的两项都是本批自身成本，不是工具回归**：
  ① 起草 7.00 s/行（11 次 Read）；② 收口 207s（其中 86s 是我两条命令参数写错）。
  工具段仍是 **9s**（扫描 8 + 白名单/容量 1），与 b374 实测一致，**没有新证据支持「收口 ≤60s 可常态复现」**。
  因此按规则**不上调下沿、也不下调上沿**，主报取窗口值 **1.3–3.9h**；下一次替换 = 窗口 b375–b377。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `f06e7c91` | `+30/−30` |
| `ZC-deep-b376-rewrite.tsv` + 本台账 + 白名单（648 行）+ INDEX 集合口径 | `c17c73a8` | — |
