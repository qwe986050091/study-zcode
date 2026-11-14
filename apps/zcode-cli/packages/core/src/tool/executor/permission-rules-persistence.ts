// 权限规则的读取、持久化与授权后的落定（从 permission-flow.ts 拆出）。
// 拆分原因：permission-flow.ts 引入 responder 竞速后超过单文件 400 行上限；这里的 helper 只与
// 规则存取内聚（project 级写 sessionStore、会话级进内存 ruleset），与 ask 时序无关。确认窗的设置调整
// 让 permission-flow.ts 再次逼近上限时，授权应答里的规则更新整段也搬了过来（行为不变）。
//
// 作用域不变量：project 级规则（permissionUpdates）写 sessionStore，跨会话生效；
//   会话级（sessionPermissionUpdates）只进 PermissionService 内存，重启/冷恢复即失效。
// 失败语义：读失败在调用方（permission-flow）转 StorageError 并拒绝执行；写盘失败返回工具失败结果，
//   绝不"当作什么都没发生"继续跑——用户选的"始终允许"没记住，属于可感知的失败。
import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type PermissionRuleset,
  type PermissionUpdate,
  type ProjectId,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { applyPermissionUpdates } from "./permission-rules.js";
import type { ToolExecutorDeps } from "./types.js";

/**
 * 读取当前 session 生效的规则集：session 自带 scope="session" 时用它，否则回落到 project 记录。
 * 无 sessionStore（测试/嵌入式）返回 null，等价于"没有项目规则"，由调用方照常判定。
 * 只读、不缓存：每次权限判定都现读，保证同一 turn 内规则变更立即可见；异常向上抛（调用方 fail-closed）。
 */
export async function loadProjectPermissionRuleset(
  deps: ToolExecutorDeps,
): Promise<PermissionRuleset | null> {
  // 可选端口缺席：没有持久规则来源，不是错误。
  if (!deps.sessionStore) return null;
  const session = await deps.sessionStore.getSession(deps.sessionId);
  // 群协作任务的记忆授权只活在会话记录里，优先于 project 规则。
  if (session?.permission?.scope === "session") return session.permission;
  if (!session?.projectID) return null;
  return deps.sessionStore.getProjectPermission(session.projectID);
}

/**
 * 把"始终允许"的规则增量写盘。scope="session" 的会话写回 session 记录；
 * 否则写 project 记录（找不到 projectID 时只警告并跳过，不能凭空造项目）。
 * 只增不删，合并走 applyPermissionUpdates；副作用是 session store 写 + 日志。
 * 异常向调用方传播，由 applyGrantedPermissionUpdates 统一转成工具失败结果。
 */
export async function persistProjectPermissionUpdates(
  deps: ToolExecutorDeps,
  updates: PermissionUpdate[],
  traceContext: TraceContext,
): Promise<void> {
  // 空增量不落盘：避免无意义的存储写与日志噪音。
  if (updates.length === 0) return;

  // 注意：无 sessionStore 时这里只 warn 并跳过（测试/嵌入式场景的既有语义），
  // 用户会以为"记住了"但其实没有写；调用方仍继续执行本次已批准的调用。
  if (!deps.sessionStore) {
    deps.logger?.warn("Project permission update skipped without session store", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const session = await deps.sessionStore.getSession(deps.sessionId);
  if (session?.permission?.scope === "session") {
    await deps.sessionStore.updateSession({
      id: deps.sessionId,
      permission: applyPermissionUpdates(session.permission, updates),
    });
    return;
  }
  const projectID = await resolveProjectId(deps);
  // 会话没绑定项目就不写：规则需要一个稳定归属，不能按"当前目录"猜一个。
  if (!projectID) {
    deps.logger?.warn("Project permission update skipped without persisted session", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  // 项目尚无规则时从空版本 1 起，与 PermissionRuleset 的默认口径一致。
  const current = (await deps.sessionStore.getProjectPermission(projectID)) ?? { version: 1 };
  const next = applyPermissionUpdates(current, updates);
  await deps.sessionStore.saveProjectPermission({ projectID, permission: next });

  deps.logger?.info("Project permission updated", {
    ...traceContextToLogContext(traceContext),
    event: "tool.permission.project_update.saved",
    module: "core.tool.executor",
    status: "completed",
    updateCount: updates.length,
  });
}

/**
 * 授权应答里的规则更新：先把项目级规则写盘，再把会话级规则放进内存 ruleset。写盘失败即返回工具失败
 * 结果（用户选的「始终允许」没能记住，不能当作什么都没发生），此时会话级规则也不落。
 */
export async function applyGrantedPermissionUpdates(options: {
  deps: ToolExecutorDeps;
  permissionUpdates: PermissionUpdate[] | undefined;
  requestId: string;
  sessionPermissionUpdates: PermissionUpdate[] | undefined;
  toolCall: ExecutableToolCall;
  traceContext: TraceContext;
}): Promise<ToolExecutionResult | undefined> {
  const { deps, permissionUpdates, requestId, sessionPermissionUpdates, toolCall, traceContext } =
    options;
  if (permissionUpdates?.length) {
    try {
      await persistProjectPermissionUpdates(deps, permissionUpdates, traceContext);
    } catch (error) {
      // 写盘失败即工具失败：用户选了"始终允许"却没记住，不能假装成功继续执行。
      return createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to persist project permission update", {
          cause: error instanceof Error ? error : undefined,
          context: {
            requestId,
            sessionId: deps.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          },
          recoverable: true,
        }),
      );
    }
  }

  if (sessionPermissionUpdates?.length) {
    // 会话免确认（docs/dynamic-workflow/launch.md「Always allow in this session」）：只进内存里的会话 ruleset，
    // 与上面的项目级持久化互不可见。
    deps.permissionService.grantSessionPermission(sessionPermissionUpdates);
    deps.logger?.info("Session permission granted", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.session_grant.applied",
      module: "core.tool.executor",
      requestId,
      status: "completed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      updateCount: sessionPermissionUpdates.length,
    });
  }
  // undefined = 没有失败；调用方据此继续执行 handler。
  return undefined;
}

/** 从持久 session 读 projectID；无 store/session 时 undefined（后续按"跳过持久化"处理）。 */
async function resolveProjectId(deps: ToolExecutorDeps): Promise<ProjectId | undefined> {
  const session = await deps.sessionStore?.getSession(deps.sessionId);
  return session?.projectID;
}
