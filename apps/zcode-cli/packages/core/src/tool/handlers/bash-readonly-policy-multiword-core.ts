/**
 * 多词前缀只读命令表（docker inspect/logs、gh auth status）。
 * key 形如 "docker inspect"，必须在 argv 中连续命中两个词才生效；
 * 由 bash-readonly-policy-commands.ts 与 -multiword-gh.ts 合并进 READONLY_MULTIWORD_COMMAND_POLICIES，
 * 再被 -argv.ts 的多词分支按"最长前缀优先"查找。
 * docker/gh 都可能访问远端，所以每个条目都挂回调兜底；未列出的多词形态不会命中。
 */

import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import {
  dockerCommandIsDangerous,
  ghCommandIsDangerous,
} from "./bash-readonly-policy-callbacks.js";
import { DOCKER_INSPECT_SAFE_FLAGS, DOCKER_LOGS_SAFE_FLAGS } from "./bash-readonly-policy-flags.js";

export const READONLY_MULTIWORD_POLICY_ENTRIES_CORE = [
  [
    "docker inspect",
    {
      // 只允许查看本机 daemon；-H/--context 等远端/凭据选项由 dockerCommandIsDangerous 拒绝。
      safeFlags: DOCKER_INSPECT_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous,
    },
  ],
  [
    "docker logs",
    {
      // --follow 只是持续读本地日志流，仍属只读；远端 daemon 选项同样被回调拦截。
      safeFlags: DOCKER_LOGS_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous,
    },
  ],
  [
    "gh auth status",
    {
      // 只读当前登录状态；--hostname 指向其它 GH 实例时由 ghCommandIsDangerous 判危险。
      safeFlags: {
        "-a": "none",
        "-h": "string",
        "--active": "none",
        "--hostname": "string",
        "--json": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
] as const satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[];
