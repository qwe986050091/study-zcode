# ZC-deep-b381

> 批次：b381 ｜ **30 行 / 10 文件** ｜ 提交 `102f21b1`（本体）+ `8fc19502`（修复）

## 0. 普通批；`fix=1`；**判据类 1（3.3%）/ 格式类 0 / lint 10（全部拦在写盘前）**

- `plan_lines_covered=30/30`；`removed=30 added=0 allowed=42 auto_self_clear=0`（`30 + 12 = 42`）。
- **lint 一次拦下 10 条**（seps≥2 / `anchor=false` / 含「此」「它」），全部在写盘前改掉，所以
  第一轮 `missing_anchor=0 missing_predicate=0`；这是 lint 单批拦截最多的一次。
- **判据类 1 条**：`WorkspaceFileSearchSection.tsx:232` 写成「远程 workspace 的规则文件在远端机器上」，
  被 `deep-quality` 判 **同义重复**（远程/远端）。`judge-generic` 对当天内容 `hits=0`，
  **这条是批后全仓扫描抓到的，不是 judge 抓的**——记下来，说明 judge 的同义重复判定弱于 `deep-quality`。
  修复提交 `8fc19502`：改成「`WorkspaceFileSearchSection` 读到的规则文件在宿主机器：本地打不开预览」。
- **`judge hits=0` 不等于无问题**：本批就是反例。台账 §0 的三列口径不变（判据类只数被判否的行）。

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/settings/model-provider-section/StatusCards.tsx` | 3 | 0 |
| `packages/ui/src/settings/model-provider-section/useCodingPlanEntitlements.ts` | 3 | 0 |
| `packages/ui/src/settings/PluginStoreDetailView.tsx` | 3 | 0 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowDetailHeader.tsx` | 4 | 1 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowLaunchDialog.tsx` | 4 | 1 |
| `packages/ui/src/settings/WorkspaceFileSearchSection.tsx` | 3 | 0 |
| `packages/ui/src/store/automationManagementStore.ts` | 3 | 0 |
| `packages/ui/src/terminal/terminalComposedInputFallback.ts` | 3 | 0 |
| `packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx` | 3 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/cuaListDetails.tsx` | 3 | 0 |
| **合计** | **32** | **2** |

**固定对账列（§6.2 第 24 条，每批必报）**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 可清 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | --- |
| **10** | **8** | **0** | 1,529 → 1,521 | **1** | `1,529 − 8 + 0 = 1,521` ✔ |

- 未全仓清零的 2 个：两个 saved-workflows 文件各留 1 行池外上游残留，与 `pick` 的 `upOut=2` 一致。
- **可清只剩 1**：下一批起进入 §6.2 第 26 条定义的「可清 → 0」阶段（批次照跑，剩余拆两列，完成判据 = 池内可写行 0）。

## 2. 改动内容

- `StatusCards.tsx`：已用/剩余混用的改错故障、阈值比较抽常量、解析函数过滤无归属额度桶。
- `useCodingPlanEntitlements.ts`：指纹而非布尔、抑制期二次抵挡、四查询并行一次收口。
- `PluginStoreDetailView.tsx`：静态图片资源、`??` 与 `||` 的边界、高级区受控外壳。
- `SavedWorkflowDetailHeader.tsx`：`busy` 与条目缺失、菜单约束范围、测试 id 带工作流名。
- `SavedWorkflowLaunchDialog.tsx`：模块职责、`workflowArgInputId` 前缀、校验通过后的交接内容。
- `WorkspaceFileSearchSection.tsx`：本层不取数、结果只进草稿、远端规则文件不展示入口。
- `automationManagementStore.ts`：`toMessage` 纯函数、不拆多切片、不区分手动与自动刷新。
- `terminalComposedInputFallback.ts`：`text` 相等才复用、提交类按键只记时间戳、最大时效淘汰。
- `QueuedSummaryContent.tsx`：`SUMMARY_ROLL_TOTAL_MS` 的对外含义、`MAX_PENDING = 2` 的折中、接口不承载派生。
- `cuaListDetails.tsx`：图标表整体替换、容器限高滚动、宽高都非空才展示尺寸。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=102f21b1 files=10/10 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=42 auto_self_clear=0
gate: PASS order n=0 total=111.0s controllable=110.0s
GATE ALL PASS batch=b381 sha=102f21b1
```

- 第一次跑 `pool-diff` 是 `removed=29`：因为上面那条同义重复的行改写后**仍判 weak**，池里没减。
  修复后按末次扫描计 `removed=30`，`ACCT` 才闭合到 393。

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` 数据行 **12 条**（未变）。

## 5. 进度

- 全仓 weak：**3,662 → 3,632**（−30）；filler 89 不变；weak 文件 **1,529 → 1,521**（末行 `files=`）。
- 池内：**393 行 / 289 文件**（`ACCT files 718 + 289 = 1,007`、`ALIGNED diff=0`、`ASSERT PASS`）。
- `done 7,028 / remain 393`；`7,028 + 393 = 7,421`。
- **行侧进度 94.7%**（7,028 ÷ 7,421）；文件侧 `718 ÷ 1,007 = 71.3%`（辅助）。
- 可清 **1**（1,521 − 1,520）。
- 剩余批数（cap 10）：**29 批**（289 ÷ 10）。

## 6. 计时（分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `b30c9f3e`（16:08:1x） | `102f21b1`（16:11:44） | 111.0 |
| `controllable` | `--start`（16:09:54） | 批次提交 | **110.0** |
| **S0** 提交 → 收口第一条命令 | 16:11:44 | 16:11:58 | **14** |
| **S1** 全仓扫描 | 16:11:58 | 16:12:06 | **8** |
| **S2** 对账 + rewrite.tsv + `own-commits-gen` + `capacity` | 16:12:06 | 16:13:02 | **56**（含 2 次工具报错重跑：rewrite.tsv 陈旧、白名单落后） |
| **S3** 台账 | 16:13:02 | 16:13:53 | **51** |
| **S4** `git add` + `commit` | 16:13:53 | 16:13:54 | **1** |
| **合计** | 16:11:44 | 16:13:54 | **130s** |
| `批墙钟` | 16:09:54 | 16:13:54 | **240s** |

TOOL_TRIP: 40.0（S2 的 56s 里，先跑 `capacity` 后更新 rewrite.tsv / 白名单 的顺序错误占 40s，与 b376 同源；按 §5.1 扣除，不整批剔除）
> b394 回标：原 `ACCIDENT_TIMING`（整批剔除）撤销——整批剔除会把同一批里真实的 16s 对账工作也扔掉，且 b393 的同类往返若逐批剔除会让窗口系统性偏小。规则改为「扣往返、留批次」。

- `controllable` 110s 是全线最低，但**不能当提速**：本批 30 行里有 20 行是「档案类」短句（`[权衡]`/`[契约]` 前缀），
  上下文依赖低；而判据类命中 1 条也说明快不等于对。
- S2 的 56s 里有 40s 花在我自己的顺序错误上（先跑 `capacity` 后更新 rewrite.tsv / 白名单），
  与 b376 的教训同源：**§5.3 第 7 条的顺序必须逐字执行**。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `102f21b1` | `+30/−30` |
| 同义重复修复（1 行） | `8fc19502` | `+1/−1` |
| `ZC-deep-b381-rewrite.tsv` + 本台账 + 白名单（668 行） | 待提交 | — |
