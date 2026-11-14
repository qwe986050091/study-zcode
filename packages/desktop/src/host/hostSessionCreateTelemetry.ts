// 会话创建（session_create）埋点的 Host 旁路上报。
//
// 职责：在「实际新建会话并完成首发 admission」的分支上组装 AutomationSessionCreateTelemetry
// 事件并 postMessage 给 main；不从恢复订阅推断创建，避免把续跑计入新建。
// 输入输出：输入 port（可为 null）与 sessionId / messageId / create_source /
// workspaceIdentity；输出 void。
// 副作用：一次 postMessage；读取 Intl 时区与语言。
// 失败语义：整体 try/catch——上报失败只丢旁路事件，不能把已 accepted 的派发误判为失败。
// 维护的不变量：client_kind 固定 desktop；workspace 维度由 resolveWorkspaceTelemetryDetail
// 统一产出，不在本文件自行拼接。

import {
  HostResponseTypes,
  resolveWorkspaceTelemetryDetail,
  type AutomationSessionCreateTelemetry,
} from "@zcode/shared";

// 上报一次会话创建。
// port 为 null 时静默跳过（无 parentPort 的调试环境）；事件字段固定 eventType=result，
// talkId 复用 sessionId 以便与 session 侧事件 join。
// 失败语义：任何异常（含 Intl 不可用）都被吞掉，不影响调用方派发结果。
/** 仅实际新建并完成首发 admission 的派发分支调用；不从恢复订阅推断创建。 */
export function reportHostSessionCreate(
  port: { postMessage(message: unknown): void } | null | undefined,
  input: {
    sessionId: string;
    messageId: string;
    source: AutomationSessionCreateTelemetry["eventExtraDetail"]["create_source"];
    workspaceIdentity?: string;
  },
): void {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const event: AutomationSessionCreateTelemetry = {
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      talkId: input.sessionId,
      messageId: input.messageId,
      context: {
        clientTimezone: locale.timeZone,
        clientLanguage: locale.locale,
        screenResolution: "",
      },
      eventExtraDetail: {
        create_source: input.source,
        client_kind: "desktop",
        ...resolveWorkspaceTelemetryDetail(input),
      },
    };
    port?.postMessage({ type: HostResponseTypes.SessionCreateTelemetry, event });
  } catch {
    // Main 已退出或 IPC 不可用时丢弃本次旁路上报，不能把 accepted 派发误判为失败。
  }
}
