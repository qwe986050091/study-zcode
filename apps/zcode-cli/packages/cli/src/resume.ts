// 会话恢复解析：把 `--resume <id>` / `--continue` 两种入口语义收敛成具体的 sessionId。
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import type { CliEnv } from "./env.js";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { CliResumeRequest, RunDependencies } from "./cli-types.js";

// 解析本次运行要恢复的会话。
// 输入：request.resumeSessionId 显式指定时直接采用（不做存在性校验）；request.continueSession 为真时查指定目录最近一次会话。
// 输出：命中返回 sessionId；两者都未给出时返回 undefined，语义为"新建会话"。
// 副作用：continue 分支会读取 session 存储（磁盘 IO），并可能懒加载 @zcode/bootstrap 模块。
// 失败语义：continue 模式下没有可恢复会话时抛错，由命令入口转换成用户提示与退出码。
// 不变量：显式 id 优先于 continue，二者同给时不产生歧义。
export const resolveResumeSession = async (
  request: CliResumeRequest,
  workingDirectory: string,
  env: CliEnv,
  deps: RunDependencies,
): Promise<ZCodeAppOptions["sessionId"] | undefined> => {
  // 显式 id 短路在 continue 之前：用户按名称指定了会话就不该再被"最近一次"覆盖。
  if (request.resumeSessionId) {
    return request.resumeSessionId as ZCodeAppOptions["sessionId"];
  }

  // 两个开关都未打开时返回空值即"新开"，此处不是错误路径。
  if (!request.continueSession) {
    return undefined;
  }

  const resolveLatest =
    deps.resolveLatestSession ?? (await loadBootstrapModule()).resolveLatestSession;
  // 只按工作目录与环境查询，保持与 TUI 会话列表同一口径；找不到时交给上层报错而不是静默新建。
  const latest = await resolveLatest({
    directory: workingDirectory,
    env,
  });
  if (!latest) {
    throw new Error(`No resumable session found for ${workingDirectory}`);
  }
  return latest.id;
};
