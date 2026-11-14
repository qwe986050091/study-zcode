// Host 手动连接 Source Server 的入口。
//
// 职责：把「target → profile → manager.connect」三步串起来，并处理认证升级与连接复用
// 两个边界；目录负责 profile/凭据，Manager 决定实际连接归属。
// 输入输出：输入 directory.ensureProfile / manager.connect 与目标（必须是非 server target）；
// 输出 { profile, connection }，profile 是本次提交后最终生效的那份。
// 副作用：首次 ensureProfile 带 deferCredentials 不落凭据；认证升级回调时才真正提交。
// 失败语义：任何阶段的 abort 都通过 throwIfAborted 抛出；ensureProfile 或 connect 抛错直接
// 上抛，不吞错也不返回半成品。
// 维护的不变量：仅真正执行本次认证的 flight 可提交凭据（后台 flight 不继承资格）；
// 连接被复用（reusedConnectionTarget）时，本次输入未参与最终连接，保留原 profile 与凭据引用。

import type { RemoteTarget } from "@zcode/shared";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import {
  type ConnectSourceServerOptions,
  type SourceServerConnectionManager,
} from "./sourceServerConnectionManager.js";

// 先以 deferCredentials 建 profile（不写凭据），再交给 manager 决定连接。
// onAuthenticatedUpgradeRequired 里先 throwIfAborted 再提交凭据：已取消的请求不能修改目录。
// 复用分支不再 ensureProfile：否则会用本次（未参与的）输入覆盖既有凭据引用。
// 失败语义：全部抛错透传。
/** Host 手动连接入口：目录持有 profile/凭据，Manager 决定实际连接归属。 */
export async function connectSourceServerTarget(
  directory: Pick<SourceServerDirectory, "ensureProfile">,
  manager: Pick<SourceServerConnectionManager, "connect">,
  options: Omit<ConnectSourceServerOptions, "profile" | "target"> & {
    target: Exclude<RemoteTarget, { kind: "server" }>;
  },
) {
  const profile = await directory.ensureProfile(options.target, { deferCredentials: true });
  const connection = await manager.connect({
    ...options,
    profile,
    onAuthenticatedUpgradeRequired: async () => {
      // 仅真正执行本次认证的 flight 可提交凭据；加入后台 flight 的请求不会继承资格。
      options.context?.signal?.throwIfAborted();
      await directory.ensureProfile(options.target);
    },
  });
  options.context?.signal?.throwIfAborted();
  // Manager 返回复用事实时，本次输入未参与最终连接；保留原 profile 和 credential refs。
  const committedProfile = connection.reusedConnectionTarget
    ? profile
    : await directory.ensureProfile(options.target);
  return { profile: committedProfile, connection };
}
