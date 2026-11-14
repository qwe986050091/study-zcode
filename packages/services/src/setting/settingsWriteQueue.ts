// withSettingsWriteQueueTimeout 等辅助函数：超时控制、临时文件名生成与提交阶段切换。
// INV：超时只允许发生在提交前；一旦进入 rename 提交，必须等临界区收口，
// 否则旧写会晚到并覆盖新设置。进入提交阶段的唯一入口是 runUpdate 收到的回调。
// 本文件不持有队列状态，队列本身在 settingService 内，这里只提供可单测的纯逻辑。
const SETTINGS_WRITE_QUEUE_TIMEOUT_MS = 30_000;
const SETTINGS_WRITE_QUEUE_TIMEOUT_ENV = "ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS";

// 超时默认 30s，可用 ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS 覆盖。
// 非法值（非数字或非正数）静默回落默认值：环境变量拼错不应让设置写入直接失败。
export function getSettingsWriteQueueTimeoutMs(): number {
  // 环境变量名是 ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS，先 trim 再判空避免纯空格被当成合法数字
  const rawValue = process.env[SETTINGS_WRITE_QUEUE_TIMEOUT_ENV]?.trim();
  // 未设置时直接回落 30s 默认值，让测试与生产都能在无配置下启动
  if (!rawValue) {
    return SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
  }
  // Number 而非 parseInt，'12s' 这类拼写错误会得到 NaN 而不是被截成 12
  const parsedValue = Number(rawValue);
  // 非正数与 NaN 一律视为非法，超时为 0 会让每次写入立即失败
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
}

// 临时文件与目标同目录，保证 rename 是同一文件系统内的原子操作。
// pid + 时间戳 + 随机后缀共同避免并发写进程撞名。
// 崩溃窗口：进程在 rename 前被 kill 会留下 .tmp 残留，它不影响目标文件，但不会被自动回收，下一次写入按新随机名另建。
export function buildSettingsTempFile(settingsFile: string): string {
  // 临时名拼上 pid 与毫秒时间戳以及十六进制随机数，三者组合足以避免同一目录内的并发撞名
  return `${settingsFile}.tmp-${process.pid}-${Date.now()}-${Math.random()
    // toString(16) 后缀比十进制短，长路径下更不容易撞上系统文件名长度上限
    .toString(16)
    .slice(2)}`;
}

// 把一次更新与超时竞速：runUpdate 需要主动调用 enterCommitPhase 声明已进入提交。
// 超时到期时若仍处于排队或准备阶段，先让调用方作废本次写入（expireCurrentWrite），再以错误结束。
// 返回的 Promise 在两者中任一完成后 settle；finally 只负责清定时器，不改写结果。
export function withSettingsWriteQueueTimeout(
  runUpdate: (enterCommitPhase: () => void) => Promise<void>,
  expireCurrentWrite: () => void,
): Promise<void> {
  // 每次调用 getSettingsWriteQueueTimeoutMs 都重新读取超时，运行期改动环境变量立即生效
  const timeoutMs = getSettingsWriteQueueTimeoutMs();
  // 句柄用 undefined 而不是 null，clearQueueTimeout 里的真值判断才能同时覆盖未设置状态
  let timeoutHandle: NodeJS.Timeout | undefined;
  // 进入提交的标记与定时器必须同源，仅凭定时器是否存活无法区分已提交与已清理
  let commitPhaseEntered = false;
  // 超时只 reject 调用方，不会取消已在跑的 runUpdate：作废不彻底时，旧值会在超时后晚到覆盖新设置。

// 清理定时器必须幂等：正常完成、超时、异常三条路径都会走到这里。
  const clearQueueTimeout = () => {
    // 重复调用 clearQueueTimeout 时句柄已置空，幂等判断避免对同一定时器二次 clearTimeout
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

// 进入提交即撤销超时：此后的耗时属于不可中断的临界区，不能再被外部判失败。
  const enterCommitPhase = () => {
    // 回调一进入提交就先置标记，之后到达的超时分支会看到 true 而放弃 reject
    commitPhaseEntered = true;
    clearQueueTimeout();
  };

// timer.unref 让超时定时器不阻止进程退出；它只是保护机制，不应延长进程生命周期。
  // 只使用 reject 端而 resolve 端永不调用，让超时成为唯一能让该 Promise 落地的路径
  const timeoutPromise = new Promise<void>((_, reject) => {
    // 定时器在 Promise 构造器内创建，超时回调与 enterCommitPhase 共享 commitPhaseEntered
    timeoutHandle = setTimeout(() => {
      // 已进入提交则直接返回，临界区不能被外部超时打断否则旧写会晚到覆盖新设置
      if (commitPhaseEntered) {
        return;
      }
      // 先调用 expireCurrentWrite 作废本次写入，再 reject 才能让排队方释放而不是永久 pending
      expireCurrentWrite();
      // 设置写入队列持有真实持久化顺序，Provider 层不 await 也无法释放这里的 pending。
      // 超时只允许发生在提交前阶段；进入 rename 提交后必须等临界区收口，避免旧写晚到覆盖新设置。
      reject(
        new Error(`settingService update timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    // unref 让挂起的超时定时器不阻止进程退出，它只是保护措施而非工作项
    timeoutHandle.unref?.();
  });

  return Promise.race([runUpdate(enterCommitPhase), timeoutPromise]).finally(
    clearQueueTimeout,
  );
}
