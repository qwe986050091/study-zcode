# ZC-DEEP-b102

> 批次：B102（6 文件，按 31.4% 口径计算目标 303 行，实际 +303）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按缺口降序选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b102\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b102
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=303

node check-batch.mjs ZC-deep-b102 ZC-deep-b102-files.txt
TOTAL added=303 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25  340  256  80  53  apps/zcode-cli/packages/core/src/workflow/scheduler/node-runner.ts
31.36  301  220  69  50  apps/dev-docs/src/capability-map/CapabilityMapFlowElements.tsx
31.38  265  188  59  50  packages/desktop/src/main/browserView/browserScreenshotCapture.ts
31.41  222  156  49  49  packages/ui/src/lib/sessionOpenArmsTelemetry.ts
31.44  459  334 105  52  packages/desktop/tsup.config.ts
31.58  237  171  54  49  packages/ui/src/browser-use/useResponsiveBrowserViewportControl.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.40 newComments=303
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `core/src/workflow/scheduler/node-runner.ts` | 单节点执行与结算 | INV-01~18；started 时序；取消不计重试；活动与节点双写 | 53 |
| `desktop/src/main/browserView/browserScreenshotCapture.ts` | 截图 CSS 像素校正 | INV-01~18；首帧兜底；等比判定；有界倍率与降采样 | 50 |
| `desktop/tsup.config.ts` | Desktop 构建配置 | INV-01~18；动态加载脚本；env 优先级；external 与内联边界 | 52 |
| `dev-docs/src/capability-map/CapabilityMapFlowElements.tsx` | 能力地图节点与连线视图 | INV-01~18；注册表键一致；压暗不卸载；折线倒角 | 50 |
| `ui/src/browser-use/useResponsiveBrowserViewportControl.ts` | 响应式视口控制 hook | INV-01~18；ref 与 state 成对；只在假转真重置缩放；订阅清理 | 49 |
| `ui/src/lib/sessionOpenArmsTelemetry.ts` | 会话打开埋点载荷 | INV-01~18；上报即走；非法计量丢弃；身份字段固定 | 49 |
