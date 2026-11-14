# ZC-DEEP-svc-a4

> 批次：A4（3 文件，任务索引持久化）。目标：函数体内文 ≥15%、文件内文 ≥30%。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-svc-a4\orig`；spec 与生成脚本同目录（`gen1..gen9.mjs`、`spec1..spec9.json`）。

## 结果表

| 文件 | 代码行 | 内文前 → 后 | 新增注释行 |
| --- | ---: | --- | ---: |
| `packages/services/src/session/taskIndexRepo.ts` | 1077 | 13.28%（143/1077） → 31.20%（336/1077） | +193 |
| `packages/services/src/session/tasksDatabase/provider-selection-v2.ts` | 69 | 13.04%（9/69） → 34.78%（24/69） | +15 |
| `packages/services/src/session/tasksDatabase/prepared.ts` | 13 | 0.00%（0/13） → 30.77%（4/13） | +4 |
| 合计 | 1159 | 13.11%（152/1159） → 31.41%（364/1159） | +212 |

函数级最低：`getTaskRow@1018` 15.2%（5/33）；次低 `hasColumn@610` 与 `getDatabase@957` 均 16.7%，嵌套回调最低 20.0%。`below15=0`。

## 补深方式

- 以「语句组」为单位插注释，每块交代：在做什么、为什么必须这样、依赖什么前置条件、做错会出现的现象；同一事实只在首次出现处写一次。
- 大幅函数按语义段拆分：`migrateLegacyAcpTaskIds`（SELECT 口径 → 事务与四个 prepared → 逐行合并/改主键 → 日志计数）、`buildLegacyAcpMigratedRow`（主键分支 → 组织态取或 → 时间单调 → meta_json 回写）、`writeRecord`（事务边界 → 先读后 upsert → 列绑定 → 写后重读 → 组织登记）、`applyCliFacts`（预留行补齐 → 单条 UPDATE 的 CASE 与位掩码 → 重读）。
- SQL 语义（冲突键、watermark、位掩码、CASE 分支）一律写到 `.prepare(...)` 调用行上方，绝不落进多行模板字符串内部；插入前用 TypeScript AST 逐条校验锚点所在行是否位于模板字面量内部，插入后再扫一遍最终文件（`templateCommentLines=0`）。
- 小文件逐个函数覆盖：`prepared.ts` 四个函数各一条判据说明；`provider-selection-v2.ts` 覆盖解码回退、字段清洗、两种旧格式、乐观校验、`'null'` 归一。
- 去重：对每条新增注释与邻近 ±8 行既有注释做字符二元组相似度扫描，阈值 0.45 命中后改写或删除，最终 `flagged=0`；因此本批新增净行数低于插入行数。

## 三条命令的真实输出

```
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-a4
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=212

node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only packages/services/src/session/taskIndexRepo.ts,packages/services/src/session/tasksDatabase/provider-selection-v2.ts,packages/services/src/session/tasksDatabase/prepared.ts --threshold 15 --fns 30
SUMMARY files=3 innerCode=1159 innerZh=364 below15=0 min=30.77 median=31.20
（taskIndexRepo：336/1077 = 31.20%；provider-selection-v2：24/69 = 34.78%；prepared：4/13 = 30.77%）

node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files packages/services/src/session/taskIndexRepo.ts,packages/services/src/session/tasksDatabase/provider-selection-v2.ts,packages/services/src/session/tasksDatabase/prepared.ts --quiet --top 20
SUMMARY files=3 units=622 coverage=37.0% branch=60.0% field=9.1% comments=633 substance=82.5% explain=99.2% filler=0.5% weak=1.3%
```

补充自检（模板字符串未被注释污染）：

```
node ZC-deep-svc-a4/scan-final.mjs <三个文件>
packages/services/src/session/taskIndexRepo.ts templateCommentLines=0
packages/services/src/session/tasksDatabase/provider-selection-v2.ts templateCommentLines=0
packages/services/src/session/tasksDatabase/prepared.ts templateCommentLines=0
```

## 锚定的不变量

- **索引与转录一致**：`meta_json` 只作展示兜底；`taskId`、`workspaceIdentity`、`workspacePath`、`unreadAt` 由列投影在 `readPresentation`/`rowToMeta` 覆盖，旧 JSON 不得反向污染主键与身份。
- **主键与冲突键**：`tasks` 的定位与 upsert 冲突键固定为 `(workspace_key, task_id)`；`workspace_key` 只能经 `workspaceKey()` 计算。
- **watermark 单调**：`last_unread_at = MAX(tasks.last_unread_at, COALESCE(tasks.unread_at,0))`；清除未读走 `unread_at=?` 的 CAS，先把现值吸收进 watermark 再置 NULL。
- **事务边界**：`ownTransaction` 才 `COMMIT`/`ROLLBACK`；嵌套调用复用外层；组织库登记与任务行同事务。
- **失败策略分读写**：写路径（`writeRecord`、`applyCliFacts`、`clearTaskUnreadIfMatches`）抛错即回滚；读路径（`rowToMeta`、`readPresentation`、`provider-selection`）坏数据降级并记 warn，constraint 为单行失败不拖垮整批/整页。
- **冷恢复迁移**：`migrateLegacyAcpTaskIds` 先合并 `target` 再删旧行，`buildLegacyAcpMigratedRow` 对组织态取或、时间取单调方向；只有真正改过主键或合并的行才计入 `migrated`。
- **handoff 位协议**：位 1 删除、位 2 标题、位 4 孤儿；`-1` 作为全 1 掩码保留其余位。
- **prepared 双重判据**：内存集合命中仍要复查 `areTasksDatabaseMigrationsApplied`，缓存不能替代库内事实。
- **旧三列解码**：`decodeComponent` 失败回退原文；未识别的 `builtin:` 前缀返回 `undefined`；写回用旧 `model/provider/thought_level` 做乐观校验。

## 看似该改其实不能改

1. `listTaskMetas` 的 `AND cli_created_at IS NOT NULL`：看似可交给调用方过滤，挪走会让只有预留行的空标题任务进入列表。
2. upsert 里的 `unread_at = tasks.unread_at`：看似该用 `excluded.unread_at` 简化，实际会清空用户未读状态。
3. `last_unread_at = MAX(...COALESCE(tasks.unread_at,0))`：看似与写入值重复，去掉后 watermark 会回退、CAS 令牌被旧值命中。
4. `deleted: source.deleted === 1 ? 1 : target.deleted`：看似可取 `target` 或做或运算，会让已删旧行复活。
5. `handoff_pending & ~4` 的无条件清孤儿位：看似该等同步器确认，实际上收到 CLI 事实就已证伪孤儿状态。
6. `decodeComponent` 的 `catch` 回退原文：看似该抛错，单行旧数据不合法会中断整批迁移。
7. `if (!providerId) return undefined;`：看似可回落到原始 provider 字符串，会写入非法 `providerId` 并让新列不可查询。
8. `prepared.ts` 里的 `areTasksDatabaseMigrationsApplied` 复查：看似冗余，库文件回滚/替换后内存缓存仍为真。
9. `task_status: record.meta.status ?? null` 等 `?? null` 归一：看似可直接绑定，`undefined` 会被驱动拒绝并回滚整个事务。
10. `ORDER BY ... , task_id` 的尾列兜底：看似可省，同毫秒更新的行翻页时会漂移或重复。
11. `migrateLegacyAcpTaskIds` 的 `AND trim(acp_session_id) <> ''`：看似与 `IS NOT NULL` 重复，空白值会被写成空 `task_id`。
