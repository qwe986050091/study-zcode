# ZC-DEEP-b106

> 批次：B106（6 文件，按 31.4% 口径目标 284 行，实际 +284）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b106\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b106
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=284

node check-batch.mjs ZC-deep-b106 ZC-deep-b106-files.txt
TOTAL added=284 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.29  193  147  46  46  packages/desktop/scripts/mcp-apps-host-fixture/managed-model-checks.ts
31.33  219  150  47  47  docs/knip/docs/scripts/generate-plugin-docs.ts
31.34  274  201  63  47  packages/desktop/src/main/pluginSandbox/registry.ts
31.36  487  338 106  49  apps/zcode-cli/packages/tui/src/app-shiki-diff-view.tsx
31.37  206  153  48  47  packages/desktop/scripts/gen-ui-fixture/runtime-checks.ts
31.58  291  209  66  48  packages/desktop/src/main/desktopCronScheduler.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.29 median=31.35 newComments=284
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `tui/src/app-shiki-diff-view.tsx` | 语法高亮 diff 视图 | INV-01~18；行展平与行号推进；左右配对；高亮指纹与兜底 | 49 |
| `docs/knip/scripts/generate-plugin-docs.ts` | 插件参考文档生成 | INV-01~18；目录扫描；元数据合并顺序；写失败隔离 | 47 |
| `desktop/scripts/.../runtime-checks.ts` | 运行时交互探针 | INV-01~18；页面内轮询；提示定位四方位；探针清理 | 47 |
| `desktop/scripts/.../managed-model-checks.ts` | 托管模型夹具检查 | INV-01~18；命令与事件偏移；认领取消时序；页面替换绑定 | 46 |
| `desktop/src/main/desktopCronScheduler.ts` | scheduler 进程托管 | INV-01~18；host 路由；transient 回执；幂等关闭与强杀 | 48 |
| `desktop/src/main/pluginSandbox/registry.ts` | 插件沙箱注册表 | INV-01~18；幂等键；配额与固定；手势一次性消费 | 47 |
