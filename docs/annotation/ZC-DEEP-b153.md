# ZC-DEEP-B153（4 文件，+157 行）

> 范围：exec 输出编码、commands 子命令、远端资产预检与云端内容 schema（合计 909 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b153\orig`；清单：`ZC-deep-b153-files.txt`。
> 目标密度 31.4%，实际落点 31.19%~31.71%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts: 7 blocks, 40 lines
[ok] apps/zcode-cli/packages/cli/src/commands-command.ts: 6 blocks, 39 lines
[ok] packages/server/src/remote/remoteAssetPreflight.ts: 6 blocks, 39 lines
[ok] packages/shared/src/cloudContent.ts: 6 blocks, 39 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=157
TOTAL added=157 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.51% code=238 comment=75 apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts
31.19% code=218 comment=68 apps/zcode-cli/packages/cli/src/commands-command.ts
31.54% code=130 comment=41 packages/server/src/remote/remoteAssetPreflight.ts
31.71% code=123 comment=39 packages/shared/src/cloudContent.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts` | 为子进程注入 UTF-8 locale，并决定一次性与流式解码的编码 | 优先 UTF-8、仅确定非法才回退、流式模式一次定型、尾部不完整拼接、locale 只补空缺、chcp 限时与 locale 推断 | 40 |
| `apps/zcode-cli/packages/cli/src/commands-command.ts` | 实现 `zcode commands` 的 list/inspect 与两种输出格式 | 子命令缺省与参数校验、退出码只在本层决定、依赖注入与惰性加载、错误统一出口、人类可读与 JSON 投影边界 | 39 |
| `packages/server/src/remote/remoteAssetPreflight.ts` | 远端部署前探测 tar、下载器、校验器与进度能力 | 单次往返探测、缺必需工具即失败、按等号解析、先收 stdout 再等关闭、关闭早于数据时的排空窗口与只结算一次 | 39 |
| `packages/shared/src/cloudContent.ts` | 定义云端内容弹窗的运行时校验 schema 与推导类型 | 主题缺省、URL 仅 http/https 且禁凭据、包体 zip/摘要/大小上限、hero 与动作判别联合、按钮唯一性与动作存在性 | 39 |

## 3. 说明

- `outputEncoding.ts` 首行为 `// ============` 分隔线且在文件中重复，文件头使用 `nth: 1` 锚定文件首行。
- `cloudContent.ts` 的交叉校验块锚定 `.superRefine((payload, context) => {`，插入后位于该调用之前，未进入链式调用的参数区。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
