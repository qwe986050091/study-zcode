# ZC-DEEP-B190（4 文件，+133 行）

> 范围：发布指针管理、工作流脚本元数据、专家命令处理、观测事件流（合计 684 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b190\orig`；清单：`ZC-deep-b190-files.txt`。
> 目标密度 31.4%，实际落点 31.33%~31.61%。

## 1. 验收输出

```text
[ok] packages/zcode-server-cli/src/runtime/releaseManager.ts: 4 blocks, 34 lines
[ok] apps/zcode-cli/packages/bootstrap/src/app/script-workflow-meta.ts: 4 blocks, 33 lines
[ok] apps/zcode-cli/packages/cli/src/command-center/handlers/expert.ts: 4 blocks, 32 lines
[ok] apps/zcode-cli/packages/debug/server/observation-events.ts: 4 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=133
TOTAL added=133 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.33% code=150 comment=47 packages/zcode-server-cli/src/runtime/releaseManager.ts
31.61% code=174 comment=55 apps/zcode-cli/packages/bootstrap/src/app/script-workflow-meta.ts
31.45% code=124 comment=39 apps/zcode-cli/packages/cli/src/command-center/handlers/expert.ts
31.36% code=236 comment=74 apps/zcode-cli/packages/debug/server/observation-events.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `zcode-server-cli/src/runtime/releaseManager.ts` | 发布指针管理 | 临时名唯一、独占权限、有界重试、事务标记与恢复、执行前边界校验、真实路径规范化 | 34 |
| `bootstrap/src/app/script-workflow-meta.ts` | 脚本元数据 | 读取上限、子进程求值隔离与超时、输出上限、稳定序列化、括号扫描跳过字符串与注释 | 33 |
| `cli/.../handlers/expert.ts` | 专家命令处理 | 空参数默认查询、取消归停止、未知首词整体为任务、能力缺失提示、自动切自主模式 | 32 |
| `debug/server/observation-events.ts` | 观测事件流 | 重试帧与问候、间隔归一、单飞扫描、关闭后不写、目录排序签名、共享内存只比大小 | 34 |

## 3. 说明

- `releaseManager.ts` 的块落在重命名重试、原子写与类声明前；既有 Windows/事务安全注释未动。
- `script-workflow-meta.ts` 的块落在读取入口、稳定哈希与求值函数前；已有 JSDoc 与扫描器注释保持原样。
- `expert.ts` 的块落在命令入口、参数解析与停止分支前；文件头既有说明未动。
- `observation-events.ts` 首行为 `/**`，与其余块注释重名，故 header 锚点取 `firstNth: 1`；块落在流创建、指纹聚合与单目标函数前。
- 本批 1 次修正（首行锚点重复），修正后 check 一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1962 needLines=29338 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1958 needLines=24746
```

累计 1,266 文件 / 123,479 行。
