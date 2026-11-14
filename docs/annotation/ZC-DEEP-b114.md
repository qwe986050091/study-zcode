# ZC-DEEP-b114

> 批次：B114（6 文件，按 31.4% 口径目标 270 行，落地 270 行）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b114`；开工前 6 文件均为 `newComments=0`。
> 首选项 `bootstrap/src/app/script-workflow-child-source.ts` 为子进程源码字符串
> （`String.raw` 模板），插入注释会改动运行时源码，按既定规则顺延，改取清单下一项。
> 中断复核：机器重启后复扫确认 B113 已完整收尾（`added=294`、索引与两个汇总文档均已回填），
> B114 仅有清单、计划与快照，未产生任何半插入文件，因此直接从原文插入。

## 校验

```
node zc-verify.mjs ZC-deep-b114
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=270

node check-batch.mjs ZC-deep-b114 ZC-deep-b114-files.txt
TOTAL added=270 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25  190  144   45  44  packages/desktop/scripts/mcp-apps-host-fixture/retention-main.ts
31.25  205  144   45  44  packages/provider/src/config/schema.ts
31.32  250  182   57  45  packages/shared/src/feedbackPrivacy.ts
31.52  233  165   52  45  packages/desktop/src/main/zcodeDataSizeScanner.ts
31.54  389  260   82  47  packages/desktop/src/main/unreadBadge.ts
31.69  189  142   45  45  packages/shared/src/gen-ui/tweakProtocol.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.42 newComments=270
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/scripts/mcp-apps-host-fixture/retention-main.ts` | 插件沙箱 retention 压测 fixture | INV-01~18；启动装配；guest 配置；容量 64；LRU 与 busy；截止时间释放 | 44 |
| `desktop/src/main/unreadBadge.ts` | 未读角标换算与任务栏 overlay | INV-01~18；多窗取最大；平台分派；点阵渲染；预乘混合；超采样圆点 | 47 |
| `desktop/src/main/zcodeDataSizeScanner.ts` | 数据目录字节统计 | INV-01~18；上限与 Abort；首目录缺失；符号链接；原因折叠；结果守卫 | 45 |
| `provider/src/config/schema.ts` | Provider 与 Model 配置解析 | INV-01~18；三来源；账号片段；五类模型规则；访问配置分派；纯构造 | 44 |
| `shared/src/feedbackPrivacy.ts` | 反馈文本脱敏管道 | INV-01~18；键名归一；URL 凭据；私钥与认证头；递归清洗；JSON 片段 | 45 |
| `shared/src/gen-ui/tweakProtocol.ts` | GenUI tweak 协议 schema | INV-01~18；四种控件；strict；回调唯一；载荷上限；消息联合 | 45 |
