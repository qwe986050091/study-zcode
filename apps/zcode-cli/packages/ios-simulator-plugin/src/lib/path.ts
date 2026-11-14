/**
 * iOS 模拟器插件的路径工具：提供插件私有数据目录、工作区路径校验与展示用相对路径。
 *
 * 职责边界：只做路径解析与目录创建，不涉及模拟器/构建语义。
 * 副作用：data() 会执行 mkdir(recursive) 真实创建目录。
 * 失败语义：data() 遇到不可写路径抛出原始 fs 错误；inside() 越界抛 Error，调用方应视为参数非法。
 * 跨平台：本插件面向 macOS（xcrun/simctl），路径拼接统一走 path，不硬编码分隔符。
 */
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 预留常量：由 dist 目录回到包根的相对深度，当前未被引用，保留以兼容打包布局变化。
const PACKAGE_ROOT_FROM_DIST = "../.."

/**
 * 解析并创建插件数据目录下的子路径。
 *
 * 根目录优先取环境变量 IOS_SIM_PLUGIN_DATA，未设置时回退系统临时目录下的 ios-simulator-plugin，
 * 保证沙箱/CI 环境也有可写位置。输出为绝对路径。
 * 副作用：递归创建目录；创建失败抛出 fs 错误，调用方需自行提示或降级。
 * 不变式：目录创建成功后返回，同一入参重复调用不会失败（幂等）。
 */
export async function data(...part: string[]): Promise<string> {
  const dir = path.join(process.env.IOS_SIM_PLUGIN_DATA || path.join(os.tmpdir(), "ios-simulator-plugin"), ...part)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * 把用户提供的相对路径限制在 base 目录内，阻止路径穿越。
 *
 * raw 来自工具参数，必须视为不可信；resolve 后只有等于 base 或位于 base 之下才返回。
 * 失败语义：越界（如 ../、绝对路径指向外部）抛 Error，调用方应作为参数错误反馈，而非静默截断。
 * 注意：基于字符串前缀判断，不解析符号链接，不承担真实沙箱职责。
 */
export function inside(base: string, raw: string): string {
  const out = path.resolve(base, raw)
  if (out === base || out.startsWith(base + path.sep)) return out
  throw new Error(`Path escapes project root: ${raw}`)
}

/**
 * 计算相对当前工作目录的展示路径，避免向模型暴露机器绝对路径。
 * path.relative 在文件即 cwd 时返回空串，这里兜底为 "."；无副作用、不抛错。
 */
export function rel(file: string): string {
  return path.relative(process.cwd(), file) || "."
}
