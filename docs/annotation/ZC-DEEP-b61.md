# ZC-DEEP-b61

> 批次：B61（12 文件，按 31.4% 口径计算目标 840 行；按当前工作树复算，优先同类：`apps/zcode-cli/packages` 5 个（`core` 三处、`dynamic-workflow`、`bootstrap/app`）、`shared` 2 个、`ui` 3 个、`desktop/src/main` 2 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b61\orig`；开工前 12 文件 `newComments=0`（30% 口径缺口 794 行）。

## 校验

```
node zc-verify.mjs ZC-deep-b61
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=840

node check-batch.mjs ZC-deep-b61 ZC-deep-b61-files.txt
TOTAL added=840 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.30   491   345   108   71  apps/zcode-cli/packages/core/src/session-context/read-session-context.ts
31.32   529   380   119   71  apps/zcode-cli/packages/bootstrap/src/app/script-workflow-tool-port.ts
31.37   580   424   133   71  apps/zcode-cli/packages/core/src/hooks/runner.ts
31.39   312   223    70   69  packages/shared/src/subagent-profile-frontmatter.ts
31.39   320   223    70   69  packages/ui/src/lib/sidebarPurposeSectionPreferences.ts
31.42   302   226    71   70  packages/shared/src/gen-ui/contract.ts
31.42   459   331   104   70  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-callbacks.ts
31.47   404   286    90   69  packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts
31.48   355   270    85   71  apps/zcode-cli/packages/dynamic-workflow/src/index.ts
31.48   398   270    85   70  packages/ui/src/components/ai-elements/speech-input.tsx
31.52   370   276    87   71  packages/ui/src/store/pluginManagementStoreLoading.ts
31.60   354   231    73   68  packages/desktop/src/main/desktopDeepLinkUrl.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.30 median=31.42 newComments=840
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `core/hooks/runner.ts` | 工作区钩子执行器 | INV-01~18；事件名必须与 hook.event 全等，matcher 只做二次过滤；hookInvocationId 一次 run 一份；hookRunId 每条 hook 独立；预扫描 admission 只用于剔除与计数；每条 hook dispatch 前重算 admission；hookCount 等于客户端可见且会发事件的钩子数；隐藏 hook 复用内部下标 | 71 |
| `core/tool/handlers/bash-readonly-policy-callbacks.ts` | bash 只读判定回调 | INV-01~20；危险回调 true 即整条不可读；只承接无法用 flag 表穷举的命令；sed 覆盖 `-i`/`-i.bak`/`--in-place`；sed 内 `w` 与 `s///w` 按写文件处理；参数解析跨过 `-e`/`-l` 取值；只把首个非选项参数当脚本；jq 的 `-f`/`--rawfile` 等让过滤器脱离字面量 | 70 |
| `core/session-context/read-session-context.ts` | 会话上下文读取 | INV-01~18；输出固定十项，全量与裁剪同时给；预算夹在 4000~48000；非法预算回落 24000 不抛错；逐条读取失败剔除不中断；model-only 的 user 剔除、assistant 保留；空 part 不进候选；同分才用 index 加权且权重万分之一 | 71 |
| `dynamic-workflow/src/index.ts` | 动态工作流包出口 | INV-01~18；入口只再导出无副作用；顶层导出名是跨包契约；根入口允许带 typescript，浏览器桶不允许；每个符号只有一个来源；类型用 export type 导出；facade d.ts 常量是模型可见 API 唯一事实源；留白 id 按名字铸成 | 71 |
| `bootstrap/app/script-workflow-tool-port.ts` | 脚本工作流工具端口 | INV-01~18；start 返回前必须已登记 running 快照；后台 promise 双回调都写终态；后台 AbortController 独立于 tool call signal；等待路径取消不传播到后台；已 aborted 立即 reject 且不注册监听；abort 监听三出口全清理；来源解析顺序 scriptPath → script → name → resumeFromRunId | 71 |
| `shared/gen-ui/contract.ts` | Gen-UI 协议契约 | INV-01~18；形状全由 zod schema 定义、类型从 schema 推导；每个对象 schema 以 strict 收尾；路径只做线上格式校验，归一化归执行器；拒绝 NUL/换行与 `..` 段；末段必须是小写连字符 html 且以绝对路径开头；reference mode 用枚举；作用域身份 identity 优先 path 兜底 | 70 |
| `shared/subagent-profile-frontmatter.ts` | 子代理 frontmatter 解析 | INV-01~18；BOM 先剥离；首行 trim 后必须全等 `---`；结束分隔符索引必须大于 0；无闭合分隔符整体降级为 body；body 从结束分隔符下一行开始；tools 空值整体删除；mcpServers 的 undefined/null/数组三态不混用 | 69 |
| `ui/store/pluginManagementStoreLoading.ts` | 插件管理加载态 | INV-01~18；加载态是派生结果不承载服务端事实；同服务/工作区/配置层的在途查询只发一次；变更后新查询不复用旧任务；配置层参与去重键分桶；回写前核对上下文；只有最近操作能写错误态；失败保留上次成功数据 | 71 |
| `ui/lib/sidebarPurposeSectionPreferences.ts` | 侧栏分区偏好 | INV-01~18；存储键是唯一持久化契约；分区 id 列表同时是类型来源、默认顺序与白名单；读到的 JSON 一律视为不可信；解析失败/类型不符/存储不可用统一降级默认；未知/重复 id 或长度不符整体作废；来源分组只接受布尔值；规范化后为空折叠为 undefined | 69 |
| `ui/components/ai-elements/speech-input.tsx` | 语音输入组件 | INV-01~18；模式生命周期内只探测一次，三态 speech-recognition/media-recorder/none；探测顺序 SSR 短路→原生→MediaRecorder→none；识别与录音互斥；卸载停识别器与 MediaRecorder 并停全部音轨；清理先解绑再 stop 再置空；识别实例未就绪禁用按钮 | 70 |
| `desktop/src/main/desktopDeepLinkUrl.ts` | 深链 URL 解析 | INV-01~18；协议只认 `zcode:` 精确相等；主机白名单是集合不是前缀；路径归一先剥尾斜杠再补前导；带主机与裸路径两形态结果一致；裸路径先跳过首个空串；hostname 非空且不在白名单立即 false；OAuth 回调只认 `/callback` 一级 | 68 |
| `desktop/src/main/desktopLinuxDeepLinkRegistration.ts` | Linux 深链注册 | INV-01~18；桌面项只在 Linux 写入；AppImage 环境用 APPIMAGE 路径否则用 executablePath；Exec 只持久化 allowlist 参数；allowlist 按出现顺序去重；每个路径词加双引号并转义；末尾固定 `%U`；必须含 MimeType 与 `x-scheme-handler/zcode` | 69 |

合计 **840**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 后台任务不得被父 turn 取消连带杀掉

`script-workflow-tool-port.ts` 给后台任务独立的 AbortController，父 turn 的 signal 只影响等待者。
复用父 signal 会让用户切走对话就中断已在跑的工作流，回来发现任务半途而废。

### 2. 每条 hook 的 admission 必须在 dispatch 前重算

`hooks/runner.ts` 的预扫描只用于剔除与计数，真正派发前逐条重算。
沿用预扫描结果会让运行期间被关闭的钩子继续执行，用户关掉开关却仍在跑脚本。

### 3. 加载态不承载服务端事实

`pluginManagementStoreLoading.ts` 失败时保留上次成功的插件数据，只置 loading=false 并记错误。
把失败写成空列表会让插件市场瞬间清空，用户误以为插件被卸载。

### 4. frontmatter 无闭合分隔符整体降级

`subagent-profile-frontmatter.ts` 找不到结束分隔符时把整段当 body。
强行按首行切分会让子代理配置吃进半截 YAML，启动时字段全为默认值。

### 5. Exec 只持久化 allowlist 参数

`desktopLinuxDeepLinkRegistration.ts` 不把深链 URL、调试端口、工作区路径写进桌面项。
写入会让「用此应用打开」复用一次性的会话参数，之后每次点击都打开同一个旧会话。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 后台任务复用父 signal | 切走对话即中断工作流 |
| hook 沿用预扫描 admission | 关闭开关后仍在跑脚本 |
| 插件加载失败写空列表 | 插件市场瞬间清空 |
| frontmatter 无闭合仍强切 | 子代理配置字段全默认 |
| Exec 写入一次性 URL | 每次点击打开同一旧会话 |
| sed `-i.bak` 未识别 | 只读模式实际改写用户文件 |
| 预算 NaN 未回落 | 上下文裁剪算出负长度、崩溃 |
| 包出口改名 | 跨包调用方编译期断裂 |
| 去重键漏配置层 | user 与 workspace 结果互相覆盖 |
| 偏好键改名 | 全部用户侧栏布局被重置 |
| 语音组件卸载不停音轨 | 麦克风指示灯常亮 |
| 深链协议用前缀匹配 | `zcodeevil:` 也能唤起应用 |

## 顺延

B61 复算清单共 20 个候选，本批取 12 个，其余顺延到 B62，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.30%~31.60%，`suspicious=0`。
