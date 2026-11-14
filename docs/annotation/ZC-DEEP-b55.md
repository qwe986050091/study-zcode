# ZC-DEEP-b55

> 批次：B55（12 文件，复算缺口 917 行；按当前工作树复算，优先同类/同目录：`ui/src` 4 个、`desktop/src/main` 3 个（含 `web-remote-relay` 1 个）、`adapters/model` 1 个、`node-repl-host` 1 个、`office-runtime` 1 个、`e2e-report` 1 个、`shared/zcode-protocol-v4` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b55\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b55
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=972

node check-batch.mjs ZC-deep-b55 ZC-deep-b55-files.txt
TOTAL added=972 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.23   396   285    89   89  packages/e2e-report/src/viewer/App.tsx
31.30   360   262    82   77  packages/desktop/src/main/web-remote-relay/webRemoteControlTransport.ts
31.33   411   300    94   78  packages/shared/src/zcode-protocol-v4/telemetry.ts
31.34   394   284    89   79  packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx
31.34   369   268    84   78  packages/desktop/src/main/chromeExecutableDiscovery.ts
31.35  1390   976   306   87  apps/zcode-cli/packages/adapters/src/model/model-execution.ts
31.37   418   306    96   79  packages/ui/src/settings/pluginManagedResourceGroups.ts
31.43   484   350   110   89  apps/zcode-cli/packages/node-repl-host/src/server.ts
31.45   552   407   128   80  apps/zcode-cli/packages/office-runtime/ui/viewers/PptxView.tsx
31.52   359   257    81   77  packages/desktop/src/main/chromeProfileDiscovery.ts
31.52   543   387   122   80  packages/ui/src/store/codingPlanQuotaResetState.ts
31.60   371   250    79   79  packages/ui/src/components/ai-elements/inline-citation.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.23 median=31.36 newComments=972
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `e2e-report/viewer/App.tsx` | 报告查看器根视图 | INV-01~19；reportData/trendData 两条加载链路；内外层 catch 错误分级；error/loading 分支顺序；失败聚合；指标卡派生；空态占位行；viewer URL 回落与 location 只读 | 89 |
| `node-repl-host/server.ts` | Node REPL 宿主服务 | INV-01~19；求值上下文与会话生命周期；输出流分离；超时与三重中断合并；sessionKey 串行隔离；Worker 与错误序列化 | 89 |
| `ui/usage-stats/AppUsageDailyModelTrendChart.tsx` | 按日按模型用量趋势图 | INV-01~19；日序列补齐与同日累加排序；模型维度顺序与截断；主题色映射；Y 轴峰值上限；空数据占位；tooltip 过滤与回退；memo 依赖；刻度抽稀 | 79 |
| `office-runtime/ui/viewers/PptxView.tsx` | PPTX 查看器 | INV-01~18；懒渲染窗口与槽位契约；`ready` 幂等；节点插入层级；适宽单点推导与 200px 下限；解包超限抛错；解析错误不上抛 React 边界；倒序命中与描边命名空间；句柄→缩略图→ObjectURL 释放顺序 | 80 |
| `desktop/main/chromeExecutableDiscovery.ts` | Chrome 可执行文件发现 | INV-01~19；3 秒命令预算与子进程生命周期；进程枚举平台白名单与两类 catch 回退；stat+isFile+非 Windows X_OK；uniquePaths 去重顺序；顺序即优先级；PATH 解析早退；Spotlight 与 XDG 双层容错 | 78 |
| `ui/ai-elements/inline-citation.tsx` | 行内引用角标 | INV-01~18；域名提取与 `new URL` 抛错；`+N` 计数；悬浮卡片零延时；context 空值与实例回灌；轮播索引成对写入；select 订阅解绑；按钮 type/aria-label；三行截断 | 79 |
| `ui/settings/pluginManagedResourceGroups.ts` | 插件托管资源分组 | INV-01~19；分组键由 pluginId/kind/技能路径归一化决定；稳定顺序（kind 序 + attention + index 兜底）；去重与 seenPaths 占位；缺失字段归一；纯函数不复制 server 引用 | 79 |
| `ui/store/codingPlanQuotaResetState.ts` | 额度重置 zustand store | INV-01~19；四字段状态按 source 分桶；自动完成口径（startedAt 为空）；观察记录幂等；played 单调游标；claim key 去重与编码；payload 校验；reserve/commit 两阶段与幂等；lease 释放与失败重试 | 80 |
| `adapters/model/model-execution.ts` | 模型执行适配 | INV-01~20；binding 冻结与每请求重建 factory；transport 只缓存无凭据网络层；fetch 包装顺序（proxy→路由→安全→业务错误→捕获）；非 2xx/JSON 业务码识别；SSE 逐帧转发与 streamFailed；尾帧 flush；错误体 1s 上限；64KB 限长读取与 reader 释放；retry-after 保留 | 87 |
| `desktop/main/chromeProfileDiscovery.ts` | Chrome 用户配置发现 | INV-01~19；命令超时与子进程生命周期；profile 目录正则；Local State 损坏降级与 info_cache∪磁盘并集；可导入性过滤与去重；选择优先级/歧义终态；`not_found` 兜底；Windows 策略路径展开与 `%VAR%` 语义 | 77 |
| `desktop/main/web-remote-relay/webRemoteControlTransport.ts` | 手机远控 relay 传输 | INV-01~19；connect/握手定时器；auth_ack 与 pairedGeneration；心跳 ACK 与超时；帧大小拦截与 rpc-frame 旁路；重连退避、KICKED、注册失效重试；dispose 顺序与定时器成对清理 | 77 |
| `shared/zcode-protocol-v4/telemetry.ts` | 协议遥测类型与校验 | INV-01~19；kind 判别联合与事件类型登记；strict 边界；基字段必填与 version 字面量；providerHostname/IPv6 脱敏；commandHash 与长度上限；superRefine 条件必填与互斥；可选字段向后兼容；transform 断言权衡 | 78 |

合计 **972**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 令牌只能存在于请求期

`model-execution.ts` 的 transport 只缓存无凭据网络层，鉴权在每次请求时叠加。
把 token 缓进长连接后，切换账号时旧凭据仍被复用，模型请求以已注销身份发出。

### 2. 报告加载的错误分级不能合并

`e2e-report/viewer/App.tsx` 的 reportData 与 trendData 各自 catch，分别决定整页错误与局部降级。
合并成一个 catch 后，趋势数据缺失会把整份报告判为失败，用户连已加载的用例结果都看不到。

### 3. 幻灯片资源释放有固定顺序

`PptxView.tsx` 先释放渲染句柄，再清缩略图，最后 revoke ObjectURL。
顺序颠倒会让缩略图仍引用已回收的 URL，界面出现一片空白图。

### 4. profile 选择歧义必须显式终态

`chromeProfileDiscovery.ts` 在多个可导入 profile 且无显式选择时返回歧义态而非默认首个。
默认取首个会让用户无意中把浏览器数据导入到别人的账户配置里。

### 5. relay 的 pairedGeneration 必须校验

`webRemoteControlTransport.ts` 在收到 ack 时比对配对代际。
不比对时，重连前的一条迟到 ack 会把新连接置为已配对，手机端看到的是旧桌面会话。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| transport 缓存凭据 | 切账号后请求仍用旧 token |
| 报告两个数据源合并 catch | 局部失败导致整页白屏 |
| 幻灯片不 revoke ObjectURL | 内存随翻页增长，缩略图空白 |
| profile 歧义默认取首个 | 导入到错误浏览器账户 |
| relay 不校验 pairedGeneration | 重连后显示旧桌面会话 |
| 日序列不补齐 | 趋势图断点，均值失真 |
| REPL 输出流不分离 | stdout 混入结果，解析失败 |
| 插件分组用不稳定排序 | 每次渲染资源顺序抖动 |
| 额度 claim 不去重 | 重复重置，额度被多次消耗 |
| 遥测 strict 放行未知 kind | 未知事件污染看板维度 |
| 引用角标不校验 URL | 非法域名导致渲染抛错 |

## 顺延

B55 复算清单共 20 个候选，本批取 12 个，其余顺延到 B56，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.23%~31.60%。
