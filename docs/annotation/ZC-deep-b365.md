# ZC-deep-b365

> 批次：b365 ｜ **13 行 / 6 文件** ｜ 提交 `b2083cb1`

## 0. 普通批；`fix=1`；`hit_rate=0%`（precheck 后首批）

- `files=6/6`；`plan_lines_covered=13/13`；`removed=13 added=0 allowed=23 auto_self_clear=0`。
- **机械自检首跑**：`missing_anchor=0 missing_predicate=1`（`sidebarPurposeSectionPreferences.ts:316`
  「…日志层不记录也不上报」缺谓词）→ 补「必须」后 0/0；**judge 首轮 `hits=0`**。
- **六闸仍报 1 条 L**：`useSessionSubagents.ts:159`
  「loadMore 循环以 remaining 为界，只在 nextCursor 存在时继续，二者共同构成终止条件。」
  补「缺一必须退出」后全 PASS。**`fix=1`（一轮），`hit_rate = 0 ÷ 13 = 0%`**。
- **新发现（记入 §5.3）**：闸的「无信息列举」检测是**独立于 `isWeakContent` 的第二份词表**，
  本轮扩的 `为/即/表示` 只作用于 `isWeakContent`，对该分支无效——所以 judge 判 0、闸仍判 L。
  这不是判据冲突，而是两个检查器覆盖面不同；扩表时必须两处同步。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/hooks/useProviderSettingsView.ts` | 2 | 2 | 0 | ui/hooks |
| `packages/ui/src/hooks/useSessionSubagents.ts` | 2 | 2 | 0 | ui/hooks |
| `packages/ui/src/lib/sidebarPurposeSectionPreferences.ts` | 2 | 2 | 0 | ui/lib |
| `packages/ui/src/project-sidebar/index.tsx` | 2 | 2 | 0 | ui/project-sidebar |
| `packages/ui/src/project-sidebar/RemoteProjectMenu.tsx` | 2 | 2 | 0 | ui/project-sidebar |
| `packages/desktop/src/host/windowHostControllerService.ts` | 3 | 3 | 0 | desktop/host |
| **合计** | **13** | **13** | **0** | — |

- 2 个顶层目录（ui / desktop）；6 文件全部清零。

## 2. 改动内容

- `useProviderSettingsView.ts`：`generationRef` 自增作废旧代；代际不符直接 return。
- `useSessionSubagents.ts`：`requestSeq` 只增不重置；`loadMore` 以 `remaining` 与 `nextCursor` 双终止。
- `sidebarPurposeSectionPreferences.ts`：`expanded === fallback` 时删键表达继承；`catch` 吞异常是刻意选择。
- `project-sidebar/index.tsx`：排序是 `reorder` 偏好；`allExpanded` 只管全部展开按钮语义。
- `RemoteProjectMenu.tsx`：`onOpenRemoteWorkspace` 可选、由调用方决定；`DropdownMenu` 单一根。
- `windowHostControllerService.ts`：`Promise.all` 并行三列表；`generation` 加一作废在途；offline 不影响投影保留。

## 3. 六闸

```
gate: PASS scope n=0 plan=13 allow=0 diff_old=13 diff_new=13 out_of_scope_edits=0 plan_lines_covered=13/13
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=2
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=2 verify_ok=true
gate: PASS commit n=0 sha=b2083cb1 files=6/6 numstat=13/13 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=13 added=0 allowed=23 auto_self_clear=0
gate: PASS order n=0 total=107.0s controllable=95.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 进度（双分母）

- 全仓 weak：`4,069 → 4,056`（−13），文件 `1,626 → 1,620`（−6）。
- 池内：**815 行 / 420 文件** = **可写 320** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,606 / remain 815`；`6,606 + 815 = 7,421`。
- **对基线 89.0%**；**对可达上限 6,926：95.4%**。
- 可清到零文件 **100**；含不可写残留 **1,520**。

## 6. 计时与近四批窗口

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | `d54fdf89`（12:32:24） | `b2083cb1`（12:34:11） | 107.0s | 8.23s |
| `controllable` | `--start`（12:32:36） | 批次提交（12:34:11） | 95.0s | **7.31s** |
| 收口段 | 12:34:11 | 台账提交 `f3979f41`（12:35:06） | 55s | — |
| `批墙钟` | 12:32:36 | 台账提交 `f3979f41`（12:35:06） | 150.0s | 11.54s |

| 批 | 行/批 | s/行 | 收口 |
| --- | ---: | ---: | ---: |
| b362 | 20 | 3.45 | 35s |
| b363 | 19 | 3.68 | 41s |
| b364 | 17 | 3.94 | 37s |
| b365 | 13 | 7.31 | 55s |
| 均值 | 17.3 | 4.60 | 42.0s |

- `批墙钟 150s` 正好压线（阈值 `>150s`，未超）；偏高来自 13 行的分母小 + 一轮回改。

- b365 的 7.31 s/行偏高，原因是**闸报 L 后回改一轮**（与 b362 的 3.45 不可直接比）；
  近四批均值 4.60 s/行，仍低于停批阈值 8。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `b2083cb1` | `+13/−13` |
| `ZC-deep-b365-rewrite.tsv` + 本台账 + INDEX | `f3979f41` | — |
