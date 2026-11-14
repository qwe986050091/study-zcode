# ZC-DEEP-b60

> 批次：B60（12 文件，按 31.4% 口径计算目标 859 行；按当前工作树复算，优先同类/同目录：`ui/src` 8 个（`settings/model-provider-section`、`workspace-plugin-preview`、`plugin-ui` 两处、`lib` 两处、`components/ui`、`v4`）、`desktop/src` 4 个（`main`、`host`、`renderer` 两处））。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b60\orig`；开工前 12 文件均为 `newComments=0`（30% 口径缺口 818 行）。
> 本批起目标行数改为 `round(code × 0.314) − 当前注释行`，直接落 31.2%~31.6%，避免 B59 那样的贴线返工。

## 校验

```
node zc-verify.mjs ZC-deep-b60
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=859

node check-batch.mjs ZC-deep-b60 ZC-deep-b60-files.txt
TOTAL added=859 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   316   237    74   72  packages/ui/src/workspace-plugin-preview/WorkspacePluginPreview.tsx
31.27   378   259    81   70  packages/ui/src/lib/fileDisplay.tsx
31.35   364   252    79   70  packages/ui/src/lib/assistantFileReferences.ts
31.35   333   252    79   72  packages/ui/src/plugin-ui/adapters/pluginUiPagePlane.ts
31.39   371   274    86   74  packages/ui/src/settings/model-provider-section/useCodingPlanEntitlements.ts
31.40   343   258    81   70  packages/ui/src/plugin-ui/components/PluginUiLauncherItems.tsx
31.40   452   328   103   72  packages/desktop/src/host/windowHostSessionsIndexObserver.ts
31.40   462   328   103   73  packages/desktop/src/renderer/src/main.tsx
31.41   579   398   125   74  packages/desktop/src/main/resourceManagerWindow.ts
31.45   381   283    89   71  packages/desktop/src/renderer/src/plugin-sandbox/aliasRuntime.ts
31.47   347   251    79   70  packages/ui/src/components/ui/dropdown-menu.tsx
31.60   350   250    79   71  packages/ui/src/v4/ConversationDraftEmptyState.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.22 median=31.40 newComments=859
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/settings/model-provider-section/useCodingPlanEntitlements.ts` | 编码计划权益 hook | INV-01~20；provider 身份由 selection.kind 定团队或个人；未解析出 Account Access 即禁用；cache identity 含 Registry revision 与执行期账号上下文；start 计划可查由 options.enabled 决定；自动刷新决策为纯函数；provider 未加载不刷新；抑制期指纹再挡一次后清空 | 74 |
| `ui/workspace-plugin-preview/WorkspacePluginPreview.tsx` | 工作区插件预览与引用 | INV-01~19；只有已启用且无冲突的插件可引用；mention id 为 plugin 前缀，value 存原始 id；label 取 manifest 原始 name；icon 缺失不写 data；身份 key identity 优先路径兜底再拼远程会话；快照按 workspaceKey 生效；刷新优先复用同工作区最近成功快照 | 72 |
| `desktop/src/main/resourceManagerWindow.ts` | 资源管理器窗口 | INV-01~19；main 侧单实例引用，再次打开只聚焦；采样控制器与窗口同生共死，关闭/崩溃/webContents 销毁汇到同一停止函数；采样只认发起方 webContents；未激活取快照直接抛错；聚合后复审中止信号；整机 CPU 依赖上一样本差分、结果夹 0~100 | 74 |
| `desktop/src/renderer/src/main.tsx` | renderer 引导入口 | INV-01~18；性能时间线清理先于业务渲染登记；T4 只取模块求值时刻；T0-T3 只解析 main 注入 query；启动标记挂 window；主题在首次渲染前落 documentElement；平台标记只描述 Desktop chrome；启动参数一律有默认值；ServicePort 前只渲染启动壳 | 73 |
| `ui/plugin-ui/adapters/pluginUiPagePlane.ts` | 插件 UI 承载平面 | INV-01~18；承载根全文档只建一次且挂在停车容器；同一时刻只有一个锚点拥有表面；可见性回调只在布尔翻转时触发；已挂载 webview 迁移必须走 moveBefore；保留式迁移能力缺失直接失败；选主前重置容器样式；绝对定位按 zoom/滚动/clientTop 换算 | 72 |
| `desktop/src/host/windowHostSessionsIndexObserver.ts` | 会话索引观察者 | INV-01~20；订阅以 window-controller scope 绑 workspace key；existing-only 缺 runtime 降级 dormant 不拉起 Agent；summaries 只发全量；snapshot 整体替换不求并集；cursor 仅在 fromSeq 与本地 seq 连续时推进；增量同帧全应用或全不应用；断档只请求 forceSnapshot；恢复在途不重复发起 | 72 |
| `desktop/src/renderer/src/plugin-sandbox/aliasRuntime.ts` | 插件沙箱别名运行时 | INV-01~18；只做官方 App 薄封装不自实现协议；握手推迟到首次成员访问；同一次运行只握手一次；握手失败只记一次不自动重试；页面自建官方 App 时别名永久让位且不可撤销；工具输入缺失归空对象；结果与元数据分字段；状态变更必触发通知 | 71 |
| `ui/components/ui/dropdown-menu.tsx` | 下拉菜单基础组件 | INV-01~20；open 所有权只在调用方或 Radix；Content 必须包 Portal；align 默认 start、sideOffset 默认 2 是本仓约定；默认值只写在解构处；类名先基线后调用方；宽度不绑触发器宽度；高度用 available-height 且关闭态锁 overflow；菜单层固定 z-[60]；阴影三处带 important | 70 |
| `ui/lib/assistantFileReferences.ts` | 助手文件引用解析 | INV-01~20；citation 区间先于其他通道登记为保护区；保护区间只增不减，相交候选丢弃；结果按 start 升序 end 次升序；同 path 只保留最先入表；区间左闭右开；kind 只能来自定义表或 citation 预览；匹配先清洗再转小写；strip 行列后缀但 raw 保留原文 | 70 |
| `ui/lib/fileDisplay.tsx` | 文件图标与路径展示 | INV-01~18；兜底图标自包含成 data URL；图标前缀只从运行时 BASE_URL 派生；base URL 收敛成恰好一个结尾斜杠；地址固定 `<base>material-icons/<名字>.svg`；默认文档与目录图标模块求值固化一次；目录与文件只看 kind；未知扩展名回落 document；目录路径只在真实出现时给出 | 70 |
| `ui/plugin-ui/components/PluginUiLauncherItems.tsx` | 插件 UI 启动项 | INV-01~18；key 由插件 id 与界面 id 拼成不含序号；前缀固定 `plugin-ui:`；顺序沿用 entries 推荐顺序；草稿态不产生启动项；无可用条目时网格给空态、菜单返回 null；加载态先于空态；骨架固定八格；忙碌态按插件粒度并暴露 aria-busy | 70 |
| `ui/v4/ConversationDraftEmptyState.tsx` | 会话草稿空态 | INV-01~18；问候档位固定 6 个；边界小时表升序且首项 5；分段按时间自早到晚串联；区间左闭右开不留缝；下次换档只取严格晚于当前的边界；明早首边界读表首项；延迟下限恒为 1 毫秒；字号解析为纯函数；手机远控恒用 20px 紧凑档 | 71 |

合计 **859**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 资源管理器窗口单实例

`resourceManagerWindow.ts` 在 main 侧只保留一个实例引用，再次打开只聚焦。
允许并发创建会让两个窗口各自采样，用户看到两份互相矛盾的资源曲线。

### 2. 会话索引 snapshot 整体替换

`windowHostSessionsIndexObserver.ts` 收到 snapshot 时整体替换而不与旧投影求并集。
求并集会让已删除的会话残留在索引里，界面上出现点开即报错的幽灵条目。

### 3. 插件沙箱别名让位不可撤销

`aliasRuntime.ts` 一旦检测到页面已自建官方 App，别名永久让位。
允许撤销会让两套 App 实例同时存在，消息通道被重复注册，插件收到两次响应。

### 4. 承载根挂在停车容器而非锚点内

`pluginUiPagePlane.ts` 把承载根放在停车容器，切换锚点时整体迁移。
挂在锚点内部时切换 tab 会连带销毁 webview，用户看到插件页面反复重载并丢状态。

### 5. 菜单默认值只能写在解构处

`dropdown-menu.tsx` 的 `align` 与 `sideOffset` 默认值只在形参解构处写一次。
在 JSX 里再兜底会让调用方显式传 `0` 被默认值反覆盖，菜单紧贴触发器。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 资源管理器并发建窗 | 两份互相矛盾的资源曲线 |
| 索引 snapshot 求并集 | 幽灵会话条目点开即报错 |
| 别名让位可撤销 | 插件收到两次响应 |
| 承载根挂在锚点内 | 切 tab 后插件页面重载丢状态 |
| 菜单默认值写在 JSX | 显式 0 偏移被覆盖 |
| 权益缓存 identity 缺账号上下文 | 切换账号后仍显示旧套餐 |
| 预览快照不校验 workspaceKey | 切工作区显示上一个库的插件 |
| 采样不校验发起方 | 别的窗口可读取本窗口资源 |
| 时间线 cursor 断档仍推进 | 漏掉增量后索引永久缺项 |
| 文件引用保护区可缩减 | 引用与 citation 区间重叠错乱 |
| 文件图标写死前缀 | 非根部署下图标全丢 |
| 启动项 key 带序号 | 重排后重挂载、动画重现 |
| 空态分段区间首尾相接 | 同刻出现两档问候 |

## 顺延

B60 复算清单共 20 个候选，本批取 12 个，其余顺延到 B61，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；目标行数统一按 `round(code × 0.314) − 当前注释行` 计算，实测密度 31.22%~31.60%。
