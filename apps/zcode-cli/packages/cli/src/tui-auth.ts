// TUI 认证适配层：把 TUI 的登录/登出/配置 API Key 请求转给 bootstrap 的对应实现。
// 与 CLI 子命令共用同一套凭据存储，区别只在于 TUI 需要用 deps 注入、且通过回调把授权链接交给界面渲染。
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";
import type {
  CommandCenterApiKeyOptions,
  CommandCenterBigmodelLoginOptions,
  CommandCenterLoginOptions,
} from "./command-center/types.js";

// 在 TUI 内执行登录（默认 provider）。
// 输入：deps 提供 env/cwd/loadDotenv/loginZCodeCli 的覆盖；options 可带 abortSignal 与授权链接回调。
// 输出：bootstrap loginZCodeCli 的原始结果（含账号信息与凭据路径），不在此做裁剪。
// 副作用：加载 `.env`、写凭据文件、通过 onAuthorizeUrl 回调把链接交给界面；可能打开浏览器。
// 失败语义：`.env` 解析失败立即抛错（带 cause），其余错误由 bootstrap 抛出，TUI 负责展示。
export async function loginForTui(
  deps: RunDependencies,
  options?: CommandCenterLoginOptions,
) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const login = deps.loginZCodeCli ?? (await loadBootstrapModule()).loginZCodeCli;
  return await login({
    abortSignal: options?.abortSignal,
    env,
    onAuthorizeUrl: options?.onAuthorizeUrl,
  });
}

// 在 TUI 内执行 BigModel Coding Plan 登录。
// 输入/输出与 loginForTui 同构，只是走 loginBigmodelCodingPlan 这条 provider 通道。
// 副作用：同 loginForTui（写凭据、回调授权链接）。
// 口径：两者互不复用凭据文件，切换 provider 需要各自登录。
export async function loginBigmodelForTui(
  deps: RunDependencies,
  options?: CommandCenterBigmodelLoginOptions,
) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const login =
    deps.loginBigmodelCodingPlan ?? (await loadBootstrapModule()).loginBigmodelCodingPlan;
  return await login({
    abortSignal: options?.abortSignal,
    env,
    onAuthorizeUrl: options?.onAuthorizeUrl,
  });
}

// 通过显式 API Key 完成 Coding Plan 配置（无浏览器授权流程）。
// 输入：options.apiKey 为必填明文密钥（来自界面输入）；providerId 决定写入哪一路配置。
// 输出：bootstrap configureCodingPlanApiKey 的结果；失败时抛错，由 TUI 提示。
// 副作用：持久化密钥到本地凭据存储；不加载 `.env`（密钥不依赖环境文件）。
export async function configureApiKeyForTui(
  deps: RunDependencies,
  options: CommandCenterApiKeyOptions,
) {
  const configure =
    deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
  return await configure({
    apiKey: options.apiKey,
    env: deps.env ?? process.env,
    providerId: options.providerId,
  });
}

// 在 TUI 内执行登出：清空本地凭据。
// 输入：deps 可注入 env/cwd/loadDotenv/logoutZCodeCli。
// 输出：bootstrap logoutZCodeCli 的结果（含被清理的凭据路径）。
// 副作用：删除凭据文件；`.env` 仅加载用于账户上下文，不参与清理决策。
// 幂等性：未登录时仍返回成功，TUI 可安全地重复调用。
export async function logoutForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
  return await logout({ env });
}
