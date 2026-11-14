# ZC-deep-b388

> 批次：b388 ｜ **20 行 / 10 文件** ｜ 提交 `bc24a2b7`（原 `b217963d`，仅修正标题）

## 0. 普通批；`fix=0`；**判据类 2 / 格式类 0 / lint 0**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | 5 | 5 行被判据拦下：`useRootPlatformEffects:752` 与 `HooksList:96` 分隔符 2 个、`automationAgentConfigOptions:37` 与 `AutomationEditView:3548` 与 `McpSettingsSection:918` 含禁用代词；改后一次过 |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 2 | 首轮 `HooksList:253` 与 `AutomationEditView:3549` 判 W；补 `PluginHookRow` / `DropdownMenu` 两个标识符后 `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/resource-manager/storage/useStorageUsage.ts` | 2 | 0 |
| `packages/ui/src/root/useRootPlatformEffects.ts` | 2 | 0 |
| `packages/ui/src/settings/automationAgentConfigOptions.ts` | 3 | 1 |
| `packages/ui/src/settings/AutomationEditView.tsx` | 8 | 6 |
| `packages/ui/src/settings/ExternalAgentImportDialog.tsx` | 2 | 0 |
| `packages/ui/src/settings/HooksList.tsx` | 2 | 0 |
| `packages/ui/src/settings/McpSettingsSection.tsx` | 2 | 0 |
| `packages/ui/src/settings/model-provider-section/CodingPlanStatusMeta.tsx` | 3 | 1 |
| `packages/ui/src/settings/model-provider-section/ProviderModelModalityOptions.tsx` | 2 | 0 |
| `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts` | 2 | 0 |
| **合计** | **30** | **10** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **10** | **7** | **0** | 1,472 → 1,465 | 1,380 | **85** | `1,472 − 7 + 0 = 1,465` ✔；`1,380 + 85 = 1,465` ✔ |

- 3 个文件各留池外上游残留：`automationAgentConfigOptions` 1 行、`AutomationEditView` 6 行、`CodingPlanStatusMeta` 1 行。
- **表外差集**：`b387 → b388` 新增 **0** / 移除 **2**，名单落盘
  [`ZC-deep-b388-outside-diff.tsv`](ZC-deep-b388-outside-diff.tsv)：
  `- packages/ui/src/resource-manager/storage/useStorageUsage.ts`、`- packages/ui/src/settings/HooksList.tsx`。
  这 2 个文件本批彻底清零，表外 87 → 85。
- 表内 1,520 = ACTIVE 1,380 + CLEARED 140。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=b217963d files=10/10 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=34 auto_self_clear=0
gate: PASS order n=0 total=406.0s controllable=155.0s
GATE ALL PASS batch=b388 sha=b217963d
```

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
```

## 3. 进度

- 全仓 weak：**3,496 → 3,476**（−20）；weak 文件 **1,472 → 1,465**。
- 池内：**239 行 / 219 文件**（`7,182 + 239 = 7,421`、`788 + 219 = 1,007`、`ALIGNED OK`）。
- **行侧进度 96.8%**（7,182 ÷ 7,421）；文件侧 `788 ÷ 1,007 = 78.2%`（辅助）。
- **残留两列**：池内可写 **239 行** / 池外残留 **3,237 行**（`3,476 − 239`）。
- 剩余批数（cap 10）：**22 批**（219 ÷ 10）。形状：`239 ÷ 22 = 10.9 行/批`、`219 ÷ 22 ≈ 10 文件/批`。

## 4. 计时（一位小数，S0–S4 之和 = 收口）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `32a39922`（17:27:06） | `bc24a2b7`（17:33:52） | 406.0 |
| `controllable` | `--start`（17:31:17.6） | 批次提交 | **155.0 ± 0.5** |
| **S0** 提交 → closeout | 17:33:52 | 17:33:53.3 | **1.3** |
| **S1** 扫描 + 1b/1c | — | — | **7.4** |
| **S2** rewrite.tsv + own-commits + capacity | — | — | **1.3**（0.0 + 0.2 + 1.1） |
| **S3** 台账 | 17:34:02 | 17:36:14 | **132.0** |
| **S4** 提交 | 17:36:14 | 17:36:27 | **13.0**（含一次 `add` 路径写错的重跑） |
| **收口 S0–S4** | 17:33:52 | 17:36:27 | **155.0 ± 0.5**（1.3 + 7.4 + 1.3 + 132.0 + 13.0） |
| **批墙钟（实测端点）** | 17:31:17.6 | 17:36:27 | **309.4** |

- **两个 `155.0` 各自独立，但不能互相印证**：`controllable` 由 gate `order` 从 `--start` 时间戳算到批次提交；
  `收口` 由 S0–S4 四段实测相加，端点同样落在批次提交与台账提交上。
- **`批墙钟` 不是独立测量**：早期写法 `310.0 = 155.0 + 155.0` 是和值；实测端点为 `309.4`，
  与 `310.0` 差 `0.6s`，来源是 git 提交时间戳只有秒级精度。**对外读作 `309.4 ± 0.5`**，
  与 `118.0 / 118.0` 那次同规格处理，不把「和值恰好相等」当证据。

**`[1b 校验]` / `[1c allowed]` 原文**：

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
[1b 校验] batch=b388 pre=b387 weak=d:/code/_annot_baseline/b388-repo-post.txt weak_rows=3476 plan=20 head_added=20
```

### 4.1 `controllable` 高出模型 19% 的归因

模型给 `61.4 + 20 × 3.45 = 130.4s`，实测 `155.0s`，差 **`24.6s`（+18.9%）**，远超四点拟合的最大残差 `4.2%`。

| 来源 | 量 | 说明 |
| --- | ---: | --- |
| 上下文窗口 | 20 个 / 10 文件 | 每行读 1 个窗口（前后 5–7 行），**2 行/文件**，无跨文件串读 |
| 额外检索 | 2 次 | `AUTOMATION_DEFAULT_MODE` 的调用点（11 处）、`hasActions` 的定义式（`canOpenSession \|\| Boolean(onDeleteRun)`） |
| 返修轮次 | 3 轮校验链 + 2 次 `apply` | lint 首轮 5 行不过（分隔符 2 个 ×2、禁用代词 ×3）→ 整套 `apply` 重跑；judge 首轮 2 条 W → 补锚点后 `plan-new / precheck / diffset / judge` 再跑 2 轮 |

- **形状无异常**：20 行摊在 10 个文件上，平均 2 行/文件，读取量 1:1，不是「需要跨文件阅读」的难批。
- **超支全部是返修**：模型是「每批固定 + 每行边际」两项式，**没有返修轮次项**。
  这 `24.6s` 不是记账错，也不是本批更难，而是公式缺项；已记入 §6 GATE-DEBT-1 的观察面。
- **没有混入非起草工作**：CLOSING / INDEX 填数发生在 S3，落在收口侧，不在 `controllable` 里。

### 4.2 S3 的「稳态 / 一次性」拆分

S3 `132.0s` 当批没有分段打点，下面按动作归类，**非实测**：

| 段 | 秒（估） | 性质 |
| --- | ---: | --- |
| 台账 `ZC-deep-b388.md` | ~45 | 稳态（每批都要写） |
| CLOSING 7 处填数 | ~40 | 本批起常态；**骨架本身是 b387 一次性**，已在 b387 的 S3 `52.5s` 内 |
| INDEX 6 处填数 | ~35 | 稳态 |
| `NEVER-CLEAR` 刷新 + `add` 重跑 | ~12 | 稳态 |

- b389 起把 S3 拆两段：**`S3a` 台账 + 白名单**（稳态）、**`S3b` CLOSING/INDEX 填数**（文档），两个数分列上报。
- 当前 `65.0s` 收口中位**含文档一次性与每批填数成本**，主报会跟着漂；CLOSING §5 已注明哪一版含一次性。

## 5. 点估计（主报）

```
[窗口] b387 / b386 / b385（b381 与 b384 标事故，中位与包络同时剔除）
[窗口滚动] 滚入 b387（165s）；滚出 b383（96s）
[点估计] 1.00h = 22批 × 61.4 + 239行 × 3.45 + 22批 × 65s（收口中位 54 / 65 / 84）→ 3605.3s
[点估计] 1.00h（收口维持 b388 的 65.0s）→ 3605.3s
[点估计] 0.93h（收口回到窗口最低 b386 的 54.0s）→ 3363.3s
[观测包络] 0.93–1.08h（同窗口 min 152s / max 176s；参考，不进主报）
[表外差集] 新增 0 / 移除 2（b387 → b388）
```

- **主报 = `1.00h`**（收口中位 65.0s）；收口回到 `54.0s` 则 `0.93h`。
- **窗口滚动**：滚入 `b387（165s）`、滚出 `b383（96s）`，包络从 `0.61–1.12h`（23 批）变为
  `0.93–1.08h`（22 批）。下沿抬升 `0.32h` 全部来自 `96s` 滚出，不是精度提升。
- 收口中位与包络同源：`b387 / b386 / b385`；b381 与 b384 两处同时剔除。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `bc24a2b7`（原 `b217963d`） | `+20/−20` |
| rewrite.tsv + outside-diff + 本台账 + CLOSING 填数 + 白名单 697 行 | `74d13d9f` | — |

- **提交标题 `true (+20/−20)` 已修正，SHA 由 `b217963d` 变为 `bc24a2b7`**。
  依据：该提交**未推送**（`git branch -r --contains` 为空），按「只换 subject、内容树不动」处理，
  用 `git rebase --onto` 重放后 3 个文档提交。`OWN-COMMITS.tsv` 已同步为新 SHA，`b388-backup` 分支保留旧链。
- **根因已拦住**：`gate-run.mjs` 的 `opt()` 新增校验——`--name` 后若跟 `--` 开头的 token 直接退出。
  实测 `node gate-run.mjs --subject --batch b388 …` → `参数错误：--subject 缺少值（下一个 token 是 --batch）`，`exit=2`。
- 计时回填见 `463294e6`（S3 `132.0` / S4 `13.0`）。
