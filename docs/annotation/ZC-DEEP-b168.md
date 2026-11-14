# ZC-DEEP-B168（4 文件，+155 行）

> 范围：执行适配器基类、模型 I/O 诊断落盘、脚本工作流明细仓储与旧 CLI 提供方迁移（合计 2,057 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b168\orig`；清单：`ZC-deep-b168-files.txt`。
> 目标密度 31.4%，实际落点 31.30%~31.52%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-base.ts: 4 blocks, 37 lines
[ok] apps/zcode-cli/packages/adapters/src/model/runner-debug.ts: 5 blocks, 45 lines
[ok] apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-activities.ts: 4 blocks, 37 lines
[ok] apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts: 4 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=155
TOTAL added=155 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.30% code=246 comment=77 apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-base.ts
31.44% code=776 comment=244 apps/zcode-cli/packages/adapters/src/model/runner-debug.ts
31.52% code=257 comment=81 apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-activities.ts
31.44% code=194 comment=61 apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../adapters/src/exec/node-execution-adapter-base.ts` | 执行适配器状态与预算基类 | 两表回收语义、关闭顺序与幂等、路径弱缓存、三级上限回退、快照字段白名单 | 37 |
| `.../adapters/src/model/runner-debug.ts` | 生成与流式两条链路的诊断落盘 | 全出口吞错、统一脱敏边界、文件轮转与硬上限、超限整文件重置、增量指纹与有界等待 | 45 |
| `.../adapters/src/storage/.../script-workflow-activities.ts` | 活动、事件与子会话链接仓储 | 尝试号单调、事件序号单调、限量取最近、唯一键只更状态、写后必读 | 37 |
| `.../bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts` | 旧 CLI 提供方与默认模型迁移 | 只消费已校验投影、内置只留密钥、全有或全无、冻结输出、模型成员去重与优先级 | 36 |

## 3. 说明

- 前三个文件首行是 `// ====` 横幅，且文件内重复出现同款分隔线，故头部锚点统一用 `firstNth: 1` 定位第一行。
- `runner-debug.ts` 的块只落在四个函数签名，未进入聚合 promise 与 SQL 之外的字符串模板。
- `script-workflow-activities.ts` 的块落在三个导出函数签名，未触碰 SQL 文本。
- `legacy-cli-personal-provider-config-importer.ts` 的块落在主入口、默认选择与成员收集签名。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2050 needLines=32231 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2046 needLines=27639
```

累计 1,178 文件 / 120,424 行。
