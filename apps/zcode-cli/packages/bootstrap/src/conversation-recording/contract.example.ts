/**
 * conversation-recording-app 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SessionEventSink } from "@zcode/contracts";
import type { ConversationRecordingWiringContract } from "./contract.js";

/**
 * 最小接线样例：cliEnabled=true 而 config.enabled=false 时仍应创建 recorder，
 * 验证「CLI 开关优先于配置」这条优先级；随后把 recorder 与宿主 sink 合并。
 */
export function exampleConversationRecordingApp(
  wiring: ConversationRecordingWiringContract,
  hostSink: SessionEventSink | undefined,
): SessionEventSink | undefined {
  const recorder = wiring.resolveRecorder({
    cliEnabled: true,
    cliDir: "~/zcode-recordings",
    cliStorageRoot: "~/.zcode/cli",
    config: { enabled: false },
  });
  return wiring.composeEventSink(hostSink, recorder);
}
