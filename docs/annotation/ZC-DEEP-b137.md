# ZC-DEEP-B137（4 文件，+170 行）

> 范围：配置 hook 的进程执行、/rewind 编排、Agent 工具入口与 effort 建议面板。
> 快照：`d:\code\_annot_baseline\ZC-deep-b137\orig`；清单：`ZC-deep-b137-files.txt`。
> 目标密度 31.4%，实际落点 31.22%~31.52%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts: 5 blocks, 42 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts: 5 blocks, 44 lines
[ok] apps/zcode-cli/packages/core/src/tool/handlers/agent.ts: 5 blocks, 43 lines
[ok] apps/zcode-cli/packages/tui/src/app-effort-suggestion-panel.tsx: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=170
TOTAL added=170 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.44% code=229 comment=72 apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts
31.52% code=368 comment=116 apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts
31.46% code=302 comment=95 apps/zcode-cli/packages/core/src/tool/handlers/agent.ts
31.22% code=189 comment=59 apps/zcode-cli/packages/tui/src/app-effort-suggestion-panel.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts` | 把配置 hook 翻译成受控进程执行并归一化结果 | 退出码语义、阻断形状分派、stdin 清理与诊断截断 | 42 |
| `apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts` | /rewind 的独立 turn 编排与工作区回退 | 互斥槽位、分派顺序、取消复查与投影重建 | 44 |
| `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts` | Agent 工具：把输入转译为子代理派发请求 | 同步/后台两种结果形态、模型覆盖与入口声明口径 | 43 |
| `apps/zcode-cli/packages/tui/src/app-effort-suggestion-panel.tsx` | effort 候选面板的单行渲染与列宽预算 | 固定行高、detail/label 分配与宽度归一化 | 41 |

## 3. 说明

- `agent.ts` 文件中 `/**` 出现多次，文件头按 `nth=1` 命中首个。
- 首次自检报两条锚点未命中（`parseHookStdout`、`createExitCodeBlockOutput` 为单行签名），改为整行锚定后通过。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
