// INV-01 每个方法先握手再请求：守住位置 七个方法首行；改错故障 首次调用被服务端拒绝。
// INV-02 工作区字段整体展开：守住位置 各方法的 workspace 展开；改错故障 身份缺失后跨区读错数据。
// INV-03 可选参数按存在性展开：守住位置 六处条件展开；改错故障 未提供的字段以 undefined 下发。
// INV-04 只做参数搬运不做校验：守住位置 方法体结构；改错故障 出现第二套默认值口径。
// INV-05 返回值类型与协议一一对应：守住位置 方法签名；改错故障 上层拿到未声明的形状。
// INV-06 artifact 读面与 run 读面分开：守住位置 方法分组；改错故障 把用户产物当 run 顶层返回值。
// INV-07 artifactRead 必须带版本与区间：守住位置 入参映射；改错故障 读到错误的版本片段。
// INV-08 节点结果按 siteId 与序号定位：守住位置 workflowRunNodeResult；改错故障 取错节点的 transcript。
// INV-09 依赖通过闭包显式注入：守住位置 工厂入参；改错故障 直接 import 服务造成循环依赖。
// INV-10 本文件不持有状态：守住位置 无模块级变量；改错故障 握手状态在多个会话间串扰。
// INV-11 拆分只为行数约束：守住位置 文件头注释；改错故障 行为被误当作有意的语义变更。
//
// 模块职责：createAgentConversationTransport 的 workflow-run 只读查询面。
// 阅读顺序：先看工厂入参与握手，再看 events 与 runs，最后看 artifact 三面与节点结果。
// createAgentConversationTransport 的 workflow-run 查询面。拆分原因：主文件受
// eslint max-lines(400) 约束，主文件与分支增量叠加超限，
// 按查询面边界把 dwf journal 的两个只读查询拆到本文件（闭包依赖显式传入，行为不变）。
import type { IZCodeAgentService } from "@zcode/services";
import type {
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";

// 依赖全部来自入参，便于主文件按需拼装并保持无环。
// agentService 只取用到的七个方法，缩小耦合面。
// workspace 是值对象，展开时随每次请求一起带上。
export function createWorkflowRunTransportMethods(input: {
  agentService: Pick<
    IZCodeAgentService,
    | "conversationWorkflowRunEventsV4"
    | "conversationWorkflowRunsV4"
    | "conversationWorkflowRunArtifactsV4"
    | "conversationWorkflowRunArtifactDataV4"
    | "conversationWorkflowRunArtifactReadV4"
    | "conversationWorkflowRunWorkspaceV4"
    | "conversationWorkflowRunNodeResultV4"
  >;
  ensureHandshake: () => Promise<unknown>;
  workspace: { workspacePath: string; workspaceIdentity?: string };
}) {
  const { agentService, ensureHandshake, workspace } = input;
  return {
    // 事件查询按 afterSequence 增量拉取，不传则从头。
    // limit 为空时不下发键，交给服务端默认值。
    // 握手必须在请求前完成，失败会向上抛出。
    async workflowRunEvents(
      params: V4ConversationWorkflowRunEventsParams,
    ): Promise<V4ConversationWorkflowRunEventsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunEventsV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    // 会话级 run 列表只接受 limit，分页由调用方推进。
    // 返回顺序以服务端为准，这里不做二次排序。
    async workflowRuns(
      params: V4ConversationWorkflowRunsParams,
    ): Promise<V4ConversationWorkflowRunsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunsV4({
        ...workspace,
        sessionId: params.sessionId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    // dwf 用户面产物的三条读面。
    // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是 run 的顶层返回值。
    // 术语区分：`artifact` 属于产物面，`workflowRun` 的顶层返回值不含这一层。
    // 列表查询不需要版本号，只按 run 维度取。
    // 这里只搬运 sessionId 与 runId，不做额外过滤。
    async workflowRunArtifacts(
      params: V4ConversationWorkflowRunArtifactsParams,
    ): Promise<V4ConversationWorkflowRunArtifactsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactsV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
      });
    },
    async workflowRunArtifactData(
      params: V4ConversationWorkflowRunArtifactDataParams,
    ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactDataV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    // 读取必须同时给出 artifactId、version 与字节区间。
    // offset 与 limit 是必填的，缺一个都会读到错误片段。
    // 区间裁剪不在 `workflowRunArtifactRead` 做：`offset` 与 `limit` 的校验归服务端。
    async workflowRunArtifactRead(
      params: V4ConversationWorkflowRunArtifactReadParams,
    ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactReadV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        version: params.version,
        offset: params.offset,
        limit: params.limit,
      });
    },
    // dwf 脚本 transcript 的两条读面。
    async workflowRunWorkspace(
      params: V4ConversationWorkflowRunWorkspaceParams,
    ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunWorkspaceV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
      });
    },
    // 节点结果按 siteId 加序号定位，两者缺一不可。
    // maxBytes 为空时不下发，由服务端决定默认上限。
    // 返回值是节点 transcript 片段，不是整份 run 输出。
    async workflowRunNodeResult(
      params: V4ConversationWorkflowRunNodeResultParams,
    ): Promise<V4ConversationWorkflowRunNodeResultResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunNodeResultV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        siteId: params.siteId,
        ordinal: params.ordinal,
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      });
    },
  };
}
