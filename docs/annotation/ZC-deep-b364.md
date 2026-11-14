# ZC-deep-b364

> 批次：b364 ｜ **17 行 / 6 文件** ｜ 提交 `8d666d4b`

## 0. 方案 ① 普通批；`fix=2`；`hit_rate=17.6%`

- `TALLY {"ownIn":17,"outOfScope":0,"upIn":0,"upOut":0,"pending":0,"planIn":17,"planOut":0}` / `files=6/6`。
- **首轮 `hits=3`**：
  - `W` 2 条（无锚点）：`bigmodelUsageQuotaMapper.ts:48`、`LexicalChatInput.tsx:277` → 补类型名/参数名；
  - `L` 1 条（无谓词）：`ModelTrajectorySearchBar.tsx:119`（`只作用于…不作用于` 不在表）→ 改「必须只作用于」。
  第二轮 0。`fix=2`；`hit_rate = 3 ÷ 17 = 17.6%`。
- 等集断言：`plan=17 diff=17 missing=0 extra=0`。
- **`fix≥2` 连续计数：b363=2、b364=2 → 达「连续两批」→ 本批后停批做语义抽检**，b365 等抽检结论。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/LexicalChatInput.tsx` | 3 | 3 | 0 | ui |
| `packages/ui/src/ModelTrajectorySearchBar.tsx` | 3 | 3 | 0 | ui |
| `packages/ui/src/project-sidebar/useProjectTaskActions.ts` | 3 | 3 | 0 | ui/project-sidebar |
| `packages/ui/src/remote/remoteWorkspaceController.ts` | 3 | 3 | 0 | ui/remote |
| `packages/ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx` | 3 | 3 | 0 | ui/workspace-file-tree |
| `packages/services/src/usage-stats/providers/bigmodelUsageQuotaMapper.ts` | 2 | 2 | 0 | services/usage-stats |
| **合计** | **17** | **17** | **0** | — |

- 2 个顶层目录（ui / services），5 个 ui 子域；6 文件全部清零。

## 2. 改动内容

- `LexicalChatInput.tsx`：`modifiedEnterSubmits` 的 `&&` 条件保持展开；三个键位返回 false 由上层 normalizer 决定投递；历史态退出判据点名 `getEditorMarkdown` 与 `entries[currentIndex]`。
- `ModelTrajectorySearchBar.tsx`：零匹配禁用跳转；`type="search"` 取系统语义；关闭按钮不受 `disabled` 影响。
- `useProjectTaskActions.ts`：`logger.error` 先行、`kind` 选 toast；`mutate` 成功即 `refresh()`；归档写 `!task.archived`。
- `remoteWorkspaceController.ts`：`disconnect-device` 只带 `sourceServerId`；`origin` 不符直接抛错；`close-workspace` 必须只接受 `user-close`。
- `WorkspaceFileTreeStickyFolders.tsx`：空列表返回 null；`onToggle` 先于 `reveal`；`layout="static"` 不参与虚拟定位。
- `bigmodelUsageQuotaMapper.ts`：`BigModelUsageQuotaLimitPayload` 不导出；`items` 混装三类套餐时只取当前个人计划。

## 3. 六闸

```
gate: PASS scope n=0 plan=17 allow=0 diff_old=17 diff_new=17 out_of_scope_edits=0 plan_lines_covered=17/17
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=8d666d4b files=6/6 numstat=17/17 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=17 added=0 allowed=27 auto_self_clear=0
gate: PASS order n=0 total=85.0s controllable=67.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 进度（双分母）

- 全仓 weak：`4,086 → 4,069`（−17），文件 `1,632 → 1,626`（−6）。
- 池内：**828 行 / 426 文件** = **可写 333** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,593 / remain 828`；`6,593 + 828 = 7,421`。
- **对基线 88.8%**；**对可达上限 6,926：95.2%**。
- 可清到零文件 **106**；含不可写残留 **1,520**；池外残留 3,241 行。

## 6. 计时（B 段第 15 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `d54fdf89`（12:26:20） | 批次提交 `8d666d4b`（12:27:45） | 85.0s | 5.00s |
| `controllable` | `--start`（12:26:38） | 批次提交（12:27:45） | 67.0s | **3.94s** |
| 收口段 | 批次提交（12:27:45） | 台账提交 `a8351088`（12:28:22） | 37s | — |
| `批墙钟` | 最早产物 `b364-t-start.txt`（12:26:38） | 台账提交 `a8351088`（12:28:22） | 104.0s | 6.12s |

**滚动窗口**（只判水平稳定，**不用于反推批数**）：

| 批 | 行/批 | s/行 | 收口 |
| --- | ---: | ---: | ---: |
| b361 | 25 | 4.76 | 46s |
| b362 | 20 | 3.45 | 35s |
| b363 | 19 | 3.68 | 41s |
| b364 | 17 | 3.94 | 37s |
| 均值 | **20.3** | **3.96** | **39.8s** |

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `8d666d4b` | `+17/−17` |
| `ZC-deep-b364-rewrite.tsv` + 本台账 + INDEX | `a8351088` | — |
