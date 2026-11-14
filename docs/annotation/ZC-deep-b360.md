# ZC-deep-b360

> 批次：b360 ｜ **24 行 / 6 文件** ｜ 提交 `8c62e38a`
> 本批同时是**窗口收口**：全量重算 + 逐行探针审计 + 40 批自足化审计。

## 0. 方案 ① 普通批；`fix=2`；`hit_rate=12.5%`

- `TALLY {"ownIn":24,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":24,"planOut":24}` / `files=6/6`。
- **首轮 `hits=3`，全为 `L` 无信息列举**：
  - `ConversationUserInputContent.tsx:53`（`拆成/保留` 不在谓词表）→ 改「由三段组成」；
  - `ConversationTurnRow.tsx:62`（`下传/不做` 不在表）→ 改「必须原样下传」；
  - `ConversationUserInputContent.tsx:113`（`分派/退回` 不在表）→ 改「由 part.type 分派」「必须退回」。
  - 第二轮 `hits=0`。**L 首轮命中 3 条，其中 2 条是「并列三段」句式**，与 b358 的 L 属同一类。
- `hit_rate = 3 ÷ 24 = 12.5%`；`fix≥2` 连续计数 **1**（b359 为 1 轮，已复位；b360 重新计 1）。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/v4/ConversationTurnRow.tsx` | 4 | 4 | 0 | ui/v4 |
| `packages/ui/src/v4/ConversationUserInputContent.tsx` | 4 | 4 | 0 | ui/v4 |
| `packages/ui/src/v4/index.ts` | 4 | 4 | 0 | ui/v4 |
| `packages/ui/src/v4/useDraftSuggestedPluginActionPopover.ts` | 4 | 4 | 0 | ui/v4 |
| `packages/ui/src/components/ai-elements/prompt-input-actions.tsx` | 4 | 4 | 0 | ui/components/ai-elements |
| `packages/ui/src/settings/McpServerForm.tsx` | 4 | 4 | 0 | ui/settings |
| **合计** | **24** | **24** | **0** | — |

- 本批只从**可清到零**的 136 个文件里选（`u=0 且 residue=0`），6 文件全部清零。
- **目录分布**：1 个顶层目录（`packages/ui`），3 个子域（`v4` 占 4 个文件）。

## 2. 改动内容

- `ConversationTurnRow.tsx`：`row` 原样透传；解构属性名与 props 逐字一致；`reasoningContentVariant` 透传不读默认；复制文本多段优先。
- `ConversationUserInputContent.tsx`：三段解析结果；标签归一先 trim 再去斜杠；提及块样式统一；按 `part.type` 分派。
- `v4/index.ts`：注册表导出范围；分屏与工作台分组；弹窗宿主单独导出；适配函数排末。
- `useDraftSuggestedPluginActionPopover.ts`：成功/错误时长常量；`resultTimerRef` 带 `operationId`；展示前先清旧计时；`onDismiss` 可选语义。
- `prompt-input-actions.tsx`：文件对话框由上下文实现；截图先让外部拦截；空结果不添加；触发器占位图标。
- `McpServerForm.tsx`：`McpScopeMenu` 纯受控字段；非 json 直提；空草案早退；占位示例按传输类型二分。

## 3. 六闸

```
gate: PASS scope n=0 plan=24 allow=0 diff_old=24 diff_new=24 out_of_scope_edits=0 plan_lines_covered=24/24
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=8c62e38a files=6/6 numstat=24/24 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=24 added=0 allowed=34 auto_self_clear=0
gate: PASS order n=0 total=133.0s controllable=87.0s
```

## 4. 窗口收口（三项审计）

- **全量重算**：白名单重生成 **578 行**（`head=30a9d317`）；`capacity --weak b359-repo-post` →
  `ACCT done 6,488 + remain 933 = 7,421`、`ALIGNED diff=0`、`ASSERT PASS`。
- **逐行探针审计**：`b360-probe-audit.mjs` 对本线全部 `rewrite.tsv` 重判 ——
  **扫描 7,383 行 / 有效 7,350 行 / 33 行因文件或行号已不存在跳过 / `onPlannedLine` 命中 0**。
  硬条件 `onPlannedLine > 0` 不成立，**不停批**。
- **40 批自足化审计**：五项检查全部一条命令可复现，无手工步骤 ——
  ① `own-commits-gen`（1s）；② `capacity --weak`（ALIGNED）；③ `preflight --whitelist` → `STALE-EXPECTED`；
  ④ `preflight --total-start` → `TOTAL-START OK`；⑤ `b360-probe-audit`（3s）。
  基线仍为 **1,007 文件 / 7,421 行**，无漂移，无需重建。

## 5. 池内 / 可写 / 上游（b360 定案）

- 全仓 weak：`4,174 → 4,150`（−24），文件 `1,656 → 1,650`（−6）。
- 池内：**909 行 / 450 文件**（密度 2.02），其中按 blame 拆成 **可写 414 行** + **上游 495 行**。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 行上游不在 `remain` 内；`414 + 495` 不得再当剩余桶用。见 INDEX §6.2 第 22 条。**
- 可清到零文件 **130**；含不可写残留 **1,520**（`NEVER-CLEAR.tsv`，四列）。
- `done 6,512 / remain 909`（池内观测）；**待办量 = 可写 414**，进度分母用 `6,512 + 414`。
- 池外残留 3,241 行（不变）。

## 6. 计时（B 段第 11 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `07354856`（12:03:59） | 批次提交 `8c62e38a`（12:06:12） | 133.0s | 5.54s |
| `controllable` | `--start`（12:04:45） | 批次提交（12:06:12） | 87.0s | **3.63s** |
| 收口段 | 批次提交（12:06:12） | 台账提交 `f537bc52`（12:09:26） | 194s | — |
| `批墙钟` | 最早产物 `b360-t-start.txt`（12:04:45） | 台账提交 `f537bc52`（12:09:26） | 281.0s | 11.71s |

- `total − controllable = 46s`，即「上一提交 → `--start`」的起草准备段（本批先跑完窗口审计再开批）。
- 收口 **194s** 是**窗口收口**（含 post 全量快照 8s、blame 拆分约 110s、探针 3s、台账），
  与 b355 的 60s 同属「窗口收口」类，**单列、不并入普通收口中位数**；也不触发 150s 停批（只 1 批）。
- 普通收口序列保持：45 / 82 / 39 / 77 / 61，中位 **61s**。
- 监控：可控 3.63 s/行（阈值 8，未触发）。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 窗口全量重算（白名单 / INDEX / NEVER-CLEAR） | `07354856` | — |
| 批次本体（6 文件 1→1 改写） | `8c62e38a` | `+24/−24` |
| `ZC-deep-b360-rewrite.tsv` + 本台账 + INDEX | `f537bc52` | — |
