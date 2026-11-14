# ZC-DEEP-B202（4 文件，+126 行）

> 范围：provider 业务码映射、斜杠命令过滤替换、预览代码内容分流与模型配置帮助气泡（合计 534 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b202\orig`；清单：`ZC-deep-b202-files.txt`。
> 目标密度 31.4%，实际落点 31.00%~31.78%。

## 1. 验收输出

```text
[ok] packages/ui/src/lib/providerBusinessError.ts: 8 blocks, 33 lines
[ok] packages/ui/src/lib/slashCommands.ts: 6 blocks, 31 lines
[ok] packages/ui/src/previewPaneCodeContent.tsx: 8 blocks, 31 lines
[ok] packages/ui/src/settings/model-provider-section/ModelConfigHelp.tsx: 6 blocks, 31 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=126
[packages/ui/src/lib/providerBusinessError.ts] added=33 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/lib/slashCommands.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/previewPaneCodeContent.tsx] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/settings/model-provider-section/ModelConfigHelp.tsx] added=31 nonComment=0 starSlash=0 suspicious=0
TOTAL added=126 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.00% code=100 comment=31 packages/ui/src/lib/slashCommands.ts
31.42% code=226 comment=71 packages/ui/src/lib/providerBusinessError.ts
31.68% code=101 comment=32 packages/ui/src/previewPaneCodeContent.tsx
31.78% code=107 comment=34 packages/ui/src/settings/model-provider-section/ModelConfigHelp.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/lib/providerBusinessError.ts` | 业务码到界面动作映射 | 码表唯一真值、三张映射成对、包装码推断边界、模型级并发退化 3009、配额刷新口径 | 33 |
| `ui/src/lib/slashCommands.ts` | 斜杠命令过滤 | 行首识别、空白失活、三级评分分层、排序稳定性、替换与光标计算 | 31 |
| `ui/src/previewPaneCodeContent.tsx` | 预览内容分流 | mermaid 专用分支、共用滚动 ref、设置项透传、批注参数不加工、只读默认值 | 31 |
| `ui/src/settings/.../ModelConfigHelp.tsx` | 字段帮助气泡 | 按钮与 label 同级、仅鼠标悬停自动开关、阻止焦点抢占、文案分段与强调边界 | 31 |

## 3. 说明

- `providerBusinessError.ts` 原 16.81%，既有文件头业务码表与两处中文注释全部保留；
  新增块锚定类型守卫、两个查询函数与四个推断函数，把"包装码才推断、直接码优先"的顺序写死。
- `slashCommands.ts` 原零注释，块锚定评分函数、查询提取、过滤链、排序与替换返回；
  三级排序（分数、名称长度、字典序）标注为不可随意改写的行为契约。
- `previewPaneCodeContent.tsx` 原 0.99%，块锚定 mermaid 分支、滚动 ref、图表组件与三组透传参数；
  未改任何 props 名与默认值。
- `ModelConfigHelp.tsx` 原 2.80%，块锚定文案取值、指针、点击、段落渲染与强调函数；
  `pointerType` 过滤与阻止焦点是触摸端与键盘可用性的关键，已写成显式不变量。
- 本批 `slashCommands.ts` 的 `lineStart` 锚点在两个函数中各出现一次，改用 `nth: 1` 后通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1914 needLines=27872 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1910 needLines=23280
```

累计 1,314 文件 / 125,023 行。
