# ZC-deep-b370

> 批次：b370 ｜ **24 行 / 6 文件** ｜ 提交 `7aee12ba`

## 0. 普通批；`fix=1`；`hit_rate=4.2%`

- `files=6/6`；`plan_lines_covered=24/24`；`removed=24 added=0 allowed=35 auto_self_clear=0`。
- **首轮 1 行命中**：`validation.ts:1190` 缺谓词（precheck `missing_predicate=1`，judge 同步判 `L`）→ `1 ÷ 24 = **4.2%**`。
  补 `因此` 后 `0/0`、`hits=0`。
- 首轮只 1 条，说明上一批（b369，16.7%）暴露的「多分句缺关系词」问题在本批起草时已经按同一判据自查过——
  这 24 行里有 9 行是多分句带列举的，只有 1 行漏了谓词。

## 1. 选行与目录分布

| 文件 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | --- |
| `packages/services/src/conversation-share/conversationShareArtifactDiscovery.ts` | 4 | 0 | services |
| `packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts` | 4 | 0 | services |
| `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts` | 4 | 0 | services |
| `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` | 4 | 0 | services |
| `packages/shared/src/conversation-share-content.ts` | 4 | 1（池外） | shared |
| `packages/shared/src/validation.ts` | 4 | 0 | shared |
| **合计** | **24** | **1** | — |

- 5 个文件清零、1 个留 1 行池外 weak，全仓文件数 −5（1,601 → 1,596）。
- 只有 **2 个顶层目录**（services / shared），是本段目录最集中的一批。

## 2. 改动内容

- `conversationShareArtifactDiscovery.ts`：预检不匹配不阻断、只退回全量；`nextOffset === null` 是唯一正常退出；
  附件改写只发生在 `userInput` 行；末轮用下标比较的理由。
- `legacyZCodeConfigProviderReader.ts`：`disabledReason` 顶层优先；两个能力位缺省交给工厂；
  大小写不同视为同一模型；墓碑在对外契约里表现为「不存在」。
- `zcodeAgentConnectionScope.ts`：缺一段路由就返回 `null`；`stageFrame` 两个短路条件；
  `clock` 分支跳过 workspace 绑定。
- `zcodeTaskIndexSyncer.ts`：单帧体积即足以判恢复；`reason` 必填的由来；`discardIndexRecovery` 的两步；
  回放只保留同 `subscriptionId` 的暂存帧。
- `conversation-share-content.ts`：`safeJson` 的有界范围；深度超限在入口返回；五个锚点；
  版本比较用 `>=` 的兼容含义。
- `validation.ts`：两个视图字段都可选；引用完整性不管；`taskHostId` 的反向约束；无 `workspacePath` 的硬约束。

## 3. 六闸

```
gate: PASS scope n=0 plan=24 allow=0 diff_old=24 diff_new=24 out_of_scope_edits=0 plan_lines_covered=24/24
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=7aee12ba files=6/6 numstat=24/24 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=24 added=0 allowed=35 auto_self_clear=0
gate: PASS order n=0 total=103.0s controllable=103.0s
GATE ALL PASS batch=b370 sha=7aee12ba
```

## 4. 自清

- `auto_self_clear=0`，无新增登记；`POOL-SELF-CLEAR.tsv` 仍 11 行。

## 5. 进度（双分母）

- 全仓 weak：`3,951 → 3,927`（−24），文件 `1,601 → 1,596`（−5）。
- 池内：**687 行 / 396 文件** = **可写 192** + 上游 495。
- `done 6,734 / remain 687`；`6,734 + 687 = 7,421`（capacity `ASSERT PASS`）。
- **对基线 90.7%**（6,734 ÷ 7,421）；**对可达上限 97.2%**（6,734 ÷ 6,926）。
- 可清到零文件 **76**（81 − 5）；含不可写残留 **1,520**（未变）。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 | `7aee12ba`（13:11:38） | 103.0s | 4.29s |
| `controllable` | `--start`（13:09:55） | 批次提交（13:11:38） | 103.0s | **4.29s** |
| 收口段 | 13:11:38 | 台账提交 `ebef0575`（13:12:27） | 49s | — |
| `批墙钟` | 13:09:55 | 台账提交（13:12:27） | 152.0s | 6.33s |

| 批 | 行/批 | 行/文件 | s/行 | 收口 |
| --- | ---: | ---: | ---: | ---: |
| b367 | 26 | 4.33 | 6.04 | 235s |
| b368 | 24 | 4.00 | 4.25 | 86s |
| b369 | 24 | 4.00 | 4.67 | 46s |
| b370 | 24 | 4.00 | **4.29** | 49s |

- b368–b370 三批同为 24 行 / 6 文件，`s/行` 4.25 / 4.67 / 4.29，**离散度 0.42**。
  这三批把「行数」与「文件数」都控住了，剩下唯一的差异是 `fix`（b369 多一轮），
  所以可以把 **4.3 s/行** 当作这一形状下的稳定值（b367 的 6.04 是离群）。
- **离群原因：未定**。试过一个可测量——**顶层目录跨度**（b366 4 / b367 4 / b368 3 / b369 4 / b370 2）
  对 `s/行`（7.17 / 6.04 / 4.25 / 4.67 / 4.29），**Pearson r = 0.66，n = 5**，既不足以支持也不足以否定。
  所以只保留一条有证据的结论：**开销不随文件数线性增长**（b368–b370 与 b366 同为 6 文件，差 1.7–2.9 倍）。
  在拿到 ≥10 个同形状样本前，不再给「异构度」这类形容词作解释。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `7aee12ba` | `+24/−24` |
| `ZC-deep-b370-rewrite.tsv` + 本台账 + INDEX + 白名单 | 见回填 | — |
