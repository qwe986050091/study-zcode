# ZC-deep-b379

> 批次：b379 ｜ **15 行 / 5 文件（标定批 F=5）** ｜ 提交 `b873934d`

## 0. 普通批；`fix=0`；**判据类 0.0% / 格式类 0 / lint 1（已拦在写盘前）**

- `plan_lines_covered=15/15`；`removed=15 added=0 allowed=27 auto_self_clear=0`
  （`allowed = plan 15 + 自清 12 = 27`，再次验证 §6.2 第 25 条公式）。
- 首轮 **0 行命中**（判据类 0 / 格式类 0），六闸一次过（`record_runs=1`）。
- **`0` 只表示写盘后没返工**，不表示一次写对：lint 拦下 1 条
  （`task-context-menu-content.tsx:28` 初稿「覆盖禁用与定位，新增能力先确认…」两个逗号 = seps 2），
  改成冒号后通过。**这条若直接落盘就是判据类 1。**
- **本批是标定批，不是排期批**：刻意取 `F=5 / L=15` 的形状，去检验 b378 解出的
  `c_f = 5.5`、`c_l = 3.6` 是否站得住（结论见 §7：**不站得住，是逐批固定成本**）。

## 1. 选行、逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx` | 3 | 0 |
| `packages/ui/src/project-sidebar/grouped/view.ts` | 3 | 0 |
| `packages/ui/src/remote-connection/RemoteConnectionConnectingStep.tsx` | 5 | 2 |
| `packages/ui/src/remote-connection/RemoteConnectionHistoryInput.tsx` | 3 | 0 |
| `packages/ui/src/root/oauthProviderFamilySelectionRefresh.ts` | 3 | 0 |
| **合计** | **17** | **2** |

**固定对账列（§6.2 第 24 条，每批必报）**

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 可清 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | --- |
| **5** | **4** | **0** | 1,538 → 1,534 | **14** | `1,538 − 4 + 0 = 1,534` ✔ |

- 未全仓清零的 1 个：`RemoteConnectionConnectingStep.tsx`（`5 → 2`，两行池外上游残留），与 `pick` 的 `upOut=2` 一致。
- 无新进 weak，无质量问题。

## 2. 改动内容

- `task-context-menu-content.tsx`：原语覆盖范围（`ContextMenuItem`）、`TaskGroupColorDot` 同源、Radix `Presence` 负责卸载。
- `view.ts`：三条「改错故障」分别点名 `replaceTaskInGroupedView` / `findGroupIdByTaskKey` / `resolveGroupedDraftTaskPlacementForTask`。
- `RemoteConnectionConnectingStep.tsx`：`recognizedDeviceName` 优先、`logsExpanded` 初值、`logs.reverse()` 每阶段一次。
- `RemoteConnectionHistoryInput.tsx`：组件边界、`handleOpenChange` 唯一写入口、`activeIndex = -1` 时方向键放行。
- `oauthProviderFamilySelectionRefresh.ts`：`expectedAccountSettings` 取查询前快照、两个权益为空时降级、`selection` 为空不写入。

## 3. 六闸

```
gate: PASS scope n=0 plan=15 allow=0 diff_old=15 diff_new=15 out_of_scope_edits=0 plan_lines_covered=15/15
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=b873934d files=5/5 numstat=15/15 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=15 added=0 allowed=27 auto_self_clear=0
gate: PASS order n=0 total=489.0s controllable=118.0s
GATE ALL PASS batch=b379 sha=b873934d
```

## 4. 自清

- `auto_self_clear=0`；`POOL-SELF-CLEAR.tsv` **数据行 12 条**（b379 复核：文件 19 行 = 注释 6 + 空行 0 + 数据 12，唯一 key 12）。

## 5. 进度

- 全仓 weak：**3,693 → 3,678**（−15）；filler 89 不变；weak 文件 **1,538 → 1,534**（末行 `files=`）。
- 池内：**439 行 / 309 文件**（`ACCT files 698 + 309 = 1,007`、`ALIGNED diff=0`、`ASSERT PASS`）。
- `done 6,982 / remain 439`；`6,982 + 439 = 7,421`。
- **行侧进度 94.1%**（6,982 ÷ 7,421）；文件侧 `698 ÷ 1,007 = 69.3%`（辅助）。
- 可清 **14**（1,534 − 1,520）。
- 剩余批数（cap 10）：**31 批**（309 ÷ 10）。

## 6. 计时（分段）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | 上一提交 `c1ff4c05`（15:37:5x） | `b873934d`（15:46:04） | 489.0 |
| `controllable` | `--start`（15:44:06） | 批次提交 | **118.0**（`s/行 = 7.87`、`s/文件 = 23.6`） |
| **S0** 提交 → 收口第一条命令 | 15:46:04 | 15:46:19 | **15** |
| **S1** 全仓扫描 | 15:46:19 | 15:46:27 | **8** |
| **S2** 对账 + rewrite.tsv + `own-commits-gen` + `capacity` | 15:46:27 | 15:46:44 | **17** |
| **S3** 台账 | 15:46:44 | 15:47:04 | **20** |
| **S4** `git add` + `commit` | 15:47:04 | 15:47:05 | **1** |
| **合计** | 15:46:04 | 15:47:05 | **61s** |
| `批墙钟` | 15:44:06 | 15:47:05 | **179s** |

## 7. 标定：第三点证伪了 `c_f`

三点（`controllable` 口径）：

| 点 | 文件 | 行 | `controllable` |
| --- | ---: | ---: | ---: |
| P1 b377 | 10 | 30 | 163.0 |
| P2 b378 | 10 | 10 | 91.0 |
| **P3 b379** | **5** | **15** | **118.0** |

- 用 P1/P2 解出的 `c_f = 5.5`、`c_l = 3.6` **外推 P3 应为 81.5s，实测 118.0s，残差 +36.5s（+45%）**。
  **所以 b378 那句「首次预测—实测闭环」说大了**：P1/P2 两点解两参数，残差恒为 0，
  `159 vs 156` 检验的只是「`墙钟 = 起草 + 收口` 的可加性」，与参数准不准无关。
- 三点解三参数（含截距 `a`）：`c_l = 3.6`、`a + 10c_f = 55`、`a + 5c_f = 64`
  → **`c_f = −1.8 s/文件`、`a = 73 s/批`**。
  **⚠ 订正（b380）**：这不是「每文件成本 ≈ 0」，也不是「每文件成本为负」——
  三点近乎共线（`L=15` 夹在 10 与 30 之间，`118s` 又贴 91 与 163 的中值 127），
  **`c_f = −1.8` 是共线加噪声的数值产物，不能给它编物理意义**。
  b380 用反向对照（同量级行数、文件数 5 → 10）判了符号：两者同为 118s，`c_f` 稳定在 0 附近；
  正确结论与参数见那份台账 §7（`a = 61.4s`、`c_l = 3.45 s/行`，四点过定拟合）。
- **注意**：三点解三参数同样残差恒为 0，所以这仍是「解」不是「验证」；b380 的四点解两参数才是验证。
- **`c_f` 被低估的方向也写清楚**：b378 是装箱的最后一批，即「最省形状」（10 个文件各 1 行、上下文最短），
  **不是随机批**，所以它给出的 `c_f` 天生偏小；b379 的 `F=5` 同样是刻意选的形状。
  两批都不得当作「平均形状」引用。
- ~~用「每批 73s + 每行 3.6s + 收口」重算剩余 31 批（309 文件 / 439 行）：`31 × 141 + 1,580 = 5,951s ≈ 1.65h`~~
  **作废（b380）**：`a = 73` 与 `c_l = 3.6` 都来自共线三点解，已被四点过定拟合的 `61.4 / 3.45` 取代。
  当前有效的独立点估计见 b380 台账 §7（`1.46h`），且**不进主报区间**。
