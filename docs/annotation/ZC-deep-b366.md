# ZC-deep-b366

> 批次：b366 ｜ **30 行 / 6 文件** ｜ 提交 `2918f33a`

## 0. 普通批；`fix=0`；`hit_rate=3.3%`（all-checks 口径首跑）

- `files=6/6`；`plan_lines_covered=30/30`；`removed=30 added=0 allowed=40 auto_self_clear=0`。
- **首轮三项全 0**：`sentence-precheck` `missing_anchor=0 missing_predicate=0`；`judge` `hits=0`；
  六闸六行全 PASS 且 `判据=0`。
- **但首轮有 1 处越界**：`deploy.ts:134`（`resourcePackages` 的 JSDoc）不在 plan 内，我先按弱句下手改了，
  被**等集断言** `plan=30 diff=31 extra=1` 拦下，还原该行后 `plan=30 diff=30 missing=0 extra=0`。
  该行 blame 是上游、且不在池内，本就不该写。
- **`hit_rate` 口径**：严格按「precheck + judge + 六闸」= `0 ÷ 30 = 0%`；
  把**等集断言**算作首轮检查（它是六闸 `scope` 的同源前置，且比 `out_of_scope_edits` 更早更严）
  则为 `1 ÷ 30 = **3.3%**`。本线从 b366 起报后者，并在 INDEX §6.2 第 16 条写明这一项。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/provider-node/src/zcode-builtin-remote-synchronizer.ts` | 5 | 5 | 0 | provider-node |
| `packages/server/src/remote/deploy.ts` | 5 | 5 | 1（上游） | server/remote |
| `packages/services/src/session/taskChangeSummary.ts` | 5 | 5 | 0 | services/session |
| `packages/ui/src/ModelTrajectoryPaneDetails.tsx` | 5 | 5 | 0 | ui |
| `packages/ui/src/previewPaneCodeContent.tsx` | 5 | 5 | 0 | ui |
| `packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts` | 5 | 5 | 0 | ui/store |
| **合计** | **30** | **30** | **1** | — |

- 4 个顶层目录（provider-node / server / services / ui）；`PLAN#1` 报 `writable=30`、`pool-out=1`。
- **5 个文件清零、1 个留 1 行上游 weak**（`deploy.ts:134`），所以全仓文件数只减 5。

## 2. 改动内容

- `zcode-builtin-remote-synchronizer.ts`：`#inFlight` 在途复用；`dispose` 只置位不等收敛；
  租约收尾三支（cancelled 保持计数、成功恢复间隔、失败指数退避封顶）各补分支理由。
- `deploy.ts`：解析器只快照配置不发起请求；升级宁可多发一次也不复用旧制品；`caller-serialized` 只跳过锁；
  `catch` 先存结果后统一抛出；释放与部署结果分开存并按组合决定 `AggregateError`。
- `taskChangeSummary.ts`：按轮隔离、跨轮与按轮的差别只在聚合范围、`finalContent` 覆盖与条目不重复、
  用首末内容跳过中间轮次。
- `ModelTrajectoryPaneDetails.tsx`：纯渲染无共享可变、无 cleanup 可写、图片只渲染占位、
  `max-h-64` 取舍、`tone` 只区分两档。
- `previewPaneCodeContent.tsx`：四项透传并说明「默认值不在这里兜底」；行号/换行来源各归调用方。
- `zcodeSessionStoreWorkspaceSlice.ts`：引用不变即短路、空结果不写补丁、草稿态同对象重置四个字段、
  失效版本与草稿同批落库、`draftFocusVersion` 驱动聚焦。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=2918f33a files=6/6 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=40 auto_self_clear=0
gate: PASS order n=0 total=216.0s controllable=215.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 进度（双分母）

- 全仓 weak：`4,056 → 4,026`（−30），文件 `1,620 → 1,615`（−5）。
- 池内：**785 行 / 414 文件** = **可写 290** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,636 / remain 785`；`6,636 + 785 = 7,421`。
- **对基线 89.4%**；**对可达上限 6,926：95.8%**。
- 可清到零文件 **95**；含不可写残留 **1,520**（未变）。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `63c33d52` | `2918f33a`（12:48:53） | 216.0s | 7.20s |
| `controllable` | `--start`（12:45:18） | 批次提交（12:48:53） | 215.0s | **7.17s** |
| 收口段 | 12:48:53 | 台账提交 `9b0219f3`（12:50:56） | 123s | — |
| `批墙钟` | 12:45:18 | 台账提交 `9b0219f3`（12:50:56） | 338.0s | 11.27s |

| 批 | 行/批 | s/行 | 收口 |
| --- | ---: | ---: | ---: |
| b363 | 19 | 3.68 | 41s |
| b364 | 17 | 3.94 | 37s |
| b365 | 13 | 7.31 | 55s |
| b366 | 30 | 7.17 | 123s |
| 均值 | 19.75 | 5.53 | — |

- **215s 的分段实测**（按产物 mtime，三段相加正好闭合）：

  | 段 | 起止 | 秒 | 内容 |
  | --- | --- | ---: | --- |
  | 落笔段 | 12:45:18 → 12:47:44 | **146** | 起草 30 行 + 1 次失败的 `pick-generic`（pending=31）+ stash/pop |
  | 校验段 | 12:47:44 → 12:48:16 | **32** | `plan-new` + precheck + 等集断言 + 还原 1 行越界 |
  | 六闸段 | 12:48:16 → 12:48:53 | **37** | scope / record / verify / commit / pool-diff / order |

  所以 `7.17 s/行 = 215 ÷ 30` 的分子里，**六闸只占 37s（1.23 s/行）**，
  其余 178s 才是起草与校验；一次失败的 pick 约 10s、stash/pop 约 5s 也在这 178s 里。
- **不能把「30 行」当成本批偏慢的原因**：分子不变、分母变大只会让 `s/行` 变**低**。
  抬高它的是 215s 本身，而 215s 里最大的一项是「6 个文件各自重读上下文」。
- **每条注释的固定开销随文件数走，不随行数走**（本批首次量化）：6 个文件各 5 行，
  平均**每文件 ~24s**（146s ÷ 6，含落笔与一次失败调用）才能产出 5 行，即 **4.87 s/行**；
  若同样是 30 行但只跨 2 个文件，固定开销会被摊薄一半。
  推论：**cap 6 + 低密度（行/文件 < 3）的批在 `s/行` 上天然吃亏，短批反而更贵**，
  与「批越小越快」的直觉相反。**可证伪的预测**：b367 是 26 行 / 6 文件（4.33 行/文件），
  若「每文件固定开销」主导，`s/行` 应仍在 **7 附近**；若行数主导，应回落到 4–5。
  这条留待 b367–b370 四批检验，**检验前不据此改排期**。
- `收口 123s` 明显高于近三批（41/37/55s），差额是**一次性的口径工作**（hit_rate 回算、pool 重算、
  两个新脚本落盘），不是每批固定成本；**不进中位数外推**，与 b357 的 158s 同类处理（不计入、不剔除）。
- 仍低于停批阈值 8 s/行；**连续 3 批 >8 才停**，当前计数 0。
- **不得拿 7.17 当基准**：本批是「6 个 5 行文件、全跨目录」的形状，行/文件 5.0，高于池均 1.9。

## 7. 流程缺陷（本批新发现，登记为 D-004）

1. **`pick-generic` 必须先于落笔**：脚本用 `git blame` 取归属，工作树已改的行会返回
   `000…0`，31 行全落 `pending`（首次跑 `TALLY pending=31 plan=0`）。本批改用
   `stash push -- <6 文件>` → `pick-generic` → `stash pop` 复原。
   此后顺序固定为：`--start` → `pick-generic` → 起草落笔 → `plan-new` → precheck → 等集断言 → judge → 六闸。
2. **`plan-new` 必须从源码重取内容列**：`plan.tsv` 的内容列是改写前快照，直接复制会让 precheck 读到旧文本。
   新增 `_annot_baseline/plan-new.mjs`（按 file/baseLine 读当前工作树）与 `diffset-assert.mjs`（等集断言）。

## 8. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `2918f33a` | `+30/−30` |
| `ZC-deep-b366-rewrite.tsv` + 本台账 + INDEX + 白名单 | `9b0219f3` | — |
