# ZC-DEEP-B174（4 文件，+145 行）

> 范围：MCP App 页面宿主适配、页面工具条目、工作流存储契约用例与 Word 解析器（合计 906 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b174\orig`；清单：`ZC-deep-b174-files.txt`。
> 目标密度 31.4%，实际落点 31.21%~31.60%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/handlers.ts: 5 blocks, 38 lines
[ok] apps/zcode-cli/packages/core/src/mcp/app-tools.ts: 5 blocks, 35 lines
[ok] apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-nodes.ts: 5 blocks, 35 lines
[ok] apps/zcode-cli/packages/office-runtime/src/adapters/parse/docx.ts: 5 blocks, 37 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=145
TOTAL added=145 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.49% code=308 comment=97 apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/handlers.ts
31.21% code=141 comment=44 apps/zcode-cli/packages/core/src/mcp/app-tools.ts
31.40% code=207 comment=65 apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-nodes.ts
31.60% code=250 comment=79 apps/zcode-cli/packages/office-runtime/src/adapters/parse/docx.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../bootstrap/src/zcode-protocol/mcp-ui/handlers.ts` | MCP App 页面宿主适配 | 活动调用按会话隔离、墓碑防标识复用、归属校验即关闭、可见性判定、订阅绑定实例代次、资源大小与类型设限 | 38 |
| `.../core/src/mcp/app-tools.ts` | 页面工具转为 core 工具条目 | 条目与执行器解耦、超时三段之和、只读免审批、审批粒度会话级、预算截断、超时不可覆盖 | 35 |
| `.../dynamic-workflow/src/testing/journal-contract-nodes.ts` | 存储契约用例（节点与执行者） | 顺序与拆分前一致、缺席字段保持缺席、结算整条替换带回输入、报告节点单次写入、边界零值合法 | 35 |
| `.../office-runtime/src/adapters/parse/docx.ts` | Word 解析为块模型与大纲 | 只解析字节、缺正文即损坏、编号独立计数、样式链上限、可见文本排除删除与域码、越界统一报错 | 37 |

## 3. 说明

- `handlers.ts` 的块落在会话清理、归属校验、处理器工厂与资源边界四个函数签名前，未进入返回对象方法体。
- `app-tools.ts` 的块落在超时常量、条目工厂、处理器属性与方法归一化函数前；首行为模块注释，直接以首行为锚点。
- `journal-contract-nodes.ts` 的块落在注册函数与三条用例声明前，用例体保持零改动。
- `docx.ts` 的块落在段落接口、样式读取、标题推导与解析入口前，遍历与搜索循环体未插入。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2026 needLines=31421 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2022 needLines=26829
```

累计 1,202 文件 / 121,297 行。
