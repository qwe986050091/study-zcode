# ZC-deep-b368

> 批次：b368 ｜ **24 行 / 6 文件** ｜ 提交 `ce8cb1cd`

## 0. 普通批；`fix=0`；`hit_rate=0%`

- `files=6/6`；`plan_lines_covered=24/24`；`removed=24 added=0 allowed=35 auto_self_clear=0`。
- **首轮 0 命中**：precheck `0/0`、judge `hits=0`、等集断言 `plan=24 diff=24 missing=0 extra=0`、六闸全 PASS。
  无回改轮（`fix=0`），也没有池外自清。
- 这是 B 段第一支「一次过」的批：上一支 `fix=0` 且 `hit_rate=0%` 的是 b362。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` | 4 | 4 | 0 | bootstrap |
| `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts` | 4 | 4 | 1（池外） | core/agent |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts` | 4 | 4 | 0 | core/tool |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts` | 4 | 4 | 0 | core/tool |
| `apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts` | 4 | 4 | 0 | core/tool |
| `apps/zcode-cli/packages/core/src/tool/json-schema.ts` | 4 | 4 | 2（池外） | core/tool |
| **合计** | **24** | **24** | **3** | — |

- **4 个文件清零、2 个各留 1–2 行池外 weak**（`session-history-hydrator`、`json-schema`），
  所以全仓文件数只减 4（1,609 → 1,605），与「写了几行」不同步，差额就是这 3 行。
- 3 个顶层目录（bootstrap / core）+ core 下 2 个子目录；`PLAN#1` 报 `writable=24 pool-out=3`。

## 2. 改动内容

- `server.ts`：`getOperationId` 与插件侧副本必须同步；`detached` 三条件同时成立才释放；
  `takePostResponseMessages` 返回副本、改数组不回写 outbox；`clear` 两处调用后 batch 不可恢复。
- `session-history-hydrator.ts`：三投影互不替代（点出两个函数名）；
  `part.id` 是唯一正确去重键（改成按内容会让重发的 prompt 少一条）；首项才是真实用户信封；
  非空用户消息的闸门是「`shouldRestoreRealUserEnvelope` 或附件条目非空」。
- `bash-git-runtime-safety.ts`：逐个 `commandPart` 检查；`normalizeCommandName` 优先；
  包装形式（`bash -c` / `env` / `xargs`）按内层识别；符号链接先 `readlink` 再判是否在 `cwdCanonical` 内。
- `bash-semantics.ts`：`EMPTY_CLASSIFICATION` 三个字段全 false；中性命令表点名；
  先剥赋值前缀与写选项再按两张表分类；silent 要每个 `commandPart` 都在表内。
- `node-repl.ts`：回合结束删条目、迟到回调回退；代际比较；`locator` 写动作才算表面变化；
  传输前后各断言一次代际。
- `json-schema.ts`：`validateNode` 递归分发；`enum`/`const` 与 `type` 各报一次；
  长度与数值边界各自独立、可同时上报。

## 3. 六闸

```
gate: PASS scope n=0 plan=24 allow=0 diff_old=24 diff_new=24 out_of_scope_edits=0 plan_lines_covered=24/24
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=ce8cb1cd files=6/6 numstat=24/24 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=24 added=0 allowed=35 auto_self_clear=0
gate: PASS order n=0 total=103.0s controllable=102.0s
GATE ALL PASS batch=b368 sha=ce8cb1cd
```

## 4. 自清

- `auto_self_clear=0`，本批无新增登记；`POOL-SELF-CLEAR.tsv` 保持 11 行（b367 那条是最后一条）。

## 5. 进度（双分母）

- 全仓 weak：`3,999 → 3,975`（**−24**），文件 `1,609 → 1,605`（−4）。
- 池内：**735 行 / 402 文件** = **可写 240** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,686 / remain 735`；`6,686 + 735 = 7,421`（capacity `ASSERT PASS`）。
- **对基线 90.1%**（6,686 ÷ 7,421）；**对可达上限 96.5%**（6,686 ÷ 6,926）。
- 可清到零文件 **85**（89 − 4）；含不可写残留 **1,520**（未变）。

## 6. 计时

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 | `ce8cb1cd`（13:04:04） | 103.0s | 4.29s |
| `controllable` | `--start`（13:02:22） | 批次提交（13:04:04） | 102.0s | **4.25s** |
| 收口段 | 13:04:04 | 台账提交 `7882a755`（13:05:30） | 86s | — |
| `批墙钟` | 13:02:22 | 台账提交（13:05:30） | 188.0s | 7.83s |

| 批 | 行/批 | 行/文件 | s/行 | 收口 |
| --- | ---: | ---: | ---: | ---: |
| b364 | 17 | 2.83 | 3.94 | 37s |
| b365 | 13 | 2.17 | 7.31 | 55s |
| b366 | 30 | 5.00 | 7.17 | 123s |
| b367 | 26 | 4.33 | 6.04 | 235s |
| b368 | 24 | 4.00 | **4.25** | 86s |

- **b366 提出的「cap 6 天生吃亏、每文件固定开销 ~24s」这条被本批否掉**：
  b368 同样是 6 文件、行/文件 4.0（比 b367 更低），`s/行` 却只有 **4.25**，
  若每文件真有 24s 固定开销，下限就该是 144s ÷ 24 = 6.0。
  所以成本不由**文件数**决定，而由**要读的上下文量**决定：
  b367 的 6 个文件横跨 ui / web / adapters / bootstrap，每个都要重读几十行；
  b368 的 6 个文件有 4 个同属 `core/src/tool`，同构且注释集中，读一次模板就够。
- 结论改写为：**`s/行` 的主导项是「本批文件之间的异构度」**，不是文件数也不是行数。
  这条目前只有 1 个反例支撑，四批内继续观察，仍不改排期。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `ce8cb1cd` | `+24/−24` |
| `ZC-deep-b368-rewrite.tsv` + 本台账 + INDEX + 白名单 | 见回填 | — |
