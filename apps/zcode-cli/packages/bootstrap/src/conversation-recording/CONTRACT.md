# conversation-recording-app

完整对话记录在 App 装配层的开关解析与 event sink 组合。

模块存在的意图：把 CLI 参数、配置优先级和宿主 event sink 的组合规则集中在一处，避免 `create-app` 里出现第二套记录开关或让记录 sink 覆盖宿主 sink。落盘与 provider 捕获属于 `@zcode/adapters` 的 `conversation-recording` 模块。

不变量：

- CLI 开关与目录优先于配置；未启用时返回 `undefined`，不创建目录。
- 记录 sink 与宿主 sink 同时安装；任一失败不吞掉另一个的错误。
- 记录 sink 本身不抛错：记录失败由 adapters 的 recorder 内部处理。
- 本模块不做文件 I/O，也不持有 session 的业务状态。

```text
CLI/config → resolveRecorder → runtime/model adapter
                            └→ composeEventSink(hostSink, recorder)
```
