# ZC-deep-b362

> 批次：b362 ｜ **20 行 / 6 文件** ｜ 提交 `72f74b51`

## 0. 方案 ① 普通批；`fix=0`；`hit_rate=0%`

- `TALLY {"ownIn":20,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":20,"planOut":0}` / `files=6/6`。
- **首轮 `hits=0`**：语义抽检后首批，按 §5.3「动笔前对照」四条起草，未触发返修。
- `hit_rate = 0%`；`fix≥2` 计数**清零后为 0**（b362 重新起算）。
- 本批执行了新流程：改前按**计划行号**取原文；改完先做 `plan 行集合 == diff 行集合` 等集断言
  （`plan=20 diff=20 missing=0 extra=0`），再跑 judge、最后六闸。

## 1. 选行与目录分布

| 文件 | 可写 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/services/src/bots/channelReply.ts` | 3 | 3 | 0 | services/bots |
| `packages/services/src/bots/feishuChannelRuntime.ts` | 3 | 3 | 0 | services/bots |
| `packages/services/src/bots/statusFormatting.ts` | 3 | 3 | 0 | services/bots |
| `packages/services/src/bots/topicHistory.ts` | 3 | 3 | 0 | services/bots |
| `packages/shared/src/source-server/connectionErrors.ts` | 4 | 4 | 0 | shared/source-server |
| `packages/web/src/web-remote-control/adapters/webRemoteControlDeviceInfo.ts` | 4 | 4 | 0 | web/web-remote-control |
| **合计** | **20** | **20** | **0** | — |

- 3 个顶层目录（services / shared / web），其中 bots 子域 4 个文件；6 文件全部清零。

## 2. 改动内容

- `channelReply.ts`：授权条件逐项列出并返回 stale；并发完成需再查 replay；正文长度在发送前拦截。
- `feishuChannelRuntime.ts`：锁实现可注入但生产必须用 `acquireFeishuWebSocketLock`；凭据缺失参与指纹；后台刷新吞错不中断定时器。
- `statusFormatting.ts`：完成态优先 `actualDurationMs`、缺失回退墙钟；`content/thought` 同级取最新；无正文用 `tool-call` 兜底。
- `topicHistory.ts`：分页重叠必须按 id 去重；无 checkpoint 视为不限下界；先收集卡片 id 再加父引用。
- `connectionErrors.ts`：`phaseCodes` 只作顶层兜底；`visit` 的 `applyPhaseFallback` 仅顶层为 true；取消以 `AbortError` 名为准。
- `webRemoteControlDeviceInfo.ts`：`Number.isFinite` 判据；时区取不到返回 undefined；默认参数由全局 `navigator` 提供；`updatedAt` 由注入 `now()` 决定。

## 3. 六闸

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=72f74b51 files=6/6 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 allowed=30 auto_self_clear=0
gate: PASS order n=0 total=89.0s controllable=69.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 进度（双分母）

- 全仓 weak：`4,125 → 4,105`（−20），文件 `1,644 → 1,638`（−6）。
- 池内：**864 行 / 438 文件** = **可写 369** + 上游 495。
  **该拆分已作废（b371 订正）：`remain` 就是可写行，495 不在 `remain` 内。见 INDEX §6.2 第 22 条。**
- `done 6,557 / remain 864`；`6,557 + 864 = 7,421`。
- **对基线 88.4%**；**对可达上限 6,926：94.7%**。
- 可清到零文件 **118**；含不可写残留 **1,520**；池外残留 3,241 行。

## 6. 计时（B 段第 13 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `18ce278a`（12:18:44） | 批次提交 `72f74b51`（12:20:13） | 89.0s | 4.45s |
| `controllable` | `--start`（12:19:04） | 批次提交（12:20:13） | 69.0s | **3.45s** |
| 收口段 | 批次提交（12:20:13） | 台账提交 `c68d52ec`（12:20:48） | 35s | — |
| `批墙钟` | 最早产物 `b362-t-start.txt`（12:19:04） | 台账提交 `c68d52ec`（12:20:48） | 104.0s | 5.20s |

- 零返修批：收口 35s 是 B 段最低；可控段 3.45 s/行也是最低；写作清单前置的效果首次体现。
- 监控：收口 35s（阈值 150s）、可控 3.45 s/行（阈值 8）。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `72f74b51` | `+20/−20` |
| `ZC-deep-b362-rewrite.tsv` + 本台账 + INDEX | `c68d52ec` | — |
