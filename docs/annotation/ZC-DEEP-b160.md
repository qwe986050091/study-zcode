# ZC-DEEP-B160（4 文件，+150 行）

> 范围：Shiki 代码高亮、文件引用投影、会话事件排序闸门与工作流保存控制器（合计 584 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b160\orig`；清单：`ZC-deep-b160-files.txt`。
> 目标密度 31.4%，实际落点 30.86%~31.62%。

## 1. 验收输出

```text
[ok] packages/ui/src/lib/shikiHighlighter.ts: 6 blocks, 37 lines
[ok] packages/ui/src/lib/zcodeFileCitation.ts: 6 blocks, 38 lines
[ok] packages/ui/src/lib/zcodeSessionEventOrder.ts: 6 blocks, 37 lines
[ok] packages/ui/src/project-workflow/useWorkflowRunSave.ts: 6 blocks, 38 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=150
TOTAL added=150 hardBad=0 suspicious=0
```

逐文件密度：

```text
30.86% code=162 comment=50 packages/ui/src/lib/shikiHighlighter.ts
31.62% code=136 comment=43 packages/ui/src/lib/zcodeFileCitation.ts
31.50% code=127 comment=40 packages/ui/src/lib/zcodeSessionEventOrder.ts
31.45% code=159 comment=50 packages/ui/src/project-workflow/useWorkflowRunSave.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/lib/shikiHighlighter.ts` | 按语言与主题分片高亮代码块，维护高亮器与 token 两级缓存 | 纯文本短路、别名归一、缓存键防碰撞、微任务回调、订阅广播与清理、失败降级 | 37 |
| `packages/ui/src/lib/zcodeFileCitation.ts` | 解析正文文件引用指令并决定流式阶段可见文本截断 | 指令名与语法常量、可选字段透传、代码块保护、未闭合指令保留、扩展名推断 | 38 |
| `packages/ui/src/lib/zcodeSessionEventOrder.ts` | 会话事件去重、序号排序与缺口检测闸门 | 有界去重窗口、水位只进不退、连续序号放行、快照保留模式、缺口释放 | 37 |
| `packages/ui/src/project-workflow/useWorkflowRunSave.ts` | 完成卡与侧板共用的保存/再次运行控制器 | 目标对象与缓存键、代际重查、保存回填、重名探测降级、启动器目标优先 | 38 |

## 3. 说明

- `shikiHighlighter.ts` 的注释只落在 `Map` 声明与函数签名之前，未进入 `createHighlighter` 的配置对象。
- `zcodeFileCitation.ts` 的流式守卫块锚定函数体内首条语句，避开既有 JSDoc，保持其与函数的绑定关系。
- `zcodeSessionEventOrder.ts` 的闸门块锚定工厂函数签名，未插入返回对象的字面量方法内部。
- `useWorkflowRunSave.ts` 的 `useEffect` / `useCallback` 块仅插入到语句层，不改变 hook 依赖数组顺序。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

