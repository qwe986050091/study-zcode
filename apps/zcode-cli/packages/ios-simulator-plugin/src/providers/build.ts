/**
 * xcodebuild 构建与「构建后安装启动」能力。
 *
 * 职责边界：定位工程/workspace 与 scheme、准备模拟器、执行构建、记录日志、查找 .app 产物；
 * 不负责创建工程（project.ts）与模拟器列表管理（sim.ts）。
 * 副作用：真实执行 xcodebuild（默认超时 600 秒）、写 DerivedData 与日志文件到插件数据目录、可能启动模拟器。
 * 失败语义：构建失败不抛错，返回 ok=false 与日志摘要；构建成功却找不到 .app 或 bundleId 才抛错。
 * 口径：appPath/logPath/derivedDataPath 均为绝对路径（日志路径经 rel 转为相对 cwd），bundleId 可能缺省。
 * 跨平台：仅 macOS；构建固定 iOS Simulator destination 且关闭代码签名（CODE_SIGNING_ALLOWED=NO）。
 */
import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { data, inside, rel } from "../lib/path.js"
import { brief, ok, run, type Run } from "../lib/run.js"
import { boot, install, launch } from "./sim.js"
import { bundle, discover, source } from "./project.js"

/**
 * 构建入参：project/workspace 二选一，scheme 缺省时尝试发现；
 * derivedDataPath 默认由插件数据目录按 cwd+工程+scheme 哈希隔离；udid/device/runtime 用于选择模拟器。
 */
type Build = {
  project?: string
  workspace?: string
  scheme?: string
  configuration?: string
  device?: string
  udid?: string
  runtime?: string
  derivedDataPath?: string
  bundleId?: string
  openSimulator?: boolean
  timeoutMs?: number
}

/**
 * 构建并启动的入参，在 Build 之上增加 launchArgs，仅影响启动阶段，不参与构建。
 */
type RunApp = Build & {
  launchArgs?: string[]
}

/**
 * 执行 xcodebuild 构建并返回结构化结果。
 *
 * 流程：discover/source 解析工程与 scheme → 启动模拟器 → 准备 DerivedData → 构建 → 记录日志 →
 * 解析 bundleId 并查找 .app 产物。
 * 副作用：启动模拟器（open 由 openSimulator 控制）、写 DerivedData 与日志；不安装到模拟器。
 * 失败语义：无 scheme 直接抛错；构建失败返回 ok=false、code、timedOut 与截断日志；
 * bundleId 解析失败被吞掉（返回 undefined），因为构建本身可能不需要它。
 * 不变式：DerivedData 目录按 (cwd, 工程文件, scheme) 哈希，保证同一组合复用缓存、不同组合互不污染。
 */
export async function app(input: Build = {}) {
  const found = await discover()
  const src = source(input, found)
  if (!src.scheme) throw new Error("No scheme found. Pass scheme explicitly.")

  const sim = await boot({
    udid: input.udid,
    name: input.device,
    runtime: input.runtime,
    open: input.openSimulator,
  })
  const dir = input.derivedDataPath
    ? inside(process.cwd(), input.derivedDataPath)
    : path.join(await data("DerivedData"), key(`${process.cwd()}:${src.file}:${src.scheme}`))
  await mkdir(dir, { recursive: true })
  const config = input.configuration || "Debug"

  const out = await run(
    [
      "xcodebuild",
      src.flag,
      src.file,
      "-scheme",
      src.scheme,
      "-configuration",
      config,
      "-destination",
      `platform=iOS Simulator,id=${sim.udid}`,
      "-derivedDataPath",
      dir,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { timeout: input.timeoutMs ?? 600_000 },
  )
  const log = await record("build", out)
  const id = input.bundleId || (await bundle(src.flag, src.file, src.scheme).catch(() => undefined))
  // 成功时才查找产物：失败构建可能留下残缺 .app，提前返回会误导调用方去安装。
  const prod = ok(out) ? await find(dir, config) : undefined

  return {
    ok: ok(out),
    source: src,
    simulator: sim,
    derivedDataPath: dir,
    appPath: prod,
    bundleId: id,
    logPath: log,
    code: out.code,
    timedOut: out.timed,
    output: brief(out, 12_000),
  }
}

/**
 * 构建后安装并启动应用。
 *
 * 副作用：链式触发构建、模拟器启动、simctl install 与 launch。
 * 失败语义：构建失败时返回 built 并标记 installed/launched=false（不抛错，让模型看到构建日志）；
 * 构建成功但缺 .app 或 bundleId 时抛错（无法继续）；安装/启动失败原样上抛。
 * 返回口径：在 app() 结果上追加 installed/launched 的原始输出。
 */
export async function runApp(input: RunApp = {}) {
  const built = await app({ ...input, openSimulator: input.openSimulator ?? true })
  if (!built.ok) return { ...built, installed: false, launched: false }
  if (!built.appPath) throw new Error("Build succeeded, but no .app product was found in DerivedData.")
  if (!built.bundleId) throw new Error("Build succeeded, but PRODUCT_BUNDLE_IDENTIFIER could not be resolved.")

  const installed = await install(built.simulator.udid, built.appPath)
  const launched = await launch(built.simulator.udid, built.bundleId, input.launchArgs ?? [])
  return { ...built, installed, launched }
}

/**
 * 把一次构建的完整输出落盘为日志文件，返回相对 cwd 的路径。
 *
 * 文件名为「时间戳-任务名.log」，内容含命令、退出码、超时标记与 stdout/stderr；
 * 副作用：创建目录并写文件，写盘失败会抛错（属于构建已完成但日志记录失败的边界情况）。
 */
async function record(name: string, out: Run): Promise<string> {
  const dir = await data("logs")
  const file = path.join(dir, `${stamp()}-${name}.log`)
  await writeFile(
    file,
    [`$ ${out.cmd.join(" ")}`, `exit=${out.code}`, `timedOut=${out.timed}`, "", out.stdout, out.stderr].join("\n"),
    "utf8",
  )
  return rel(file)
}

/**
 * 在 DerivedData 中查找构建产物并按 configuration 选择。
 * 返回 undefined 表示没有找到，由调用方决定报错或降级。
 */
async function find(dir: string, config: string): Promise<string | undefined> {
  return pickAppProduct(await apps(dir, 8), config)
}

/**
 * 从 .app 列表中选择与 configuration 匹配的产物。
 *
 * 优先 <Config>-iphonesimulator 目录（模拟器专用产物），其次 Debug-iphonesimulator，
 * 最后退回第一个，避免 release/debug 并存时误装；返回 undefined 表示列表为空。
 */
export function pickAppProduct(hits: string[], config: string): string | undefined {
  return (
    hits.find((item) => item.includes(`${path.sep}${config}-iphonesimulator${path.sep}`)) ||
    hits.find((item) => item.includes(`${path.sep}Debug-iphonesimulator${path.sep}`)) ||
    hits[0]
  )
}

/**
 * 递归收集目录下的 .app 包。
 * depth 为负即停止；只把目录识别为 .app（Xcode 产物是目录），读取失败返回空数组；
 * 不按文件名过滤，交由 pickAppProduct 按 configuration 挑选。
 */
async function apps(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      items.map(async (item) => {
        const file = path.join(dir, item.name)
        if (item.isDirectory() && item.name.endsWith(".app")) return [file]
        if (item.isDirectory()) return apps(file, depth - 1)
        return []
      }),
    )
  ).flat()
}

/**
 * 计算字符串的 16 位 SHA-1 前缀，用于 DerivedData 子目录命名；不用于安全用途。
 */
function key(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16)
}

/**
 * 生成文件名安全的时间戳：ISO 字符串中的冒号与点在 Windows/部分文件系统非法，
 * 统一替换为短横线，便于日志跨平台同步与排序。
 */
function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-")
}
