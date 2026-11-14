# ZC-DEEP-B135（3 文件，+120 行）

> 范围：WSL 探测与代理地址工具、受限 CEL 词法分析。
> 快照：`d:\code\_annot_baseline\ZC-deep-b135\orig`；清单：`ZC-deep-b135-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.50%。

## 1. 验收输出

```text
[ok] packages/server/src/remote/wsl-detect.ts: 5 blocks, 40 lines
[ok] packages/server/src/remote/wslProxy.ts: 5 blocks, 40 lines
[ok] packages/model-option-map/src/tokenizer.ts: 5 blocks, 40 lines
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=144 comment=45 packages/server/src/remote/wsl-detect.ts
31.50% code=127 comment=40 packages/server/src/remote/wslProxy.ts
31.25% code=128 comment=40 packages/model-option-map/src/tokenizer.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/server/src/remote/wsl-detect.ts` | WSL 可用性与发行版列表探测 | 双编码解码、分段解析、缓存隔离与失败失效 | 40 |
| `packages/server/src/remote/wslProxy.ts` | WSL 代理地址规范化与宿主网关解析 | 协议补全、端口探测命令引用、候选来源分级 | 40 |
| `packages/model-option-map/src/tokenizer.ts` | 受限 CEL 子集词法分析 | 分支优先级、偏移边界、转义与冻结词表 | 40 |

## 3. 说明

- 三文件首行均唯一，无需 `nth`。
- 本批为上一个被取消回合的断点批次，插入前经 `zc-verify` 确认无半插入。
- 快照与现文件差异仅为本批新增注释行。
