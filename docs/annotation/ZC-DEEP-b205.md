# ZC-DEEP-B205（4 文件，+124 行）

> 范围：plugins 子命令共用件、轮尾 Browser 截图、bash 只读 argv 校验与 xlsx 解析器（合计 682 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b205\orig`；清单：`ZC-deep-b205-files.txt`。
> 目标密度 31.4%，实际落点 31.09%~31.58%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/cli/src/plugins-command-shared.ts: 7 blocks, 30 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/browser-turn-screenshot.ts: 9 blocks, 31 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-flags.ts: 8 blocks, 31 lines
[ok] apps/zcode-cli/packages/office-runtime/src/adapters/parse/xlsx.ts: 9 blocks, 32 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=124
[apps/zcode-cli/packages/cli/src/plugins-command-shared.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[apps/zcode-cli/packages/core/src/runtime/methods/browser-turn-screenshot.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-flags.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[apps/zcode-cli/packages/office-runtime/src/adapters/parse/xlsx.ts] added=32 nonComment=0 starSlash=0 suspicious=0
TOTAL added=124 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.09% code=119 comment=37 apps/zcode-cli/packages/cli/src/plugins-command-shared.ts
31.28% code=195 comment=61 apps/zcode-cli/packages/core/src/runtime/methods/browser-turn-screenshot.ts
31.45% code=159 comment=50 apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-flags.ts
31.58% code=209 comment=66 apps/zcode-cli/packages/office-runtime/src/adapters/parse/xlsx.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `cli/src/plugins-command-shared.ts` | plugins 子命令共用件 | 依赖名与导出名双侧绑定、注入优先、懒加载 bootstrap、scope 三值映射、标识按最后一个 @ 拆、裸名唯一命中 | 30 |
| `core/.../browser-turn-screenshot.ts` | 轮尾 Browser 截图 | take 语义、端口缺席即降级、只截 active tab、超预算先压缩、无图不落 part、completed 终态与三事件时序同源 | 31 |
| `core/.../bash-readonly-policy-argv-flags.ts` | 只读 argv 校验 | 三种策略分流、xargs 目标白名单、`--` 语义、紧凑条数特例、短 flag 粘连与簇的双重校验、取值类型判定 | 31 |
| `office-runtime/.../parse/xlsx.ts` | xlsx 解析器 | 先查包再解压、单元格形状判定顺序、合并区非主格置空、公式原文与缓存分离、25 行/60 列分页、区间裁边 | 32 |

## 3. 说明

- `plugins-command-shared.ts` 原 5.88%，块锚定导出名映射、resolveDep、baseOptions、resolveScope、标识拆分与裸名解析；
  「左侧依赖名是测试注入键、右侧是真实导出名」的耦合关系写入注释，避免只改一侧。
- `browser-turn-screenshot.ts` 原 15.38%，块锚定工具名/原始字节常量、display 判定、事件追加、状态消费、端口早退、list 调用与无 active tab 分支；
  原有中文注释保留，只补「为什么跳过不等于失败」的判定依据。
- `bash-readonly-policy-argv-flags.ts` 原 11.95%，块锚定空 argv、commandOnly、xargs 分支、`--` 语义、head/tail 紧凑条数、短 flag 粘连与 none 型；
  把「拿不准不做猜测」的失败语义落到具体分支上。
- `xlsx.ts` 原 16.27%，块锚定分页常量、display、readCell、usedBounds、分页循环、列截断、openPackage 与无定位器分支；
  未改动任何解析逻辑，仅补齐顺序与边界理由。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1902 needLines=27518 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1898 needLines=22926
```

累计 1,326 文件 / 125,403 行。
