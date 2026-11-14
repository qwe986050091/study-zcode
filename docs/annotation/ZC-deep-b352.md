# ZC-deep-b352

> 批次：b352 ｜ **36 行 / 6 文件** ｜ 提交 `d451994d`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`

## 0. 形状 B 第 3 批（cap 6，无行目标，目录软约束）

- `TALLY {"ownIn":36,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":36,"planOut":0}` / `plan=36` / `files=6/6`。
- 选行来自 `PLAN#1`（6 文件 / 36 行，`writable=36`），不是手挑。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/lib/remoteConnectionPresentationErrors.ts` | 6 | 6 | 0 | ui/lib |
| `packages/ui/src/lib/sessionOpenArmsTelemetry.ts` | 6 | 6 | 0 | ui/lib |
| `packages/ui/src/openWorkspacePageThemeHero.tsx` | 6 | 6 | 0 | ui |
| `packages/ui/src/project-sidebar/useProjectSidebarPreferences.ts` | 6 | 6 | 0 | ui/project-sidebar |
| `packages/ui/src/settings/HooksSection.tsx` | 6 | 6 | 0 | ui/settings |
| `packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts` | 6 | 6 | 0 | ui/settings/model-provider-section |
| **合计** | **36** | **36** | **0** | — |

- **目录分布**：**1 个顶层目录**（`packages/ui`）、5 个子域，比 b350/b351 更聚，符合「同目录优先」的软约束。

## 2. 改动内容

- `remoteConnectionPresentationErrors.ts`：`allowLocalDownload` 写明由分类结果给出；`classifyRemoteConnectionError`
  的查表与 `switch` 分工；`primaryAction` 按七类改写；`target` 缺失时 `kind` 为 `undefined`；
  `formatRemoteConnectionError` 追加 `retryableHint` 的条件；独立提示抑制写成只排除 `source-server-upgrade-required`。
- `sessionOpenArmsTelemetry.ts`：`reporter` 可空的原因；测试清理函数单独命名的理由；`roundedNonNegative` 的四种拒绝输入；
  `build…Payload` 与 `report…Start` 的构造/上报分离；`targetReporter` 优先于全局；返回 `void` 而非 `Promise`。
- `openWorkspacePageThemeHero.tsx`：三套调色板各写成具体色值与混合模式；`useResolvedThemeHeroPalette` 的订阅源；
  两个光晕的定位类名与作用。
- `useProjectSidebarPreferences.ts`：`KEY` 一条记录承载三类偏好；入参范围；`availability` 的默认值；
  `useState` 惰性初值同步读；`reconcileProjectOrder` 的基准；`changeOrder` 的归一顺序。
- `HooksSection.tsx`：`isInCompatibilitySection` 的排除法；`deferredSearchTerm` 与即时输入的分工；
  `hooksService` 包装只改 `loadHooks` / `saveHooks` 并转发 `grantWorkspaceHookTrust`；`trustHook` 的 workspace 来源；
  `activeScope` 缺省为 `"user"`；`latestReviewScopeTarget` 为空时不切换作用域。
- `providerFamilyConnectionVisibility.ts`：`currentSubscription` 非空即 `purchased`；未登录只过滤入口；
  `entitlementTeamItems` 去重后置；`fallbackTeamItems` 的生成条件；`showPurchasedTeamPlanFallback` 的开关作用；
  被 `filter` 淘汰项不参与条数与锚点定位。

## 3. 六闸

```
gate: PASS scope n=0 plan=36 allow=0 diff_old=36 diff_new=36 out_of_scope_edits=0 plan_lines_covered=36/36
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=d451994d files=6/6 numstat=36/36 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=36 added=0 allowed=45 auto_self_clear=0
gate: PASS order n=0 total=119.0s controllable=115.0s
```

## 4. 判据与返修

`fix=0/0/0s`（`judge` 首跑 `hits=0`，无复判）。

## 5. 自清

- `removed=36 added=0 auto_self_clear=0`；累计仍 **9 行 / 9 文件**，距阈值 20 行差 11。

## 6. 池外对账

- 全仓 weak：`4,423 → 4,387`（**−36**），文件 `1,697 → 1,691`。
- **句子级**：`done 6,276 / remain 1,145`，`6,276 + 1,145 = 7,421`，**84.6%**。
- **逐行**：`remain ≈ 1,145 + 1,046 = 2,191`，`done ≈ 5,230 / 7,421`，约 **70.5%**。
- 池外：`4,387 − 1,145 = 3,242`，与 b350/b351 同值。

## 7. 守卫与产能

- `GUARD 15 文件`：`pre=4 post=4 新增=0` → **PASS**。
- `capacity --batch b352`：`done files=509 (+6) / lines=6,276 (+36)`，`REMAIN 498 files / 1,145 lines`，
  `PLAN 83 批 / 6.0 文件 / 13.8 行`，`ALIGNED diff=0`；`ledger-assert PASS`。
- 批数序列：86（1,255）→ 85（1,217）→ 84（1,181）→ **83（1,145）**，每批减 1，差额都是执行掉的 `PLAN#1`。
- 白名单 547 行。

## 8. 计时（B 段第 3 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（白名单 `9181f19e`） | 批次提交 `d451994d` | 119.0s | 3.31s |
| `controllable` | `--start`（11:03:38） | 批次提交（11:05:33） | 115.0s | 3.19s |
| 起草段 | `b352-files.txt`（11:03:29） | `--start` | 9s | — |
| 收口段 | 批次提交（11:05:33） | 台账提交（11:07:00） | 87s | — |
| `批墙钟` | 最早产物（11:03:29） | 台账提交 `fa550dc7`（11:07:00） | 211s | 5.86s |

- **收口三项拆解（本批实测）**：批后快照 **8.3s**、白名单重生成 **≈0.2s**、产能重算 **≈1s**（记账口径）；
  `--plan` 口径的产能重算单跑 **≈23s**（b352 规划时实测）。
  收口从 b351 的 178s 降到 **87s**，差额主要是本批没有 stale/MISMATCH 试错；仍高于 60s 目标，主因是台账写作与 INDEX 编辑。
- 监控按新口径记录：**收口 87s（阈值 150s，连续 3 批才停，当前 1/3 未触发）**、**可控 3.19 s/行（阈值 8，连续 3 批才停）**；
  `s/行` 5.86 仅记录不作停批依据。

## 9. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 白名单（开批前，545 行） | `9181f19e` | 2 文件 |
| 批次本体（6 文件 1→1 改写） | `d451994d` | `+36/−36` |
| `ZC-deep-b352-rewrite.tsv` + 白名单 547 行 + 本台账 + INDEX 同步 | `fa550dc7` | — |
