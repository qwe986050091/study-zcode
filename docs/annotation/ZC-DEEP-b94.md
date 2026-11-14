# ZC-DEEP-b94

> 批次：B94（6 文件，按 31.4% 口径计算目标 314 行，实际 +314）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b94\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b94
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=314

node check-batch.mjs ZC-deep-b94 ZC-deep-b94-files.txt
TOTAL added=314 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28  266  195   61  52  packages/ui/src/root/oauthProviderFamilySelectionRefresh.ts
31.28  276  195   61  51  packages/ui/src/v4/ConversationUserInputContent.tsx
31.41  253  191   60  51  packages/ui/src/v4/V4ChatPane.tsx
31.58  259  190   60  53  packages/ui/src/settings/SettingsPageParts.tsx
31.60  366  250   79  54  packages/ui/src/v4/replaceableConversationTransport.ts
31.61  265  193   61  53  packages/ui/src/v4/telemetry/useSessionOpenArmsTelemetry.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.28 median=31.50 newComments=314
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `v4/replaceableConversationTransport.ts` | 换代期传输门面 | INV-01~18；身份稳定；订阅归属；释放不阻塞；迟到确认 | 54 |
| `v4/telemetry/useSessionOpenArmsTelemetry.ts` | 会话打开埋点 | INV-01~18；一次一组；超时兜底；冷热归因；绘制后结算 | 53 |
| `v4/ConversationUserInputContent.tsx` | 用户输入消息渲染 | INV-01~18；只认入口确认；原文可回退；插件不成链 | 51 |
| `v4/V4ChatPane.tsx` | 竖切聊天区入口 | INV-01~18；单一面板；上下文先行；透传不改写 | 51 |
| `settings/SettingsPageParts.tsx` | 设置页通用部件 | INV-01~18；列宽统一；预览隔离；两列网格；可达性 | 53 |
| `root/oauthProviderFamilySelectionRefresh.ts` | 登录后家族连接刷新 | INV-01~18；家族归一；未知保护；条件写入；已存优先 | 52 |

合计 **314**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 换代时应先解绑再释放

`replaceableConversationTransport.ts` 的顺序是解除旧监听、再取消它名下的订阅。
反序会让旧代理在释放期间继续把帧推给同一个监听集合。

### 2. 迟到确认必须重新核对代理

`subscribe` 返回后要比较发起时的代理与当前代理。
只写回归属表会让过期订阅占住新代理的订阅标识。

### 3. 打开埋点一次只上报一组

`useSessionOpenArmsTelemetry.ts` 以已结算标记封口。
缺这一道，绘制回调与超时计时器会各报一次。

### 4. 成功需要活跃且快照匹配

仅凭会话标识命中会把重连时保留的旧快照判成新会话成功。
必须先看连接状态，再比快照会话。

### 5. 用户输入只认发送入口确认

`ConversationUserInputContent.tsx` 只对首个权威目标标记使用特殊界面。
按文本包含关系重猜，会把隐藏上下文块误画成控制命令。

### 6. 条件写入用查询前的版本

`oauthProviderFamilySelectionRefresh.ts` 在发起请求前快照设置。
用回包后的设置当预期值，等于放弃版本约束。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 换代先释放后解绑 | 旧代理继续向同一监听集合推帧 |
| 取消订阅失败即抛 | 断线换代中断，面板永久卡在旧连接 |
| 迟到确认直接写入 | 过期订阅占住新代理标识 |
| 命令发往旧代理 | 远端任务归属字段为空 |
| 监听末位不解绑 | 卸载后仍回调，内存无法回收 |
| 打开不设已结算 | 同一次打开重复上报 |
| 超时不清理 | 卸载后计时器仍触发上报 |
| 成功只看会话命中 | 重连旧快照被记成新会话成功 |
| 冷热推断反了 | 复用会话被统计成冷启动 |
| 输入内容按包含重猜 | 上下文提示被画成控制命令 |
| 插件标记进文件分支 | 点击插件跳到文件查看器 |
| 面板标识不固定 | 同工作区出现两份归属 |
| 只读开关未透传 | 只读面板出现编辑入口 |
| 预览继承应用主题 | 深浅预览色差明显 |
| 滑块回传字符串 | 下游数值运算得到拼接结果 |
| 权益查询失败即抛 | 登录后刷新整体中断 |
| 刷新失败仍继续 | 用空访问做选择，写坏映射 |
| 条件写入预期用回包值 | 迟到操作覆盖用户新设置 |
| 启动把不可用当失效 | 已保存连接被自动替换 |

## 断点报告（续跑基线）

- 最后完成批次：**B94**（6 文件 / +314 行 / 全绿）；`added=314`、硬校验全 0。
- 累计（core+apps）：**836 文件 / 105,353 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,388 个 coreBelow30 / 36,237 行**，完成度 **74.4%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.28%~31.61%，`suspicious=0`。
