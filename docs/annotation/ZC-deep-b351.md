# ZC-deep-b351

> 批次：b351 ｜ **36 行 / 6 文件** ｜ 提交 `4db34c86`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`（含 `plan_lines_covered`）、`gate-run.mjs`

## 0. 形状 B 定案后的第 1 批（cap 6，无固定行目标）

- 形状 B 已按 §6.1 第 5 条定案：**cap 6 文件、无 33 行目标、目录聚类软约束（≤4 个顶层目录）**。
- `TALLY {"ownIn":36,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":36,"planOut":0}` / `plan=36` / `files=6/6`。
- 36 行是「贪心装箱取整批候选」的结果，**不按 33 凑**；本批正好落在 36，属巧合而非目标回归。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/shared/src/model-provider-family.ts` | 6 | 6 | 0 | shared |
| `packages/shared/src/telemetry.ts` | 6 | 6 | 0 | shared |
| `packages/ui/src/browser-use/useResponsiveBrowserViewportControl.ts` | 6 | 6 | 0 | ui/browser-use |
| `packages/ui/src/feedback/FeatureRequestDialog.tsx` | 6 | 6 | 0 | ui/feedback |
| `packages/ui/src/feedback/feedbackSubmissionJob.ts` | 6 | 6 | 0 | ui/feedback |
| `packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts` | 6 | 6 | 0 | ui/hooks |
| **合计** | **36** | **36** | **0** | — |

- **目录分布**：顶层目录 **2 个**（`packages/shared` 2、`packages/ui` 4），在软约束（≤4 个顶层目录）内；
  `packages/ui` 内部跨 4 个子域（`browser-use` / `feedback` 2 / `hooks`），同域优先已做到能做的程度。
- 选行来自 `capacity-estimate --plan 6x100` 的 `PLAN#1`（6 文件 / 36 行，`writable=36`），
  不是从全池里手挑。

## 2. 改动内容

- `model-provider-family.ts`：管理地址的推导来源写成 `buildBigModelCodingPlanTeamManageUrl` + `ZCODE_ENV`；
  索引键类型写成 `ModelProviderFamilyId`；`flatMap` 展开三档套餐后反查唯一；`hostname` 转小写的理由写成「否则大小写不同会判成两个家族」；
  根域命中写成 `等于 rootDomain 或以 .rootDomain 结尾`；遍历顺序写成「追加在末尾不影响已有匹配」。
- `telemetry.ts`：`new URL` 抛错返回空串而非回落到原始输入；成功路径写 `parsed.hostname.toLowerCase()`；
  `resolveSafeTelemetryHostname` 的「只提取不校验」写明调用方只能据空串判断；屏幕尺寸回落写成零宽高占位；
  取值链写成 `options → Intl.resolvedOptions → 固定默认值`；三个字段写明只进 `TelemetryRendererContext`。
- `useResponsiveBrowserViewportControl.ts`：上报前用 `{ ...responsiveViewportSizeRef.current }` 复制；
  `applyResponsiveMode` 的重置条件写成 `nextMode` 由假转真；该函数不调平台接口；`null` 表示退出响应式；
  effect 的三条件写成 `isResponsiveMode` 与上一帧同为真且缩放变化；订阅的事件名写成 `platform.onBrowserViewViewportChanged`。
- `FeatureRequestDialog.tsx`：字段上限写成 `FEATURE_TEXT_MAX` / `CONTACT_MAX`；`handleClose` 先调 `cancelActiveCreate`；
  `handleReset` 只清 `description` / `solution` / `error` 且保留 `contact`；`handleSubmit` 的步骤写成具体调用；
  同步抛错时 job 尚未生成故只复位 `submitting`；正文模板写成按三段顺序拼标题。
- `feedbackSubmissionJob.ts`：`subscribeFeedbackSubmissionJobs` 先登记再回调；`dismissFeedbackSubmissionJob` 只移除展示项；
  `activeUploadProgressId` 必须在三条路清回 `null`；已有 `ticketId` 只能 `cancelUpload`；
  `uploadLogsUntilComplete` 写成先 `prepareCompactLogArchive` 再循环上传；`shouldRetryLogUpload` 只由取消错误驱动。
- `useWebRemoteControlTaskOpen.ts`：两个工作区键的来源写成 `resolveWebRemoteControlWorkspaceKey`；
  `onTaskOpen` 早于请求；写未读的三条件写成具体字段；失败只走 `logger.warn`；
  显式调 `markTaskRead`；断连分支写成 `isDisconnectedRemoteWorkspaceBridgeError` 命中后调 `onNavigateHome`。

## 3. 六闸

```
gate: PASS scope n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0 plan_lines_covered=36/36
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=4db34c86 files=6/6 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=36 added=0 allowed=45 auto_self_clear=0
gate: PASS order n=0 total=161.0s controllable=160.0s
```

- `plan_lines_covered=36/36`（第 2 批必报项，正控）。

## 4. 判据与返修（`fix`）

`fix=0/0/0s`

- `judge` **首跑即 `hits=0`**，无回改；`deep-quality` 未报空泛提醒/堆叠。
- `b351-fix.tsv` 仍缺（本批未单独记两次 judge 时刻）；b352 起按 §6.2 第 11 条补 `首轮hit/回改行/回改秒`。

## 5. 自清

- `pool-diff removed=36 added=0 auto_self_clear=0`；累计仍 **9 行 / 9 文件**（自动 4、人工 5），距阈值 20 行差 11。

## 6. 池外对账

- 全仓 weak：`post-b350 4,459` → `post-b351 4,423`（**−36**），文件 `1,703 → 1,697`（六个文件全清）。
- **句子级**：`done 6,240 / remain 1,181`，`6,240 + 1,181 = 7,421`，**84.1%**。
- **逐行**：`remain ≈ 1,181 + 1,046 = 2,227`，`done ≈ 5,194 / 7,421`，约 **70.0%**。
- 池外：`4,423 − 1,181 = 3,242`，永久不排期（与 b350 同值，说明本批只动池内行）。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0` → **PASS**。
- `capacity --batch b351`：`done files=503 (+6) / lines=6,240 (+36)`，`REMAIN 504 files / 1,181 lines`，
  `ALIGNED diff=0`；`ledger-assert`：`503 + 504 = 1,007`、`6,240 + 1,181 = 7,421` → **PASS**。
- **批数修正（对 86 的差额）**：`remain=1,255` 时 `PLAN 86 批`；`remain=1,217`（b350 后）时 **85 批**；
  本批后 `remain=1,181` 时 **84 批**（均值 6.0 文件 / 14.1 行）。**两次各减 1 批**，差额正好是
  b350、b351 各自执行掉的 6 文件——它们当时分别是 `PLAN#1`，被执行后该片不再出现在排期里。
- 白名单 542 行（b351 后）。

## 8. 复算命令

```powershell
node docs/annotation/_tools/own-commits-gen.mjs d:/code/ZCode
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak b350-repo-post.txt --plan 6x100 --plan-print 3
node _annot_baseline/pick-generic.mjs b351 d:/code/_annot_baseline/b351-files.txt d:/code/_annot_baseline/b350-repo-post.txt
node _annot_baseline/gate-run.mjs --batch b351 --start
node _annot_baseline/judge-generic.mjs b351
node _annot_baseline/gate-run.mjs --batch b351 --subject "注释清水 b351：6 文件 1→1 改写"
node docs/annotation/_tools/capacity-estimate.mjs --repo d:/code/ZCode --weak b351-repo-post.txt --pre-weak b350-repo-post.txt --batch b351 --plan 6x100
```

## 9. 计时（B 段第 2 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `af1c5142`） | 批次提交 `4db34c86` | 161.0s | 4.47s |
| `controllable` | `--start`（10:53:48） | 批次提交 | 160.0s | 4.44s |
| 起草段 | `b351-files.txt`（10:53:34） | `--start` | 14s | — |
| 收口段 | 批次提交（10:56:28） | 台账提交（10:59:26） | 178s | — |
| `批墙钟` | 最早产物（10:53:34） | 台账提交 `56d56fb1`（10:59:26） | 352s | 9.78s |

- **成本监控首个数据点（§6.1 第 5 条）**：本批 `s/行 = 批墙钟 ÷ 36 = 352 ÷ 36 = 9.78`。
  首批 4.63 s/行 是 6.3 行/文件的集中候选，本批 6.0 行/文件仍是偏集中档（36 行 / 6 文件）。
  9.78 未触发阈值，但**离 12 已经很近**，主要来自 178s 收口段（白名单重生成 + 产能重算 + 台账写作）。
  监控阈值：连续 5 批 >12 s/行 即停批重新定价；当前计数 **0/5**。
- 与 b350 对比（同形状，可合并观察但样本 n=2）：`controllable` 112s → 160s，行数 38 → 36，
  每行 2.95 → 4.44 s/行。差异主要来自本批 6 个文件分属 2 个包、跨包读码成本更高，不是判据返修。

## 10. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，540 行） | `af1c5142` | 2 文件 |
| 批次本体（6 文件 1→1 改写） | `4db34c86` | `+36/−36` |
| `ZC-deep-b351-rewrite.tsv` + 白名单 542 行 + 本台账 + INDEX 同步 | `56d56fb1` | — |

- 收口判据：A1 `remain=1,181≠0`；A2 `6,240 + 1,181 = 7,421`；A3 `ledger-assert PASS`；
  A4 `6,240 + 0 + 1,181 = 7,421`。
