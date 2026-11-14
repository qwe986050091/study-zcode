# ZC-deep-b383

> 批次：b383 ｜ **24 行 / 10 文件** ｜ 提交 `d7ca39bf`

## 0. 普通批；`fix=0`；**判据类 0 / 格式类 0 / lint 1**

| 抓取步骤 | 条数 | 内容 |
| --- | ---: | --- |
| lint（写盘前） | **1** | `rows-renderer.tsx:63` 含「据此」，改成「随后」后通过 |
| `sentence-precheck` | 0 | `missing_anchor=0 missing_predicate=0` |
| `judge-generic`（写盘后） | 0 | `hits=0` |
| 六闸 | 0 | 一次过 |
| `deep-quality` 全仓扫描 | 0 | 24 条目标行无一残留 |

- **判据口径本批变更**：§5.3 4b——反引号内 2 字符标识符计锚点（`ident()` 只放宽反引号内容 + 标识符形状）。
  本批有 6 行靠 `\`id\``／`\`fs\``／`\`7z\`` 这类短标识符过判据，若按旧口径它们会被判 W。

## 1. 逐文件对账与固定三列

| 文件 | 批前 weak | 批后 weak |
| --- | ---: | ---: |
| `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx` | 3 | 0 |
| `packages/web/src/share/ConversationShareLandingPage.tsx` | 5 | 2 |
| `packages/zcode-server-cli/src/packaging/stageArchives.ts` | 3 | 0 |
| `packages/zcode-server-cli/src/packaging/stageDependencies.ts` | 3 | 0 |
| `packages/desktop/scripts/mcp-apps-host-fixture/rows-renderer.tsx` | 2 | 0 |
| `packages/desktop/scripts/mcp-apps-host-fixture/sampling-main.ts` | 2 | 0 |
| `packages/e2e-report/src/viewer/CoveragePanel.tsx` | 2 | 0 |
| `packages/model-option-map/src/merge-patch.ts` | 2 | 0 |
| `packages/provider/src/config-service.ts` | 2 | 0 |
| `packages/provider/src/config/model-config.ts` | 2 | 0 |
| **合计** | **26** | **2** |

| 清理文件数（池内清零） | 全仓清零 | 新进 weak 文件 | 集合 | 可清 | 恒等式 |
| ---: | ---: | ---: | --- | ---: | --- |
| **10** | **9** | **0** | 1,512 → 1,503 | **−17 → 记 0（已到底）** | `1,512 − 9 + 0 = 1,503` ✔ |

- 未全仓清零的 1 个：`ConversationShareLandingPage.tsx`（`5 → 2`，两行池外上游），与 `pick` 的 `upOut=1` 一致。
- **集合仍在下穿基线**（1,503 < 1,520，`可清 −17`）：基线 1,520 里已有 17 个文件彻底干净，属基线陈旧，不是账错。

## 2. 六闸

```
gate: PASS scope n=0 plan=24 allow=0 diff_old=24 diff_new=24 out_of_scope_edits=0 plan_lines_covered=24/24
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=d7ca39bf files=10/10 numstat=24/24 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=24 added=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 total=314.0s controllable=65.0s
GATE ALL PASS batch=b383 sha=d7ca39bf
```

## 3. 进度

- 全仓 weak：**3,600 → 3,576**（−24）；weak 文件 **1,512 → 1,503**。
- 池内：**339 行 / 269 文件**（`738 + 269 = 1,007`、`7,082 + 339 = 7,421`、`ALIGNED OK`）。
- **行侧进度 95.4%**（7,082 ÷ 7,421）；文件侧 `738 ÷ 1,007 = 73.3%`（辅助）。
- **集合已到底**：可清记 0，此后只报「新进 / 清零」。
- 剩余批数（cap 10）：**27 批**（269 ÷ 10）。

## 4. 计时（一位小数，S0–S4 之和 = 收口）

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `total` | `1f7200a3`（16:26:48） | `d7ca39bf`（16:32:02） | 314.0 |
| `controllable` | `--start`（16:30:57） | 批次提交 | **65.0** |
| **S0** 提交 → closeout | 16:32:02 | 16:32:09 | **7.0** |
| **S1** 扫描 + 1b 校验 | 16:32:09 | 16:32:17 | **8.0** |
| **S2** rewrite.tsv + own-commits + capacity | 16:32:17 | 16:32:18.3 | **1.3** |
| **S3** 台账 | 16:32:18.3 | 16:32:32.0 | **13.7** |
| **S4** 提交 | 16:32:32.0 | 16:32:33.0 | **1.0** |
| **收口 S0–S4** | 16:32:02 | 16:32:33 | **31.0**（7.0 + 8.0 + 1.3 + 13.7 + 1.0） |
| **批墙钟** | 16:30:57 | 16:32:33 | **96.0**（65.0 + 31.0） |

**`[1b 校验]` 首行原文（b383 实跑证据）**：

```
[1b 校验] batch=b383 pre=b382 weak=d:/code/_annot_baseline/b383-repo-post.txt weak_rows=3576 plan=24 head_added=24
```

- 批号显式传入、无默认值；打印实际读取的 weak 路径与行数；`plan=24 == head_added=24` 才继续。
  b382 那条「把参数写死会静默读上一批输入」的风险，现在会在 1b 直接退出。

## 5. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体 | `d7ca39bf` | `+24/−24` |
| rewrite.tsv + 本台账 + 白名单 676 行 | `8b0d4bed` | — |

## 6. 补记（b384 起生效，不改上文）

- **点估计漏报**：本批缺主报点估计。补：`27 × 61.4 + 339 × 3.45 + 27 × 53.6 = 4,274.6s = 1.19h`；
  收口若维持本批 `31.0s`，同式 `3,664.4s = 1.02h`。b384 起每批必报，不再有空档。
- **`可清 −17` 的读法修正**：`−17` 是净值（`1,520 − 108 CLEARED + 91 新进 = 1,503`），不是「17 条干净」。
  `可清` 指标自 b384 退役，改报「池内可写行 / 池外残留行」两列（见 INDEX §6.2-24）。
- **`allowed=38` 拆项**：`24 + 14 + 0`——plan 24、自清表既有数据 14 行、本批自动登记 0；不是常数 12。

