const SAMPLE_MS = 1000;
const MAX_PAUSE_MS = 5000;
const MAX_CLOCK_DRIFT_MS = 100;

/**
 * 时钟可靠性看门狗：每 1s 比较一次单调时钟增量与 wall clock 增量。
 *
 * 判定口径：单次采样间隔超过 5s、时间回退（elapsed < 0）、或两者漂移超过 100ms，
 * 都视为本段计时不可信（例如系统休眠、NTP 跳变），把 unreliable 交给注入的 sample 回调。
 * 副作用仅为回调通知与定时器；不写日志、不落盘、不参与命令 admission。
 */

/** 诊断采样不参与 admission；只有启用中的输入才创建，timer 不阻止 CLI 退出。 */
export class LocalTtftClockWatch {
  private readonly timer: ReturnType<typeof setInterval>;
  /**
   * 启动采样定时器并立即建立上一拍的单调/wall 基线。
   *
   * 输入：单调时钟读取器 now 与不可信通知回调 sample；输出无。
   * 副作用：每 1s 触发一次 sample；timer.unref() 保证诊断采样不阻止 CLI 进程退出。
   * 失败/降级：回调由调用方实现，本类不捕获异常；时钟源异常只会体现为 unreliable=true。
   */
  constructor(now: () => number, sample: (unreliable: boolean) => void) {
    let previous = now();
    let wall = Date.now();
    this.timer = setInterval(() => {
      const current = now();
      const currentWall = Date.now();
      const elapsed = current - previous;
      const unreliable =
        elapsed > MAX_PAUSE_MS ||
        elapsed < 0 ||
        Math.abs(currentWall - wall - elapsed) > MAX_CLOCK_DRIFT_MS;
      previous = current;
      wall = currentWall;
      sample(unreliable);
    }, SAMPLE_MS);
    this.timer.unref();
  }
  /**
   * 停止采样并释放定时器。调用后不会再触发 sample 回调；
   * 允许重复调用（clearInterval 对已清理句柄幂等）。无其它副作用。
   */
  dispose(): void {
    clearInterval(this.timer);
  }
}
