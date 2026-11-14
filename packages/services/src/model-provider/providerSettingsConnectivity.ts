// INV-01：凭据解析与 headers 必须由正式执行链负责，本层不消费流，只把已落盘并进入 Registry 的
// ModelSelection 交给目标 Environment 的正式执行链；复用真实链路才能避免「测试通过、实发失败」。
// INV-02：对外永不抛出，所有失败折叠为 success=false + message，UI 不需要包 try/catch。
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsConnectivityTester } from "./providerFacadeServices.js";

interface FormalModelConnectivityInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly selection: {
    readonly providerId: string;
    readonly modelId: string;
  };
}

// 执行器只承诺 success=true，失败必须通过抛错表达，错误码分类留在各 Environment 内部，
// 避免本层复制一份会与执行链漂移的错误映射表。
type FormalModelConnectivityExecutor = (
  input: FormalModelConnectivityInput,
) => Promise<{ readonly success: true }>;

/**
 * 设置页只负责把已经落盘并进入 Registry 的 ModelSelection 交给目标 Environment。
 * Provider 鉴权、headers、reasoning 映射和流消费全部由正式 Model 执行链负责。
 */
export function createProviderSettingsConnectivityTester(dependencies: {
  readonly testModelConnectivity: FormalModelConnectivityExecutor;
}): ProviderSettingsConnectivityTester {
// 每次测试都重新走执行链解析凭据：设置页刚改完 Key 就点测试必须命中新值，不能复用缓存。
  return async (input) => {
    try {
      await dependencies.testModelConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        selection: {
          providerId: input.providerId,
          modelId: input.modelId,
        },
      });
      return { success: true };
// [失败路径] String(error) 兜住非 Error 抛出，保证 UI 始终拿到可展示的 message。
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}

export type { ModelConnectivityResult };
