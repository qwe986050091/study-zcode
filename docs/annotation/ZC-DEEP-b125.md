# ZC-DEEP-B125（4 文件，+177 行）

> 范围：`apps/zcode-cli` 的用量快照投影、bash 只读策略表、TUI 提交落地与剪贴板图片读取。
> 快照：`d:\code\_annot_baseline\ZC-deep-b125\orig`；清单：`ZC-deep-b125-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.51%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts: 5 blocks, 44 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts: 5 blocks, 45 lines
[ok] apps/zcode-cli/packages/tui/src/app-submit.ts: 5 blocks, 45 lines
[ok] apps/zcode-cli/packages/cli/src/clipboard-image.ts: 5 blocks, 43 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=177
TOTAL added=177 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.31% code=214 comment=67 apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts
31.51% code=219 comment=69 apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts
31.25% code=288 comment=90 apps/zcode-cli/packages/tui/src/app-submit.ts
31.49% code=235 comment=74 apps/zcode-cli/packages/cli/src/clipboard-image.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts` | 用量查询结果投影成 App 快照 | 时区偏移、四档分级、连续天数与七天切周 | 44 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts` | 单命令只读策略表 | git 全局 flag 三分类、三种策略形态、兜底集合与 docker 前缀 | 45 |
| `apps/zcode-cli/packages/tui/src/app-submit.ts` | 提交结果合并与两条提交路径 | 恢复优先级、空响应不占位、排队分支与取消语义 | 45 |
| `apps/zcode-cli/packages/cli/src/clipboard-image.ts` | 跨平台剪贴板图片读取 | 字节上限、平台分发、临时目录清理与子进程结算 | 43 |

## 3. 说明

- `bash-readonly-policy-simple-commands.ts` 与 `app-submit.ts` 的文件首行本身是注释，文件头 `//` 块插在其上方，未改动既有注释内容。
- 其余两个文件首行为 `import`，头部插在模块最前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
