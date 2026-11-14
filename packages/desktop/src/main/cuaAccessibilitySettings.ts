/* eslint-disable max-lines -- 安装验签、main 级权限会话和拖拽 TOCTOU 共同维护同一 Helper identity */
// 授权引导不触发任何 macOS 原生权限弹窗。若每个 TCC stage 先经 LaunchServices
// 拉起 Helper 到一次性权限请求模式，由 Helper 进程内命中 AXIsProcessTrustedWithOptions{prompt:true}
// / CGRequestScreenCaptureAccess 来让自己“自动出现在权限列表里”，代价是一个打断用户的系统对话框。
// 只打开对应设置页，Helper 进入 TCC 列表由用户从浮窗把 .app 拖进列表完成
// （实测拖入后 auth_value 直接为 2，比弹窗少一步——弹窗只创建条目，仍需用户自己找到并勾选）。
// 每 stage 的验签指纹不再交给 open(2) 前的终检，而是登记到会话上，由 dragstart 前的同步比对消费。
// INV-01 仅 macOS 提供该授权引导：平台不是 darwin 时两个入口都直接返回失败，不安装也不打开任何设置页；守住位置：openCuaPermissionOnboarding 与 prepareCuaHelperPermissionDrag 的平台判断；改错故障：Windows/Linux 用户收到一次 x-apple 深链打开失败，并被引导去授权一个本机不存在的 TCC 主体
// INV-02 安装或验签失败必须 fail-closed，禁止回退到“路径存在即使用”；守住位置：openCuaPermissionOnboarding 的 ensureInstalled 异常分支；改错故障：用户把辅助功能授权给坏签名或旧版 bundle，TCC 条目指向错误主体，Computer Use 之后静默失效
// INV-03 授权身份只能由验签通过的 helperAppPath 解析，不得用配置路径或缓存路径；守住位置：openCuaPermissionOnboarding 中 resolveHelperIdentity 的入参；改错故障：引导落到另一个可执行体，系统设置里勾选的那一行与实际运行的 Helper 不是同一个
// INV-04 每个 stage 启动前都必须重新建立验签证据，首次 ensureInstalled 的结论不得跨 stage 复用；守住位置：runSession 循环内 verifyHelperPermissionIdentityUnchanged 的 launch 调用；改错故障：用户停留在设置页期间安装目录被替换，第二项权限被授予给恶意 bundle
// INV-05 指纹必须在完整验签之前抓取、验签之后立即比对，两个异步边界各一次；守住位置：verifyHelperPermissionIdentityUnchanged 的 fingerprint 与两次 unchanged 判断；改错故障：验签期间被替换的字节反而成为“已验证指纹”，同步拖拽校验形同虚设
// INV-06 验签后必须复核精确身份（appPath、executablePath、displayName、bundleId 全等），不能只比 bundleId；守住位置：verifyHelperPermissionIdentityUnchanged 内 sameHelperPermissionIdentity 的调用；改错故障：共享 bundleId 的另一份 app 继承本次授权结论，恢复权被授予错误的可执行体
// INV-07 成功返回前必须再跑一次 post-settings 验签，任何变化都不得授予恢复权；守住位置：runSession 末尾 openedPermissions 非空时的终检；改错故障：用户在设置页期间 Helper 被升级，重启后运行的是未授权的新版本，表现为权限已勾选却持续被拒
// INV-08 会话身份键必须覆盖 bundleId、displayName、appPath、executablePath 四个字段；守住位置：CuaPermissionOnboardingCoordinator.run 的 identityKey；改错故障：开发或升级窗口内两份 app 被合并成一个会话，后加入者拿到第一份的权限结果
// INV-09 同一身份键只允许一个进行中的会话，后续请求必须 join 而不是另起流程；守住位置：run 中 existing.promise 分支；改错故障：两组系统设置引导并发抢焦点，产生用户无法退出的中间态
// INV-10 终态会话的异步清理未完成时，新请求必须等原 promise 释放身份键后再重试；守住位置：run 中 existing.promise.then 分支；改错故障：新旧 LaunchServices 实例交叠，系统设置权限列表里出现两条同名 Helper 条目
// INV-11 参与者各自持有 abort 监听，任一窗口关闭只摘除自身，不得直接取消共享会话；守住位置：joinSession 的 onAbort；改错故障：一个窗口先关闭导致其余窗口的引导被取消，用户看到“已取消”却仍停在设置页
// INV-12 只有最后一个参与者离开时才 abort 共享会话，并在同一时刻关闭 requirement join 门；守住位置：onAbort 内 activeParticipants.size 判断；改错故障：后续显式重试被并入已取消的会话，收到一次假成功
// INV-13 恢复权按 participantKey 去重，同一 host 只授予一次、不同窗口各授予一次；守住位置：joinSession 的 recoveryOwnerParticipantKeys 判断；改错故障：同一 renderer 重复点击触发多次 Helper 重启，或多窗口里的第二个窗口永远拿不到恢复
// INV-14 会话总超时覆盖全部 stage，每轮都要按已耗时重算剩余预算；守住位置：runSession 的 sessionTimer 与 remainingMs 计算；改错故障：两个 stage 各自满额计时，用户等待时长翻倍并可能在中途被误判超时
// INV-15 每个 stage 的设置页返回超时必须夹到会话剩余预算之内，不得超过总超时；守住位置：returnTimeoutMs 的 Math.min 计算；改错故障：单项返回超时晚于会话超时，会话先被 abort，用户看到失败提示但设置页仍开着
// INV-16 打开设置页之前必须先注册 return 信号，顺序不得颠倒；守住位置：openSettingsAndWaitForReturn 的调用契约与 runSession 的调用点；改错故障：System Settings 的切走与返回落在监听器空窗内，引导永远等不到返回而超时
// INV-17 没有 main return 信号的兼容路径不得把 returnedFromSettings 置为 true；守住位置：runSession 的 else 分支与最终 returnedFromSettings 计算；改错故障：renderer 以为用户已返回并触发 Helper 重启，实际用户还停在设置页
// INV-18 权限阶段顺序固定为先辅助功能后屏幕录制，与系统设置列表顺序一致；守住位置：PERMISSION_STAGE_ORDER 与 normalizeRequiredPermissions 的 filter；改错故障：用户先被带到屏幕录制页，勾完发现还要再走一遍，误以为第一次没生效
// INV-19 未知权限值一律收窄为 accessibility，不得抛错也不得透传到下游；守住位置：normalizePermission 与 normalizeRequiredPermissions 的 filter；改错故障：renderer 传了拼错的值导致整条引导失败，或落到未定义分支打开错误设置页
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";
import type { CuaHelperInstallerOptions } from "@zcode/services/node";
import {
  resolveHelperPermissionSubjectIdentity,
  type HelperPermissionSubjectIdentity,
} from "@zcode/services/cua-permission-broker";
import type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { createDesktopCuaHelperInstaller } from "./desktopCuaHelperInstaller.js";

// 两个常量是全文件唯一的深链定义，其他位置只能经 settingsUrlForPermission 取用
// 深链只负责把 System Settings 切到对应隐私面板，不触发任何 TCC 原生授权弹窗
// 面板锚点 Privacy_Accessibility 与 Privacy_ScreenCapture 是未公开格式，拼错会落到 Security 首页
// 打开面板后无法预选或高亮具体条目，Helper 能否出现在列表里取决于用户拖入或此前授权
// [失败路径] shell.openExternal 对未注册 scheme 会静默失败，调用方只能按“已尝试打开”继续流程
// 若改用 AppleScript 或按 bundle id 打开，会额外要求自动化权限，在授权引导里再套一层授权
export const MACOS_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
export const MACOS_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export interface OpenCuaAccessibilitySettingsOptions {
  initialPermission?: CuaPermissionKind;
  requiredPermissions?: CuaPermissionKind[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** main IPC 注入的 renderer/webContents 身份；同一 host 的重复 join 只授予一次 recovery。 */
  participantKey?: string;
  sessionTimeoutMs?: number;
  settingsReturnTimeoutMs?: number;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  ensureHelperInstalled?: () => Promise<string>;
  /** 测试或宿主显式注入；生产默认从 Electron Resources 解析随包 Helper。 */
  bundledHelperAppPath?: string;
  /** 每个 TCC stage 启动前重新执行完整安装验签；生产默认使用 installer.verifyInstalled。 */
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
  openSettingsUrl?: (url: string) => Promise<void>;
  /**
   * 必须先注册 return 信号，再调用 openSettings，避免 System Settings 切走/返回发生在监听器空窗。
   * IPC 生产适配器监听 Electron app/browser-window；纯单测可立即执行 openSettings 并返回。
   */
  openSettingsAndWaitForReturn?: (options: {
    permission: CuaPermissionKind;
    sessionId: string;
    timeoutMs: number;
    signal: AbortSignal;
    openSettings: () => Promise<void>;
  }) => Promise<void>;
}

// 这里只限制“系统设置是否成功出现”的机器阶段；一旦确认设置页在前台，用户勾选权限不再受墙钟
// 倒计时约束，只由 surface cancel、origin destroyed 或 app quit 结束。
const DEFAULT_SETTINGS_RETURN_TIMEOUT_MS = 2 * 60_000;
// 旧拖拽引导把屏幕录制排在前面，与用户看到的权限列表顺序相反；
// 两项同时缺失时统一先处理辅助功能，再处理屏幕录制。
const PERMISSION_STAGE_ORDER: readonly CuaPermissionKind[] = ["accessibility", "screen_recording"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 拖拽 TOCTOU 门：prepare 时验过的 .app，可能在用户拖入系统设置前被同 UID 攻击者覆写，
// 而 TCC 绑定的是被拖入的 bundle 身份。拖拽当下必须有"自校验以来字节未变"的*同步*证据——但对 120MB
// bundle 跑 codesign 太慢会错过 dragstart 手势。改用轻量字节指纹：关键文件的 ino/ctime/size（ctime 是
// inode change time，用户态无法回拨），任何对 Mach-O / 签名清单 / Info.plist 的替换都会改变指纹。prepare
// 时抓一次，dragstart 前同步比对，不符即拒拖 + 清缓存重新 prepare。残留仅剩比对与 startDrag 之间的
// 微秒级窗口（与 launch 路径 verifyInstalled→launch 同源、同量级）。
export type CuaHelperBundleFingerprint = string;

function statSignature(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.ctimeNs}:${st.size}`;
  } catch {
    return "MISSING";
  }
}

// 广度优先遍历整个子树，把每个条目的相对路径与 stat 签名拼成一条可直接比较的串
// 相对路径参与拼接：同名文件换到别的子目录也会改变指纹，避免只比集合不比位置
// readdirSync 失败时 continue 而不中断：不可读子目录本身已由父层 stat 覆盖
// 子项按名字排序，保证同一棵树每次遍历产出稳定顺序，否则指纹会因目录返回顺序抖动而误报
// 条目数触到上限时追加 TOO_MANY 再提前返回，避免恶意构造的超宽树把主线程拖住
// [权衡] 上限意味着第 512 个之后的条目变化不会被发现，这是为同步性接受的已知缺口
// 该缺口只在 Resources 膨胀到异常规模时成立，正常包体积远低于此
// 若改成对整棵树做内容哈希，成本与上限问题都消失，但同步拖拽路径承受不了
function bundleTreeFingerprint(root: string, maxEntries = 512): string {
  const pending: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: root, relativePath: "." },
  ];
  const parts: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (parts.length >= maxEntries) return `${parts.join(",")},TOO_MANY`;
    parts.push(`${current.relativePath}:${statSignature(current.absolutePath)}`);
    let children: string[];
    try {
      children = readdirSync(current.absolutePath).sort();
    } catch {
      continue;
    }
    for (const child of children) {
      pending.push({
        absolutePath: join(current.absolutePath, child),
        relativePath: `${current.relativePath}/${child}`,
      });
    }
  }
  return parts.join(",");
}

// 指纹是 ino、ctimeNs、size 的拼接串，不做内容哈希，因为它要跑在 dragstart 之前的同步路径
// 不读文件内容：对上百 MB 的 bundle 做全量哈希会让 OS 拖拽手势窗口过期，用户拖不出任何东西
// ctime 是 inode change time，用户态无法回拨，任何写入、改名、chmod 都会推进它
// 覆盖四类位置：app 目录本体、_CodeSignature 清单、Info.plist、Resources 递归树
// Resources 必须递归：ax_macos.node 与随 SEA 分发的 dylib 都在那里，只 stat 清单发现不了原地覆写
// MacOS 目录单独枚举，目录缺失时写入 MISSING 而不是抛错，让后续比对自然判为变化
// [失败路径] 函数不 throw：所有 stat 失败都被折叠成 MISSING 字符串，调用方只需做字符串相等
// [权衡] 不解码签名也不校验 cdhash：那是 verifyInstalled 的职责，这里只提供“同一批字节”的廉价证据
export function captureCuaHelperBundleFingerprint(appPath: string): CuaHelperBundleFingerprint {
  const parts = [
    `app=${statSignature(appPath)}`,
    `sig=${statSignature(join(appPath, "Contents", "_CodeSignature", "CodeResources"))}`,
    `info=${statSignature(join(appPath, "Contents", "Info.plist"))}`,
    // ax_macos.node 与随 SEA 分发的 runtime dylib 都位于 Resources。只采 CodeResources 的 stat
    // 无法发现对资源文件的原地覆写；递归采 inode/ctime/size 才能在 dragstart 同步拒绝这种 TOCTOU。
    `resources=${bundleTreeFingerprint(join(appPath, "Contents", "Resources"))}`,
  ];
  try {
    const macosDir = join(appPath, "Contents", "MacOS");
    const entries = readdirSync(macosDir).sort();
    parts.push(
      `macos=${entries.map((entry) => `${entry}:${statSignature(join(macosDir, entry))}`).join(",")}`,
    );
  } catch {
    parts.push("macos=MISSING");
  }
  return parts.join("|");
}

export function cuaHelperBundleFingerprintUnchanged(
  appPath: string,
  fingerprint: CuaHelperBundleFingerprint,
): boolean {
  return captureCuaHelperBundleFingerprint(appPath) === fingerprint;
}

// renderer 传来的值不可信，只接受 screen_recording 这一种非默认取值
// 其余输入（缺省、拼错、null、对象）统一收敛到 accessibility，而不是抛错
// 收敛而非拒绝的理由：引导失败对用户毫无信息量，打开辅助功能面板至少是可恢复动作
// [失败路径] 若这里抛错，IPC 只回一条笼统失败，用户完全不知道要去授权什么
// 取值域必须与 normalizeRequiredPermissions 的 filter 完全一致，任一处放宽都会让未定义阶段进入循环
function normalizePermission(value: unknown): CuaPermissionKind {
  return value === "screen_recording" ? "screen_recording" : "accessibility";
}

function normalizeRequiredPermissions(
  options: OpenCuaAccessibilitySettingsOptions,
): CuaPermissionKind[] {
  const requested = Array.isArray(options.requiredPermissions)
    ? options.requiredPermissions
    : [normalizePermission(options.initialPermission)];
  const requestedSet = new Set(
    requested.filter(
      (permission): permission is CuaPermissionKind =>
        permission === "screen_recording" || permission === "accessibility",
    ),
  );
  // 先用 Set 去重再按常量顺序过滤，最终顺序由常量决定而不是调用方数组顺序
  // 去重的意义：同一权限被重复请求时只走一次 stage，不会第二次打开同一个面板
  // 过滤同时承担白名单职责，非法字符串不会进入会话的 requiredPermissions
  // 空数组是合法结果：runSession 立刻退出循环，并把 returnedFromSettings 判为 false
  // [权衡] 不在此处补一个默认 accessibility，调用方显式传空数组就是“没有要授权的项”，替它加项会打开用户没请求的面板
  // 若改成按调用方顺序执行，屏幕录制可能排在辅助功能前面，与用户看到的权限列表顺序相反
  return PERMISSION_STAGE_ORDER.filter((permission) => requestedSet.has(permission));
}

// 权限到面板的唯一映射点：settingsUrlForPermission 是生产路径与测试注入的唯一取址入口，禁止调用方自行拼深链
// 屏幕录制必须单独一个面板：macOS 把它放在 Screen Recording，不在 Accessibility 下
// 三元只区分两个已知值，其他值走 accessibility，与 normalizePermission 的兜底保持一致
// [权衡] 不写成 Record 查表：目前只有两项，新增权限时这里的类型收窄会强制改到，漏改编译不过
// 若要支持麦克风或自动化，必须同步改本函数与 PERMISSION_STAGE_ORDER，否则打开的面板与授权目标错位
function settingsUrlForPermission(permission: CuaPermissionKind): string {
  return permission === "screen_recording"
    ? MACOS_SCREEN_RECORDING_SETTINGS_URL
    : MACOS_ACCESSIBILITY_SETTINGS_URL;
}

// 精确身份是四个不可变字段的全等，不是 bundleId 前缀或 displayName 相似
// executablePath 必须单列：同一 bundle 内可执行体被替换时 bundleId 与文件名都可以保持不变
// displayName 也参与比较：TCC 列表按它展示，改名意味着用户勾选的是另一行
// [权衡] 不比 version 与 cdhash：版本升级本身是允许的，字节变化已由 bundle 指纹覆盖
// 补 cdhash 需要额外 codesign 调用，放在同步路径上会拖垮拖拽手势的响应窗口
// 任何字段不等都必须 throw，由上层转成 fail-closed 结果，不允许取其一继续
function sameHelperPermissionIdentity(
  expected: HelperPermissionSubjectIdentity,
  actual: HelperPermissionSubjectIdentity,
): boolean {
  return (
    expected.appPath === actual.appPath &&
    expected.executablePath === actual.executablePath &&
    expected.displayName === actual.displayName &&
    expected.bundleId === actual.bundleId
  );
}

// 链路固定为：抓快照、完整验签、快照比对、身份解析、快照再比对
// 快照在任何 await 之前取得，因此它代表“验签所针对的那批字节”，而不是验签之后的状态
// 验签后立刻比对：codesign 与 Gatekeeper 调用可能耗时数秒，期间目录可被同 UID 覆写
// 身份解析也是异步的，解析结果可能对应已被替换的 app，所以解析后必须再比一次
// 两次比对复用同一个 fingerprint，不在中途重抓，否则等于用新字节给自己背书
// 返回值是该链路上未变的指纹，交给 dragstart 同步比对消费，重建一次就失去意义
// phase 只影响报错文案，不参与 verifyHelperPermissionIdentityUnchanged 的判定，所以调用方据文案区分 launch 与 post-settings 现场
// [失败路径] 任一步 throw 都会在 runSession 的 catch 里转成 fail-closed，绝不降级为继续授权
async function verifyHelperPermissionIdentityUnchanged(
  identity: HelperPermissionSubjectIdentity,
  options: OpenCuaAccessibilitySettingsOptions,
  phase: "launch" | "post-settings",
): Promise<CuaHelperBundleFingerprint> {
  const fingerprint = captureCuaHelperBundleFingerprint(identity.appPath);
  await options.verifyHelperInstalled?.(identity.appPath);
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(`ZCode Computer Use changed while its ${phase} signature was being verified`);
  }
  const currentIdentity = await (
    options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
  )(identity.appPath);
  if (!sameHelperPermissionIdentity(identity, currentIdentity)) {
    throw new Error(`ZCode Computer Use permission identity changed during ${phase} verification`);
  }
  if (!cuaHelperBundleFingerprintUnchanged(identity.appPath, fingerprint)) {
    throw new Error(
      `ZCode Computer Use changed while its ${phase} permission identity was being resolved`,
    );
  }
  return fingerprint;
}

type CuaHelperInstallerLogger = NonNullable<CuaHelperInstallerOptions["logger"]>;

function toInstallerLogger(
  logger: OpenCuaAccessibilitySettingsOptions["logger"],
): CuaHelperInstallerLogger | undefined {
  if (!logger) return undefined;
  return {
    debug: (_traceId, ...args) => logger.debug?.(...args),
    info: (_traceId, ...args) => (logger.info ?? logger.warn)(...args),
    warn: (_traceId, ...args) => logger.warn(...args),
    error: (_traceId, ...args) => (logger.error ?? logger.warn)(...args),
  };
}

interface ActiveOnboardingSession {
  identity: HelperPermissionSubjectIdentity;
  sessionId: string;
  controller: AbortController;
  activeParticipants: Set<number>;
  requiredPermissions: Set<CuaPermissionKind>;
  processedPermissions: Set<CuaPermissionKind>;
  openedPermissions: CuaPermissionKind[];
  acceptingRequirements: boolean;
  recoveryOwnerParticipantKeys: Set<string>;
  /**
   * 每个 stage 重新建立的验签指纹证据，由 dragstart 前的同步比对消费
   * （拖入的 bundle 才是 TCC 绑定对象）。
   */
  launchFingerprint?: CuaHelperBundleFingerprint;
  promise?: Promise<CuaAccessibilitySettingsResult>;
}

/**
 * main-process 级协调器。key 使用 Helper 的精确授权身份而不是 renderer/window/workspace：macOS TCC
 * 只认这个授权主体，同一主体并发弹两组 native prompt 会互相抢焦点并产生不可恢复的中间态。
 */
// 进程内协调器，把“同一授权主体只跑一条引导”收敛到 CuaPermissionOnboardingCoordinator.sessions 这张以精确身份为键的表
// 键由四个身份字段拼串得到，不是 renderer、window 或 workspace 标识
// 会话状态包含参与者集合、必需项集合、已处理与已打开阶段、以及恢复权归属
// 一个会话只持有一个 AbortController，所有加入的参与者共享同一个取消信号
// acceptingRequirements 是 join 门：为 true 时新请求并入，为 false 时只能等清理完成后重开
// promise 同时承担单飞与“清理完成”两个职责，finally 里按引用比对后才删除条目
// [并发] 全部读写都在 main event loop 上串行发生，因此不加锁；代价是会话回调里禁止放同步长耗时操作，否则会卡住所有窗口
// 若改成按 workspace 或 window 建键，同一 Helper 会被并行引导两次，TCC 状态被交错覆盖
class CuaPermissionOnboardingCoordinator {
  private readonly sessions = new Map<string, ActiveOnboardingSession>();
  private nextParticipantId = 0;

  constructor(private readonly createSessionId: () => string = randomUUID) {}

  run(
    identity: HelperPermissionSubjectIdentity,
    requiredPermissions: CuaPermissionKind[],
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    // bundle id + displayName 不是“精确 Helper 身份”。开发/升级窗口内，两份不同路径或
    // executable 的 bundle 可以共享这两个字符串；若错误合并会话，后加入窗口会把权限结果和恢复权
    // 绑定到第一份 app。协调 key 覆盖验签后 identity 的全部不可变字段，任何路径/可执行体变化都隔离。
    const identityKey = [
      identity.bundleId,
      identity.displayName,
      identity.appPath,
      identity.executablePath,
    ].join("\0");
    const existing = this.sessions.get(identityKey);
    if (existing?.promise) {
      if (existing.acceptingRequirements) {
        for (const permission of requiredPermissions) {
          existing.requiredPermissions.add(permission);
        }
        options.logger?.info?.(
          "[cua-permission-onboarding] joined active Helper permission session",
          existing.sessionId,
          identity.bundleId,
        );
        return this.joinSession(existing, options.signal, options.participantKey);
      }
      // 上一会话已进入终态，但精确权限 Helper 的异步清理尚未完成。必须等 identity key 真正释放后
      // 再重试，不能让新会话与迟到的 LaunchServices 实例交叠。
      return existing.promise.then(() => {
        if (options.signal?.aborted) {
          return this.canceledParticipantResult(existing, options.signal.reason);
        }
        return this.run(identity, requiredPermissions, options);
      });
    }

    const session: ActiveOnboardingSession = {
      identity,
      sessionId: this.createSessionId(),
      controller: new AbortController(),
      activeParticipants: new Set(),
      requiredPermissions: new Set(requiredPermissions),
      processedPermissions: new Set(),
      openedPermissions: [],
      acceptingRequirements: true,
      recoveryOwnerParticipantKeys: new Set(),
    };
    const promise = this.runSession(session, options).finally(() => {
      if (this.sessions.get(identityKey) === session) {
        this.sessions.delete(identityKey);
      }
    });
    session.promise = promise;
    this.sessions.set(identityKey, session);
    return this.joinSession(session, options.signal, options.participantKey);
  }

  private joinSession(
    session: ActiveOnboardingSession,
    signal?: AbortSignal,
    participantKey?: string,
  ): Promise<CuaAccessibilitySettingsResult> {
    this.nextParticipantId += 1;
    const participantId = this.nextParticipantId;
    const recoveryParticipantKey = participantKey?.trim() || `participant:${participantId}`;
    session.activeParticipants.add(participantId);

    return new Promise<CuaAccessibilitySettingsResult>((resolve) => {
      let active = true;
      const detach = () => {
        signal?.removeEventListener("abort", onAbort);
        session.activeParticipants.delete(participantId);
      };
      const onAbort = () => {
        if (!active) return;
        active = false;
        detach();
        resolve(this.canceledParticipantResult(session, signal?.reason));
        if (session.activeParticipants.size === 0 && !session.controller.signal.aborted) {
          // 共享会话不能归首个 caller signal 独占。任一窗口关闭只移除自身；最后一个参与者
          // 离开才取消 native flow，并先关闭 requirement join 门，后来的显式重试会等待精确 cleanup。
          session.acceptingRequirements = false;
          session.controller.abort(
            signal?.reason ?? new Error("all CUA permission onboarding windows closed"),
          );
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      void session.promise!.then((result) => {
        if (!active) return;
        active = false;
        detach();
        const returned =
          result.success === true &&
          result.returnedFromSettings === true &&
          typeof result.sessionId === "string";
        // Promise continuation 在 main event loop 内串行执行。同一 renderer/webContents 的重复调用只
        // 有一个取得恢复权；不同窗口各有独立 host/Helper，必须各自得到一次恢复权，不能全局去重。
        const ownsRecovery =
          returned && !session.recoveryOwnerParticipantKeys.has(recoveryParticipantKey);
        if (ownsRecovery) session.recoveryOwnerParticipantKeys.add(recoveryParticipantKey);
        resolve({
          ...result,
          ...(returned ? { restartHelperAfterReturn: ownsRecovery } : {}),
        });
      });
    });
  }

  private canceledParticipantResult(
    session: ActiveOnboardingSession,
    reason: unknown,
  ): CuaAccessibilitySettingsResult {
    return {
      success: false,
      canceled: true,
      sessionId: session.sessionId,
      returnedFromSettings: false,
      error: `permission onboarding canceled: ${messageOf(
        reason ?? new Error("origin window closed"),
      )}`,
    };
  }

  private async runSession(
    session: ActiveOnboardingSession,
    options: OpenCuaAccessibilitySettingsOptions,
  ): Promise<CuaAccessibilitySettingsResult> {
    const configuredSessionTimeoutMs = options.sessionTimeoutMs;
    const sessionTimeoutMs =
      typeof configuredSessionTimeoutMs === "number" && Number.isFinite(configuredSessionTimeoutMs)
        ? Math.max(1, configuredSessionTimeoutMs)
        : null;
    const startedAt = Date.now();
    const controller = session.controller;
    const sessionTimer =
      sessionTimeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new Error(`CUA permission onboarding session exceeded ${sessionTimeoutMs}ms`),
              ),
            sessionTimeoutMs,
          );
    let returnedCount = 0;

    try {
      while (true) {
        const permission = PERMISSION_STAGE_ORDER.find(
          (candidate) =>
            session.requiredPermissions.has(candidate) &&
            !session.processedPermissions.has(candidate),
        );
        if (!permission) {
          // 最后一页返回后的 identity 终检仍会 await；若 join 门保持开启，新权限会在
          // while 已结束后被静默并入并收到假 success。同步关闭 join 门，让后来请求等 cleanup 后新开会话。
          session.acceptingRequirements = false;
          break;
        }
        session.processedPermissions.add(permission);
        const remainingMs =
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : sessionTimeoutMs - (Date.now() - startedAt);
        if (Number.isFinite(remainingMs) && remainingMs <= 0) {
          controller.abort(new Error("CUA permission onboarding session timed out"));
          throw controller.signal.reason;
        }
        // 首次 ensureInstalled 的验签证据不能跨越用户停留设置页的时间复用。同 UID 进程可在
        // 下一 stage 前替换安装目录，导致授权落到另一 bundle。每一 stage 都以“指纹前快照 → 完整
        // verify → 精确 identity 复核 → 指纹后快照”的顺序重新建立证据；任一处变化都 fail-closed。
        //
        // 终检在 dragstart 前同步比对：Helper 进入 TCC 列表靠用户拖拽，
        // 而 TCC 绑定的正是被拖入的那个 bundle，所以「拖之前字节没变」贴近
        // 真实风险。指纹登记到会话上供拖拽缓存消费（见 desktopCuaPermissionIpc）。
        session.launchFingerprint = await verifyHelperPermissionIdentityUnchanged(
          session.identity,
          options,
          "launch",
        );
        if (controller.signal.aborted) throw controller.signal.reason;

        const openSettingsUrl =
          options.openSettingsUrl ?? ((url: string) => shell.openExternal(url));
        const openSettings = async () => {
          await openSettingsUrl(settingsUrlForPermission(permission));
          if (!session.openedPermissions.includes(permission)) {
            session.openedPermissions.push(permission);
          }
        };
        // 单阶段返回超时取配置值与会话剩余预算的较小者，避免子超时比总超时更宽松
        // 会话没有总超时时剩余预算为 Infinity，此时取配置值本身
        // 剩余预算至少经 Math.max(1, sessionTimeoutMs - (Date.now() - startedAt)) 夹到 1ms：已耗尽时给出可判定的立即超时
        // [资源] 每阶段新建的定时器由 openSettingsAndWaitForReturn 自行清理，本函数不持有句柄
        // 该值只约束“设置页是否出现并返回”，用户勾选权限不再受它约束
        // 若直接使用配置值，两个阶段串联后实际等待可达两倍，用户会先撞上会话超时失败
        const returnTimeoutMs = Math.min(
          options.settingsReturnTimeoutMs ?? DEFAULT_SETTINGS_RETURN_TIMEOUT_MS,
          sessionTimeoutMs === null
            ? Number.POSITIVE_INFINITY
            : Math.max(1, sessionTimeoutMs - (Date.now() - startedAt)),
        );
        if (options.openSettingsAndWaitForReturn) {
          await options.openSettingsAndWaitForReturn({
            permission,
            sessionId: session.sessionId,
            timeoutMs: returnTimeoutMs,
            signal: controller.signal,
            openSettings,
          });
          if (controller.signal.aborted) throw controller.signal.reason;
          returnedCount += 1;
        } else {
          // 旧接口没有 main return signal：保留“打开设置页”的兼容行为，但绝不能伪造 return=true。
          await openSettings();
          if (controller.signal.aborted) throw controller.signal.reason;
        }
      }

      // 最后一页返回与 restart 之间仍可能发生 Helper 升级/替换。IPC 后台刷新拖拽缓存不属于本次
      // 授权证据；必须在 success 前重新验签并绑定同一 identity，变化时 fail-closed、不发恢复权。
      if (session.openedPermissions.length > 0) {
        await verifyHelperPermissionIdentityUnchanged(session.identity, options, "post-settings");
        if (controller.signal.aborted) throw controller.signal.reason;
      }
      return {
        success: true,
        sessionId: session.sessionId,
        returnedFromSettings:
          session.openedPermissions.length > 0 &&
          returnedCount === session.openedPermissions.length,
        error: undefined,
      };
    } catch (error) {
      session.acceptingRequirements = false;
      return {
        success: false,
        canceled: controller.signal.aborted || undefined,
        sessionId: session.sessionId,
        returnedFromSettings: false,
        error: `permission onboarding failed: ${messageOf(error)}`,
      };
    } finally {
      if (sessionTimer) clearTimeout(sessionTimer);
    }
  }
}

const mainCuaPermissionOnboardingCoordinator = new CuaPermissionOnboardingCoordinator();

export async function openCuaPermissionOnboarding(
  options: OpenCuaAccessibilitySettingsOptions = {},
): Promise<CuaAccessibilitySettingsResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  let helperAppPath: string;
  try {
    helperAppPath = await (options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled)();
  } catch (error) {
    // Security boundary：安装/校验失败时
    // 必须 fail-closed，绝不回退到“路径存在即用”的未验证 Helper —— 否则会引导用户把 Accessibility /
    // Screen Recording 授权给旧版本 / 坏签名 / 错误 Team / 被替换的 bundle，破坏“Helper 是独立且受
    // TeamIdentifier pinning 的授权主体”这一核心边界。dev 场景由 installer 内部的
    // ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL 承接：通过 dev 校验时 ensureInstalled 会正常返回本地 app，
    // 根本不会进到这个 catch；只有真正校验失败才会到这里。
    return {
      success: false,
      error: `ZCode Computer Use is unavailable (install/verification failed): ${messageOf(error)}`,
    };
  }

  let identity: HelperPermissionSubjectIdentity;
  try {
    identity = await (options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity)(
      helperAppPath,
    );
  } catch (error) {
    return {
      success: false,
      returnedFromSettings: false,
      error: `ZCode Computer Use permission identity verification failed: ${messageOf(error)}`,
    };
  }
  const verifiedOptions: OpenCuaAccessibilitySettingsOptions = {
    ...options,
    ...(options.verifyHelperInstalled
      ? { verifyHelperInstalled: options.verifyHelperInstalled }
      : defaultInstaller
        ? { verifyHelperInstalled: defaultInstaller.verifyInstalled }
        : {}),
  };
  return mainCuaPermissionOnboardingCoordinator.run(
    identity,
    normalizeRequiredPermissions(options),
    verifiedOptions,
  );
}

// 2026-08 审计曾把拖拽链路当作死代码删除（当时渲染层无调用方，权限引导靠 native 弹窗让 Helper
// 自动进入 TCC 列表）。弹窗被摘除后，拖拽重新成为 Helper 进入权限列表的**唯一**途径，
// 故恢复本函数。openCuaAccessibilitySettings（旧确认弹窗频道）不恢复，它已被 onboarding 取代。

export interface PrepareCuaHelperPermissionDragOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: OpenCuaAccessibilitySettingsOptions["logger"];
  /** 与 onboarding 共用桌面 installer factory 的 install+verify。测试可注入。 */
  ensureHelperInstalled?: () => Promise<string>;
  bundledHelperAppPath?: string;
  verifyHelperInstalled?: (appPath: string) => Promise<void>;
  resolveHelperIdentity?: (appPath: string) => Promise<HelperPermissionSubjectIdentity>;
}

export interface PrepareCuaHelperPermissionDragMainResult extends PrepareCuaHelperPermissionDragResult {
  /**
   * 与本次完整验签前后绑定的同步 bundle 指纹。只允许 main 内存缓存消费 —— IPC handler 必须在
   * 返回 renderer 前剥掉此字段（跨进程暴露既无用又扩大攻击面）。
   */
  helperBundleFingerprint?: CuaHelperBundleFingerprint;
}

// 拖拽授权与 onboarding 最终引向同一个 TCC 授权主体，安全校验必须一致：磁盘上被旧版 / 坏签名 /
// 错误 Team / 同用户可写内容替换的 .app 若被拖进 Accessibility/Screen Recording，TCC 授权会落到
// 错误主体，绕过整个 TeamIdentifier pinning 设计。所以拖拽前必须走同一条 install+verify
// （bundle id / 版本 / arch / codesign / TeamIdentifier / Gatekeeper）。
//
// 但 Electron 原生文件拖拽要求在 dragstart 事件链路里*同步*调用 event.sender.startDrag()，
// 等不了这些异步 I/O（否则错过 OS 拖拽手势窗口，用户拖不出任何文件）。因此把 install+verify
// 拆到本函数：浮窗挂载时预热并缓存已验证路径 + 指纹，dragstart 只读缓存并同步比对（见
// desktopCuaPermissionIpc）。
export async function prepareCuaHelperPermissionDrag(
  options: PrepareCuaHelperPermissionDragOptions = {},
): Promise<PrepareCuaHelperPermissionDragMainResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      success: false,
      error: "ZCode Computer Use permissions are only available on macOS.",
    };
  }
  const env = options.env ?? process.env;
  const defaultInstaller = options.ensureHelperInstalled
    ? null
    : createDesktopCuaHelperInstaller({
        logger: toInstallerLogger(options.logger),
        env,
        bundledHelperAppPath: options.bundledHelperAppPath,
        platform,
      });
  try {
    const helperAppPath = await (
      options.ensureHelperInstalled ?? defaultInstaller!.ensureInstalled
    )();
    // 顺序关键：先抓快照，再完整 verify，验签后与 identity 读取后各复核一次。若在 ensure/verify
    // 返回后才抓指纹，攻击者可在两者之间替换 .app，导致恶意字节反而成为“已验证指纹”。只有全程未变
    // 的同一批字节才允许交给同步 dragstart 缓存。
    const verifiedFingerprint = captureCuaHelperBundleFingerprint(helperAppPath);
    await (options.verifyHelperInstalled ?? defaultInstaller?.verifyInstalled)?.(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag signature was being verified");
    }
    const identity = await (
      options.resolveHelperIdentity ?? resolveHelperPermissionSubjectIdentity
    )(helperAppPath);
    if (!cuaHelperBundleFingerprintUnchanged(helperAppPath, verifiedFingerprint)) {
      throw new Error("ZCode Computer Use changed while its drag identity was being resolved");
    }
    return {
      success: true,
      helperAppPath,
      helperDisplayName: identity.displayName,
      helperBundleId: identity.bundleId,
      helperBundleFingerprint: verifiedFingerprint,
    };
  } catch (error) {
    const message = messageOf(error);
    options.logger?.warn(
      "[cua-permission-onboarding] helper install/verify failed; refusing to prepare drag of an unverified Helper",
      message,
    );
    return { success: false, error: message };
  }
}
