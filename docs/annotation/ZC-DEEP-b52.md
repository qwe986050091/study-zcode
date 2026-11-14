# ZC-DEEP-b52

> 批次：B52（12 文件，复算缺口 939 行；按当前工作树复算，优先同类/同目录：`desktop/src/main` 7 个（含 `browserView` 2 个、`pluginSandbox` 1 个）、`ui/src` 2 个、`shared`/`rpc`/`server` 各 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b52\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b52
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=987

node check-batch.mjs ZC-deep-b52 ZC-deep-b52-files.txt
TOTAL added=987 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.23   385   269    84   81  packages/ui/src/components/ai-elements/file-tree.tsx
31.30   359   262    82   80  packages/desktop/src/main/desktopBrowserViewIpc.ts
31.30   398   262    82   81  packages/shared/src/git.ts
31.31   474   329   103   82  packages/server/src/remote/docker-backend.ts
31.33   557   399   125   82  packages/desktop/src/main/browserView/browserScreenshotActivityController.ts
31.35   440   319   100   82  packages/desktop/src/main/browserView/browserCommandPageHandlers.ts
31.38   456   341   107   82  packages/desktop/src/main/pluginSandbox/host.ts
31.38   731   529   166   85  packages/desktop/src/main/cuaAccessibilitySettings.ts
31.50   377   273    86   81  packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts
31.51   387   292    92   89  packages/desktop/src/main/localTtftExporter.ts
31.52   368   257    81   81  packages/ui/src/ToolCallBlocks/renderers/read-session-context.tsx
31.54   366   260    82   81  packages/rpc/src/channelServer.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.23 median=31.36 newComments=987
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/main/localTtftExporter.ts` | 本地 TTFT 采样导出 | INV-01~18；TTFT 以首个输出 token 为判据而非首字节；无 endpoint 时整体降级；view 桶与基数上限；drain 单消费者；labels 脱敏；trace 导出失败不影响主流程；shutdown 释放顺序 | 89 |
| `desktop/main/browserView/browserCommandPageHandlers.ts` | 浏览器页面命令执行 | INV-01~19；命令白名单与 URL 校验；导航等待有 deadline；页面销毁走失败路径；AbortError 原样上抛；evaluate 错误转结构化结果；同一页面命令串行 | 82 |
| `desktop/main/cuaAccessibilitySettings.ts` | CUA 辅助功能授权设置 | INV-01~19；仅 macOS 生效；install/verify fail-closed；每阶段重建验签证据；身份四字段精确匹配；post-settings 终检；会话单飞与 join 门；参与者级取消；总超时预算夹取 | 85 |
| `desktop/main/pluginSandbox/host.ts` | 插件沙箱宿主 | INV-01~20；单次安装幂等；三张容器表一致；partition 清理顺序；`about:blank` 卸载；stop 串行化；IPC sender 归属校验；initId 版本协商；租约唯一与失效竞态 | 82 |
| `desktop/main/browserView/browserScreenshotActivityController.ts` | 截图活动态控制器 | INV-01~20；活动计数不飘；lease 生成与释放按 generation 停泵；并发截图合并；事件循环让出；瞬态失败可恢复；定时器与监听器配对释放 | 82 |
| `desktop/main/desktopBrowserViewIpc.ts` | 浏览器视图 IPC 面 | INV-01~20；通道名常量化；sender 与窗口归属校验；参数 schema 校验；处理器一次性注册；未知 viewId 返回明确错误；`ipcMain.on` 单向通道；失败信封兜底 | 80 |
| `desktop/main/desktopFinderOpenFolderWorkflow.ts` | Finder 打开文件夹工作流 | INV-01~19；workflow 脚本与 Info.plist 生成；XML 转义；写文件前比对内容；服务索引刷新；路径存在性校验；不拼 shell 防注入；重复安装幂等 | 81 |
| `ui/components/ai-elements/file-tree.tsx` | 文件树组件 | INV-01~19；展开态与数据分离；path 作为唯一键；受控/非受控分叉；Set 引用身份；展开与选中双通道；目录图标派生；aria-tree 与键盘激活；空目录占位 | 81 |
| `ui/ToolCallBlocks/renderers/read-session-context.tsx` | 会话上下文读取结果 | INV-01~19；只读展示；失败结果优先覆盖；文本提取字段优先级；查询与会话 id 提取；空内容占位；快照提示回调可缺省；长文本折行 | 81 |
| `shared/git.ts` | git 输出解析 | INV-01~19；porcelain 状态码映射；路径转义与引号；空仓库与 detached HEAD 边界；未知状态码兜底；纯解析不执行命令；输出结构稳定 | 81 |
| `rpc/channelServer.ts` | RPC 通道服务端 | INV-01~19；请求 id 唯一与响应配对；handler 覆盖语义；异常转 error envelope；通道关闭清理 pending；消息顺序；未知 method 明确拒绝 | 81 |
| `server/remote/docker-backend.ts` | Docker 远端后端 | INV-01~19；容器引用白名单；argv 数组化防注入；POSIX 引号转义；running 状态判定；两级缓存单飞；mkdir 先于写文件；abort 与退出四路幂等收尾 | 82 |

合计 **987**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. TTFT 的判据是首个输出 token

`localTtftExporter.ts` 只在收到首个 `first_output` 时记录时间差，而不是首个网络字节。
改成首字节会把连接建立与 TLS 握手算进 TTFT，观测值整体偏高且不可比。

### 2. 插件宿主单次安装必须幂等

`pluginSandbox/host.ts` 用单例 + 三张表保证重复 install 不产生第二套容器。
失去幂等后同一 partition 出现两个 guest，截图与 CDP 命令随机落到其中一个。

### 3. 通道请求 id 必须唯一且只配对一次

`rpc/channelServer.ts` 为每个请求分配自增 id，响应到达后从 pending 表移除。
不移除会让同一 id 的迟到响应覆盖新请求结果；不复用 id 则 pending 表无限增长。

### 4. Docker 命令必须 argv 数组化

`docker-backend.ts` 全程用 `execFile` + 参数数组，不拼 shell 字符串。
拼字符串后带空格或分号的路径会被解释为额外命令，属于命令注入。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| TTFT 用首字节计时 | 观测值整体偏高，跨版本不可比 |
| 插件宿主重复安装不幂等 | 同一分区两个 guest，命令随机失效 |
| 截图活动计数加减不对称 | 状态栏一直显示“截图中” |
| IPC 不校验 sender 归属 | 任意渲染进程可操作他人浏览器视图 |
| 文件树用下标做 key | 展开态在列表刷新后错位 |
| git 解析硬编码状态字符 | 新状态码出现时整行被丢弃 |
| RPC pending 表不清理 | 长时间运行后内存持续增长 |
| Docker 命令拼 shell 字符串 | 路径含空格或分号时执行失败甚至注入 |
| Finder 工作流重复写 plist | 每次启动都触发一次服务注册 |
| 会话上下文不截断 | 超长结果把对话面板撑爆 |
| CUA 授权校验 fail-open | 未授权也放行自动化操作 |
| 浏览器命令无 deadline | 页面卡住时命令永久挂起 |

## 顺延

B52 复算清单共 20 个候选，本批按同类同目录取 12 个，其余 8 个顺延到 B53，开工前用更新后的工作树重新测量后确定：

- `apps/zcode-cli/packages/i18n/src/types.ts`（89）
- `packages/stream-animate/src/server/deepseekRunner.ts`（88）
- `apps/zcode-cli/packages/bootstrap/src/plugins.ts`（86）
- `packages/e2e-report/src/viewer/App.tsx`（86）
- `apps/zcode-cli/packages/node-repl-host/src/server.ts`（84）
- `apps/zcode-cli/packages/adapters/src/mcp/index.ts`（83）
- `packages/zcode-server-cli/src/server-core/http.ts`（83）
- `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts`（77）

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.23%~31.54%。
