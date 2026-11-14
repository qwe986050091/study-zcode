# ZC-DEEP-B188（4 文件，+134 行）

> 范围：桌面构建配置、内置发行包下载、模型配置合同、V4 物理帧协议（合计 574 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b188\orig`；清单：`ZC-deep-b188-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.47%。

## 1. 验收输出

```text
[ok] packages/desktop/vite.config.ts: 4 blocks, 34 lines
[ok] packages/provider-node/src/zcode-builtin-download.ts: 4 blocks, 33 lines
[ok] packages/shared/src/model-config.ts: 4 blocks, 33 lines
[ok] packages/shared/src/zcode-protocol-v4/wire.ts: 4 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=134
TOTAL added=134 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.34% code=201 comment=63 packages/desktop/vite.config.ts
31.36% code=118 comment=37 packages/provider-node/src/zcode-builtin-download.ts
31.25% code=112 comment=35 packages/shared/src/model-config.ts
31.47% code=143 comment=45 packages/shared/src/zcode-protocol-v4/wire.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/vite.config.ts` | 渲染层构建配置 | 动态导入构建脚本、真实安装根别名、覆盖率插桩边界、环境与产品身份分轴、生产隐藏映射 | 34 |
| `packages/provider-node/src/zcode-builtin-download.ts` | 内置发行包下载 | 总预算与取消合并、配置严格校验、禁跟随重定向、正文上限、锁释放、阶段化错误 | 33 |
| `packages/shared/src/model-config.ts` | 模型数据合同 | 映射非空与编译错误转字段、枚举去重去空、上限正整数、稀疏形状只放宽必填、类型由模式推导 | 33 |
| `packages/shared/src/zcode-protocol-v4/wire.ts` | V4 物理帧模式 | 两类帧判别、序号与分片上界、校验和格式、候选帧只校验外层、跨字段一致性 | 34 |

## 3. 说明

- `vite.config.ts` 的块落在构建期定义、依赖别名表与默认配置工厂前；`define` 表内既有行内注释未动。
- `zcode-builtin-download.ts` 的块落在下载主流程、嵌套读取函数与边界错误类前；`try` 内既有安全注释保持原样。
- `model-config.ts` 原文件仅 2 行注释，header 插在首个 import 之上；块落在选项映射工厂、完整配置模式与类型导出前。
- `wire.ts` 首行是既有文件说明，header 插在其上；块落在帧联合类型、候选模式与完整校验器前。
- 本批 4 份 spec 均一次 check 通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1970 needLines=29591 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1966 needLines=24999
```

累计 1,258 文件 / 123,213 行。
