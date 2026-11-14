/**
 * 路径与目录工具：为 Android 模拟器插件提供统一的插件私有数据目录、项目根内路径校验和展示用相对路径。
 *
 * 职责边界：
 * - 只做路径计算与目录创建，不读写具体业务文件；
 * - 所有落盘路径必须先经过 data() 获得插件数据目录，或经 inside() 校验未越出项目根；
 * - 不解析设备/模拟器语义，也不做命令执行。
 *
 * 副作用：data() 会真实执行 mkdir(recursive)，在首次调用时创建目录树。
 * 失败语义：data() 创建失败会向上抛出 fs 错误；inside() 越界时抛 Error，调用方应视为用户输入非法。
 * 不变式：同一个 ANDROID_PLUGIN_DATA 下多次调用 data() 返回同一绝对路径，可安全重复调用（幂等）。
 */
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 解析并创建插件私有数据目录下的子路径。
 *
 * 输入为若干路径片段，按顺序拼接到插件数据根；根目录优先取环境变量 ANDROID_PLUGIN_DATA，
 * 未设置时回退到系统临时目录下的 android-emulator-plugin，保证 Windows/macOS/Linux 都有可写位置。
 * 输出为绝对路径字符串，调用方可直接用于读写文件。
 * 副作用：递归创建目录；若父路径不可写（权限、只读盘）会抛出原始 fs 错误，调用方需自行降级或提示。
 * 不变式：目录创建成功后再返回，避免调用方拿到路径后写盘才发现目录缺失；
 * 同一入参重复调用不会失败（mkdir 带 recursive）。
 */
export async function data(...part: string[]): Promise<string> {
  const dir = path.join(
    process.env.ANDROID_PLUGIN_DATA || path.join(os.tmpdir(), "android-emulator-plugin"),
    ...part,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 将用户提供的相对路径解析到 base 目录内，并阻止路径穿越。
 *
 * 输入 raw 可能来自工具参数（如截图输出名、配置文件名），因此必须视为不可信。
 * 输出为规范化的绝对路径；当结果等于 base 或位于 base 之下时才返回。
 * 失败语义：越界（如 ../../etc、绝对路径指向别处）时抛出 Error，调用方应作为参数错误反馈给上层，
 * 而不是静默截断路径，避免把写操作落到项目外。
 * 注意：这里基于字符串前缀判断，不解析符号链接，调用方不应依赖它承担真实的安全沙箱职责。
 */
export function inside(base: string, raw: string): string {
  const out = path.resolve(base, raw);
  if (out === base || out.startsWith(base + path.sep)) return out;
  throw new Error(`Path escapes project root: ${raw}`);
}

/**
 * 计算文件相对当前工作目录的展示路径。
 *
 * 用于工具返回结果中给人/模型看的路径，避免泄露机器绝对路径。
 * 当文件就是 cwd 时 path.relative 返回空串，这里统一兜底为 "."，保证输出永远是非空字符串。
 * 无副作用；不抛错。
 */
export function rel(file: string): string {
  return path.relative(process.cwd(), file) || ".";
}
