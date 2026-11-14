/**
 * AVD（Android Virtual Device）与模拟器生命周期能力：列举/创建 AVD、启动新模拟器、停止模拟器，
 * 以及为其它工具提供「确保有可用设备」的兜底逻辑。
 *
 * 职责边界：负责设备选择与模拟器进程管理，不做 APK 构建、安装与 UI 操作。
 * 副作用：createAvd 会写 AVD 目录并走 avdmanager；startEmulator 会常驻拉起 emulator 进程（detached 后 unref）；
 * stopEmulator 会按 serial 杀掉模拟器。
 * 失败语义：命令失败/超时抛 Error 并带输出摘要；启动阶段超时抛带设备状态列表的错误，便于判断卡在哪一步。
 * 不变式：startEmulator 只用于新建，禁止传 serial 复用；启动后必须等 boot_completed 才返回可用设备。
 */
import { spawn as spawnChild } from "node:child_process";
import { brief, ok, run } from "../lib/run.js";
import { androidSystemImagePackage } from "./config.js";
import { isBootComplete, listDevices, pickDevice, validSerial, type Device } from "./device.js";
import { androidEnv, requireTool } from "./sdk.js";

/**
 * 对外暴露的 AVD 摘要，只包含名称；路径等内部信息不返回，避免把用户目录结构泄露给模型。
 */
type Avd = {
  name: string;
};

/**
 * 启动/确保设备的入参：serial 表示复用既有目标，avd 指定新建时使用的 AVD，
 * timeoutMs 同时约束「等待设备就绪」与「等待新模拟器 boot」的总时长。
 */
type StartInput = {
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

/**
 * 启动结果：在 Device 信息之上补充 reused/started 两个互斥标记。
 * started=true 表示本次调用新拉起了模拟器进程；reused 为其取反，调用方可据此决定是否提示等待时间。
 */
type StartResult = Device & {
  reused: boolean;
  started: boolean;
};

/**
 * AVD 名称白名单：允许字母数字、下划线、点、空格与连字符。
 * 该值会进入 emulator/avdmanager 参数，限制字符集可避免路径分隔符与 shell 元字符。
 */
const AVD = /^[A-Za-z0-9_. -]+$/;
// 轮询间隔：模拟器冷启动通常数十秒，2 秒一次既能及时返回又不会频繁打 adb。
const EMULATOR_BOOT_POLL_MS = 2_000;
// 查询 AVD 名的命令很快，5 秒足够；超时视为「查不到」而不是致命错误。
const AVD_NAME_TIMEOUT_MS = 5_000;

/**
 * 列出本机可见的 AVD。
 *
 * 通过 emulator -list-avds 获取，输出逐行即 AVD 名，因此无需额外解析文件系统。
 * 副作用：只读，不启动模拟器。失败语义：命令失败或超时抛 Error(brief)，由工具层转成错误结果。
 */
export async function listAvds(): Promise<Avd[]> {
  const emulator = await requireTool("emulator");
  const out = await run([emulator, "-list-avds"], { timeout: 20_000, env: await androidEnv() });
  if (!ok(out)) throw new Error(brief(out));
  return parseAvds(out.stdout);
}

/**
 * 解析 emulator -list-avds 的纯文本输出。
 *
 * 兼容 CRLF/LF（Windows 与 macOS 输出差异），去掉空行后每行映射为 {name}。
 * 纯函数、无副作用；不在此处校验名称合法性，校验放在 pickAvd，避免历史 AVD 名导致列举失败。
 */
export function parseAvds(value: string): Avd[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((name) => ({ name }));
}

/**
 * 保证有一个可用设备：优先复用，必要时新建模拟器。
 *
 * 决策顺序：显式 serial → 校验并等待其就绪；否则尝试挑选任意就绪设备（adb 失败不致命，视为没有）；
 * 都没有才调用 startEmulator。副作用：可能拉起模拟器进程。
 * 失败语义：serial 非法或指定设备不就绪会抛错；自动挑选阶段的 adb 失败被吞掉，是为了让后续启动路径有机会兜底。
 * 返回口径：Device，调用方可直接拿 serial 执行 adb 命令。
 */
export async function ensureDevice(input: StartInput = {}): Promise<Device> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (input.serial) return waitForReadyTarget(await pickDevice({ serial: input.serial }), timeoutMs);
  // 自动挑选失败（adb 未就绪、无设备）不应直接报错，否则会挡住「按需启动模拟器」的主路径。
  const ready = await pickDevice().catch(() => undefined);
  if (ready) return waitForReadyTarget(ready, timeoutMs);
  return startEmulator(input);
}

/**
 * 按 AVD 启动一个全新的 GUI 模拟器，并等待其 boot 完成后返回。
 *
 * 副作用：spawn emulator 进程（stdio=ignore、unref），进程生命周期超出本次调用；同时会占用 AVD 实例。
 * 失败语义：显式传 serial 视为调用错误（该工具只负责新建）；AVD 已在运行时抛出带 serial 的提示；
 * spawn 失败或 boot 超时抛 Error，超时信息包含当前 adb 设备状态，便于用户排查。
 * 不变式：先用 start 前设备集合做差集，再按 AVD 名匹配，避免把其它已在运行的模拟器误判为本次启动结果。
 */
export async function startEmulator(input: StartInput = {}): Promise<StartResult> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  // serial 与「新建模拟器」语义冲突，提前报错比后续 adb 匹配失败更易理解。
  if (input.serial) {
    throw new Error(
      "android_start_emulator always starts a new emulator. Reuse an existing target by passing serial to build, install, launch, screenshot, log, or UI tools.",
    );
  }
  const avd = await pickAvd(input.avd);
  const running = await runningAvd(avd.name);
  // 同一 AVD 不能被两个 emulator 进程同时占用，先查运行实例并回传 serial，引导调用方复用。
  if (running) {
    throw new Error(
      `Android AVD "${avd.name}" is already running as ${running.serial}. Reuse it by passing serial "${running.serial}" to target tools, or choose another AVD.`,
    );
  }
  // 记录启动前的设备集合，后面只认「新增且 AVD 名匹配」的实例，避免误返回已有模拟器。
  const before = new Set((await listDevices().catch(() => [])).map((item) => item.serial));
  const emulator = await requireTool("emulator");
  const env = await androidEnv();
  const child = spawnChild(emulator, ["-avd", avd.name], {
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (item): item is [string, string] => typeof item[1] === "string",
      ),
    ),
    shell: false,
    stdio: "ignore",
  });
  await waitForSpawn(child);
  child.unref();
  const device = await waitForStartedDevice(before, avd.name, timeoutMs);
  return targetResult({ ...device, raw: `${device.raw} pid:${child.pid}` }, true);
}

/**
 * 停止指定 serial 的模拟器（adb emu kill）。
 *
 * serial 必须通过 validSerial 校验，防止把任意字符串作为 adb -s 参数注入。
 * 副作用：终止模拟器进程与其虚拟设备；仅适用于 emulator，不用于真机。
 * 失败语义：命令非零退出或超时抛 Error(brief)；返回 stopped=true 表示 kill 命令已被接受。
 */
export async function stopEmulator(input: { serial: string }) {
  if (!validSerial(input.serial)) throw new Error(`Invalid Android device serial: ${input.serial}`);
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", input.serial, "emu", "kill"], {
    timeout: 20_000,
    env: await androidEnv(),
  });
  if (!ok(out)) throw new Error(brief(out));
  return { stopped: true, serial: input.serial };
}

/**
 * 用 avdmanager 创建 AVD。
 *
 * 名称优先取入参，其次环境变量 ANDROID_PLUGIN_DEFAULT_AVD，最后默认 medium_phone；
 * 系统镜像默认按 API/variant/ABI 推导，也可由 packageId 覆盖。
 * 副作用：写 AVD 配置目录；force=true 时覆盖同名 AVD，会破坏原有配置，调用方需确认。
 * stdin 固定写入 "no\n"，用于自动拒绝 avdmanager 的「是否创建自定义硬件配置」交互，避免进程挂起。
 * 失败语义：命令失败/超时抛 Error(brief)；SDK license 未接受时错误会体现在输出摘要中。
 */
export async function createAvd(
  input: { name?: string; packageId?: string; device?: string; force?: boolean } = {},
) {
  const name = cleanAvd(input.name || process.env.ANDROID_PLUGIN_DEFAULT_AVD || "medium_phone");
  const pkg = input.packageId || defaultSystemImage();
  const avdmanager = await requireTool("avdmanager");
  const args = ["create", "avd", "--name", name, "--package", pkg];
  if (input.device) args.push("--device", input.device);
  if (input.force) args.push("--force");
  const out = await run([avdmanager, ...args], {
    input: "no\n",
    timeout: 120_000,
    env: await androidEnv(),
  });
  if (!ok(out)) throw new Error(brief(out));
  return {
    created: true,
    name,
    packageId: pkg,
    output: brief(out),
  };
}

/**
 * 选择一个 AVD：显式名称优先精确匹配，其次大小写不敏感的子串匹配（容忍用户简写），
 * 否则退回列表首个。名称非法直接抛错；完全没有 AVD 时给出创建指引，而不是返回 undefined。
 */
async function pickAvd(name?: string): Promise<Avd> {
  // 名称会进入 emulator 参数，先做格式校验再查列表，避免带路径分隔符的值穿透。
  if (name && !AVD.test(name)) throw new Error(`Invalid Android AVD name: ${name}`);
  const avds = await listAvds();
  const want = name || process.env.ANDROID_PLUGIN_DEFAULT_AVD;
  if (want) {
    const hit = avds.find(
      (item) => item.name === want || item.name.toLowerCase().includes(want.toLowerCase()),
    );
    if (hit) return hit;
  }
  const first = avds[0];
  if (first) return first;
  throw new Error(
    "No Android AVDs found. Create one in Android Studio or call android_create_avd after confirming setup.",
  );
}

/**
 * 轮询等待「本次新启动的」模拟器完成 boot，并按 AVD 名确认身份。
 *
 * 只接受新出现且 boot_completed 的实例，再比对 emu avd name，避免 AVD 名相同前缀或其它实例干扰。
 * 失败语义：超时抛出包含当前设备状态列表的错误，帮助区分「进程没起来」「adb 未识别」「boot 卡住」。
 */
async function waitForStartedDevice(
  before: Set<string>,
  avdName: string,
  timeoutMs: number,
): Promise<Device> {
  const deadline = Date.now() + timeoutMs;
  let last: Device[] = [];
  while (Date.now() < deadline) {
    last = await listDevices().catch(() => []);
    for (const fresh of startedEmulatorCandidates(last, before)) {
      if (!(await isBootComplete(fresh.serial))) continue;
      // 查不到 AVD 名（命令失败）视为该实例不匹配，继续轮询其它候选，不中断整体等待。
      const name = await avdNameFor(fresh.serial).catch(() => undefined);
      if (name === avdName) return fresh;
    }
    await sleep(EMULATOR_BOOT_POLL_MS);
  }
  const detail = last.length
    ? last.map((item) => `${item.serial}:${item.state}`).join(", ")
    : "no adb devices";
  throw new Error(`Timed out waiting for Android Emulator to boot (${detail}).`);
}

/**
 * 从 adb 设备列表中筛出「本次新增、已 online 的模拟器」候选。
 *
 * 以 before 集合做差集，剔除调用前就已存在的设备；只接受 kind=emulator 且 state=device，
 * 因为 offline/unauthorized 的实例还不能执行命令，提前返回会误导调用方。
 */
export function startedEmulatorCandidates(devices: Device[], before: Set<string>): Device[] {
  return devices.filter((item) => {
    return item.kind === "emulator" && item.state === "device" && !before.has(item.serial);
  });
}

/**
 * 等待既有目标设备可用：真机直接返回；模拟器需轮询 boot_completed。
 *
 * 真机没有可靠的 boot 标志，因此跳过等待；模拟器冷启动期间 adb 可能已可见但系统未就绪，
 * 直接执行安装会失败，所以必须等到 boot 完成。失败语义：超时抛 Error 并带上 serial。
 */
async function waitForReadyTarget(device: Device, timeoutMs: number): Promise<Device> {
  // 真机视为已就绪，避免对真机做无意义的 sys.boot_completed 轮询。
  if (device.kind !== "emulator") return device;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBootComplete(device.serial)) return device;
    await sleep(EMULATOR_BOOT_POLL_MS);
  }
  throw new Error(`Timed out waiting for Android Emulator to boot (${device.serial}).`);
}

/**
 * 查找某个 AVD 当前是否已有运行中的模拟器实例。
 *
 * 只检查 online 的 emulator，逐个用 emu avd name 反查；单台查询失败被吞掉并继续，
 * 因为一台设备不认识该命令不应阻断对其余设备的判断。无匹配返回 undefined。
 */
async function runningAvd(name: string): Promise<Device | undefined> {
  const emulators = (await listDevices().catch(() => [])).filter(
    (item) => item.kind === "emulator" && item.state === "device",
  );
  for (const device of emulators) {
    const avdName = await avdNameFor(device.serial).catch(() => undefined);
    if (avdName === name) return device;
  }
  return undefined;
}

/**
 * 查询指定模拟器实例对应的 AVD 名。
 *
 * 输出首行非 OK 的文本即 AVD 名（emulator 会先打印 "OK"）；命令失败或超时返回 undefined，
 * 由调用方决定是视为不匹配还是致命错误。超时单独收紧到 5 秒，避免单台设备拖慢整体轮询。
 */
async function avdNameFor(serial: string): Promise<string | undefined> {
  const adb = await requireTool("adb");
  const out = await run([adb, "-s", serial, "emu", "avd", "name"], {
    timeout: AVD_NAME_TIMEOUT_MS,
    env: await androidEnv(),
  });
  if (!ok(out)) return undefined;
  return out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== "OK");
}

/**
 * 组装 StartResult，reused 与 started 互斥。
 *
 * 当前实现只在新启动场景调用（started=true），因此 reused 恒为 false；
 * 保留字段是为了让调用方无需区分「复用/新建」两条返回路径。
 */
function targetResult(device: Device, started: boolean): StartResult {
  return {
    ...device,
    reused: !started,
    started,
  };
}

/**
 * 轮询等待用的延时工具，不消耗 CPU；模拟器启动期间由 setTimeout 驱动检查节奏。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待子进程真正 spawn 成功或报错。
 *
 * Node 的 spawn() 是异步的，同步返回不代表可执行文件存在；这里以 spawn 事件作为启动成功信号，
 * error 事件则 reject，避免后续轮询在进程根本没起来时白等整个超时。
 */
function waitForSpawn(child: ReturnType<typeof spawnChild>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

/**
 * 校验并规范化 AVD 名，确保落盘与命令参数都使用无首尾空白的值。
 */
function cleanAvd(value: string): string {
  if (!AVD.test(value)) throw new Error(`Invalid Android AVD name: ${value}`);
  return value.trim();
}

/**
 * 默认系统镜像包名，实际取值委托 config.ts，保证 API 级别/variant/ABI 的默认口径只有一处定义。
 */
function defaultSystemImage(): string {
  return androidSystemImagePackage();
}
