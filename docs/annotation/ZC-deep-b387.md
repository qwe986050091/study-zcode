# ZC-deep-b387

> 批次：b387 ｜ **20 行 / 10 文件** ｜ 提交 `91c231e7`

## 0. 普通批；`fix=0`；**判据类 0 / 格式类 0 / lint 0**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| 自写 lint（写盘前） | 0 | 20 行一次过（锚点 / 分隔符 / 代词） |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 0 | `hits=0` |
| 六闸 | 0 | 一次过（`same=0 indent=0 drift=0`） |
| `deep-quality` 全仓扫描 | 0 | 20 条目标行无一残留 |

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/PermissionDialog.tsx` | 3 | 1 |
| `packages/ui/src/plugin-ui/adapters/usePluginUiSidePaneModel.tsx` | 2 | 0 |
| `packages/ui/src/project-sidebar/ArchiveGroupCard.tsx` | 2 | 0 |
| `packages/ui/src/project-sidebar/ProjectCreation.tsx` | 3 | 1 |
| `packages/ui/src/project-sidebar/ProjectEditor.tsx` | 3 | 1 |
| `packages/ui/src/project-sidebar/ProjectNodeContent.tsx` | 2 | 0 |
| `packages/ui/src/project-sidebar/remote-project-connection.ts` | 2 | 0 |
| `packages/ui/src/quickpick/TaskFindDialog.tsx` | 4 | 2 |
| `packages/ui/src/remote-connection-flow/requestRemoteProjectConnection.ts` | 2 | 0 |
| `packages/ui/src/resource-manager/ResourceManagerApp.tsx` | 3 | 1 |
| **合计** | **26** | **6** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | ACTIVE | 表外 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | ---: | --- |
| **10** | **5** | **0** | 1,477 → 1,472 | 1,385 | **87** | `1,477 − 5 + 0 = 1,472` ✔；`1,385 + 87 = 1,472` ✔ |

- 5 个文件各留 1 行池外上游残留：`PermissionDialog`、`ProjectCreation`、`ProjectEditor`、`TaskFindDialog`（2 行）、`ResourceManagerApp`。
- **表外差集（首个非空）**：`b386 → b387` 新增 **0** / 移除 **2**，名单落盘
  [`ZC-deep-b387-outside-diff.tsv`](ZC-deep-b387-outside-diff.tsv)：
  `- packages/ui/src/project-sidebar/remote-project-connection.ts`、`- packages/ui/src/remote-connection-flow/requestRemoteProjectConnection.ts`。
  这 2 个文件本批彻底清零，所以从表外集合退出；表外 89 → 87。
- 表内 1,520 = ACTIVE 1,385 + CLEARED 135。

## 2. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=91c231e7 files=10/10 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=34 auto_self_clear=0
gate: PASS order n=0 total=374.0s controllable=100.0s
GATE ALL PASS batch=b387 sha=91c231e7
```

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
```

## 3. 进度

- 全仓 weak：**3,516 → 3,496**（−20）；weak 文件 **1,477 → 1,472**。
- 池内：**259 行 / 229 文件**（`7,162 + 259 = 7,421`、`778 + 229 = 1,007`、`ALIGNED OK`）。
- **行侧进度 96.5%**（7,162 ÷ 7,421）；文件侧 `778 ÷ 1,007 = 77.3%`（辅助）。
- **残留两列**：池内可写 **259 行** / 池外残留 **3,237 行**（`3,496 − 259`）。
- 剩余批数（cap 10）：**23 批**（229 ÷ 10）。形状：`259 ÷ 23 = 11.3 行/批`、`229 ÷ 23 ≈ 10 文件/批`。

## 4. 计时（一位小数，S0–S4 之和 = 收口）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `7ea73611`（17:18:05） | `91c231e7`（17:24:19） | 374.0 |
| `controllable` | `--start`（17:22:39） | 批次提交 | **100.0** |
| **S0** 提交 → closeout | 17:24:19 | 17:24:22 | **3.0** |
| **S1** 扫描 + 1b/1c | — | — | **7.5** |
| **S2** rewrite.tsv + 白名单 + capacity | — | — | **1.3**（0.0 + 0.2 + 1.1） |
| **S3** 台账 | 17:24:30.8 | 17:25:23.3 | **52.5** |
| **S4** 提交 | 17:25:23.3 | 17:25:24 | **0.7** |
| **收口 S0–S4** | 17:24:19 | 17:25:24 | **65.0**（3.0 + 7.5 + 1.3 + 52.5 + 0.7） |
| **批墙钟** | 17:22:39 | 17:25:24 | **165.0**（100.0 + 65.0） |

**`[1b 校验]` / `[1c allowed]` 原文**：

```
[1c allowed] plan=20 + selfclear_rows=14 + auto=0 → allowed=34
[1b 校验] batch=b387 pre=b386 weak=d:/code/_annot_baseline/b387-repo-post.txt weak_rows=3496 plan=20 head_added=20
```

## 5. 点估计（主报）

```
[窗口] b386 / b385 / b383（b384 标事故，中位与包络同时剔除）
[窗口滚动] 滚入 b386（152s）；滚出 b382（139s）
[点估计] 0.99h = 23批 × 61.4 + 259行 × 3.45 + 23批 × 54.0s → 3547.8s
[点估计] 0.99h（收口维持 b386 的 54.0s）→ 3547.8s
[点估计] 0.84h（收口回到窗口最低 b383 的 31.0s）→ 3018.8s
[观测包络] 0.61–1.12h（同窗口 min 96s / max 176s；参考，不进主报）
[表外差集] 新增 0 / 移除 2（b386 → b387）
```

- **主报 = `0.99h`**（收口中位 54.0s）；收口回到 `31.0s` 则 `0.84h`。
- **窗口滚动**：滚入 `b386（152s）`、滚出 `b382（139s）`，包络从 `0.64–1.17h`（24 批）变为
  `0.61–1.12h`（23 批）。区间变窄是「批数减少 + 窗口换了上限 176s」，不是精度提升。
- 收口中位与包络同源：`b386 / b385 / b383`；b381 与 b384 两处同时剔除。

## 6. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `91c231e7` | `+20/−20` |
| rewrite.tsv + outside-diff + 本台账 + CLOSING 填数 + 白名单 694 行 | `c803e6b7` | — |
