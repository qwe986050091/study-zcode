# ZC-DEEP-svc-a10 深度注释报告（剩余关键小件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v2）
> 分诊计划：[ZC-DEEP-svc-triage.md](./ZC-DEEP-svc-triage.md) 剩余关键小件组。
> 范围：v3 Bot 配置/运行态仓储、Bot 默认值与字段归一、群消息节流、技能发现遍历、服务暴露策略、自动化工具禁令。
> 口径：**内文率** = 函数体内整行中文注释 ÷ 函数体内代码行（`zc-inner.mjs`，AST trivia）。
> 硬约束：只加整行 `//` 中文注释；不改代码 token、缩进、import、字符串；清理只改写未入库的自有注释行；不 git add / commit。

## 1. 结果

| 文件 | 代码行 | 内文（前→后） | 内文率（前→后） | 净增 |
| --- | ---: | --- | --- | ---: |
| `bots/repo.ts` | 64 | 8 → 23 | 12.50% → 35.94% | 15 |
| `bots/config.ts` | 53 | 3 → 17 | 5.66% → 32.08% | 14 |
| `bots/groupDeliveryThrottle.ts` | 10 | 1 → 6 | 10.00% → 60.00% | 5 |
| `skills/skillDiscoveryWalk.ts` | 63 | 4 → 24 | 6.35% → 38.10% | 20 |
| `collection.ts` | 24 | 0 → 9 | 0.00% → 37.50% | 9 |
| `zcode-agent/automationToolPolicy.ts` | 14 | 0 → 6 | 0.00% → 42.86% | 6 |
| **合计** | **228** | **16 → 85** | **7.02% → 37.28%** | **69** |

文件级最低 32.08%（`bots/config.ts`），中位 38.10%；函数级最低 20.0%（`getDefaultBotReplyGranularity`，1/5），全部满足「函数级 ≥15%、文件级 ≥30%」。

> 说明：`zc-gate` 统计的 `addedCommentLines=139` 相对 HEAD 计算，含前几轮已写入但未提交的 70 行文件头注释；本批实际净增 69 行，另有 19 行自有注释按注水门禁改写（不增加行数）。

## 2. 补深方式

- 每个语句组写四件事：在做什么、为什么必须这样、依赖什么前置条件、做错会出现什么现象；不写函数级排比总结。
- 注释贴住紧邻语句，同一事实只说一次；与既有文件头 INV 不重复，只把 INV 落到具体分支上。
- 所有新增行都带真实标识符或阈值数字（`v3`、`withFileLock`、`250ms`、`MAX_SKILL_SCAN_DEPTH` 等），避免被注水判据命中。

重点覆盖的故障面：

- `bots/repo`：v3 文件一旦存在就只认 v3，解析失败必须抛错而非回退旧快照（否则用户新配置被静默覆盖）；迁移只在 v3 缺失时发生，且读写共用同一 `path` 锁，否则两个进程会迁移出两份不同 Bot 列表；`updateContext` 在锁内重新读盘并以 `undefined` 语义删除运行态，避免并发更新互相覆盖造成运行态分裂。
- `bots/config`：`version: 3` 是 schema 判定依据；归一化先铺 `DEFAULT_BOT_COMMANDS` 再逐键覆盖（`??` 而非 `||`，否则 `false` 被当缺省重新开启命令）；`modelSelection` 用 `safeParse` 只丢弃非法项，不拖垮整个 Bot 读取。
- `groupDeliveryThrottle`：`chatKey` 记录的是最早发送时刻而非消息队列；先占位再 `sleep`，保证并发调用看到已推迟的额度；只有被推迟的调用才等待，未推迟的立即返回，群消息顺序因此与调用顺序一致且首条不被平白延迟 250ms。
- `skillDiscoveryWalk`：显式栈 + `MAX_SKILL_SCAN_DEPTH` 双重兜底防止越界；普通目录不 `realpath`（树天然无环），只对软链按 `realpath` 去重，避免 Windows junction 环路重复扫描或无限展开；`readdir` 失败按 `onError` 上报后跳过整棵子树。
- `collection`：暴露策略是白名单（`allowedChannels`），`overrides` 优先于已注册实例但不回写注册表；注册只按 `channelName` 覆盖，方法本身不做鉴权。
- `automationToolPolicy`：自动化轮与闲时轮各持一份禁令常量，合并时保留调用方原有 `deny` 项；两份名单绝不共用，否则自动化轮会放行 `OffPeakCreate`、闲时轮会误禁只读的 `OffPeakList`，形成自我复制式调度。

## 3. 校验原文

结构校验：

```text
node d:\code\_annot_baseline\zc-verify.mjs --rewrite ZC-deep-svc-a10
SUMMARY files=6 rewrittenSegments=17 deletedOwnCommentLines=19 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

注水门禁：

```text
node d:\code\_annot_baseline\zc-gate.mjs --scan d:\code\_annot_baseline\ZC-deep-svc-a10\_files.txt
SUMMARY files=6 badFiles=0 addedCommentLines=139 waterLines=0 waterRate=0.00%
```

内文率复测：

```text
node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only <6 个文件> --threshold 15 --fns 30
SUMMARY files=6 innerCode=228 innerZh=85 below15=0 min=32.08 median=38.10
```

语义质量：

```text
node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files <6 个文件> --quiet --top 20
SUMMARY files=6 units=174 coverage=61.5% branch=75.0% field=100.0% comments=172 substance=83.7% explain=100.0% filler=0.0% weak=0.0%
```

## 4. 锚定不变量

- 锚点取整行 `trim()` 后全文相等；重复行用 `nth`：`const current = await readOptionalJson(path);`（1=readConfig）、`return parsed;`（1=writeConfig）、`const parsed = botsStateFileSchema.parse(state);`（2=writeState）、`const parsedSelection = ...` 与 `...(options.mode ...)`/`...(modelSelection ...)`（各 1/2）、`const merged = new Set(current);` 与 `return [...merged];`（各 1/2）。
- 锚点全部选在可执行语句行，未落在跨行模板字符串内部；`atomicWritePrivateTextFile(... `${JSON.stringify(value, null, 2)}\n`)` 与两个凭据 `return \`...\`;` 都是单行模板字面量，注释插在该行之前，不触及字符串内容。
- 插入缩进由脚本沿用锚点行前缀；`codeTokenDiff=0`、`headTokenDrift=0` 证明代码 token 流未变。
- 19 行改写全部落在「相对 HEAD 新增」的自有注释行上（不在 `git show HEAD:<file>` 内），只替换注释文本，未删除任何上游注释；无模板字符串内的注水行需要保留。

## 5. 看似该改其实不能改

- `repo.readConfig` 在 v3 损坏时不回退旧文件：看似可以降级恢复，但旧快照会覆盖用户新配置；只能抛错让上层暴露问题。
- `repo` 的迁移写入必须留在 `withFileLock` 内：把 `writeJson` 挪到锁外能减少锁持有时间，但两个进程会各自迁移出不同 Bot 列表。
- `repo.updateContext` 的 `undefined` 返回值就是删除语义：改成空对象或跳过写入会让调用方误判成功，运行态残留脏数据。
- `config.normalizeBotCommandPolicy` 的 `??` 不能换成 `||`：`false` 是用户显式关闭，换成 `||` 会重新开启命令。
- `config` 丢弃 `cli` 字段是 Bugfix 而非兼容负担：把 `cli` 原样写回会让已移除命令在新版本重新出现。
- `groupDeliveryThrottle` 的 `nextSendAt` 只存时间点、不存消息：改成消息队列会持有群聊内容并在进程重启后重放，也会破坏「先占位后等待」的顺序保证。
- `skillDiscoveryWalk` 只对软链做 `realpath`：对普通目录也做会为每个目录多一次 IO，且不改变正确性。
- `skillDiscoveryWalk` 的 `depth >= MAX_SKILL_SCAN_DEPTH` 在产出之后判断：提前 `continue` 会连当前层技能一起丢掉。
- `collection.exposeOnChannelServer` 的白名单判断不能省略：没有策略时是显式全量暴露的调用约定，但传入策略后漏判会形成越权调用面。
- `automationToolPolicy` 两份名单常量不能合并：automation 轮明确放行 `OffPeakCreate`，闲时轮必须 deny 它，合并会让其中一轮错误放行。
