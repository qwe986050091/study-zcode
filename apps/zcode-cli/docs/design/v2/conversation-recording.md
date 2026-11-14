# 完整对话记录（Conversation Recording）

## 背景与目标

默认的 `model-io` 日志是诊断用途：生产环境会裁剪请求体、按 delta/tail 压缩上下文，并按文件大小重置；SessionEvent 默认只存在内存 event store。需要排查或留档时，用户无法拿到「这次运行里模型实际收到了什么、返回了什么」。

本能力提供一个显式开关：开启后，把一次运行中和模型交互的全部内容按 session 落盘为两份 JSONL：

- `capture.jsonl`：provider 实际 HTTP 请求/响应，包括头部、请求体、响应体。
- `events.jsonl`：runtime 发出的全部 SessionEvent。

目标是可人工阅读、可被工具逐行消费，不承担训练数据流水线、上传或长期存储治理。

## 开关与优先级

有两种开启方式：

- CLI：`--record-conversation` 开启；`--record-conversation-dir <dir>` 同时开启并指定输出根目录。这两个参数作用于 `-p/--prompt` 与 TUI；`app-server` / `agent-server` 由客户端会话创建，使用配置文件开关。
- 配置文件（`~/.zcode/cli/config.json`）：

  ```json
  {
    "recording": {
      "conversation": {
        "enabled": true,
        "dir": "~/zcode-recordings"
      }
    }
  }
  ```

优先级从高到低：

1. CLI 显式开关（`--record-conversation-dir` 视为开启）。
2. 配置 `recording.conversation.enabled`。
3. 默认关闭。

`dir` 的解析顺序：CLI `--record-conversation-dir` > 配置 `recording.conversation.dir` > `<storage.dir>/cli/conversation`（默认 `~/.zcode/cli/conversation`）。路径按现有配置路径规则展开 `~`。

会话恢复、fork、子代理和 workflow 子会话沿用同一个根目录。

## 落盘布局

```text
<rootDir>/<sessionId>/capture.jsonl
<rootDir>/<sessionId>/events.jsonl
```

- 每个 sessionId 一个目录；子代理、workflow child 按自己的 sessionId 分目录。
- `sessionId` 只保留 `[a-zA-Z0-9_-]`，其它字符折叠为 `-`；缺失时使用 `no-session`。
- 文件采用追加写入；运行中不生成汇总 JSON，避免长会话在内存中聚合。

## capture.jsonl 记录格式

每个**物理** provider HTTP 请求一行，成功、失败、重试、compact 回退、鉴权刷新后的重新请求都单独成行。

```json
{
  "type": "provider_exchange",
  "capturedAt": "2026-10-29T10:00:00.000Z",
  "completedAt": "2026-10-29T10:00:01.234Z",
  "durationMs": 1234,
  "sessionId": "sess_xxx",
  "traceId": "trace_xxx",
  "turnId": "turn_xxx",
  "providerId": "openai",
  "modelId": "gpt-5",
  "request": {
    "method": "POST",
    "url": "https://api.example.com/v1/responses",
    "headers": { "authorization": "Bearer ..." },
    "body": "{...}"
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "text/event-stream" },
    "body": "data: {...}\\n\\n"
  }
}
```

- `request.body` 是 option map / 兼容层处理后的实际发送体，不是 runtime 的 canonical messages。
- `response.body` 是原始响应文本；流式响应对 `Response.clone()` 完整读取后写入，因此在流结束时才落行。
- 请求抛出（网络错误、abort 等）时没有 `response`，改为 `error: { name, message, stack }`。
- 字段缺失时省略；不得用占位内容伪造请求/响应。

## events.jsonl 记录格式

每个 SessionEvent 一行，内容为该事件在 event store 补号并发布后的完整 JSON（字段沿用 `logging.md`：`id`、`sessionId`、`turnId`、`traceId`、`sequenceNumber`、`type`、`timestamp`、`payload`）。

覆盖范围为主 runtime 的全部 sink 通知：模型请求/完成、流式事件、工具事件、compact、权限、subagent 原始事件和 workflow child 转发事件。按事件自身的 `sessionId` 写入对应目录。

## 内容与安全约束

本能力是用户显式选择的**原始记录**模式：

- 不脱敏请求/响应 header，Authorization、API Key、Cookie 等会原样写入。
- 不裁剪消息、system prompt、tool schema/结果和 reasoning 文本。
- 图片、视频、PDF 等 base64/dataURL 原样写入。
- 不按文件大小或会话数做轮转；磁盘占用由用户自行管理。

因此输出目录必须按敏感数据处理，不应提交到仓库、共享目录或公开环境。CLI help 与文档必须明确这一点。

## 失败语义

- 记录是旁路行为：任何记录失败（目录不可写、序列化失败、磁盘满）都不得影响模型请求、事件发布、turn 生命周期或进程退出码。
- 写入按文件串行排队，保持行顺序；同一 session 的 capture 与 events 各自独立队列。
- App 关闭时 await 记录队列 flush；flush 失败只记日志。
- 记录失败使用 `warn` 级别日志，字段包含 `event: "conversation_recording.write_failed"`、路径和错误信息；不重复刷屏。

## 非目标

- 不抓取 MCP、WebFetch、Bash 等非模型网络流量。
- 不替代 `model-io` 诊断日志，也不改变其裁剪/保留策略。
- 不提供上传、加密、轮转、索引或脱敏后导出；需要这些能力时在外围工具处理。
- 不在 `ZCODE_RUNTIME_ENV=test` 下做特殊屏蔽：本能力只在显式开启时写盘，单测默认不触发。

## 验收场景

1. `--record-conversation -p "..."` 在默认根目录生成 `<sessionId>/capture.jsonl` 与 `events.jsonl`；capture 行含原始 header 与响应体，events 行覆盖 model_request/model_complete。
2. `--record-conversation-dir <dir>` 覆盖默认根目录，且未显式给 `--record-conversation` 也视为开启。
3. 配置 `recording.conversation.enabled=true` 时不加 CLI 参数也会记录；CLI 开关优先级高于配置。
4. 一次包含重试/compact 回退的运行中，每次物理请求都有独立 capture 行。
5. 记录目录不可写时，模型请求与 turn 正常完成，日志出现一条 `conversation_recording.write_failed`。
6. 未开启时，不创建目录、不写任何文件，行为与当前版本一致。
