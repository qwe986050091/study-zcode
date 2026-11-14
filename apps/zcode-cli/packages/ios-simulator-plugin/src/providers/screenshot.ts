/**
 * iOS 模拟器截图能力。
 *
 * 职责：先确保目标模拟器已启动（`boot`），再调用 `xcrun simctl io screenshot` 截图，
 * 返回相对路径、字节数与 base64 数据，供工具层直接回传。
 * 输入口径：`udid`/`device`/`runtime` 用于选择设备；`path` 为相对 cwd 的输出位置，经 `inside`
 * 限制在项目目录内，避免越界写文件；未给 path 时落到 data/screenshots。
 * 输出：simulator 元信息 + 相对路径 + 字节数 + base64 图片。
 * 失败语义：simctl 非零退出抛错并附带 `brief(out)` 摘要；读取文件失败直接抛出，不返回部分结果。
 * 副作用：创建输出目录并写入 PNG；除按需启动模拟器外不改变设备状态。
 */
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { data, inside, rel } from "../lib/path.js"
import { brief, ok, run } from "../lib/run.js"
import { boot } from "./sim.js"

type Shot = {
  udid?: string
  device?: string
  runtime?: string
  path?: string
  openSimulator?: boolean
}

/**
 * 截取当前模拟器画面。
 * 输入：`path` 相对 cwd 并被收敛到项目目录；其余字段透传给 `boot` 选设备。
 * 输出：simulator、相对路径、字节数与 base64 内容。
 * 失败语义：xcrun 退出码非零抛 Error(brief(out))；图片读取失败直接抛出。
 * 副作用：mkdir -p 输出目录并写 PNG。
 */
export async function shot(input: Shot = {}) {
  const sim = await boot({
    udid: input.udid,
    name: input.device,
    runtime: input.runtime,
    open: input.openSimulator,
  })
  const file = input.path
    ? inside(process.cwd(), input.path)
    : path.join(await data("screenshots"), `${stamp()}-${sim.udid}.png`)
  await mkdir(path.dirname(file), { recursive: true })

  const out = await run(["xcrun", "simctl", "io", sim.udid, "screenshot", file], { timeout: 30_000 })
  if (!ok(out)) throw new Error(brief(out))
  const bytes = await readFile(file)
  return {
    simulator: sim,
    path: rel(file),
    bytes: bytes.byteLength,
    data: bytes.toString("base64"),
  }
}

/** 生成文件名安全的时间戳：把 ISO 时间里的 `:` 与 `.` 替换为 `-`，避免路径非法。 */
function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-")
}
