# ZC-DEEP-b97

> 批次：B97（6 文件，按 31.4% 口径计算目标 325 行，实际 +325）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b97\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b97
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=325

node check-batch.mjs ZC-deep-b97 ZC-deep-b97-files.txt
TOTAL added=325 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.15  266  183   57  53  packages/web/src/auth/webAuthService.ts
31.15  245  183   57  53  packages/web/src/web-remote-control/ui/webRemoteControlConnectionSheet.tsx
31.25  249  176   55  53  apps/zcode-cli/packages/cli/src/plugins-command-format.ts
31.41  263  191   60  53  packages/zcode-server-cli/src/packaging/stageDependencies.ts
31.42  420  296   93  54  apps/zcode-cli/packages/core/src/tool/json-schema.ts
34.38  276  192   66  59  packages/provider-node/src/zcode-builtin-remote-synchronizer.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.15 median=31.33 newComments=325
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `cli/src/plugins-command-format.ts` | 插件命令输出格式化 | INV-01~18；诊断分流；空集早退；字段顺序 | 53 |
| `provider-node/src/zcode-builtin-remote-synchronizer.ts` | 内置远端版本同步 | INV-01~18；单飞；租约归属；锁外下载 | 59 |
| `web/src/auth/webAuthService.ts` | Web OAuth 登录编排 | INV-01~18；nonce 先行；单次消费；回跳受限 | 53 |
| `web-remote-control/ui/webRemoteControlConnectionSheet.tsx` | 多连接选择层 | INV-01~18；键集对齐；首行无分割；滚动隔离 | 53 |
| `zcode-server-cli/src/packaging/stageDependencies.ts` | 发行依赖装配 | INV-01~18；可选可缺；首版独占；拒绝宿主产物 | 53 |
| `core/src/tool/json-schema.ts` | 工具契约 Schema 校验 | INV-01~18；双输出；类型短路；元素先于长度 | 54 |

合计 **325**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 同步器在锁外下载，锁内只做租约决议

`zcode-builtin-remote-synchronizer.ts` 把控制文件的读改写全部收在文件锁内，
网络请求放在锁外。若在持锁期间 `fetchRelease`，一个慢请求会让其余进程的
刷新全部排队，dispose 也拿不到锁去中止。

### 2. 租约按 leaseId 归属，不按端点整体接管

`#finishLease` 先比对 endpointKey 与 leaseId，再写回退窗口。
只比端点会让后到进程覆盖先到者刚建立的租约，两个进程同时下载同一版本。

### 3. OAuth 回调必须复用授权时的 provider 与回调地址

`webAuthService.ts` 从 `takePendingLogin` 取回 provider 与 redirectUri。
用默认 provider 重新推导，会让 token 请求打到另一家、或地址与授权时不一致而失败。

### 4. 登录二次回跳只透传 code 与 error

跨源 `return_to` 仅在受信开发域名下生效，且跳转 URL 不携带 token。
把凭证塞进 URL，等于把 token 暴露给第三方源与浏览器历史。

### 5. 发行包只保留目标平台的预编译产物

`stageDependencies.ts` 的 node-pty 白名单只放行 `prebuilds/<target>`，
opentui 系列按目标名过滤。放宽后会把宿主平台的二进制打进目标包，
在另一平台加载即崩。

### 6. 结构化问题与 legacy 文案顺序刻意不同

`json-schema.ts` 的 legacy errors 保持原有文案顺序，issues 按
properties 顺序、且元素问题先于数组长度问题。两者若强行统一，
参数回退序列化后的顺序会与 schema 解析器分叉，模型拿到错位的问题列表。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 刷新在持锁期间下载 | 多进程刷新串行，dispose 卡在锁上 |
| 租约只比端点不比 leaseId | 两个进程同时下载同一版本 |
| 取消也累加失败计数 | 主动销毁后仍长时间无法刷新 |
| 成功不清零失败计数 | 恢复后继续按旧退避等待 |
| 控制文件损坏直接抛错 | 崩溃残留永久阻断刷新 |
| state 解析失败仍继续 | 被篡改的 state 进入 token 交换 |
| 回调不取回 pending provider | token 请求打到错误的 provider |
| 回跳携带 token | 凭证泄漏到第三方源 |
| 白名单放过宿主 build | 目标包内混入错误平台二进制 |
| 复制时保留嵌套 node_modules | 发行包体积倍增且版本冲突 |
| 类型不符仍下钻校验 | 派生错误刷屏，掩盖真实字段 |
| oneOf 命中多个仍通过 | 非法输入进入工具执行 |
| 缺省把 unknown 当对象 | 无 schema 字段被错误要求为对象 |
| 数组长度问题提前生成 | 与解析器顺序不一致，模型纠错错位 |

## 断点报告（续跑基线）

- 最后完成批次：**B97**（6 文件 / +325 行 / 全绿）；`added=325`、硬校验全 0。
- 累计（core+apps）：**854 文件 / 106,297 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,370 个 coreBelow30 / 35,293 行**，完成度 **75.1%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.15%~34.38%，`suspicious=0`。
