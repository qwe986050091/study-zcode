# conversation-recording

完整对话记录的 provider 原始交换与 SessionEvent 落盘。

模块存在的意图：把「模型实际收到/返回了什么」从 runtime canonical 消息和会被裁剪的 model-io 日志里分离出来，提供一条显式开启、原始、逐行的旁路记录。行为规格见 `apps/zcode-cli/docs/design/v2/conversation-recording.md`。

不变量：

- `createConversationCaptureFetch` 只包装 provider fetch，读取 `Response.clone()`，不改变返回给 AI SDK 的响应、流顺序或错误传播。
- 记录不得阻塞或失败模型请求；任何写入/序列化错误只记日志。
- 同一文件的写入按调用顺序串行排队；`close()` 只等待当前队列。
- 原始记录模式不脱敏 header、消息与媒体 base64；调用方必须把输出目录当敏感数据处理。
- sessionId 只用于目录分段，必须经过字符过滤，不能逃出 rootDir。

与其它模块的交集：

- adapters 的 model execution 在 option map 之后包装 fetch，因此记录的是 provider 实际发送体。
- bootstrap 的 `conversation-recording-app` 负责开关/目录解析与 event sink 组合，不直接写文件。
