// RPC 日志分级（debug / info / warn）。
//
// 职责：按消息内容给 Host 侧 RPC 日志一个最小分级，避免统一按 error 记录时「看起来所有
// RPC 都失败」；本文件只决定级别，不负责输出。
// 输入输出：输入日志消息与可选参数；输出 "debug" | "info" | "warn"，纯函数。
// 副作用：无。
// 失败语义：不抛出；未命中规则一律 info，未知格式不会被误报为 warn。
// 维护的不变量：只有明确的 ` FAIL ` 才升级到 warn；带 PROVIDER_NOT_READY 错误码的启动握手
// 失败视为 info，防止每个 workspace 都留一条假告警。

import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";

type RpcLogLevel = "debug" | "info" | "warn";

// 解析一条 RPC 日志的级别。
// backgroundBashOutputV4 每秒轮询成功一次，成功日志降为 debug 以免刷屏，但失败仍按 FAIL 规则。
// getWorkspaceRuntimeIdentity 的 provider-not-ready 失败属于启动握手状态（registry 稍后才同步），
// 只在参数里确实带该错误码时降为 info；其他 FAIL 一律 warn。
/**
 * host 之前把 RPC 日志统一走 error，主日志里看起来像所有 RPC 都失败了。
 * 这里按消息内容做最小分级：FAIL 记 warn，高频输出轮询成功记 debug，其余记 info。
 */
export function resolveRpcLogLevel(message: string, ...args: unknown[]): RpcLogLevel {
  // 后台详情每秒读取一次，成功日志会持续落盘；只降低该查询的成功级别，保留失败诊断。
  if (message.startsWith("[rpc:call] zcode-agent.backgroundBashOutputV4 OK (")) return "debug";

  // workspace 首次绑定时，provider registry 会在 runtime identity 查询之后同步；
  // 这个明确带错误码的失败是启动握手状态，不是服务降级，避免每个 workspace 都留下一条 warn。
  if (
    message.includes("zcode-session.getWorkspaceRuntimeIdentity FAIL") &&
    args.some(
      (arg) =>
        typeof arg === "object" &&
        arg !== null &&
        "code" in arg &&
        (arg as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
    )
  ) {
    return "info";
  }

  return message.includes(" FAIL ") ? "warn" : "info";
}
