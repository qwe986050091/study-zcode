/**
 * 模拟器 UI 自动化（基于 `idb`）。
 *
 * 职责：点击、滑动、输入文本、按硬件键、读取界面元素描述；所有操作前先确保设备已启动。
 * 输入口径：`Target` 的 udid/device/runtime 透传给 `boot`；坐标/时长/文本直接作为 idb 参数。
 * 输出口径：统一返回 `{backend:"idb", udid, output}`，output 为截断到 20000 字符的命令摘要。
 * 失败语义：idb 未安装或不在 PATH 时抛错并给出安装提示；命令非零退出抛 Error(brief(out))。
 * 副作用：真实操作模拟器 UI；`status` 之外的调用都要求 idb 可用。
 * 不变量：`reservedBackends` 保留 xcodebuildmcp 占位，调用方据此判断未来可选后端。
 */
import { brief, ok, run } from "../lib/run.js"
import { boot } from "./sim.js"

type Target = {
  udid?: string
  device?: string
  runtime?: string
}

type Tap = Target & {
  x: number
  y: number
  duration?: number
}

type Swipe = Target & {
  x1: number
  y1: number
  x2: number
  y2: number
  delta?: number
}

type Text = Target & {
  text: string
}

type Button = Target & {
  button: "APPLE_PAY" | "HOME" | "LOCK" | "SIDE_BUTTON" | "SIRI"
  duration?: number
}

/**
 * 查询 UI 自动化后端可用性。
 * 输出：`{backend, available, detail, reservedBackends}`；detail 在不可用时给出固定提示文案。
 * 副作用：只执行 `idb --version` 探测，不操作设备。
 */
export async function status() {
  const idb = await run(["idb", "--version"], { timeout: 5000 })
  return {
    backend: "idb",
    available: ok(idb),
    detail: ok(idb) ? brief(idb) : "idb is not installed or not on PATH",
    reservedBackends: ["xcodebuildmcp"],
  }
}

/**
 * 点击指定坐标。
 * 输入：x/y 必填；duration 可选（长按时长，单位由 idb 定义）。
 * 输出：idb 命令摘要；失败抛错。
 * 副作用：在目标模拟器上产生一次点击事件。
 */
export async function tap(input: Tap) {
  const sim = await target(input)
  return exec(sim.udid, [
    "ui",
    "tap",
    String(input.x),
    String(input.y),
    ...(input.duration === undefined ? [] : ["--duration", String(input.duration)]),
  ])
}

/**
 * 执行滑动手势。
 * 输入：起止坐标 (x1,y1)→(x2,y2)；delta 可选，用于控制滑动速度/步长。
 * 输出：idb 命令摘要；失败抛错。
 * 副作用：在目标模拟器上产生滑动事件。
 */
export async function swipe(input: Swipe) {
  const sim = await target(input)
  return exec(sim.udid, [
    "ui",
    "swipe",
    String(input.x1),
    String(input.y1),
    String(input.x2),
    String(input.y2),
    ...(input.delta === undefined ? [] : ["--delta", String(input.delta)]),
  ])
}

/**
 * 向当前焦点输入文本。
 * 输入：`text` 原样作为 idb 参数（调用方需确保已聚焦输入框）。
 * 输出：idb 命令摘要；失败抛错。
 * 副作用：向模拟器注入键盘输入。
 */
export async function typeText(input: Text) {
  const sim = await target(input)
  return exec(sim.udid, ["ui", "text", input.text])
}

/**
 * 触发硬件/系统按键（APPLE_PAY/HOME/LOCK/SIDE_BUTTON/SIRI）。
 * 输入：button 为受控枚举，duration 可选；非法值由类型系统拦截。
 * 输出：idb 命令摘要；失败抛错。
 * 副作用：产生系统级按键事件。
 */
export async function button(input: Button) {
  const sim = await target(input)
  return exec(sim.udid, [
    "ui",
    "button",
    input.button,
    ...(input.duration === undefined ? [] : ["--duration", String(input.duration)]),
  ])
}

/**
 * 读取当前界面元素树（JSON）。
 * 输入：可选 Target，用于选择设备。
 * 输出：idb 的 `describe-all --json` 摘要；可供上层解析元素 id/label。
 * 失败语义：idb 不可用或命令失败抛错。
 */
export async function describe(input: Target = {}) {
  const sim = await target(input)
  return exec(sim.udid, ["ui", "describe-all", "--json"])
}

/** 把 Target 归一为已启动的模拟器；所有 UI 操作共用，避免重复 boot 逻辑。 */
async function target(input: Target) {
  return boot({ udid: input.udid, name: input.device, runtime: input.runtime })
}

/**
 * 统一执行 idb 命令。
 * 行为：先探测后端可用性，不可用时直接给出安装指引；成功时返回截断后的输出。
 * 失败语义：后端不可用或非零退出都抛错，不返回半成品结果。
 */
async function exec(udid: string, args: string[]) {
  const found = await status()
  if (!found.available) {
    throw new Error("UI automation backend unavailable. Install idb and idb-companion, or use build/run/screenshot tools only.")
  }
  const out = await run(["idb", ...args, "--udid", udid], { timeout: 60_000 })
  if (!ok(out)) throw new Error(brief(out))
  return {
    backend: "idb",
    udid,
    output: brief(out, 20_000),
  }
}
