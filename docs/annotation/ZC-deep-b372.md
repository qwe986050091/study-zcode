# ZC-deep-b372

> 批次：b372 ｜ **40 行 / 10 文件**（cap 10 首批）｜ 提交 `fec0930b`

## 0. 普通批；`fix=4`（两轮）；`hit_rate=10.0%`

- `files=10/10`；`plan_lines_covered=40/40`；`removed=40 added=0 allowed=51 auto_self_clear=0`。
- **首轮 4 行命中**（去重按行）：`4 ÷ 40 = **10.0%**`。
  - `codingPlanQuotaResetCoordinator.ts:260`：`L 无信息列举`（缺谓词）。
  - `useCodingPlanProducts.ts:105`：`W 单行无信息`（只有数字锚点，`ident()` 不认，需标识符）。
  - `RemoteConnectionSelection.tsx:245`：`W 单行无信息`（同上）。
  - `useCodingPlanProducts.ts:130`：`L 无信息列举`（我写的「因此」不在 `PREDICATE_WORDS` 里，改「所以」才过）。
- 两轮 fix：第一轮 4 行 → 复检仍 2 行（105、130）→ 第二轮改成 `ident` 命中的 `getServiceCache` 与谓词 `所以` → `hits=0`。
- **口径收获**：`PREDICATE_WORDS` 里没有「因此」，b370 台账「补因此后 hits=0」是巧合（那行另有「不再」类词）；
  锚点 `ANCHOR` 认数字，但 `W` 判据用的 `ident()` 只认 ≥3 字符标识符与全大写缩写——**数字锚点挡不住 W**。

## 1. 选行与目录分布

| 文件 | 本批 | 批后 weak | 子目录 |
| --- | ---: | ---: | --- |
| `packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts` | 4 | 0 | lib |
| `packages/ui/src/lib/keyboardShortcuts.ts` | 4 | 0 | lib |
| `packages/ui/src/lib/slashCommands.ts` | 4 | 0 | lib |
| `packages/ui/src/plugin-ui/adapters/pluginUiPagePlane.ts` | 4 | 1（池外） | plugin-ui |
| `packages/ui/src/remote-connection/RemoteConnectionSelection.tsx` | 4 | 0 | remote-connection |
| `packages/ui/src/root/useRemoteWorkspaceHistory.ts` | 4 | 1（池外） | root |
| `packages/ui/src/settings-sync/SettingsSyncSelectionStep.tsx` | 4 | 0 | settings-sync |
| `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx` | 4 | 0 | settings |
| `packages/ui/src/settings/model-provider-section/StartPlanBalanceCard.tsx` | 4 | 0 | settings |
| `packages/ui/src/settings/model-provider-section/useCodingPlanProducts.ts` | 4 | 0 | settings |
| **合计** | **40** | **2** | — |

- 8 个文件清零；2 个各留 1 行池外 weak。全仓文件数 `1,592 → 1,584`（−8）。
- 顶层目录 **1 个**（ui），是 B 段迄今最集中的一批；子目录 6 个。

## 2. 改动内容

- `codingPlanQuotaResetCoordinator.ts`：`stop()` 清理顺序的三条改错后果都补了函数名与常量名锚点。
- `keyboardShortcuts.ts`：INV-09 补 `1`–`9` → `Digit1`–`Digit9`；INV-13 补 `altKey`；平台判定与键名展示各补真名。
- `slashCommands.ts`：前缀分档写 `scoreFuzzyMatch`；排序写 `command.name.length` / `localeCompare` / `sort`。
- `pluginUiPagePlane.ts`：`root` 同滚动树；四个布尔写全名；选主写 `placement.kind === "sidebar"` 与 `at(-1)`；
  无锚点分支写 `parkingRoot()`。
- `RemoteConnectionSelection.tsx`：`matches` 三参；只接管 `ArrowDown`/`ArrowUp`；截取 3 条的理由写明公共函数不限数量；
  `historyProfile` 回退的代价。
- `useRemoteWorkspaceHistory.ts`：注入 `runReconnectRemoteWorkspace`；`refreshQueued` 合并语义；
  首屏侧栏直出的依据；软降级不写 `disconnected`。
- `SettingsSyncSelectionStep.tsx`：`agentsWithCategory` 空结果仍展示分组；三态写 `allSelected` / `partiallySelected`。
- `ProviderFormControls.tsx`：`isTesting` 不上抛；开关必须同步；`Loader2Icon` 的 `animate-spin`；按钮按回调出现。
- `StartPlanBalanceCard.tsx`：`StartPlanBalanceCard` 职责；`embedded` 模式；`expireTime` 缺失判定；`renewTimeLabel` 可空。
- `useCodingPlanProducts.ts`：错误码常量可见性；`getServiceCache` 桶数上界；`supportedProvider` 渲染期同步；归一化不过滤。

## 3. 六闸

```
gate: PASS scope n=0 plan=40 allow=0 diff_old=40 diff_new=40 out_of_scope_edits=0 plan_lines_covered=40/40
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=fec0930b files=10/10 numstat=40/40 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=40 added=0 allowed=51 auto_self_clear=0
gate: PASS order n=0 total=445.0s controllable=168.0s
GATE ALL PASS batch=b372 sha=fec0930b
```

## 4. 自清

- `auto_self_clear=0`，`POOL-SELF-CLEAR.tsv` 数据行仍 **11 行**。

## 5. 进度（双分母）

- 全仓 weak：**3,903 → 3,863**（−40）；文件 **1,592 → 1,584**（−8）；filler 119 → 113。
- 池内：**623 行 / 374 文件**，全部可写（`ALIGNED diff=0`）。
- `done 6,798 / remain 623`；`6,798 + 623 = 7,421`（`ASSERT PASS`）。
- **对基线 91.6%**（6,798 ÷ 7,421）——本批批报**唯一进度分母**；
  文件侧 `633 ÷ 1,007 = 62.9%` 为辅助列（分母 1,007，见 INDEX §6.2 第 22 条）。
- 可清到零文件 **64**（72 − 8）；含不可写残留 **1,520**（未变）。
- 剩余批数（cap 10）：**38 批**，`min 4 / avg 16.4 / max 39`，22 批整批为 1 行文件。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `78109986` | `fec0930b`（13:52:20） | 445.0s | 11.13s |
| `controllable` | `--start`（13:49:32） | 批次提交（13:52:20） | 168.0s | **4.20s** |
| 收口段 | 13:52:20 | 台账提交 `ab364c50`（13:57:52） | 332s | — |
| `批墙钟` | 13:49:32 | 台账提交（13:57:52） | 500.0s | 12.5s |

- **收口 332s，连续第 2 批超 150s**（b371 416s → b372 332s）。按三批规则，**b373 若再超即停批检修**。
  分解**闭合到 332s**（同一窗口内顺序执行，实测）：

  | 项 | 秒 |
  | --- | ---: |
  | `deep-quality` 全仓批后扫描 | 95 |
  | `own-commits-gen` + `capacity-estimate`（两次） | 40 |
  | 台账 + INDEX 写作 | 150 |
  | 提交（`git add` + `commit`） | 10 |
  | **其它（未细分：进程启动、PowerShell 启动、命令间等待、`git status`）** | **37** |
  | **合计** | **332** |

  **性质：整组为「估算」，不是实测。** 只有 「合计 332s」 是实测（`git log` 两个时间戳之差）；
  95 / 40 / 150 / 10 / 37 都是我按轮次粗分的估计值，没有分段打点。
  **已被 b374 的分段实测取代**：扫描 **8s**、白名单+容量 **1s**（工具段合计 9s），
  台账写作 **36s**、提交 **1s**。因此上表应重读为「写作过程成本 ≈ 300s，工具 ≈ 10s」，
  **不得再拿 95s 或 4.5h 当测量值引用**。
  ~~下批起把 INDEX 增量推迟到「每 3 批一次」：只压写作里的 INDEX 部分（约 60s），
  外推上沿从 4.5h 到 3.9h，不改变「收口 ≤150s 才能到 2.6h」这个结论。~~
  **该推论建立在上面那组估算上，一并作废**；b374 实测后按滚动中位读数为准（见 b374 §7）。

- **cap 10 首批的 `s/行 = 4.20`**，低于 b371 的 5.04；但本批只 40 行、10 文件，样本 n=1，不外推。
- 固定成本随批数下降（39→38 批），单批 `controllable` 反而与 cap 6 同量级，说明 cap 提高没有带来超线性成本。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `fec0930b` | `+40/−40` |
| `ZC-deep-b372-rewrite.tsv` + 本台账 + INDEX | `ab364c50` | — |
| 白名单重生成（633 行）+ 计时回填 | 见回填 | — |
