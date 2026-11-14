# b241 改写批（合并第 2 批：6 个 1–2 行档文件）

- 日期：2026-11-10
- base：`6221f71c`（本批改写前的 HEAD）
- 范围：整文件口径，6 文件（一次门禁、一份登记表）
- 提交：`da7c8668 b241 改写 6 文件的水句 (+9/−12)`

## 1. 本批选谁

1–2 行档剩余排序取下一组 6 个（与 b240 不重叠）：

| 文件 | tsv own weak | 实测 weak |
| --- | ---: | ---: |
| `apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts` | 2 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` | 2 | 5 |
| `apps/zcode-cli/packages/cli/src/arguments.ts` | 2 | 2 |
| `apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts` | 2 | 2 |
| `apps/zcode-cli/packages/core/src/browser-client/playwright.ts` | 2 | 2 |
| `apps/zcode-cli/packages/core/src/hooks/workspace-hook-review-flow.ts` | 2 | 3 |

实测 16 行，仍高于 tsv 的 12 行——b240 的口径发现（tsv 是「本线可改」下界）继续成立。

## 2. 每文件均摊：显式阈值（b241 落成数字）

稳态区间定为 **25–40 秒/文件**。两档越界各自有动作，且以「连续两批」计数，避免单批噪声：

| 条件 | 动作 | 当前计数 |
| --- | --- | ---: |
| 连续 2 批 **> 40 秒/文件** | 每批回落到 **4–5 个**文件 | **1**（b241 = 41.7） |
| 区间内 25–40 | 维持 **6 个** | — |
| 连续 2 批 **< 25 秒/文件** | 上限抬高，试 **8 个** | 0 |

本批实测：墙钟 250.4 秒 / 6 文件 = **41.7 秒/文件**。b240 是 32.5，因此「>40」只计到 1 批，**b242 不回落**；若 b242 仍 >40，则 b243 起按 4–5 个/批执行。

## 3. 归属预检（v6 白名单）

16 行逐行 `git blame`，三个 sha：

| sha | 行数 | `own-commits --check` | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e` | 12 | 本线 | 改写/删除 |
| `ee933d52`（`docs(注释): 补齐被剔除的 contracts/bootstrap-v4 注释改写`） | 1 | **上游（未登记）** | 不改，登记豁免 |
| `872ad960`（`feat: open source`） | 3 | **上游** | 不改，登记豁免 |

白名单当前 **28 条**（`own-commits.mjs` 直读，较 b240 的 27 条多 1，来自 b240 台账登记的 `477f5d6a`）。
`ee933d52` 标题属本线写法，但**不在**任何台账/`OWN-COMMITS.md` 里，按 v6 一律判上游：宁可少改，不放行。

## 4. 门禁七行原文

首跑用的是 `docs/annotation/_tools/zc-commit.mjs`（该副本内容等于 v4，见 §12），v6 复跑（`base=6221f71c`）七行完全一致，以下为 v6 原文：

```text
=== 改写门禁（base=6221f71c）===
删本线注释    n=12  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=9  其中判据命中 0  （必须 0；已扣除搬移行）
```

复跑时出现「拒绝项 6 条 :: 无 diff」——因为改动已提交，工作区与 `6221f71c` 的 numstat 为空，属复跑预期，不是门禁失败；七行与首跑逐字相同。

## 5. TSV 与「删本线注释」逐条对应（分文件）

`ZC-deep-b241-rewrite.tsv` 12 条 = 门禁 `删本线注释 n=12`，逐条：

```text
 2  apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts
     :161  // 错误监听覆盖写响应阶段。                → 删除（与前 4 行重复）
     :212  // 令牌不符直接抛错，不做降级。            → 改写（补 session 能力映射）
 2  apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts
     :269  // 新增解释器只影响展示，不改变任何安全判定… → 删除（与 266–268 同义）
     :2556 // 不得在本地发明补丁或误删。              → 改写（补 onRewindTriggered + messageId）
 2  apps/zcode-cli/packages/cli/src/arguments.ts
     :129  // [权衡] 全局注册的代价…                 → 改写（补 commands 白名单指代）
     :193  // 该常量登记驼峰与短横线两种拼写…        → 改写（补 DISALLOWED_TOOLS_FLAGS）
 2  apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts
     :379  // 清单与建议列表同源，包含自定义命令。    → 改写（补 listAvailableCommandNames）
     :421  // 别名行只在存在别名时加入…              → 改写（补 aliasLine / entry.aliases）
 2  apps/zcode-cli/packages/core/src/browser-client/playwright.ts
     :127  // 不要改成「只包装一层」…                → 改写（补 defaultObjectWrapper）
     :375  // [契约] 这里不做本地超时、不做重试…     → 删除（与 373–374 重复）
 2  apps/zcode-cli/packages/core/src/hooks/workspace-hook-review-flow.ts
     :126  // 这三个条件任一不满足都属于调用方的编排错误… → 改写（补 throw / supersede）
     :250  // 这里不触发新请求，只是把当前代际正常收口。   → 改写（补 closeWithoutDecision / resolved）
```

删除 3 行（纯重复句），改写 9 行（1→1，补标识符锚点）。`新增注释行 n=9` 与改写条数相等，无净增注释。

## 6. 改前 / 改后度量

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=6 units=4266 coverage=9.7% branch=8.1% field=4.3% comments=2294 substance=79.3% explain=99.3% filler=0.0% weak=0.7%` | `weak=16/2294 filler=0/2294` |
| 改后 | `files=6 units=4266 coverage=9.7% branch=8.1% field=4.3% comments=2291 substance=79.5% explain=99.8% filler=0.0% weak=0.2%` | `weak=4/2291 filler=0/2291` |

`--list-weak`：16 → **4**（全部为 §9 的上游行，同一文件）。分文件：2 / 5 / 2 / 2 / 2 / 3 → 0 / 4 / 0 / 0 / 0 / 0。

## 7. 覆盖差集

按 `path|unitText` 取差集（行号会漂移）：

```text
pre=2844 post=2844 onlyPre=0 onlyPost=0
```

覆盖单元数不变，无「注释改完把某单元挤到覆盖外」的情况。

## 8. numstat

```text
+1 −2  apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts
+1 −2  apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts
+2 −2  apps/zcode-cli/packages/cli/src/arguments.ts
+2 −2  apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts
+1 −2  apps/zcode-cli/packages/core/src/browser-client/playwright.ts
+2 −2  apps/zcode-cli/packages/core/src/hooks/workspace-hook-review-flow.ts
合计 +9 −12（标题由脚本现算）
```

## 9. 上游 weak 豁免（4 行，逐条归因）

全部在 `product-projection.ts`，blame 均为上游，按 DEEP-SPEC §2.6「上游注释不可删不可改」保留：

```text
:2548  无解释  「不得在本地发明补丁或误删。」        ee933d52  docs(注释)…（未登记）
:2688  无解释  「── 生命周期 ──」                  872ad960  feat: open source
:3238  无解释  「── 流式输出 ──」                  872ad960  feat: open source
:6551  无解释  「── 内部工具 ──」                  872ad960  feat: open source
```

这是本工程第一次出现「本批收不完全部 weak」。**不放行、不绕过**：3 条分区线属导入提交，1 条属未登记的本线提交。
若后续要清，正确路径是先确认 `ee933d52` 的归属（补登或维持上游），以及由负责人决定分区线是否单独豁免，而不是在本批改它们。

## 10. ruler=

```text
deep-quality v1.9 sha1=8042442fe198   zc-gate v3 sha1=f75c5e64246f   zc-commit v6 sha1=032283968d18
own-commits sha1=79dfdb7b63b3          capacity-estimate sha1=fce060a3b541
```

（均为 git blob sha1，12 位。）

## 11. 三段计时与返工

| 段 | 打点 | 秒 |
| --- | --- | ---: |
| T0 → T1（读上下文 + 归属预检，第一处编辑前） | 17:35:42 → 17:37:58.794 | 136.8 |
| T1 → T2（编辑 12 行） | 17:37:58.794 → 17:38:17.480 | 18.7 |
| T2 → T3（快照 + 门禁 + 返工 + 提交） | 17:38:17.480 → 17:39:52.387 | 94.9 |
| **合计 == 墙钟** | 17:35:42 → 17:39:52.387 | **250.4** |

返工单独打点：

| # | 起点 | 内容 | 耗时 |
| --- | --- | --- | ---: |
| 1 | 17:39:27.257 | 门禁首跑命中 `W`：`新增注释` 2555 行无拉丁标识符（`因此这里不发明本地补丁…`）→ 补 `onRewindTriggered` / `messageId` | 25.1s（含复跑与提交） |
| 2 | 提交后 | 门禁首跑用的是 `_tools/zc-commit.mjs`（v4 内容），改用 v6 复跑核对 | 不计入墙钟（提交后自查） |

返工 #1 发生在**首次门禁之后**，因此按约定计入段 3，不混进段 2。本批仍是「有返工」样本，产能口径取 250.4s；不计入 25–40 稳态样本。

## 12. 三件跟办

### 12.1 每文件均摊阈值

已写入 §2 的表格与数字（41.7 / 32.5 / 计数 1），后续批次直接在该表追加实测值与计数。

### 12.2 `Skip 1` 类缺陷：第三例

已写入 [`_tools/INDEX.md`](_tools/INDEX.md) §9「工具输出可信度缺陷」：共同点是**从文件读数据时对「有没有表头」做了位置假设**，退出码和肉眼输出都正常，只有数字错了。

对 `_tools/` 全量审计结果：

- **真·表头假设**：`vk-calib-ctx.mjs:18`、`vk-calib-stats.mjs:24`、`vk-calib-recheck.mjs:7`、`vk-calib-weak.mjs:5,7`、`uv-audit60-cross.mjs:10`、`tmp_r52_sample_csv.mjs:22`。逐个核对输入首行：`vk-calib.tsv` / `vk-calib-stats.tsv` / `audit60.csv` **确有表头**，所以这些 `slice(1)` 正确。
- **首行是汇总横幅而非表头**：`B69-debug-lua.mjs:514`、`B70-check-rdb.mjs:679` 读的 `VK-B6x-uncovered.txt` 首行是 `uncovered 382 branch 65`，`slice(1)` 也正确。
- **其余 `slice(1)`** 都是剥 diff 的 `+`/`-` 前缀，不是行数组跳过，属正确用法。
- **当前活工具**（`zc-commit` v6、`capacity-estimate`、`own-commits`、`deep-quality`）:`capacity-estimate` 对基线逐行做 `^\d+$` 形状校验、`zc-commit` 对 numstat/blame 用正则匹配 —— 均为「形状校验」而非「位置假设」，不会再犯同类错。

结论：此类写法的存量都在一次性校对脚本里且输入确有待跳过的首行，**无需改脚本**；约束改为「新脚本读文件必须做形状校验，禁止按位置跳首行」，写进 INDEX §9。

### 12.3 5–9 档的下探验证

**未执行**，本批仍是 1–2 行档。按指令，下探 5–9 档前先做一批 3 文件验证，报「每文件均摊」与「每批秒数」，实测前不动 143 批的估算。

## 13. 下一步

1. b242 继续 6 文件（1–2 行档），观察是否连续第 2 批 >40 秒/文件；
2. 3 文件验证批放在 1–2 行档清完、切到 5–9 档之前。
