# ZC-DEEP-B141（4 文件，+163 行）

> 范围：自动化设置页基础组件、计划指导渲染器、网页元素附件 hook 与分享预检缓存。
> 快照：`d:\code\_annot_baseline\ZC-deep-b141\orig`；清单：`ZC-deep-b141-files.txt`。
> 目标密度 31.4%，实际落点 31.08%~31.61%。

## 1. 验收输出

```text
[ok] packages/ui/src/settings/AutomationDesignPrimitives.tsx: 5 blocks, 40 lines
[ok] packages/ui/src/ToolCallBlocks/renderers/plan-guidance.tsx: 5 blocks, 41 lines
[ok] packages/ui/src/v4/composer/useWebElementContexts.ts: 5 blocks, 41 lines
[ok] packages/ui/src/v4/conversationSharePreflightCache.ts: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=163
TOTAL added=163 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.08% code=148 comment=46 packages/ui/src/settings/AutomationDesignPrimitives.tsx
31.54% code=130 comment=41 packages/ui/src/ToolCallBlocks/renderers/plan-guidance.tsx
31.54% code=130 comment=41 packages/ui/src/v4/composer/useWebElementContexts.ts
31.61% code=174 comment=55 packages/ui/src/v4/conversationSharePreflightCache.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/settings/AutomationDesignPrimitives.tsx` | 自动化设置页共用的排版、空态与创建入口 | 类名常量契约、受控页签、提示条可读性与菜单结构 | 40 |
| `packages/ui/src/ToolCallBlocks/renderers/plan-guidance.tsx` | 计划指导工具结果的正文提取与渲染 | 候选优先级、字段白名单、失败态退让与回调依赖 | 41 |
| `packages/ui/src/v4/composer/useWebElementContexts.ts` | 输入框网页元素附件的维护与事件响应 | 作用域清空、工作区键过滤、按标识替换与监听解绑 | 41 |
| `packages/ui/src/v4/conversationSharePreflightCache.ts` | 分享预检的轮次指纹、缓存键与问题聚合 | 指纹字段白名单、全局问题去重、缺明细降级与预算重算 | 41 |

## 3. 说明

- `conversationSharePreflightCache.ts` 含 3 处既有块注释，正文块避开这些锚点，未改动既有注释。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
