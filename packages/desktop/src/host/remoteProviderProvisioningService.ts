// Window Host 私有的 Provider 配置「本地 → 远端」同步执行器。
//
// 职责：读取本地 provider provisioning envelope，调用远端
// providerProvisioningTargetService.apply 完成跨 Environment 的凭据写入，并把结果收敛成
// ProviderProvisioningResult。
// 输入输出：输入 source/target；输出 { syncLocalToRemote }，返回带 syncId / status /
// counts / errorCode / rolledBack 的结果对象（永不 reject）。
// 副作用：读取本地凭据并向远端写入——因此执行器只挂在 WeakMap 上，不随 ServiceCollection
// 暴露给 Renderer RPC。
// 失败语义：缺 source/target → unsupported(capability-unavailable)；读本地失败 →
// source-read-failed；调远端失败 → target-call-failed；远端返回未知阶段码 → target-apply-failed。
// 维护的不变量：成功结果不带诊断字段（未知 errorCode 会让 Main 丢弃已成功的回包）；
// 远端自由文本错误码必须经本地 allowlist 校验后才透传。

import { randomUUID } from "node:crypto";
import {
  providerProvisioningErrorCodeSchema,
  type ProviderProvisioningResult,
  type ProviderProvisioningErrorCode,
} from "@zcode/shared";
import type { IProviderProvisioningTargetService, IServiceAccessor } from "@zcode/services";
import {
  getProviderProvisioningSource,
  type ProviderProvisioningSource,
} from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";

// 执行器合约：只有一个动作，且必须以结果对象表达失败（不抛错，Main 依赖稳定回包）。
export interface RemoteProviderProvisioningExecutor {
  syncLocalToRemote(): Promise<ProviderProvisioningResult>;
}

const executors = new WeakMap<ServiceCollection, RemoteProviderProvisioningExecutor>();

// 从 collection 取执行器；不存在返回 undefined（该窗口不是 Desktop Host 或未注册）。
// 用 WeakMap 键控 collection：窗口销毁后执行器自然不可达，无需显式注销。
/** Window Host 私有执行能力；不会随 ServiceCollection 暴露到 Renderer RPC。 */
export function getRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
): RemoteProviderProvisioningExecutor | undefined {
  return executors.get(services);
}

// 注册执行器：覆盖同一 collection 的旧值（重复注册视为替换，不叠加）。
export function registerRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
  executor: RemoteProviderProvisioningExecutor,
): void {
  executors.set(services, executor);
}

// 创建执行器：source/target 都在构造时固定，sync 期间不再解析（避免中途换连接）。
// syncId 每次新建，用作远端幂等键与回包关联；错误码初始为 source-read-failed，
// 读成功后立刻切到 target-call-failed，保证 catch 分支能准确归因。
// 失败语义：全部转成 failed 结果（rolledBack=true），不抛出。
export function createRemoteProviderProvisioningExecutor(options: {
  source?: ProviderProvisioningSource;
  target?: IProviderProvisioningTargetService;
}): RemoteProviderProvisioningExecutor {
  const syncLocalToRemote = async (): Promise<ProviderProvisioningResult> => {
    const syncId = randomUUID();
    if (!options.source || !options.target) {
      return unsupportedResult(syncId, "Local/Remote Provider Provisioning capability 不可用");
    }
    let errorCode: ProviderProvisioningErrorCode = "source-read-failed";
    try {
      const envelope = await options.source.read(syncId);
      errorCode = "target-call-failed";
      const { errorCode: remoteErrorCode, ...result } = await options.target.apply(envelope);
      // 成功结果不携带诊断字段，避免未知错误码使 Main 丢弃本已成功的回包。
      if (result.status === "applied" || result.status === "already-applied") return result;
      // 旧目标没有阶段码，任意远端也可能返回自由文本；只能透传本地 allowlist。
      const parsedCode = providerProvisioningErrorCodeSchema.safeParse(remoteErrorCode);
      return { ...result, errorCode: parsedCode.success ? parsedCode.data : "target-apply-failed" };
    } catch (error) {
      return {
        syncId,
        status: "failed",
        personalProviderCount: 0,
        credentialCount: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode,
        rolledBack: true,
      } satisfies ProviderProvisioningResult;
    }
  };

  return { syncLocalToRemote };
}

// 从 workspace 连接派生执行器：source 来自本机 collection，target 来自远端连接 accessor。
// sourceServices 缺失时为 undefined，sync 会返回 unsupported 而不是误读本地凭据。
export function createRemoteProviderProvisioningExecutorFromWorkspace(options: {
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
}): RemoteProviderProvisioningExecutor {
  const source = options.sourceServices
    ? getProviderProvisioningSource(options.sourceServices)
    : undefined;
  const target = (
    options.connectionServices as IServiceAccessor & {
      providerProvisioningTargetService?: IProviderProvisioningTargetService;
    }
  ).providerProvisioningTargetService;
  return createRemoteProviderProvisioningExecutor({ source, target });
}

// 构造「能力不可用」结果：status=unsupported、rolledBack=false（未发生任何写入）。
// 用于 source/target 缺失，保持与失败结果的字段形状一致，便于 Main 统一处理。
function unsupportedResult(syncId: string, errorMessage: string): ProviderProvisioningResult {
  return {
    syncId,
    status: "unsupported",
    personalProviderCount: 0,
    credentialCount: 0,
    errorMessage,
    errorCode: "capability-unavailable",
    rolledBack: false,
  };
}
