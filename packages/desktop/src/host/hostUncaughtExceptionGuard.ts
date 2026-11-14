// Host 进程级未捕获异常的分级守卫。
//
// 职责：把 process 的 uncaughtException 回调分成「可恢复」与「致命」两类；只有明确的
// RangeError("Failed to allocate memory") 走 onRecovered，其余一律 onFatal。
// 输入输出：输入 onRecovered / onFatal 两个上报回调；输出可直接注册给 process.on 的 handler。
// 副作用：调用调用方提供的上报回调；本文件不自行退出进程。
// 失败语义：onRecovered 本身抛错会被吞掉——内存紧张时诊断上报也可能分配失败，守卫边界
// 必须保持无抛出，否则会把「可恢复错误」升级成真正的进程 abort。
// 维护的不变量：只有该明确错误被隔离；不能放宽成「所有 RangeError」或「所有 allocation 错误」，
// 否则真正的内存泄漏 / 逻辑错误会被静默吞掉。

export interface HostUncaughtExceptionGuardOptions {
  onRecovered: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
  onFatal: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
}

// 判定是否为可恢复的分配失败：必须是 RangeError 且 message 完全等于该固定文案。
// 用精确匹配而非前缀 / includes，避免把其他 RangeError 误判为可恢复。
export function isRecoverableHostAllocationError(error: unknown): error is RangeError {
  return error instanceof RangeError && error.message === "Failed to allocate memory";
}

// 创建 uncaughtException handler。
// 可恢复分支包 try/catch：上报失败不得再次抛出；致命分支直接交给 onFatal（由调用方决定
// 记录与退出），本函数不吞致命错误。
// 输入输出：返回 (error, origin) => void，可直接传给 process.on("uncaughtException", ...)。
// 维护的不变量：onFatal 只被调用一次，可恢复分支绝不调用 onFatal。
export function createHostUncaughtExceptionHandler({
  onRecovered,
  onFatal,
}: HostUncaughtExceptionGuardOptions): (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void {
  return (error, origin) => {
    if (!isRecoverableHostAllocationError(error)) {
      onFatal(error, origin);
      return;
    }

    try {
      // Electron 内置 Node 在 TLS 握手中把 peer certificate 投影成 JS 对象时，
      // native Buffer 分配失败会逃出 socket 回调；Utility Process 默认直接 abort。
      // 同类分配错误在普通 Promise 链里可被请求超时/重试回收，因此这里只隔离该明确错误，
      // 不能把日志上报失败再次升级成进程级未捕获异常。
      onRecovered(error, origin);
    } catch {
      // 内存紧张时诊断日志本身也可能分配失败，保护边界必须保持无抛出。
    }
  };
}
