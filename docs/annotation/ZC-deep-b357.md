# ZC-deep-b357

> 批次：b357 ｜ **23 行 / 6 文件** ｜ 提交 `face945c`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`、`preflight.mjs`

## 0. 方案 ① 普通批；`fix` 两轮，按纪律停批

- `TALLY {"ownIn":23,"ownOut":0,"upIn":0,"upOut":9,"pending":0,"planIn":23,"planOut":0}` / `plan=23` / `files=6/6`。
- `fix=2/3`：首轮 `hits=3`（`store/index.ts:323` L、`ConversationStatusPanel.tsx:665/666` W），
  第二轮 `hits=1`（`:666` 仍 W，补 `chat.goalVerification.complete` 作锚点后归零），复判 `hits=0`。
- 23 行＜碎尾批下限 25，但 6 文件都已清完，未再合批。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/components/ai-elements/model-selector.tsx` | 5 | 5 | 0 | ui/components/ai-elements |
| `packages/ui/src/settings/CommandsSection.tsx` | 5 | 5 | 0 | ui/settings |
| `packages/ui/src/project-sidebar/ProjectSidebarNode.tsx` | 5 | 5 | 0 | ui/project-sidebar |
| `packages/ui/src/hooks/useAppPanels.ts` | 4 | 4 | 1（池外） | ui/hooks |
| `packages/ui/src/v4/ConversationStatusPanel.tsx` | 3 | 3 | 3（池外） | ui/v4 |
| `packages/ui/src/store/index.ts` | 1 | 1 | 5（池外） | ui/store |
| **合计** | **23** | **23** | **9** | — |

- **目录分布**：**1 个顶层目录**（`packages/ui`），6 个子域。
- 选行不是 `PLAN#1`：本批仍未重跑产能（窗口在 b360），候选来自「池内 ∩ 当前 weak」现筛，故行数偏低。

## 2. 改动内容

- `model-selector.tsx`：`ModelSelectorProps` 由 `ConversationProps` 派生；对话层契约；卸载即清空搜索态；
  `ModelSelectorContent` 组合根；`aria-describedby={undefined}` 的显式置空。
- `CommandsSection.tsx`：列表与编辑器同源；`resolveCommandEditTarget` 按 `scope` 分流；
  `visibleCount` 的构成；非表单态上报 `undefined`；搜索无匹配时头部仍可用。
- `ProjectSidebarNode.tsx`：`remoteService` 可选；`nodeProps` 透传；`pendingSettingsSection` 的目标分区；
  `isDesktop` 走 `reconnectRemote`；`repairRoot` 重试。
- `useAppPanels.ts`：`activeTabByOwnerRef` 只记 `appId`；`handleToggleBrowser` 的展开分支；
  `useModelTrajectoryOpenBridge` 的 key 过滤；`hideArchived` 只过滤菜单。
- `ConversationStatusPanel.tsx`：`isDone` 分支只留成功勾；「重新开始」的入口归属；
  `getStatusPanelTodoFocusWindow` 的末尾三条退化。
- `store/index.ts`：`fontFamily` 在构造时一次性求值。

## 3. 六闸

```
gate: PASS scope n=0 plan=23 allow=0 diff_old=23 diff_new=23 out_of_scope_edits=0 plan_lines_covered=23/23
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=face945c files=6/6 numstat=23/23 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=23 added=0 allowed=33 auto_self_clear=0
gate: PASS order n=0 total=175.0s controllable=163.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 池外与进度

- 全仓 weak：`4,257 → 4,234`（**−23**），文件 `1,671 → 1,668`（**−3**）。
- `done += 23`（池内自清 0）、`files -= 3`；三个文件各留池外 weak：`useAppPanels:1`、`ConversationStatusPanel:3`、`store/index:5`。
- **句子级**：`done 6,428 / remain 993`，`6,428 + 993 = 7,421`，**86.6%**。
- 池外：`4,234 − 993 = 3,241`。

## 6. 计时（B 段第 8 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `7f6ff753`（11:35:28） | 批次提交 `face945c`（11:38:23） | 175.0s | 7.61s |
| `controllable` | `--start`（11:35:40） | 批次提交（11:38:23） | 163.0s | **7.09s** |
| 收口段 | 批次提交（11:38:23） | 台账提交 `b0c98d4f`（11:41:01） | 158s | — |
| `批墙钟` | 最早产物 `b357-t-start.txt`（11:35:40） | 台账提交 `b0c98d4f`（11:41:01） | 321.0s | 13.96s |

- 可控段 7.09 s/行仍偏高：23 行分摊固定阅读成本，且两轮判据返修占其中约 40s。
- 监控：收口 **158s 超 150s 阈值**，但只 1 批（b356 为 39s，未构成连续 3 批）；其中约 55s 是
  `total` 起点 sha 核对与白名单 `STALE-BAD` 排查，属本批一次性。可控 7.09 s/行（阈值 8，未触发）。
- 白名单 `preflight --whitelist` 当时报 `STALE-BAD`（b356/b357 源码提交已在 meta.head 之后），
  属**窗口内预期**：本批不跑产能，b360 全量重算时统一刷新。
- **工具修正（b358 前回填）**：同一状态现在由 `preflight --whitelist` 直接判
  `STALE-EXPECTED n=9 source=2 docs=7`（≤5 个源码批次提交即预期落后），
  `--total-start <sha> --batch-commit <sha>` 一行核对 `total` 起点；本批那 ≈55s 手工排查即由这两条取代。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `face945c` | `+23/−23` |
| `ZC-deep-b357-rewrite.tsv` + 本台账 + INDEX | `b0c98d4f` | — |
