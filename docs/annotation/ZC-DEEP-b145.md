# ZC-DEEP-B145（4 文件，+156 行）

> 范围：旧推理档位改名表、Provider 配置文件编解码、渠道提及与渲染动作追踪协议。
> 快照：`d:\code\_annot_baseline\ZC-deep-b145\orig`；清单：`ZC-deep-b145-files.txt`。
> 目标密度 31.4%，实际落点 31.20%~31.50%。

## 1. 验收输出

```text
[ok] packages/provider-node/src/legacy-reasoning-level-renames.ts: 6 blocks, 39 lines
[ok] packages/provider-node/src/provider-config-file-codec.ts: 6 blocks, 39 lines
[ok] packages/shared/src/channel-mention.ts: 6 blocks, 39 lines
[ok] packages/shared/src/rendererActionTrace.ts: 6 blocks, 39 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=156
TOTAL added=156 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.50% code=127 comment=40 packages/provider-node/src/legacy-reasoning-level-renames.ts
31.34% code=134 comment=42 packages/provider-node/src/provider-config-file-codec.ts
31.25% code=128 comment=40 packages/shared/src/channel-mention.ts
31.20% code=125 comment=39 packages/shared/src/rendererActionTrace.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/provider-node/src/legacy-reasoning-level-renames.ts` | 旧推理档位到默认档位的型号改名表 | 精确匹配边界、后缀分组、只读断言与无副作用约束 | 39 |
| `packages/provider-node/src/provider-config-file-codec.ts` | 个人 Provider 配置文件的解码、迁移与编码 | 版本闸门、逐级迁移、旧形状识别与读写版本共用 | 39 |
| `packages/shared/src/channel-mention.ts` | 渠道提及、回复片段与澄清结果校验 | 平台标识约束、段数与长度上限、引用来源可信与冲突检测 | 39 |
| `packages/shared/src/rendererActionTrace.ts` | 渲染动作追踪的配置、跨度与批次协议 | 采样与批量上限、字段白名单、时间单调与交叉校验 | 39 |

## 3. 说明

- `legacy-reasoning-level-renames.ts` 为纯数据表，锚点含双反斜杠正则字面量，本批按**行号取原文**生成锚点，避免转义失配。
- `provider-config-file-codec.ts` 与 `channel-mention.ts` 已有少量块注释，正文块避开这些位置。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
