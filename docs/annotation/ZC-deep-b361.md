# ZC-deep-b361

> 批次：b361 ｜ **25 行 / 6 文件** ｜ 提交 `d9ab5b18`

## 0. 方案 ① 普通批；`fix=2`；`hit_rate=12%`

- `TALLY {"ownIn":25,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":25,"planOut":25}` / `files=6/6`。
- **首轮 `hits=3`**：`L` 2 条、`W` 1 条 ——
  `useBrowserResizeOperationWarning:26`（缺谓词）、`ToolPresentation:84`（无锚点）、
  `botsTaskBroadcast:135`（缺谓词）；第二轮 1 条（135），第三轮 0。`fix=2`。
- **流程事故（本批记录，不改闸）**：我按「文本匹配」改行，把 `ToolPresentation:66` 当成计划行 84 改了，
  真正的 84 未动。judge 报出 84 仍为弱后才发现；已把 66 还原、84 改写，scope 闸读数仍 `plan_lines_covered=25/25`。
  教训：**改行必须按计划里的行号定位**，不能只按文本匹配。
- `hit_rate = 3 ÷ 25 = 12.0%`。`fix≥2` 连续计数：b360=1、**b361=2 → 触发停批，先做语义抽检第二轮**。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/root/botsTaskBroadcast.ts` | 5 | 5 | 0 | ui/root |
| `packages/ui/src/updateStatusModel.ts` | 4 | 4 | 0 | ui |
| `packages/ui/src/ToolCallBlocks/ToolPresentation.tsx` | 4 | 4 | 0 | ui/ToolCallBlocks |
| `packages/ui/src/browser-use/useBrowserResizeOperationWarning.ts` | 4 | 4 | 0 | ui/browser-use |
| `packages/ui/src/root/useReconnectingRemoteWorkspaceLogs.ts` | 4 | 4 | 0 | ui/root |
| `packages/ui/src/resource-manager/storage/StorageCategoryList.tsx` | 4 | 4 | 0 | ui/resource-manager/storage |
| **合计** | **25** | **25** | **0** | — |

- 6 文件全部从「可清到零」集合选取，批后全部清零；1 个顶层目录、5 个子域。

## 2. 改动内容

- `botsTaskBroadcast.ts`：载荷守卫只校验不修改；频道不符返回 null；工作区键同源构造；`tabs.some` 比对；`updated` 必须回 `ready`。
- `updateStatusModel.ts`：`displayVersion` 三档回退；`dialogPhase` 与版本同源；动作锁释放集中判定；`download` 完成条件。
- `ToolPresentation.tsx`：能力缺省为空；`todo` 卡必须显式开启；常规分支展开 `context`；嵌套渲染指回自身。
- `useBrowserResizeOperationWarning.ts`：两个时长常量带数值；无元素/无 `ResizeObserver` 静默返回；零尺寸不写入 `lastSizeRef`。
- `useReconnectingRemoteWorkspaceLogs.ts`：按 `workspaceKey` 分组；目标消失即清日志；空列表早退；只把有目标的项目交给匹配器。
- `StorageCategoryList.tsx`：`cleanable` 双条件；整行按钮与 `data-testid`；`tabular-nums` 防跳动；`aria-label` 必须有。

## 3. 六闸

```
gate: PASS scope n=0 plan=25 allow=0 diff_old=25 diff_new=25 out_of_scope_edits=0 plan_lines_covered=25/25
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=d9ab5b18 files=6/6 numstat=25/25 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=25 added=0 allowed=35 auto_self_clear=0
gate: PASS order n=0 total=132.0s controllable=119.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 进度（双分母）

- 全仓 weak：`4,150 → 4,125`（−25），文件 `1,650 → 1,644`（−6）。
- 池内：**884 行 / 444 文件**（密度 1.99）= **可写 389** + 上游 495（不变）。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,537 / remain 884`；`6,537 + 884 = 7,421`。
- **对基线 7,421：88.1%**；**对可达上限 6,926：94.4%**（收尾用这一列）。
- 可清到零文件 **124**；含不可写残留 **1,520**。
- 池外残留 3,241 行（不变）。

## 6. 计时（B 段第 12 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `ba223d99`（12:11:19） | 批次提交 `d9ab5b18`（12:13:31） | 132.0s | 5.28s |
| `controllable` | `--start`（12:11:32） | 批次提交（12:13:31） | 119.0s | **4.76s** |
| 收口段 | 批次提交（12:13:31） | 台账提交 `49b24c52`（12:14:17） | 46s | — |
| `批墙钟` | 最早产物 `b361-t-start.txt`（12:11:32） | 台账提交 `49b24c52`（12:14:17） | 165.0s | 6.60s |

- 首轮 3 条返修 + 一次改错行的还原，合计约 25s，落在可控段内。
- 监控：收口 46s（阈值 150s，未触发）、可控 4.76 s/行（阈值 8，未触发）。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `d9ab5b18` | `+25/−25` |
| `ZC-deep-b361-rewrite.tsv` + 本台账 + INDEX | `49b24c52` | — |
