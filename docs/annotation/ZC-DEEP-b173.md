# ZC-DEEP-B173（4 文件，+143 行）

> 范围：服务端目录布局、命令编译、进程执行适配器与 Bash 读状态回填（合计 803 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b173\orig`；清单：`ZC-deep-b173-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.45%。

## 1. 验收输出

```text
[ok] packages/zcode-server-cli/src/runtime/paths.ts: 5 blocks, 36 lines
[ok] apps/zcode-cli/packages/adapters/src/exec/execution-command.ts: 5 blocks, 36 lines
[ok] apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts: 5 blocks, 36 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts: 5 blocks, 35 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=143
TOTAL added=143 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.30% code=131 comment=41 packages/zcode-server-cli/src/runtime/paths.ts
31.45% code=248 comment=78 apps/zcode-cli/packages/adapters/src/exec/execution-command.ts
31.45% code=248 comment=78 apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts
31.25% code=176 comment=55 apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/zcode-server-cli/src/runtime/paths.ts` | 服务端目录布局与控制端点 | 默认根可覆盖、布局单点派生、端点按平台分流、缺失祖先回退、包含判断与卸载校验 | 36 |
| `.../adapters/src/exec/execution-command.ts` | 命令描述编译为 spawn 参数 | 环境不改父进程、清洗先于网络策略、已解析 shell 优先、批处理强制解释器、登录模式可降级 | 36 |
| `.../adapters/src/exec/node-execution-adapter-process.ts` | 子进程准备、终止与输出接入 | 平台差异单点收敛、快照仅限直接执行、POSIX 独立进程组、整树终止兜底、排空三步顺序 | 36 |
| `.../core/src/tool/handlers/bash-read-file-state.ts` | Bash 后过期提示与读状态回填 | 副作用不改结果、先提示后回填、只对写命令比较、截断不回填、超大文件跳过 | 35 |

## 3. 说明

- `paths.ts` 的块落在默认根与布局两个入口、规范化循环入口与包含判断签名前，未进入返回对象字面量。
- 两个 adapters 文件首行均为 `// ====` 横幅且在文件内重复，规格统一加 `firstNth: 1`。
- `execution-command.ts` 的块落在两个导出入口与两个 shell 重组函数签名前。
- `node-execution-adapter-process.ts` 的块落在类声明、准备方法、终止方法与排空方法签名前。
- `bash-read-file-state.ts` 的块落在入口、提示、回填与跳过判定四个函数签名前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2030 needLines=31555 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2026 needLines=26963
```

累计 1,198 文件 / 121,152 行。
