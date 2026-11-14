/**
 * iOS 模拟器管理（基于 `xcrun simctl`）。
 *
 * 职责：枚举/筛选设备、启动与等待就绪、安装/启动/终止应用、打开 URL。
 * 输入口径：`udid` 必须匹配 UDID 形状（`UDID` 正则）才下发命令；`name` 做包含匹配，
 * 未指定时按 `IOS_SIM_DEFAULT_DEVICE` 或 iPhone 16 回落。
 * 输出口径：设备统一为 `{name,udid,state,runtime,available}`；命令类返回带成功标记的对象。
 * 失败语义：所有非零退出都转成 Error(brief(out))，不做静默降级；找不到可用设备直接抛错。
 * 副作用：启动/打开模拟器进程、安装并运行应用；仅通过 CLI 间接产生。
 */
import { brief, ok, run } from "../lib/run.js"

type Sim = {
  name: string
  udid: string
  state: string
  runtime: string
  available: boolean
}

const UDID = /^[0-9A-Fa-f-]{8,}$/

/** 只允许形如 `0-9A-F-` 且长度 ≥8 的串进入 simctl，避免把任意字符串当设备 id 传给底层命令。 */
function valid(udid: string): boolean {
  return UDID.test(udid)
}

/**
 * 列出所有可用的 iOS/iPadOS 模拟器。
 * 输入：无；固定调用 `simctl list devices --json`，超时 20s。
 * 输出：仅 iOS 运行时且具备 name/udid 的设备；availabilityError 或 isAvailable=false 记为不可用。
 * 失败语义：xcrun 失败抛 Error(brief(out))；JSON 解析失败在 `parseSimulators` 处抛出。
 */
export async function list(): Promise<Sim[]> {
  const out = await run(["xcrun", "simctl", "list", "devices", "--json"], { timeout: 20_000 })
  if (!ok(out)) throw new Error(brief(out))
  return parseSimulators(out.stdout)
}

/**
 * 解析 `simctl list --json` 输出。
 * 输入：原始 JSON 文本；`devices` 键缺失时视为空列表。
 * 输出：按运行时分组扁平化后的设备数组；非对象条目与缺少 name/udid 的条目被过滤。
 * 失败语义：非法 JSON 交给 JSON.parse 抛出；结构异常通过默认值降级而不崩溃。
 */
export function parseSimulators(value: string): Sim[] {
  const raw = JSON.parse(value) as { devices?: Record<string, unknown[]> }
  return Object.entries(raw.devices ?? {}).flatMap(([runtime, devices]) => {
    if (!isIosRuntime(runtime)) return []
    return devices
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        name: String(item.name ?? ""),
        udid: String(item.udid ?? ""),
        state: String(item.state ?? ""),
        runtime,
        available: item.isAvailable !== false && item.availabilityError === undefined,
      }))
      .filter((item) => item.name && item.udid)
  })
}

/** 判断运行时标识是否为 iOS/iPadOS（允许前后带点、空格或连字符分隔，兼容新旧 simctl 命名）。 */
export function isIosRuntime(runtime: string): boolean {
  return /(?:^|[.\s-])(iOS|iPadOS)(?:$|[.\s-])/.test(runtime)
}

/**
 * 选择一个模拟器。
 * 优先级：显式 udid（校验后必须存在）→ 已 Booted 且未限定名称/运行时 → 名称包含匹配
 * （缺省 IOS_SIM_DEFAULT_DEVICE 或 iPhone 16）→ 任意 iPhone → 首个可用设备。
 * 输出：第一个命中的设备；已 Booted 的优先复用，避免重复启动。
 * 失败语义：udid 非法/不存在或没有任何可用设备时抛出明确错误。
 */
export async function pick(input?: { udid?: string; name?: string; runtime?: string }): Promise<Sim> {
  if (input?.udid) {
    if (!valid(input.udid)) throw new Error(`Invalid simulator UDID: ${input.udid}`)
    const hit = (await list()).find((item) => item.udid === input.udid)
    if (hit) return hit
    throw new Error(`Simulator not found: ${input.udid}`)
  }
  const sims = (await list()).filter((item) => item.available)
  const booted = sims.find((item) => item.state === "Booted")
  if (booted && !input?.name && !input?.runtime) return booted
  const want = (input?.name || process.env.IOS_SIM_DEFAULT_DEVICE || "iPhone 16").toLowerCase()
  const found = sims.find((item) => {
    return item.name.toLowerCase().includes(want) && (!input?.runtime || item.runtime.includes(input.runtime))
  })
  if (found) return found
  const phone = sims.find((item) => item.name.startsWith("iPhone") && (!input?.runtime || item.runtime.includes(input.runtime)))
  if (phone) return phone
  const first = sims[0]
  if (first) return first
  throw new Error("No available iOS simulators found.")
}

/**
 * 确保模拟器已启动并完成 bootstatus。
 * 输入：透传 `pick` 的选择参数；`open=true` 时额外打开 Simulator 窗口。
 * 输出：最新设备信息 + `opened` 标记（状态以 bootstatus 完成后的再次查询为准）。
 * 失败语义：boot 失败抛错，但“已经是 Booted”这一幂等冲突被显式忽略；bootstatus 失败直接抛。
 * 副作用：启动设备进程、可能打开 GUI 窗口。
 */
export async function boot(input: { udid?: string; name?: string; runtime?: string; open?: boolean } = {}) {
  const sim = await pick(input)
  if (sim.state !== "Booted") {
    const out = await run(["xcrun", "simctl", "boot", sim.udid], { timeout: 60_000 })
    if (!ok(out) && !brief(out).includes("current state: Booted")) throw new Error(brief(out))
    const ready = await run(["xcrun", "simctl", "bootstatus", sim.udid, "-b"], { timeout: 120_000 })
    if (!ok(ready)) throw new Error(brief(ready))
  }
  if (input.open) await show(sim.udid)
  return { ...(await pick({ udid: sim.udid })), opened: Boolean(input.open) }
}

/**
 * 打开 Simulator.app。
 * 行为：优先用 `-CurrentDeviceUDID` 定向打开；失败时退回不带参数的 `open`（打开默认窗口）。
 * 输出：`{opened, udid}`；走兜底时额外带 `fallback: true`，便于调用方区分。
 * 失败语义：两次 open 都失败时抛出，附带两次输出的摘要。
 * 副作用：启动 macOS GUI 应用。
 */
export async function show(udid?: string) {
  const args = udid ? ["open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid] : ["open", "-a", "Simulator"]
  const out = await run(args, { timeout: 10_000 })
  if (ok(out)) return { opened: true, udid }
  const fallback = await run(["open", "-a", "Simulator"], { timeout: 10_000 })
  if (ok(fallback)) return { opened: true, udid, fallback: true }
  throw new Error(brief(out) || brief(fallback))
}

/**
 * 安装应用到模拟器。
 * 输入：udid（形状校验）+ 本地 .app 路径；超时 120s。
 * 输出：`{installed: true, udid, app}`；失败抛 Error(brief(out))。
 * 副作用：改变模拟器已安装应用列表。
 */
export async function install(udid: string, app: string) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  const out = await run(["xcrun", "simctl", "install", udid, app], { timeout: 120_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { installed: true, udid, app }
}

/**
 * 启动应用。
 * 输入：udid（形状校验）、bundle id、可选启动参数；超时 60s。
 * 输出：`{launched: true, udid, bundle, output}`，output 为截断后的命令摘要。
 * 失败语义：非零退出抛错；不校验应用是否已安装（由 simctl 报错透出）。
 * 副作用：在模拟器中拉起应用进程。
 */
export async function launch(udid: string, bundle: string, args: string[] = []) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  const out = await run(["xcrun", "simctl", "launch", udid, bundle, ...args], { timeout: 60_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { launched: true, udid, bundle, output: brief(out) }
}

/**
 * 终止应用。
 * 输入：udid（形状校验）+ bundle id；超时 30s。
 * 输出：`{terminated: true, udid, bundle}`；应用未运行时由 simctl 报错并抛出。
 * 副作用：结束模拟器内的应用进程。
 */
export async function terminate(udid: string, bundle: string) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  const out = await run(["xcrun", "simctl", "terminate", udid, bundle], { timeout: 30_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { terminated: true, udid, bundle }
}

/**
 * 在模拟器中打开 URL（可触发深链/浏览器）。
 * 输入：udid（形状校验）+ URL；长度上限 2048，超限直接拒绝，避免命令行参数过长。
 * 输出：`{opened: true, udid, url}`；simctl 失败抛错。
 * 副作用：由系统按 scheme 分发给对应应用。
 */
export async function url(udid: string, value: string) {
  if (!valid(udid)) throw new Error(`Invalid simulator UDID: ${udid}`)
  if (value.length > 2048) throw new Error("URL is too long.")
  const out = await run(["xcrun", "simctl", "openurl", udid, value], { timeout: 30_000 })
  if (!ok(out)) throw new Error(brief(out))
  return { opened: true, udid, url: value }
}
