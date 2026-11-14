# ZC-DEEP-b40

> 批次：B40（12 文件；含 B39 全部 7 个顺延文件，再补 5 个）。
> 执行分三波：5 + 5 + 2（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b40\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b40
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1277

node check-batch.mjs ZC-deep-b40 ZC-deep-b40-files.txt
TOTAL added=1277 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.27   516   355  111  105  packages/shared/src/zcodeEndpoint.ts
31.30   529   377  118  105  apps/zcode-cli/packages/telemetry/src/bootstrap.ts
31.33   618   450  141  107  packages/server/src/source-server/transportAdapter.ts
31.34   571   402  126  106  packages/ui/src/hooks/useRemoteConnectionForm.ts
31.35   764   555  174  107  packages/desktop/src/host/windowHostControllerProjection.ts
31.40   759   551  173  106  apps/zcode-cli/packages/core/src/tool/handlers/bash.ts
31.41  1223   882  277  111  apps/zcode-cli/packages/adapters/src/plugins/index.ts
31.41   481   347  109  105  packages/provider/src/resolver.ts
31.45   687   477  150  107  packages/ui/src/app-shell/SidePaneTabTrigger.tsx
31.51   569   403  127  106  packages/ui/src/SlashCommandPlugin.tsx
31.53   464   352  111  106  packages/ui/src/gen-ui/adapters/page.ts
31.55   451   336  106  106  packages/ui/src/ModelTrajectoryPane.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.27 median=31.40 newComments=1277
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（`needLines=1206`）；目标新增按
`round(code × 0.314) − 当前注释行` 逐文件精确分配，合计 1,277 行。
首轮有 1 处 `suspicious`（中文句以 `new` 开头），已就地改写为中文表述，行数不变，重跑后归零。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/zcodeEndpoint.ts` | ZCode 端点解析与归一 | INV-01~18；解析优先级与 production 忽略 override；origin 归一与协议校验；v4 版本门槛的数值比较；ws 协议映射；webview 白名单；BigModel/ZAI 独立解析与回落顺序；URL 拼接改写契约 | 105 |
| `apps/zcode-cli/packages/telemetry/src/bootstrap.ts` | CLI 遥测初始化 | INV-01~16；同步工厂零 I/O；进程级唯一 Owner；Session shutdown 不关共享资源；OTLP 端点优先级；deviceMid 并发去重与临时文件 rename 原子写；锁文件 wx/EEXIST/残留回收；身份白名单与降级不阻断主链路 | 105 |
| `server/src/source-server/transportAdapter.ts` | 源码服务传输适配 | INV-01~16；backend 缓存与取消释放；staging 事务与 EXIT trap；上传下载失败清理；错误归一 phase 归类；daemon 状态复用与 token 重读；direct-tcpip 降级 | 107 |
| `ui/src/hooks/useRemoteConnectionForm.ts` | 远程连接表单状态 | INV-01~16；可用线路构建与 kind 兜底；开关时重置与草稿保留；Docker 加载代号实现最新请求获胜；finally 复位 loading；刷新失败保留旧列表；发现失败也置 loaded 防无限重试；alias 全量覆盖与失效清理 | 106 |
| `desktop/src/host/windowHostControllerProjection.ts` | 窗口控制投影 | INV-01~16；sourceKey/taskKey 身份优先级；快照与 delta 双主题序号推进；空 delta 不推进；重连时旧 source 摘除与新 source 写入同帧原子；断线降级不删投影；provisional 撤销不发帧；写路由存在性豁免；订阅先登记后回放 | 107 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` | Bash 工具处理器 | INV-01~18；空命令短路；端口缺失与后台生命周期报错；三模式优先级；后台 cwd 与已读回填时序；首字节时延与遥测归因顺序；30KB 阈值内外同值；沙箱标记；只读/并发保守声明；超时预算共用解析 | 106 |
| `apps/zcode-cli/packages/adapters/src/plugins/index.ts` | CLI 插件适配层 | INV-01~15；候选顺序与 id 先到先得；卸载抑制过滤；priority 步长；启用态收口副作用；hook 解析与执行分离；技能计数去重与符号链接边界；命令元数据生成写盘；官方缓存分片权威与回滚 | 111 |
| `provider/src/resolver.ts` | Provider 配置解析 | INV-01~16；四路配置归并的覆盖方向；Registry 发布门禁与展示视图分离；三层可执行状态；账号权益与连接状态区分；家族排序互斥；冻结与并发只读 | 105 |
| `ui/src/app-shell/SidePaneTabTrigger.tsx` | 侧栏标签触发器 | INV-01~18；拖拽与点击抑制标记；transform 缩放钳制；合成层；button 嵌套与 asChild 语义；中键 click 与 auxclick 双通道；关闭按钮冒泡；选中态 data-active；patch 与 diff 文件名三级解析 | 107 |
| `ui/src/SlashCommandPlugin.tsx` | 斜杠命令插件 | INV-01~17；`/` token 快照与 activeTrigger 同源刷新；历史回填不触发面板；Esc 签名抑制；全局最佳选中与分组顺序；CRITICAL 键盘命令注册与注销；App 命令只删 token 不插 mention；workspaceIdentity 分桶；portal 容器守卫 | 106 |
| `ui/src/gen-ui/adapters/page.ts` | Gen-UI 页面适配 | INV-01~16；快照整体替换与订阅发布；卸载闸门与可见性判定；握手超时；状态写入串行链；追问单飞的会话重校验；SDK 上下文浅拷贝；端口 sandboxId 与 initId 双校验；迟到沙箱回收；状态修订号防覆盖；dispose 顺序 | 106 |
| `ui/src/ModelTrajectoryPane.tsx` | 模型轨迹面板 | INV-01~17；打开展开/覆盖状态的事务性与版本号失效；延迟搜索索引与下标夹取；命令式高亮回收；目录打开双失败分支；原生滚动容器取舍；空态/错误/截断渲染优先级 | 106 |

合计 **1,277**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 端点解析在 production 下必须忽略 override

`zcodeEndpoint.ts` 的解析优先级把环境变量 override 限定在非生产环境。放开后，
生产包会读取到开发机遗留的 override，把请求打到错误后端——症状是「只有个别机器连不上」，
且配置界面看起来完全正常。

### 2. 遥测初始化必须零 I/O 且不阻断主链路

`bootstrap.ts` 的同步工厂不做文件读写，身份落盘与锁竞争都在异步分支里完成。
把初始化改成同步写文件，会在 CLI 启动最早期引入磁盘阻塞；任一步抛错未捕获则直接让命令起不来。

### 3. 窗口投影重连时新旧 source 必须同帧切换

`windowHostControllerProjection.ts` 在重连时先摘旧 source 再写新 source，两步之间不发中间态。
拆成两帧会让 UI 短暂看到「无 source」并清空投影；断线时删投影则会让用户看到窗口列表闪空。

### 4. 插件优先级只在同 id 首次注册时生效

`adapters/src/plugins/index.ts` 的候选顺序以 id 先到先得，后到的同 id 只做卸载抑制标记。
误改成「后到覆盖」会让官方内置插件被本地同名插件顶掉，表现为某条命令行为突变但无报错。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 生产环境仍读端点 override | 个别机器连到开发后端，配置界面无异常 |
| 遥测工厂改同步写文件 | CLI 启动变慢，磁盘异常时直接启动失败 |
| 重连分两帧切换 source | 窗口列表闪空或短暂显示无来源 |
| 断线时删除投影 | 恢复后需要整页刷新才看到窗口 |
| 插件同 id 改成后到覆盖 | 内置命令被同名插件顶掉，行为突变无报错 |
| delta 空包也推进序号 | 收到空包后跳号，后续增量被误判为过期丢弃 |
| Docker 加载不校验代号 | 快速切换目标时旧响应覆盖新列表 |
| 发现失败不置 loaded | 无限重试，连接页持续转圈 |
| `finally` 不复位 loading | 失败后按钮永久禁用 |
| 后台 cwd 与已读回填顺序颠倒 | 首次后台命令在错误目录执行 |
| 缩放不钳制 transform | 恢复侧栏后面板溢出或不可见 |

## 顺延

B40 复算清单为 19 文件，本批取 12 个（含 B39 全部 7 个顺延），其余 7 个顺延到 B41（缺口各 99~101 行）：
`packages/ui/src/settings/model-provider-section/enterpriseCodingPlanProducts.ts`（101）、
`packages/ui/src/lib/planModeTool.ts`（100）、
`packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts`（99）、
`packages/desktop/src/main/desktopCrashCapture.ts`（99）、
`packages/e2e-report/src/viewer/trendData.ts`（99）、
`packages/ui/src/lib/settingsNavigation.ts`（99）、
`packages/ui/src/onboarding/OnboardingDialog.tsx`（99）。

> 说明：每文件独立 spec（≤150 行），5 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 1 处 `suspicious` 已就地改写修正；`transportAdapter.ts` 有 3 处锚点歧义，
> `plugins/index.ts` 有 1 处，均用 `nth` 或加长锚点解决，未改动源码。
