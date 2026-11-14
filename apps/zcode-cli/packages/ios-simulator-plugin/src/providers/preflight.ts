/**
 * 环境预检：检查 macOS、完整 Xcode、xcodebuild、simctl、可用模拟器运行时与可选 UI 后端（idb）。
 *
 * 职责边界：只做只读探测与结论生成，不安装 Xcode/运行时、不启动模拟器。
 * 副作用：执行 xcode-select/xcodebuild/simctl/idb 等探测命令，不改变项目与模拟器状态。
 * 失败语义：单个探测失败降级为一条 ok=false 的 check，不让整体抛错；
 * 最终 ok 要求所有 check 通过（UI 后端在 auto/none 模式下视为通过）。
 * 返回口径：{ ok, checks }，每项含 name/ok/detail/fix，fix 用于指导用户补齐环境。
 */
import { brief, ok, run } from "../lib/run.js"
import { parseSimulators } from "./sim.js"

/**
 * 单条预检结果。
 * detail 是证据（平台/路径/版本/错误摘要），fix 是修复建议；name 用于展示，不作为程序化标识。
 */
type Check = {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

/**
 * 执行完整预检并返回结构化报告。
 *
 * 顺序：macOS → xcode-select → xcodebuild → simctl → 模拟器运行时 → UI 后端。
 * 副作用：运行多个只读探测子进程；探测失败不抛错，而是记录 check 与修复建议。
 * 跨平台：非 macOS 时 macOS 项直接失败，但后续命令仍会被执行并各自记录失败原因，便于一次性展示全部问题。
 */
export async function preflight() {
  const checks: Check[] = []
  checks.push({
    name: "macOS",
    ok: process.platform === "darwin",
    detail: process.platform,
    fix: "Run this plugin on macOS with full Xcode installed.",
  })

  const select = await run(["xcode-select", "-p"], { timeout: 10_000 })
  const dir = select.stdout.trim()
  // 仅安装 CommandLineTools 时 xcode-select 指向 /CommandLineTools，缺少完整 Xcode 无法构建 App，
  // 因此除命令成功外还要求路径不在 CommandLineTools 下。
  const clt = dir.includes("/CommandLineTools")
  checks.push({
    name: "xcode-select",
    ok: ok(select) && !clt,
    detail: ok(select) ? dir : brief(select),
    fix: "Install full Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
  })

  const build = await run(["xcodebuild", "-version"], { timeout: 10_000 })
  checks.push({
    name: "xcodebuild",
    ok: ok(build),
    detail: brief(build),
    fix: "Open Xcode once and accept license/components. CommandLineTools alone is not enough.",
  })

  const simctl = await run(["xcrun", "simctl", "help"], { timeout: 10_000 })
  checks.push({
    name: "simctl",
    ok: ok(simctl),
    detail: brief(simctl),
    fix: "Install full Xcode and make sure xcrun can find simctl.",
  })

  const devices = await run(["xcrun", "simctl", "list", "devices", "--json"], { timeout: 20_000 })
  // 用 --json 获取结构化设备列表，便于只统计 available 的真实可用模拟器，避免把不可用运行时算进去。
  const available = ok(devices) ? readAvailableDevices(devices.stdout) : []
  checks.push({
    name: "simulator devices",
    ok: ok(devices) && available.length > 0,
    detail: ok(devices) ? `${available.length} available iOS/iPadOS simulator(s)` : brief(devices),
    fix: "Install an iOS Simulator runtime from Xcode > Settings > Platforms.",
  })

  // UI 后端是可选能力：显式 none 或 auto 模式下 idb 缺失不算环境失败，只是降级为无 UI 自动化。
  const ui = process.env.IOS_SIM_UI_BACKEND || "auto"
  const idb = await run(["idb", "--version"], { timeout: 5000 })
  checks.push({
    name: "ui backend",
    ok: ui === "none" || ok(idb) || ui === "auto",
    detail: ok(idb) ? `idb ${idb.stdout.trim()}` : `backend=${ui}; idb unavailable`,
    fix: "P0 build/run/screenshot works without UI backend. Install idb later for tap/swipe/type.",
  })

  return {
    ok: checks.every((item) => item.ok),
    checks,
  }
}

/**
 * 从 simctl list --json 输出中筛出 available 的模拟器。
 * 解析失败返回空数组：JSON 结构异常不应让整份预检崩掉，而是体现为「没有可用设备」。
 */
function readAvailableDevices(value: string) {
  try {
    return parseSimulators(value).filter((item) => item.available)
  } catch (err) {
    return []
  }
}
