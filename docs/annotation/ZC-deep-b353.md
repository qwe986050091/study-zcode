# ZC-deep-b353

> 批次：b353 ｜ **35 行 / 6 文件** ｜ 提交 `7d4bf34f`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`、`preflight.mjs`

## 0. 方案 ① 首个执行批（白名单 + 产能改为每 5 批一次）

- 本批 **不重生成白名单、不重跑产能**，改用轻量校验 + 增量记账：
  `preflight.mjs --whitelist` → `STALE-OK docs-only n=6`（落后 6 个提交全部在 `docs/annotation/`）。
- `TALLY {"ownIn":35,"ownOut":0,"upIn":1,"upOut":0,"pending":0,"planIn":35,"planOut":0}` / `plan=35` / `files=6/6`。
- 选行不来自 `PLAN#1`（本批没跑产能），来自 b350 全量候选表里 ownIn>0 的前 6 个未完成文件；
  下次产能重算在 **b355**。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/settings/SourceServerManagementPanel.tsx` | 6 | 6 | 0 | ui/settings |
| `packages/ui/src/settings/model-provider-section/SectionLayout.tsx` | 6 | 6 | 0 | ui/settings/model-provider-section |
| `packages/ui/src/settingsPageHelpers.tsx` | 5 | 5 | 1（上游） | ui |
| `packages/ui/src/terminal/terminalPanelState.ts` | 6 | 6 | 0 | ui/terminal |
| `packages/ui/src/web-remote-control/domain/presentation.ts` | 6 | 6 | 0 | ui/web-remote-control |
| `packages/web/src/web-remote-control/ui/webRemoteControlDeviceListPage.tsx` | 6 | 6 | 0 | web/web-remote-control |
| **合计** | **35** | **35** | **1** | — |

- **目录分布**：**2 个顶层目录**（`packages/ui` 5、`packages/web` 1），在 ≤4 内；
  `packages/ui` 内部跨 4 个子域，同域优先已做到能做的程度。

## 2. 改动内容

- `SourceServerManagementPanel.tsx`：`errorDetailsProfile` 与编辑目标分开的理由；三块折叠态各自持有；
  `update-desktop` 按全局操作处理；删除与查看详情的禁用边界；版本号去前缀只在渲染层；
  项目行 `disabled` 时保留 `aria-label`。
- `SectionLayout.tsx`：`shouldShowModelProviderRefreshLoading` 的或语义；`refreshButtonLoading` 只算一次；
  外层 `space-y-4` 只管纵向间距；导航列与详情列各自滚动所依赖的 `data-*` 标记。
- `settingsPageHelpers.tsx`：`hasServices` 只喂展示分支；`isTerminalFontFamilyDirty` 为假时按钮禁用；
  比较不做 `toLowerCase` 的原因；`localHttpProxy` 只在保存时落盘；`handleHttpProxyNoProxySave` 提交归一化值。
- `terminalPanelState.ts`：`createTerminalSession` 先置空 `shellLabel`；`getNextTerminalSessionIndex` 只扫 `sessionIds`；
  编号复用规则；不持久化派生计数；`exitTerminalSession` 的删除分支；`activeWorkspaceKey` 决定是否收起。
- `presentation.ts`：`isSameWebRemoteControlTarget` 的三步比较（工作区键 → `sessionId` → 窗口级标识）；
  `getWebRemoteControlStatusTagLabel` 的回落顺序。
- `webRemoteControlDeviceListPage.tsx`：`DeviceTile` 的尺寸与行高分工；`switchButton` 的负外边距与不禁用；
  `selectable` 的统一入口与错误时保留列表；`onlineDevices` 单独 `filter` 的取舍。

## 3. 六闸

```
gate: PASS scope n=0 plan=35 allow=0 diff_old=35 diff_new=35 out_of_scope_edits=0 plan_lines_covered=35/35
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=7d4bf34f files=6/6 numstat=35/35 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=35 added=0 allowed=44 auto_self_clear=0
gate: PASS order n=0 total=171.0s controllable=133.0s
```

## 4. 判据与返修

`fix=0/0/0s`（`judge` 首跑 `hits=0`）。

## 5. 自清

- `removed=35 added=0 auto_self_clear=0`；累计仍 **9 行 / 9 文件**，距阈值 20 行差 11。

## 6. 池外与增量记账（无产能重跑）

- 全仓 weak：`4,387 → 4,352`（**−35**），文件 `1,691 → 1,686`（**−5**）。
- **为什么是 −5 不是 −6**：剩的那一行是 `packages/ui/src/settingsPageHelpers.tsx:259`
  （`无解释`：「能力探测中或确认不可用，开关锁定」），blame 属**上游**（`upIn=1`），
  按四态分类不可写，既不进 plan 也不进 allow，留作上游余量——不是漏改。
- **两条独立计数**：`done += 35`（行）与 `files -= 5`（批后 weak 归零的文件数）分开记，不合并成一列。
- **增量记账**：`remain 1,145 → 1,110`（−35），`done 6,276 → 6,311`，`6,311 + 1,110 = 7,421`。
- 批数沿用上次产能的 **83 批**（本批不清零），下次重算在 b355；届时同时重生成白名单并跑 `ALIGNED` 断言。

## 7. 计时（B 段第 4 批，方案 ① 首跑）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交（`71594413`） | 批次提交 `7d4bf34f` | 171.0s | 4.89s |
| `controllable` | `--start`（11:09:58） | 批次提交（11:12:11） | 133.0s | 3.80s |
| 起草段 | `b353-files.txt`（11:09:49） | `--start` | 9s | — |
| 收口段 | 批次提交（11:12:11） | 台账提交（11:12:56） | **45s** | — |
| `批墙钟` | 最早产物（11:09:49） | 台账提交 `2dad764a`（11:12:56） | 187s | 5.34s |

- **收口拆解（方案 ①）**：批后快照 **8s**、`preflight --whitelist` **<1s**、`preflight --batch` **<1s**、
  产能 **0s（本批不跑）**、台账写作与提交 ≈35s。**收口 45s，首次落到 60s 以内**。
- 监控：收口 45s（阈值 150s）、可控 **3.80 s/行**（阈值 8），均未触发；`s/行` 5.34 仅记录。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `7d4bf34f` | `+35/−35` |
| `ZC-deep-b353-rewrite.tsv` + 本台账 + INDEX 同步 | `2dad764a` | — |

- 本批**无白名单提交**（方案 ①：每 5 批一次，b355 重生成）。
