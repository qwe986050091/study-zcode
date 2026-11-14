# ZC-DEEP-B195（4 文件，+130 行）

> 范围：提及图标 DOM 数据、引导埋点、远端连接流程契约与「移到项目」对话框（合计 486 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b195\orig`；清单：`ZC-deep-b195-files.txt`。
> 目标密度 31.4%，实际落点 31.03%~31.75%。

## 1. 验收输出

```text
[ok] packages/ui/src/mentions/nodes/mentionIconDom.ts: 4 blocks, 32 lines
[ok] packages/ui/src/onboarding/useOnboardingTelemetry.ts: 4 blocks, 32 lines
[ok] packages/ui/src/remote-connection-flow/contract.ts: 4 blocks, 33 lines
[ok] packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx: 4 blocks, 33 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=130
TOTAL added=130 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.40% code=121 comment=38 packages/ui/src/mentions/nodes/mentionIconDom.ts
31.03% code=116 comment=36 packages/ui/src/onboarding/useOnboardingTelemetry.ts
31.71% code=123 comment=39 packages/ui/src/remote-connection-flow/contract.ts
31.75% code=126 comment=40 packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `mentions/nodes/mentionIconDom.ts` | 提及图标数据与 SVG 构建 | 常量数据、命名空间单点、只读类型、固定视图与尺寸、描边继承、纯构建边界 | 32 |
| `onboarding/useOnboardingTelemetry.ts` | 引导曝光与结束埋点 | 可见才建立曝光、单次曝光、偏好快照、回退模式重置、答案冻结、结束去重 | 32 |
| `remote-connection-flow/contract.ts` | 连接流程契约 | 回调可选边界、取消语义、偏好成组、归一只搬字段、进度投影不含凭据 | 33 |
| `settings/saved-workflows/SavedWorkflowMoveDialog.tsx` | 移到项目对话框 | 空候选禁用与提示、选择调和、提交三重拦截、描述分支、文案国际化 | 33 |

## 3. 说明

- `mentionIconDom.ts` 原已有 3 行文件说明，本批在其上方补 22 行头（18 条 INV + 分隔 + 3 行导读）；
  块落在命名空间常量、图标节点类型与构建函数前，图标数据区未插行。
- `useOnboardingTelemetry.ts` 的块落在职业映射、钩子签名与退出回调缓存前；既有两处语义注释未动，
  曝光副作用体内的分支保持原样。
- `contract.ts` 的块落在流程选项接口、归一函数与进度投影接口前；既有 5 处 JSDoc 未动。
- `SavedWorkflowMoveDialog.tsx` 的块落在属性接口、组件签名与提交处理器前；既有 JSDoc 与调和副作用注释未动，
  JSX 区未插入，避免落入 children/属性区。
- 本批 4 份 spec 均一次 check 通过，所有锚点经计数确认唯一。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1942 needLines=28718 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1938 needLines=24126
```

累计 1,286 文件 / 124,127 行。
