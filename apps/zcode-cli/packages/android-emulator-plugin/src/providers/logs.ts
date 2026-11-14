/**
 * logcat 读取能力：导出最近 N 行日志，并按 applicationId 做粗过滤。
 *
 * 职责边界：只读取 logcat 快照（-d 读取后即退出），不持续 streaming、不修改设备。
 * 副作用：拉起 adb logcat，可能触发 adb server；不写盘。
 * 失败语义：logcat 失败或超时抛 Error(brief)；过滤只是按包名/末段名匹配，可能漏掉 tag 与包名不同的日志。
 * 返回口径：output 为截断后的文本，lines 为实际请求行数，device 为选中的目标设备信息。
 */
import { ensureDevice } from "./avd.js";
import { packageName } from "./app.js";
import { brief, ok, run } from "../lib/run.js";
import { requireTool } from "./sdk.js";

/**
 * 读取日志的入参。
 * lines 是设备侧拉取行数（会被夹在 1~5000），limit 是返回文本的字符预算，两者含义不同不可混用。
 */
type Logs = {
  serial?: string;
  avd?: string;
  applicationId?: string;
  lines?: number;
  limit?: number;
};

/**
 * 读取目标设备的最近 logcat。
 *
 * 流程：ensureDevice 选设备 → adb logcat -d -t <lines> 取快照 → 可选按 applicationId 过滤 → 截断输出。
 * 副作用：执行 adb 命令；不改变设备状态。
 * 失败语义：命令非零退出/超时抛 Error(brief)；过滤阶段不抛错，applicationId 非法会先被 packageName 拦截。
 * 不变式：lines 始终夹在 1~5000，防止一次拉取过多日志拖慢设备或撑爆上下文。
 */
export async function logs(input: Logs = {}) {
  const device = await ensureDevice(input);
  const adb = await requireTool("adb");
  // 上下限夹取：0/负数无意义，过大值会让 adb 与模型上下文都过载。
  const lines = Math.max(1, Math.min(input.lines ?? 500, 5000));
  const out = await run(
    [adb, "-s", device.serial, "logcat", "-d", "-v", "time", "-t", String(lines)],
    { timeout: 60_000 },
  );
  if (!ok(out)) throw new Error(brief(out));
  const app = input.applicationId ? packageName(input.applicationId) : undefined;
  // 同时匹配完整包名与末段名：logcat 中常见 tag 只写末段（如 MainActivity），只按包名会漏日志。
  const value = app
    ? out.stdout
        .split(/\r?\n/)
        .filter(
          (line) =>
            line.includes(app) ||
            line.toLowerCase().includes(app.split(".").at(-1)?.toLowerCase() ?? app),
        )
        .join("\n")
    : out.stdout;
  return {
    device,
    applicationId: app,
    lines,
    output: text(value, input.limit ?? 20_000),
  };
}

/**
 * 按字符预算截断文本，超限时追加 [truncated] 标记。
 * 只保留前段：logcat 时间顺序递增，早期日志通常包含启动/权限等关键错误。
 */
function text(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + "\n...[truncated]";
}
