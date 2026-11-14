// 职责：读取或恢复「从 Claude 导入的会话」时，为历史缺失的快照做一次幂等回填。
// 边界：本文件只做参数适配与失败降级，真正的历史重建在 importedClaudeHistoryRepair 里；
// 这里不解析历史、不写存储，只把 agentService.createSession 作为依赖注入，重建逻辑由 importedClaudeHistoryRepair 承担。
// 不变量（INV）：调用方拿到的快照不会因修复失败而变化 —— 修复函数返回 null 时原样返回入参，
// 保证 resume 链路在历史损坏时仍能继续，只是历史为空。
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type {
  ZCodeSessionReadParams,
  ZCodeSessionResumeParams,
} from "#src/zcode-session/zcodeSession.js";

// scope 与 zcodeSession 共用同一命名空间，便于按会话维度串起「读取→修复→回填」的日志链路；
// 这里刻意不用 debug：历史异常属于可恢复但需要在生产可见的信号。
const logger = createServiceLogger("zcode-session-service");

// 入参同时接受 resume 与 read 两种目标类型：两者只在 mcpServers 上不同，必须统一取值，
// 否则会演化出两条各自维护的修复入口，多路径会导致状态分叉。
export async function repairEmptyImportedClaudeSessionSnapshot(params: {
  agentService: IZCodeAgentService;
  snapshot: ZCodeSessionStateSnapshot;
  target: ZCodeSessionResumeParams | ZCodeSessionReadParams;
}): Promise<ZCodeSessionStateSnapshot> {
  // 先按 repair 的入参形状适配 target；repair 抛错会向上冒泡，只有返回 null 才走原样返回。
  const repaired = await repairImportedClaudeSessionSnapshot({
    snapshot: params.snapshot,
    target: {
      workspacePath: params.target.workspacePath,
      workspaceIdentity: params.target.workspaceIdentity,
      // repair 侧以 taskId 标识会话，这里把 sessionId 映射过去；字段名不一致是既有接口，不要在此改名。
      taskId: params.target.sessionId,
      // 仅当目标类型带非空 mcpServers 才透传，避免 read 路径传入 undefined 覆盖 repair 的默认处理。
      ...("mcpServers" in params.target && params.target.mcpServers
        ? { mcpServers: params.target.mcpServers }
        : {}),
    },
// 必须复用调用方注入的 agentService 创建会话，而不是直接写状态仓库：创建过程包含
// 生命周期注册与权限上下文，绕过它会产出一个存在但不属于任何 owner 的僵尸 session。
    createSession: (input) => params.agentService.createSession(input),
    onRepair: (history) => {
      logger.warn(
        undefined,
        `[zcode-session-service] Claude 导入 session 历史异常，按 ${history.source} 回填 taskId=${params.target.sessionId}`,
      );
    },
  });
  // 修复失败（null）时原样返回入参快照，resume 链路继续，只是历史为空而非整体报错。
  return repaired ?? params.snapshot;
}
