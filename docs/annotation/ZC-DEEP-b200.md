# ZC-DEEP-B200（4 文件，+125 行）

> 范围：强制更新版本比较、SQLite 迁移串行执行器、subagent 共享契约与 workflow-artifact board 渲染器（合计 491 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b200\orig`；清单：`ZC-deep-b200-files.txt`。
> 目标密度 31.4%，实际落点 31.11%~31.58%。

## 1. 验收输出

```text
[ok] packages/shared/src/forceUpdate.ts: 6 blocks, 31 lines
[ok] packages/shared/src/sqlite-migrations/runner.ts: 6 blocks, 31 lines
[ok] packages/shared/src/subagents-types.ts: 7 blocks, 32 lines
[ok] packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx: 7 blocks, 31 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=125
[packages/shared/src/forceUpdate.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/shared/src/sqlite-migrations/runner.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/shared/src/subagents-types.ts] added=32 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx] added=31 nonComment=0 starSlash=0 suspicious=0
TOTAL added=125 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.11% code=135 comment=42 packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx
31.19% code=109 comment=34 packages/shared/src/sqlite-migrations/runner.ts
31.58% code=114 comment=36 packages/shared/src/forceUpdate.ts
31.58% code=133 comment=42 packages/shared/src/subagents-types.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/forceUpdate.ts` | 强制更新判定 | 版本归一与简写补全顺序、构建元数据不参与、预发布逐段比较规则、解析失败返回 null、空配置不限制 | 31 |
| `shared/src/sqlite-migrations/runner.ts` | 迁移执行器 | SQL 前校验、事务归属、备份目录必填、按库路径串行、失败不传播、队列按身份释放、校验和与改号语义 | 31 |
| `shared/src/subagents-types.ts` | subagent 共享契约 | 覆盖表前缀过滤与逐条丢弃、插件 id 不含版本、键归一、列表与诊断分离 | 32 |
| `ui/.../presets/ArtifactBoard.tsx` | board 预置渲染器 | 只读投影、按 key upsert、动画不重播、compact 计数、空态与截断口径 | 31 |

## 3. 说明

- `forceUpdate.ts` 原 4.39%，块锚定版本归一、严格匹配、预发布比较、总比较与准入判定；
  比较规则（数字段小于字母段、短段更小）逐条写进注释，避免后续"简化"破坏 semver 语义。
- `runner.ts` 原 2.75%，块锚定清单校验、事务提前返回、串行闸门、备份目录检查与已应用筛选；
  两处 `for (const migration of migrations)` 以 `nth: 1` 锚定首个校验循环，一次通过。
- `subagents-types.ts` 原 7.52%，块锚定覆盖解析入口、类型守卫、逐条过滤、两个 id 生成器与列表结果；
  插件 id 与普通 id 的键格式在注释中固定为线上契约。
- `ArtifactBoard.tsx` 原 8.15%，块全部锚定在 JS 语句位置（未在 JSX 内插入），
  `key` 稳定性与揭示动画的关系写成显式不变量。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1922 needLines=28112 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1918 needLines=23520
```

累计 1,306 文件 / 124,772 行。
