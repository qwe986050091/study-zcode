// 稳定 CUA 传输层：broker 管道名与 Windows helper 启动配方的进程内单例。
// INV-1 管道名全进程只生成一次（getStableCuaPipeName 的 ??=）；重生成会让已连接的 helper 找不到服务端。
// INV-2 配方解析结果连失败一起缓存（resolveStableCuaWinRecipe 的 ??=），失败后需显式重置才会重试，避免启动抖动。
import { mintBrokerSocketPath } from "@zcode/zcode-cua/broker";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { resolveWindowsCuaRuntime } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

// 统一 logger 作用域，便于按 stable-cua-transport 过滤该传输层的日志。
const logger = createServiceLogger("stable-cua-transport");

// helper 启动所需的全部输入；字段与 windowsCuaDevRuntime 的解析结果一一对应，不做裁剪。
// commandEnv 必须原样透传：缺失时 helper 会以错误的 runtime 启动（例如少 PYTHONPATH）。
export interface StableCuaWinRecipe {
  command: string;
  entryPath: string;
  root: string;
  addonPath: string;
  commandEnv: Record<string, string>;
}

// 三个模块级状态都由进程共享：stablePipeName、recipePromise（含失败）与 recipeFailureLogged 去重标记。
// 测试通过 __resetStableCuaTransportForTest 显式重置，生产路径没有重置入口。
let stablePipeName: string | null = null;
let recipePromise: Promise<StableCuaWinRecipe | null> | null = null;
let recipeFailureLogged = false;

// 管道名惰性生成并永久缓存；并发调用共享同一 ??= 结果，因此不会出现两个名字。
// mintBrokerSocketPath 读取 env，这里固定用 process.env，避免调用方传入不同环境造成分叉。
export function getStableCuaPipeName(): string {
  // ??= 只赋值一次：并发首调共享同一结果，已连接的 helper 不会看到第二个管道名。
  stablePipeName ??= mintBrokerSocketPath({ env: process.env });
  // 返回的字符串会写进 broker 与 helper 两侧启动参数，任何重新生成都会让双方失配。
  return stablePipeName;
}

// 首次调用发起解析，后续调用复用同一个 Promise（成功与失败都复用），因此并发启动只会解析一次。
// catch 里先把 recipePromise 置空再返回 null：下次调用可重试，同时本次所有等待者拿到一致的 null。
export function resolveStableCuaWinRecipe(): Promise<StableCuaWinRecipe | null> {
  // 首次调用才解析；已有 Promise（无论成败）都直接复用，并发启动不会各解析一遍。
  recipePromise ??= resolveWindowsCuaRuntime()
    // 字段逐个搬运而不是整体透传：上游多出的字段不会漏进 helper 启动参数。
    .then((runtime) => ({
      command: runtime.command,
      entryPath: runtime.entryPath,
      root: runtime.root,
      addonPath: runtime.addonPath,
      commandEnv: runtime.commandEnv,
    }))
    // catch 必须返回 null 而不是重抛：调用方用 null 表示本次不可用，重抛会让所有等待者一起失败。
    .catch((error: unknown) => {
      // 告警只打一次：helper 不可用会持续重试，每次打日志会淹没真正的失败原因。
      if (!recipeFailureLogged) {
        // 先置位再打日志：logger 若同步抛错，也不会让下一次失败重复进入。
        recipeFailureLogged = true;
        logger.warn(
          undefined,
          `Windows CUA helper recipe unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // 清空缓存让下一次调用重试；本次等待者仍拿到 null，与失败语义一致。
      recipePromise = null;
      return null;
    });
  // 返回缓存里的同一个 Promise，调用方 await 到的对象也共享，不要修改它的字段。
  return recipePromise;
}

// 仅测试使用：__resetStableCuaTransportForTest 把三个单例全部归零，使下一次调用重新生成管道名并重新解析配方。
// 生产代码不得调用，否则会让运行中的 helper 与新的管道名失配。
export function __resetStableCuaTransportForTest(): void {
  // 三个单例必须一起清：只清管道名会让旧配方继续指向旧路径。
  stablePipeName = null;
  recipePromise = null;
  // 复位 recipeFailureLogged，让重置后的第一次失败仍能打出一条告警。
  recipeFailureLogged = false;
}
