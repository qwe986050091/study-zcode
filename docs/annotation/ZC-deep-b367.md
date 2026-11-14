# ZC-deep-b367

> 批次：b367 ｜ **26 行 / 6 文件** ｜ 提交 `8f0c5b9f`

## 0. 普通批；`fix=1`；`hit_rate=11.5%`

- `files=6/6`；`plan_lines_covered=26/26`；`removed=27 added=0 allowed=37 auto_self_clear=0`。
- **首轮 3 行命中**（按行去重，同一行被两个检查同时报只计一次）：
  `main.tsx:1390` 缺锚点（precheck `missing_anchor=1`）；
  `failure-provider-business-codes.ts:74`、`conversation-telemetry-facts.ts:73` 缺谓词（precheck `missing_predicate=2`，
  judge 同步判 `L` 2 条）。→ `3 ÷ 26 = **11.5%**`。一轮回改后 precheck `0/0`、judge `hits=0`。
- **`removed=27` 比 plan 多 1**：`startup-marks.ts:37`（` */`，内容为空）在 38 行被改成带
  `discoverNodePluginsSync` 的整段后**随句元整句转强**，属邻接自清。该行池外（早于池基线 `8f7daaf0`）、
  内容为空无法单独改写，按 `POOL-SELF-CLEAR.tsv` 规则②**人工登记**后 pool-diff 通过。
  所以本批全仓 weak 减 **27**，但池内 remain 只减 **26**。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/v4/ConversationShareSelectionPanel.tsx` | 5 | 5 | 0 | ui/v4 |
| `packages/web/src/main.tsx` | 5 | 5 | 0 | web |
| `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts` | 3 | 3 | 0 | zcode-cli/adapters |
| `apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts` | 3 | 3 | 0 | zcode-cli/adapters |
| `apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts` | 4 | 4 | 0 | zcode-cli/bootstrap |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts` | 6 | 6 | 0 | zcode-cli/bootstrap |
| **合计** | **26** | **26** | **0** | — |

- **6 个文件全部清零**，所以全仓文件数减 6（1,615 → 1,609）。
- 4 个顶层目录（ui / web / zcode-cli ×2 子树）；`PLAN#1` 报 `writable=26 pool-out=0`。

## 2. 改动内容

- `ConversationShareSelectionPanel.tsx`：settings 落空走通用定位的已知降级；下移分支要求确认区；
  `ResizeObserver` 缺失时保持首帧量测；`visualThumb` 独立视觉层；`requestAnimationFrame` 只保留最后一帧。
- `main.tsx`：`document.hasFocus()` 时不弹通知；`localStorage` 不可用回落物理指纹的代价；
  覆盖方向唯一（宿主 → 本地）；能力开关写回 Host 的反例；`await` 后重查 `terminated`。
- `bash-shell-provider.ts`：`selection` 只作描述；`user-config` + 可执行即跳过自动探测；
  `cmd` 分支绕过 baseline 的理由；可执行判定 fail-closed 的具体异常类。
- `failure-provider-business-codes.ts`：配额耗尽复用限流码的取舍；字面量分组不影响补齐；
  500 不进终止模板的理由；3010 三字段必须同时成立。
- `startup-marks.ts`：再跑一次发现的后果（事实分叉）；存储根覆盖顺序；
  `skillRoots` 就地过滤；两个注入布尔不能合并。
- `conversation-telemetry-facts.ts`：`2_000` 是五张表共用上限；不按轮次分表的理由；
  主机名不归一；来源命令只在 `TurnStarted` 登记。

## 3. 六闸

```
gate: PASS scope n=0 plan=26 allow=0 diff_old=26 diff_new=26 out_of_scope_edits=0 plan_lines_covered=26/26
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=8f0c5b9f files=6/6 numstat=26/26 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=27 added=0 allowed=37 auto_self_clear=0
PRECHECK ORDER OK t-start=04:55:21 < t-record=04:57:34 <= t-verify=04:57:35 < commit=12:57:58
```

- pool-diff 首跑 **FAIL n=1**（`UNREGISTERED SELF-CLEAR … startup-marks.ts:37 (own blame)`），
  人工登记进 `POOL-SELF-CLEAR.tsv` 后 PASS。**这是本批唯一一次门禁失败**，不是回改。
- `--from order` 在新进程里拿不到 commit sha（sha 只存在于完整跑的那次进程），
  order 段改用 `precheck-assert.mjs --order --commit 8f0c5b9f --prev <父提交>` 直接复算，判据同源。

## 4. 自清

- 池外人工登记 **1 行**（`startup-marks.ts:37`）；`auto_self_clear=0`。
- capacity 复核：`SELF-CLEAR n=1 可写桶 0 / 池外 1 / 上游桶 0` —— 不扣配额，符合登记规则。

## 5. 进度（双分母）

- 全仓 weak：`4,026 → 3,999`（**−27** = 26 实写 + 1 池外自清），文件 `1,615 → 1,609`（−6）。
- 池内：**759 行 / 408 文件** = **可写 264** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,662 / remain 759`；`6,662 + 759 = 7,421`（capacity `ASSERT PASS`）。
- **对基线 89.8%**（6,662 ÷ 7,421）；**对可达上限 96.2%**（6,662 ÷ 6,926）。
- 可清到零文件 **89**；含不可写残留 **1,520**（未变）。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | `75706c9a` | `8f0c5b9f`（12:57:58） | 158.0s | 6.08s |
| `controllable` | `--start`（12:55:21） | 批次提交 | 157.0s | **6.04s** |
| 落笔段 | `--start` | `--verify`（12:57:35） | 134.5s | 5.17s |
| 收口段 | `--verify`（12:57:35） | 台账提交 `c4c86249`（13:01:30） | 235s | — |
| `批墙钟` | `--start`（12:55:21） | 台账提交 | 369.0s | 14.19s |

| 批 | 行/批 | 行/文件 | s/行 | 收口 |
| --- | ---: | ---: | ---: | ---: |
| b363 | 19 | 3.17 | 3.68 | 41s |
| b364 | 17 | 2.83 | 3.94 | 37s |
| b365 | 13 | 2.17 | 7.31 | 55s |
| b366 | 30 | 5.00 | 7.17 | 123s |
| b367 | 26 | 4.33 | **6.04** | 235s |

- **收口 235s 里约 120s 是 pool-diff 判失败后的排查与登记**（查 `classifySelfClear`、读 `POOL-SELF-CLEAR.tsv`
  历史 10 行、取 37 行 blame、复算 order）。这是一次性成本，与 b366 的口径工作同类，**不进中位数外推**。
- 若只算「判失败 → 登记 → 通过」的纯操作，约 40s；其余是读源码理解判据。

- **检验 b366 的预测**：预测「每文件固定开销主导 → b367 仍在 7 附近」，实测 **6.04**，
  落在「行数主导」一侧（4–5）与「文件数主导」（7）之间，**预测只对了一半**。
  行数从 30 降到 26 使 `s/行` 降 1.13；文件数没变（6），所以「文件数」项没有被单独测到。
  **下一次能分辨的样本是「行数相近、文件数不同的批」**，四批内未必出现，先不据此改排期。
- `total 158.0s` 与 `controllable 157.0s` 只差 1s：本批两次提交紧邻，没有批间杂活。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `8f0c5b9f` | `+26/−26` |
| `ZC-deep-b367-rewrite.tsv` + 本台账 + INDEX + `POOL-SELF-CLEAR.tsv` + 白名单 | 见回填 | — |
