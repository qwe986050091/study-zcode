/**
 * Gradle 构建与「构建后安装启动」能力。
 *
 * 职责边界：负责定位项目根、选择 module/variant、执行 Gradle 任务、记录构建日志并找出 APK；
 * 不负责创建项目（project-template）与设备启动细节（avd），安装/启动委托 app.ts。
 * 副作用：真实执行 Gradle 构建（可能数分钟）、写日志文件到插件数据目录、注册 wrapper。
 * 失败语义：构建失败不抛错，而是返回 ok=false 与日志摘要，便于模型读取错误；只有「构建成功但找不到产物」
 * 这类无法继续的组合流程才抛错。
 * 跨平台：Windows 使用 gradlew.bat，其余平台使用 gradlew，路径统一走 path.join。
 * 返回口径：apkPath/logPath 均为相对 cwd 的路径，避免暴露绝对路径；applicationId 可能缺省。
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { data, inside, rel } from "../lib/path.js";
import { brief, ok, run, type Run } from "../lib/run.js";
import { install, launch } from "./app.js";
import { ensureDevice } from "./avd.js";
import { discover, findApks } from "./project.js";
import { androidEnv, findTool } from "./sdk.js";

/**
 * 构建入参。projectDir 为相对 cwd 的路径；module/variant 缺省时使用发现结果；
 * applicationId 仅作为兜底覆盖；serial/avd/timeoutMs 透传给设备准备与 adb 操作。
 */
type Build = {
  projectDir?: string;
  module?: string;
  variant?: string;
  applicationId?: string;
  serial?: string;
  avd?: string;
  timeoutMs?: number;
};

/**
 * 构建并启动的入参，在 Build 之上增加 launchActivity；
 * 该字段只影响启动时使用 am start -W，不影响构建。
 */
type RunApp = Build & {
  launchActivity?: string;
};

/**
 * 执行 Android Gradle 构建并返回结构化结果。
 *
 * 流程：定位项目根 → discover 补全模块/variant/applicationId → 拼 assemble<Variant> 任务 → 执行 gradle →
 * 落盘构建日志 → 成功时查找 APK。
 * 副作用：启动 gradle 子进程（默认超时 600 秒），写日志文件；不安装到设备。
 * 失败语义：构建失败（非零退出/超时）返回 ok=false、code、timedOut 与截断日志，不抛异常；
 * 调用方需同时看 ok 与 apkPath，不能仅凭 apkPath 判断可安装。
 * 不变式：module 名去掉前导冒号，避免拼出 `::app:assemble` 这类非法任务路径。
 */
export async function buildApp(input: Build = {}) {
  const root = await projectRoot(input.projectDir);
  const found = await discover(root);
  const module = normalizeModule(input.module || found.modules[0] || "app");
  const variant = input.variant || found.variants[0] || "debug";
  const task = `:${module}:assemble${cap(variant)}`;
  const gradle = await gradleCommand(root);
  const out = await run([...gradle, task], {
    cwd: root,
    timeout: input.timeoutMs ?? 600_000,
    env: await androidEnv(),
  });
  const log = await record("build", out);
  // 仅在构建成功时查找 APK，失败时产物可能残缺，继续查找会误导调用方。
  const apk = ok(out) ? await findApk(root, module, variant) : undefined;
  const applicationId = input.applicationId || found.applicationIds[0];

  return {
    ok: ok(out),
    root: rel(root),
    module,
    variant,
    task,
    apkPath: apk ? rel(apk) : undefined,
    applicationId,
    logPath: log,
    code: out.code,
    timedOut: out.timed,
    output: brief(out, 12_000),
  };
}

/**
 * 构建后依次准备设备、安装 APK、启动应用。
 *
 * 副作用：链式触发 Gradle、可能拉起模拟器、adb install 与 am start；失败会在对应步骤抛出。
 * 失败语义：构建失败时返回 built 结果并标记 installed/launched=false（不抛错，让模型看到构建日志）；
 * 构建成功但缺 APK 或 applicationId 时抛错，因为无法继续后续步骤；设备/安装/启动失败原样上抛。
 * 返回口径：在 buildApp 结果上追加 device/installed/launched，applicationId 一定非空（否则前面已抛错）。
 */
export async function buildAndRun(input: RunApp = {}) {
  const built = await buildApp(input);
  if (!built.ok) return { ...built, installed: false, launched: false };
  if (!built.apkPath) throw new Error("Build succeeded, but no APK product was found.");
  if (!built.applicationId)
    throw new Error("Build succeeded, but applicationId could not be resolved.");
  const device = await ensureDevice({
    serial: input.serial,
    avd: input.avd,
    timeoutMs: input.timeoutMs,
  });
  const installed = await install({
    serial: device.serial,
    apkPath: built.apkPath,
    timeoutMs: input.timeoutMs,
  });
  const launched = await launch({
    serial: device.serial,
    applicationId: built.applicationId,
    activity: input.launchActivity,
    timeoutMs: input.timeoutMs,
  });
  return { ...built, device, installed, launched };
}

/**
 * 解析项目根目录：显式 projectDir 需经 inside() 限制在工作区内；
 * 未指定时用 discover 结果，root 为空串表示当前目录，仍走 inside 做规范化与越界校验。
 */
async function projectRoot(raw?: string): Promise<string> {
  if (raw) return inside(process.cwd(), raw);
  const found = await discover();
  if (found.root !== undefined) return inside(process.cwd(), found.root || ".");
  throw new Error("No Android Gradle project found. Use android_create_app first.");
}

/**
 * 在项目构建产物中查找指定 module 的 APK，并按 variant 挑选。
 * 返回 undefined 表示没有找到产物，由调用方决定是报错还是降级。
 */
async function findApk(
  root: string,
  module: string,
  variant: string,
): Promise<string | undefined> {
  const hits = await findApks(root, [module]);
  return pickApk(hits, variant);
}

/**
 * 从 APK 列表中挑选与 variant 匹配的产物。
 *
 * 优先匹配路径中的 /<variant>/ 目录（大小写不敏感），匹配不到则退回第一个，
 * 保证 release/debug 并存时不会误装；返回 undefined 由调用方处理缺失产物。
 */
export function pickApk(hits: string[], variant: string): string | undefined {
  const want = `${path.sep}${variant.toLowerCase()}${path.sep}`;
  return hits.find((item) => item.toLowerCase().includes(want)) || hits[0];
}

/**
 * 决定使用哪个 Gradle 命令。
 *
 * 优先项目自带 wrapper（Windows 用 gradlew.bat），保证版本与项目锁定一致；
 * 没有 wrapper 时尝试全局 gradle，并顺手执行 wrapper 任务生成 wrapper，下次即可复用；
 * 生成失败仍退回全局 gradle，最后两者都没有才抛错。
 */
async function gradleCommand(root: string): Promise<string[]> {
  const wrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (await exists(wrapper)) return [wrapper];
  const gradle = await findTool("gradle");
  if (gradle) {
    const generated = await run([gradle, "wrapper", "--gradle-version", "8.9"], {
      cwd: root,
      timeout: 120_000,
      env: await androidEnv(),
    });
    // wrapper 生成成功且文件确实存在才使用，避免 gradle 返回 0 但未真正写出脚本。
    if (ok(generated) && (await exists(wrapper))) return [wrapper];
    return [gradle];
  }
  throw new Error(
    "No Gradle wrapper or gradle executable found. Generate a wrapper or install Gradle.",
  );
}

/**
 * 把一次构建的完整输出落盘为日志文件，返回相对路径供模型引用。
 *
 * 文件名包含时间戳、任务名和 cwd 的短哈希：时间戳便于排序，cwd 哈希避免不同项目同名日志互相覆盖。
 * 副作用：创建目录并写文件；写盘失败会抛错，属于「构建已完成但日志记录失败」的边界情况。
 */
async function record(name: string, out: Run): Promise<string> {
  const dir = await data("logs");
  const file = path.join(dir, `${stamp()}-${name}-${key(process.cwd())}.log`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    [
      `$ ${out.cmd.join(" ")}`,
      `exit=${out.code}`,
      `timedOut=${out.timed}`,
      "",
      out.stdout,
      out.stderr,
    ].join("\n"),
    "utf8",
  );
  return rel(file);
}

/**
 * 判断文件/路径是否存在。
 * 用 access 而非 stat，因为这里只关心可访问性；任何错误都视为不存在，不区分权限或路径类型。
 */
async function exists(file: string): Promise<boolean> {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

/**
 * 规范化 Gradle 模块名：去掉调用方可能带上的前导冒号，空值回退 "app"。
 */
function normalizeModule(value: string): string {
  return value.replace(/^:+/, "") || "app";
}

/**
 * 把 variant 名转成 Gradle 任务的驼峰形式（debug → Debug，free-debug → FreeDebug）。
 * 只处理 - 与 _ 分隔符，符合 AGP 对 build type / flavor 的命名规则。
 */
function cap(value: string): string {
  return value
    .split(/[-_]/g)
    .map((item) => item.charAt(0).toUpperCase() + item.slice(1))
    .join("");
}

/**
 * 计算 cwd 的 8 位短哈希，用于日志文件名去重；不用于安全用途。
 */
function key(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

/**
 * 生成文件名安全的时间戳：ISO 字符串中的冒号与点在 Windows 上非法，统一替换为短横线。
 */
function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}
