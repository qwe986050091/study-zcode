# ZC-deep-b380

> 批次：b380 ｜ **16 行 / 10 文件（反向对照批 F=10 / L=16）** ｜ 提交 `70be419d`

## 0. 普通批；`fix=0`；**判据类 0.0% / 格式类 0 / lint 1（已拦在写盘前）**

- `plan_lines_covered=16/16`；`removed=16 added=0 allowed=28 auto_self_clear=0`（`16 + 12 = 28`）。
- 首轮 **0 行命中**（判据类 0 / 格式类 0），六闸一次过（`record_runs=1`）。
- **`0` 只表示写盘后没返工**，不表示一次写对：lint 拦下 1 条
  （`stage.ts:389` 初稿「身份、大小与校验」顿号 + 逗号 = seps 2），改成「组件身份与大小校验」后通过。
- **本批是反向对照批**：与 b379 的 `F=5 / L=15` 行数几乎相同、文件数翻倍（`F=10 / L=16`），
  用来判「成本是否随文件数走」（结论见 §7：**不随**）。

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/settings/InstalledPluginManagement.tsx` | 3 | 0 |
| `packages/ui/src/settings/model-provider-section/enterpriseCodingPlanProducts.ts` | 5 | 2 |
| `packages/ui/src/settings/model-provider-section/ProviderModelDraftState.ts` | 4 | 1 |
| `packages/ui/src/TaskSearchDialog.tsx` | 1 | 0 |
| `packages/ui/src/ToolCallBlocks.tsx` | 1 | 0 |
| `packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx` | 2 | 1 |
| `packages/ui/src/ToolCallBlocks/renderers/get-workflow-run.tsx` | 1 | 0 |
| `packages/ui/src/UpdateStatusDialogController.tsx` | 2 | 1 |
| `packages/zcode-server-cli/src/contracts.ts` | 1 | 0 |
| `packages/zcode-server-cli/src/packaging/stage.ts` | 3 | 2 |
| **合计** | **23** | **7** |

**固定对账列（§6.2 第 24 条，每批必报）**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 可清 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | --- |
| **10** | **5** | **0** | 1,534 → 1,529 | **9** | `1,534 − 5 + 0 = 1,529` ✔ |

- 未全仓清零的 5 个各留 1–2 行池外上游残留，与 `pick` 的 `upOut=7` 一致；**无新进 weak**。
- 顶层目录 **2 个**（`packages/ui` 9 个 + `packages/zcode-server-cli` 1 个）。

## 2. 改动内容

- `InstalledPluginManagement.tsx`：卸载回调只绑定、`status === "disabled"` 仍渲染真实组件、详情页只读的取舍。
- `enterpriseCodingPlanProducts.ts`：`isEnterpriseCodingPlanThirdPartyPaymentRequired` 用支付内容兜底；两条 `roundCurrencyAmount` 残差规则。
- `ProviderModelDraftState.ts`：`updateModelDraft` 的分流、`restoreModelDraft`、`projectModelDraft`。
- `TaskSearchDialog.tsx`：`normalizeSnippetForDedupe` 的三步口径。
- `ToolCallBlocks.tsx`：`normalizeToolEntranceAnimationKey` 两侧共用。
- `cuaDetails.tsx`：`model.environmentRows` 有项才渲染。
- `get-workflow-run.tsx`：缺年龄只留正文，不编造「刚刚」。
- `UpdateStatusDialogController.tsx`：回退条件 `updateActionInFlight` + `displayVersion`。
- `contracts.ts`：`createStoppedServerStatus` 不写盘不发送。
- `stage.ts`：关闭独立归档只跳过压缩与复制。

## 3. 六闸

```
gate: PASS scope n=0 plan=16 allow=0 diff_old=16 diff_new=16 out_of_scope_edits=0 plan_lines_covered=16/16
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=70be419d files=10/10 numstat=16/16 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=16 added=0 allowed=28 auto_self_clear=0
gate: PASS order n=0 total=720.0s controllable=118.0s
GATE ALL PASS batch=b380 sha=70be419d
```

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` 数据行 **12 条**（未变）。

## 5. 进度

- 全仓 weak：**3,678 → 3,662**（−16）；filler 89 不变；weak 文件 **1,534 → 1,529**（末行 `files=`）。
- 池内：**423 行 / 299 文件**（`ACCT files 708 + 299 = 1,007`、`ALIGNED diff=0`、`ASSERT PASS`）。
- `done 6,998 / remain 423`；`6,998 + 423 = 7,421`。
- **行侧进度 94.3%**（6,998 ÷ 7,421）；文件侧 `708 ÷ 1,007 = 70.3%`（辅助）。
- 可清 **9**（1,529 − 1,520）。
- 剩余批数（cap 10）：**30 批**（299 ÷ 10）。

## 6. 计时（分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `16cd2108`（15:48:3x） | `70be419d`（16:00:40） | 720.0 |
| `controllable` | `--start`（15:58:42） | 批次提交 | **118.0**（`s/行 = 7.38`、`s/文件 = 11.8`） |
| **S0** 提交 → 收口第一条命令 | 16:00:40 | 16:00:54 | **14** |
| **S1** 全仓扫描 | 16:00:54 | 16:01:01 | **7** |
| **S2** 对账 + rewrite.tsv + `own-commits-gen` + `capacity` | 16:01:01 | 16:01:20 | **19** |
| **S3** 台账 | 16:01:20 | 16:01:37 | **17** |
| **S4** `git add` + `commit` | 16:01:37 | 16:01:38 | **1** |
| **合计** | 16:00:40 | 16:01:38 | **58s** |
| `批墙钟` | 15:58:42 | 16:01:38 | **176s** |

## 7. 反向对照：`c_f` 的符号判出来了

四个实测点（`controllable` 口径）：

| 点 | 文件 | 行 | `controllable` |
| --- | ---: | ---: | ---: |
| P1 b377 | 10 | 30 | 163.0 |
| P2 b378 | 10 | 10 | 91.0 |
| P3 b379 | 5 | 15 | 118.0 |
| **P4 b380** | **10** | **16** | **118.0** |

- **关键对比：P3（5 文件 / 15 行）与 P4（10 文件 / 16 行）耗时相同，都是 118.0s。**
  文件数翻倍、行数只多 1 行，时间**一秒没涨**。若 `c_f = 5.5` 成立，P4 应为 `118 + 5×5.5 + 3.6 ≈ 149s`。
  实测 118 → **`c_f` 的符号稳定在 0 附近，不是负值**；b379 的 `−1.8` 是三点共线的数值产物。
- **三点共线的自我批评**：b379 的 `L=15` 正好夹在 10 与 30 之间，`118s` 又贴 91 与 163 的中值 127，
  三点几乎落在一条直线上，所以 `c_f = −1.8` 不能解释成「每文件成本为负」，也不能解释成「≈0」。
  本批的 `F` 差（5 vs 10）与 `L` 差（15 vs 16）**解耦**，才是能判符号的对照。
- **改用两参数过定拟合（丢 `c_f`，保留 `a + c_l × L`）**，四点：

  | 行 | 实测 | 拟合 | 残差 |
  | ---: | ---: | ---: | ---: |
  | 10 | 91.0 | 95.8 | −4.8 |
  | 15 | 118.0 | 113.0 | +5.0 |
  | 16 | 118.0 | 116.5 | +1.5 |
  | 30 | 163.0 | 164.7 | −1.7 |

  **`a = 61.4 s/批`、`c_l = 3.45 s/行`，最大残差 5.0s（4.2%）**。
  四点解两个参数，残差不再恒为 0——**这才是第一次真正的拟合验证**（前两次「预测—实测吻合」都是点解恒等式）。
- 剩余 30 批 / 423 行、收口中位 65s：
  `30 × 61.4 + 423 × 3.45 + 30 × 65 = 1,842 + 1,459 + 1,950 = 5,251s ≈ 1.46h`
  （独立点估计，不进主报区间）。
- 本批实测 `118 + 58 = 176s`，拟合预测 `61.4 + 3.45×16 + 65 = 181.6s`，**残差 −5.6s**；
  与上表的残差量级一致（±5s），没有因为「同批闭环」而恒等——因为这里是**过定拟合**，不是点解。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（10 文件 1→1 改写） | `70be419d` | `+16/−16` |
| `ZC-deep-b380-rewrite.tsv` + 本台账 + 白名单（663 行） | `a9337237` | — |
