# ZC-DEEP-B163（4 文件，+153 行）

> 范围：runtime 依赖门面、工具结果展示投影、Bash 输出映射、git 破坏性操作判定（合计 1,070 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b163\orig`；清单：`ZC-deep-b163-files.txt`。
> 目标密度 31.4%，实际落点 31.06%~31.35%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/core/src/runtime/deps.ts: 5 blocks, 39 lines
[ok] apps/zcode-cli/packages/core/src/tool/executor/result-display.ts: 5 blocks, 41 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts: 4 blocks, 37 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts: 4 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=153
TOTAL added=153 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.35% code=319 comment=100 apps/zcode-cli/packages/core/src/runtime/deps.ts
31.35% code=453 comment=142 apps/zcode-cli/packages/core/src/tool/executor/result-display.ts
31.33% code=166 comment=52 apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts
31.06% code=132 comment=41 apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/runtime/deps.ts` | runtime 层统一依赖门面 | 唯一入口、无状态无 IO、queryId 继承规则、日志投影只搬标识、契约与实现分区 | 39 |
| `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts` | 工具结果的有界展示投影 | 两通道分离、分派顺序、MCP 官方标识来源、JSON 整体省略、代理对边界、diff 双上限 | 41 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts` | ExecutionResult 到 BashOutput 的映射 | provider 错误短路、截断前字节、中断语义、遥测脱敏、状态归一顺序 | 37 |
| `apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts` | git 破坏性操作判定 | 前置参数只跳过不解释、帮助短路、取反优先、push 三类强推证据、stagedOnly 例外 | 36 |

## 3. 说明

- `deps.ts` 首行是既有 JSDoc 起始行，文件头使用 `firstNth: 1` 定位并插在其上方；四个块均落在三个纯函数与内部转出段之前。
- `result-display.ts` 首行同为 JSDoc 起始行，文件头使用 `firstNth: 1`；块均锚定常量或函数签名，未进入对象展开内部。
- `bash-output.ts` 的注释不进入 `attachToolExecutionTelemetry` 的对象字面量，只落在函数签名与状态函数之前。
- `git.ts` 注释只落在函数头与局部常量处，未改动 switch 内的规则表达式。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2070 needLines=32927 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2066 needLines=28335
```

累计 1,158 文件 / 119,675 行。
