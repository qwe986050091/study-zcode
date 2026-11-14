# b243 改写批（合并第 4 批：6 文件 + v7 计数洞回溯 + 提交集合断言）

- 日期：2026-11-10
- base：`05bca5eb`（b242 补记提交，本批改写前 HEAD）
- 提交：`18e274fc b243 改写 6 文件的水句 (+11/−12)`
- 回溯补修：`1c54edbb b243 回溯补修 b240 三行单行 JSDoc (+3/−3)`（本批新增，见 §9）
- 尺子：`zc-commit v9`（`GATE self=… blob=1542e4088fd2`）；回溯补修起换 `v10`（`blob=066509a32c52`，见 §9.5）

## 1. 本批选谁

1–2 行档剩余排序取下一组（`deep-quality v1.9`，改前 `--list-weak` 实测）：

| 文件 | 实测 weak |
| --- | ---: |
| `apps/zcode-cli/packages/core/src/workflow/scheduler/node-runner.ts` | 2 |
| `apps/zcode-cli/packages/office-runtime/ui/viewers/XlsxView.tsx` | 3（含 1 条 `*/` 空文本） |
| `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` | 2 |
| `packages/client/src/webRemoteControlRelayProtocol.ts` | 2 |
| `packages/desktop/scripts/mcp-apps-host-fixture/managed-environment.ts` | 2 |
| `packages/desktop/scripts/mcp-apps-host-fixture/model.ts` | 2 |

合计 13 行，可改 12 行（`XlsxView.tsx:213` 是上游 `*/`，删掉 214 的重复句后自然消失）。

## 2. 归属预检（v6 白名单，31 条）

| sha | 行数 | 判定 | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e`（`docs(注释): L2 覆盖…`） | 12 | 本线 | 改写 11 / 删除 1 |
| `0a1fc56d`（`ZCode Source Sync Bot`） | 1 | **上游** | 不删不改；`XlsxView.tsx:213` 的 `*/` |

`0a1fc56d` 的那 1 行是空文本 `*/`，`XlsxView.tsx:214` 的本线重复句删除后，`deep-quality` 不再把它算成独立 weak（与 b241 同型，见 §5）。

## 3. 门禁七行原文（v9，含 self 行）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=1542e4088fd2
=== 改写门禁（base=HEAD）===
删本线注释    n=12  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=11  其中判据命中 0  （必须 0；已扣除搬移行）
```

## 4. TSV 与「删本线注释」逐条对应（12 条 = 门禁 n=12）

登记表：`docs/annotation/ZC-deep-b243-rewrite.tsv`（12 行数据 + 表头）。

```text
node-runner.ts:148        a8784b7e  // 取消信号触发的异常不在这里结算，直接向上抛给调度器。
node-runner.ts:212        a8784b7e  // 完成态活动同时登记输入与输出产物，形成可追溯的边。
XlsxView.tsx:80           a8784b7e  // 控制器选区可能反向，先取行列的较小较大值再统一加一。
XlsxView.tsx:214          a8784b7e  // 最小宽二像素、高十六像素，单击也能得到一个可点击的选区条。
app-sidebar.tsx:91        a8784b7e  // // 交互归属：按键、焦点、选中与滚动都不在本层…
app-sidebar.tsx:260       a8784b7e  // // 丢弃而非隐藏，折叠态不占用纵向空间…
webRemoteControlRelayProtocol.ts:128  a8784b7e  // 缓冲是有限资源，达到上限时整体清空…
webRemoteControlRelayProtocol.ts:133  a8784b7e  // 上限与超时是两道独立保险…
managed-environment.ts:52   a8784b7e  // [权衡] 不走安装函数的默认环境推导…
managed-environment.ts:202  a8784b7e  // [并发] 同一方法的多次调用共享一个门控…
model.ts:44               a8784b7e  // 流式与非流式在同一个处理器里分流…
model.ts:55               a8784b7e  // 非流式分支支持延迟应答…
```

改写后逐条：

| # | 文件:行 | 改写后 |
| --- | --- | --- |
| 1 | `node-runner.ts:148` | `// AbortError 不在这里结算：取消由 abortSignal 一路透传，本层只把它抛给调度器。` |
| 2 | `node-runner.ts:212` | `// 完成态活动同时登记 inputs 与 outputs 两份产物清单，形成可追溯的边。` |
| 3 | `XlsxView.tsx:80` | `// controller range 可能反向，先对 row/col 取 min/max 再统一加一。` |
| 4 | `XlsxView.tsx:214` | **删除**（与 208–209 的「最小宽 2px、高 16px」重复） |
| 5 | `app-sidebar.tsx:91` | `// 交互归属：按键与焦点都归宿主，AppSidebar 只声明 layout 与回调。` |
| 6 | `app-sidebar.tsx:260` | `// 折叠时卸载而非 display:none：不占纵向空间，侧栏高度随之还原。` |
| 7 | `webRemoteControlRelayProtocol.ts:128` | `// buffer 达到上限时整体清空而非丢最旧一帧，让缺口对对端显式暴露。` |
| 8 | `webRemoteControlRelayProtocol.ts:133` | `// 两个阈值是独立保险：maxBuffered 防内存膨胀，stallTimeout 防链路长时间无进展。` |
| 9 | `managed-environment.ts:52` | `// [权衡] 显式传 env 而不让 install 推导：夹具在源码与构建产物两种布局下都指向同一份实现。` |
| 10 | `managed-environment.ts:202` | `// [并发] install 的多次调用共享同一个 gate，第二次在第一次放行后立即通过。` |
| 11 | `model.ts:44` | `// 同一个 handler 先读完 request body 再按 stream 字段分流。` |
| 12 | `model.ts:55` | `// 非流式分支支持延迟应答：测试先断言 request 到达，再 resolve 响应。` |

12 删 / 11 增，与 `新增注释行 n=11`、numstat `+11 −12` 一致。

## 5. 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=6 units=1046 coverage=8.9% branch=10.2% field=30.8% comments=528 substance=85.4% explain=97.5% filler=0.0% weak=2.5%` | `weak=13/528 filler=0/528` |
| 改后 | `files=6 units=1046 coverage=8.9% branch=10.2% field=30.8% comments=527 substance=86.7% explain=100.0% filler=0.0% weak=0.0%` | `weak=0/527 filler=0/527` |

`--list-weak`：13 → **0**。`XlsxView.tsx` 的 `:213` 空文本 weak 随 `:214` 删除一并消失（`*/` 是上游 `0a1fc56d`，未删）。

覆盖差集（按 `path|unitText` 去重取差集，行号会漂移）：

```text
UNCOVERED units=953（去重键 807）pre → 953（807）post
onlyPre=0  onlyPost=0
```

## 6. numstat

```text
+2 −2  apps/zcode-cli/packages/core/src/workflow/scheduler/node-runner.ts
+1 −2  apps/zcode-cli/packages/office-runtime/ui/viewers/XlsxView.tsx
+2 −2  apps/zcode-cli/packages/tui/src/app-sidebar.tsx
+2 −2  packages/client/src/webRemoteControlRelayProtocol.ts
+2 −2  packages/desktop/scripts/mcp-apps-host-fixture/managed-environment.ts
+2 −2  packages/desktop/scripts/mcp-apps-host-fixture/model.ts
合计 +11 −12
```

## 7. 三段计时与阈值

| 段 | 打点 | 秒 |
| --- | --- | ---: |
| T0 → T1（读上下文 + 归属预检） | 17:52:19.568 → 17:52:40.968 | 21.4 |
| T1 → T2（编辑 12 行） | 17:52:40.968 → 17:53:00.268 | 19.3 |
| T2 → T3（快照 + 门禁 + 提交） | 17:53:00.268 → 17:53:24.621 | 24.4 |
| **合计 == 墙钟** | 17:52:19.568 → 17:53:24.621 | **65.1** |

每文件均摊：65.1 / 6 = **10.8 秒/文件**。零返工。

阈值计数（b241 §2 表）：

| 条件 | 计数 | 结果 |
| --- | ---: | --- |
| 连续 2 批 > 40 | 0（b241 的 1 已被 b242 打破） | 不回落 |
| 连续 2 批 < 25 | **2**（b242 = 24.9、b243 = 10.8） | **b244 试 8 个** |

## 8. 返工打点

本批零返工。回溯补修（§9）发生在 b243 代码提交之后，单独打点，不计入本批每文件均摊：

| # | 区间 | 内容 | 耗时 |
| --- | --- | --- | ---: |
| R1 | 17:53:40 → 17:59:43 | v7 计数洞回溯（全提交审计 + b237/b238 工作树重放 + b240 块注释补判）+ 3 行补修 + v10 归档 + 提交 `1c54edbb` | 363s |

## 9. v7 的 JSDoc 计数洞回溯（指令第 1 件）

### 9.1 洞是什么

`zc-commit` v5–v7 收集「新增注释行」只认 `t.startsWith('//')`。JSDoc 的 `*` 行 `isComment` 认（所以也不进「新增非注释行」黑名单），但既不计入分子、也不过 W/L/POEM——**直接蒸发**。v8 补了 `*` 行；v10 再补 `/*` 起始行（含单行 `/** x */`）。

### 9.2 审计方法

1. 扫全部提交，筛「注释-only 且新增行以 `*` 或 `/*` 开头」；
2. 带批次号的写成清单，逐个建 `--detach` 工作树、把 `own-commits.mjs` / `OWN-COMMITS.md` 拷进工作树，用 `--base <sha>^` 重跑门禁；
3. 新增 `*` / `/*` 行逐行丢给 `zc-gate.judgeEntries` 判 W/L/POEM（剥前缀后按新文件行号成组，保证 POEM 的连续行判定有效）。

### 9.3 对照表（b229–b243）

| 批次 | 原 `新增注释行 n` | numstat `+` | 其中 `*` 行 | 其中 `/*` 行 | v9 重跑值 | 判据命中 | 有行本该被改写 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| b229–b236 | 各批原值 | — | 0 | 0 | 等于原值 | 0 | 否 |
| b237 `832a0225` | 12 | 14 | 1 | 1 | **13** | 0 | 否 |
| b238 `c3f5fbc4` | 3 | 7 | 4 | 0 | **7** | 0 | 否 |
| b239 `eaa331c7` | 7 | 7 | 0 | 0 | 7 | 0 | 否 |
| **b240 `477f5d6a`** | **13** | **39** | 0 | **26** | 13（v10 = **39**） | **3** | **是，已补修** |
| b241 `da7c8668` | 9 | 9 | 0 | 0 | 9 | 0 | 否 |
| b242 `14c0e7e1` | 7 | 9 | 2 | 0 | 9（批次内已换 v8） | 0 | 否 |
| b243 `18e274fc` | 11 | 11 | 0 | 0 | 11（v10 同值） | 0 | 否 |

结论：**`*` 行零命中**（b237 +1、b238 +4、b242 +2 全部通过 W/L/POEM）；**`/*` 行有 3 处命中，全部在 b240**。

### 9.4 b240 的 3 处命中（已补修，见 `1c54edbb`）

b240 台账写 `新增注释行 n=13`，而 numstat 是 `+39`——差的 26 行正是单行 JSDoc `/** … */`。
v9 重跑仍是 13（`/*` 不计），把 26 行交给 `judgeEntries` 后命中 3 条：

```text
W  model-execution.ts:136     实际生效的请求头（鉴权覆盖后的结果），与请求期快照一致。
L  marketplace.ts:287         所有已安装插件记录，按 (id, scope) 唯一。
W  marketplace.ts:307         关联插件 id；目录级诊断（非单插件）时缺省。
```

三行 blame 均为 `477f5d6a`（b240 本线），处置为逐条改写（`1c54edbb`，+3/−3）：

| 行 | 改写后 |
| --- | --- |
| `model-execution.ts:136` | `/** headers 为请求期最终生效的请求头：鉴权覆盖已并入，与 resolved 快照一致。 */` |
| `marketplace.ts:287` | `/** plugins 保存全部 InstalledPluginRecord，以 id 与 scope 组合唯一。 */` |
| `marketplace.ts:307` | `/** pluginId 指出问题的插件；目录级诊断不针对单个插件时此字段缺省。 */` |

补修门禁（v10）：`删本线 3 / 删代码 0 / 删上游 0 / 新增非注释 0 / 原行搬移 0 / 标点级 0 / 新增注释 3 命中 0`，`+3 −3`；
`deep-quality` 两个文件改前改后都是 `weak=0/1130`（说明这 3 行在整文件口径里**不报 weak**——deep-quality 把单行 JSDoc 归到字段单元，标识符从代码行继承，只有门禁的逐行口径才看得见，两条尺子的差异记在这里）。

### 9.5 工具版本

- v9（`1542e4088fd2`）：提交集合断言，b243 本体使用；
- **v10（`066509a32c52`）**：`新增注释行` 再收 `/*` 起始行（剥 `/*` 与尾 `*/` 后过判据，空体跳过），回溯补修起使用。
- 复算 b243 本体不需换 v10：该批新增 11 行全是 `//`，两版同值 11 / 命中 0。

### 9.6 口径教训

`新增注释行 n` 与 numstat `+` 的差值必须能逐项解释（非注释行 + 搬移行 + 空行）。b242 是因为 7 vs 9 差了 2 才发现洞；b240 的 13 vs 39 差了 26 却没人对——**同一个信号，b242 抓住了、b240 漏了 26 倍**。从 b243 起，差值不为 0 时必须写一行归因。

## 10. 提交内容断言（指令第 2 件）

v9 在 `git add` 与 `git commit` 之间插入：

```js
const staged = run(['diff', '--cached', '--name-only']).trim().split(/\r?\n/)...sort();
const expected = rows.map((r) => r.rel).sort();
if (missing.length || extra.length) { console.error('已暂存集合 != 本批清单，拒绝提交。'); process.exit(1); }
```

实跑两处：

- b243 代码提交：`expected=6 staged=6`；
- 回溯补修提交：`expected=2 staged=2`。

b242 的「`git mv` 改名混进代码提交」不会再发生：多一个路径就 `exit 1`，不依赖人记得 `reset`。

## 11. 观察项（仅记录，本批不处置）

`// //` 双前缀注释在 11 个文件里共约 300 行（如 `app-sidebar.tsx` 18 行、`packages/shared/src/git.ts` 62 行），
本批 `app-sidebar.tsx:91/260` 沿用原前缀改写、未去掉双层 `//`。该形态在门禁里不可见（剥一层前缀后仍有正文），
需要单独一批处理，不在本批范围内。

## 12. 下一步

1. b244 按阈值表试 **8 个文件**（连续两批 <25 秒/文件：24.9、10.8）；
2. 5–9 档下探前先做 3 文件验证批（报每批秒数与每文件均摊），实测前不动 143 批估算；
3. `// //` 双前缀单独立项（§11）。
