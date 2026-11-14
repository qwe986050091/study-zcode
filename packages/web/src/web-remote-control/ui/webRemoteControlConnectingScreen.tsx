// INV-01 阶段映射穷举：守住位置 分支；改错故障 未知状态显示空白。
// INV-02 非线性状态单独说明：守住位置 重连与后台分支；改错故障 用户不知会自恢复。
// INV-03 缺省回退准备中：守住位置 末尾；改错故障 显示原始枚举。
// INV-04 进度只高亮线性阶段：守住位置 阶段表；改错故障 重连时进度条乱跳。
// INV-05 进度段数固定四段：守住位置 文案数组；改错故障 步骤与进度不一致。
// INV-06 设备名优先连接参数：守住位置 空值回退；改错故障 显示通用文案。
// INV-07 设备平台来自记录：守住位置 属性透传；改错故障 图标缺失。
// INV-08 文案按语言整包切换：守住位置 查表；改错故障 中英混排。
// INV-09 状态区宣告忙碌：守住位置 无障碍属性；改错故障 读屏不提示加载。
// INV-10 阶段文案实时播报：守住位置 礼貌播报；改错故障 状态变化无提示。
// INV-11 步骤列表有可访问名：守住位置 标签拼接；改错故障 读屏只念步骤。
// INV-12 当前步骤标记语义：守住位置 当前属性；改错故障 无法定位当前步。
// INV-13 已完成与待办样式区分：守住位置 类名三元；改错故障 全部同色。
// INV-14 当前步骤脉冲：守住位置 条件类名；改错故障 无进行中视觉。
// INV-15 步骤文本仅供读屏：守住位置 隐藏类；改错故障 布局被文字撑开。
// INV-16 全屏高度适配安全区：守住位置 动态高度；改错故障 刘海遮挡品牌。
// INV-17 只呈现传输状态：守住位置 纯展示；改错故障 页面内改阶段逻辑。
// INV-18 描述可选才渲染：守住位置 条件渲染；改错故障 出现空段落。
//
// 模块职责：远程控制连接过程的全屏进度页。
// 状态所有权：传输状态由上层传入，本页只做展示映射。
// 阅读顺序：先看语言文案表，再看阶段解析，最后看页面装配。
import { LoaderCircleIcon } from "lucide-react";
import { DevicePlatformIcon } from "@zcode/ui/device-platform-icon";
import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";
import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
import type { WebRemoteControlTerminalTransportState } from "#src/web-remote-control/contract.js";

/** 连接过程页展示的目标电脑；名字来自连接参数，平台来自本机记住的设备记录。 */
export interface WebRemoteControlConnectingDevice {
  name?: string;
  platform?: string;
}

const copyByLocale = {
  "zh-CN": {
    connectingTo: (name: string) => `正在连接 ${name}`,
    connectingFallback: "正在连接电脑",
    steps: ["连接中转服务", "设备鉴权", "等待桌面端配对", "同步工作区"],
    stages: {
      connecting: "正在连接中转服务…",
      authenticating: "正在认证设备…",
      waiting: "等待桌面端确认配对…",
      paired: "已配对，正在加载工作区…",
      reconnecting: "连接中断，正在重连…",
      suspended: "页面在后台，等待恢复…",
      other: "正在准备远程控制…",
    },
    reconnectingDescription: "网络或休眠恢复后会自动重连，请稍候。",
    suspendedDescription: "回到前台后会自动恢复连接。",
  },
  "en-US": {
    connectingTo: (name: string) => `Connecting to ${name}`,
    connectingFallback: "Connecting to your computer",
    steps: [
      "Connect to relay service",
      "Authenticate device",
      "Wait for desktop pairing",
      "Sync workspace",
    ],
    stages: {
      connecting: "Connecting relay service…",
      authenticating: "Authenticating device…",
      waiting: "Waiting for desktop pairing…",
      paired: "Paired. Loading workspace…",
      reconnecting: "Connection interrupted, reconnecting…",
      suspended: "Page is in background, waiting to recover…",
      other: "Preparing remote control…",
    },
    reconnectingDescription: "Auto-reconnecting after network or wake-up changes.",
    suspendedDescription: "Connection will recover automatically when back in foreground.",
  },
};

// 线性阶段映射到 4 段进度；重连、后台等非线性状态不高亮任何一段。
// STEP_INDEX 把 idle 到 paired 的线性阶段折成 0 到 3 四段进度。
// reconnecting 与 suspended 不在 STEP_INDEX 里，因此不高亮任何一段。
// STEP_INDEX[state] 为 undefined 时进度条不点亮任何阶段。
// 键直接取 WebRemoteControlTerminalTransportState 的字面量，与传输状态同名。
const STEP_INDEX: Partial<Record<WebRemoteControlTerminalTransportState, number>> = {
  idle: 0,
  connecting: 0,
  authenticating: 1,
  waiting: 2,
  paired: 3,
};

// resolveStage 对线性阶段直接返回 copy.stages[state]，不带描述。
// reconnecting 额外带 copy.reconnectingDescription 说明会自动恢复。
// suspended 额外带 suspendedDescription，提示回到前台后自动恢复。
// default 分支回退到 copy.stages.other，用于其余未列举状态。
// resolveStage 只读取 copy，不修改 transport 状态。
function resolveStage(
  state: WebRemoteControlTerminalTransportState,
  copy: (typeof copyByLocale)["zh-CN"],
): { label: string; description?: string } {
  switch (state) {
    case "connecting":
    case "authenticating":
    case "waiting":
    case "paired":
      return { label: copy.stages[state] };
    case "reconnecting":
      return { label: copy.stages.reconnecting, description: copy.reconnectingDescription };
    case "suspended":
      return { label: copy.stages.suspended, description: copy.suspendedDescription };
    default:
      return { label: copy.stages.other };
  }
}

/** 选中设备到任务首页之间的全屏连接过程页；只呈现 transport 状态，不改变阶段逻辑。 */
// copy 由 locale 从 copyByLocale 整包取出，不做逐字段回退。
// stage 由 resolveStage(state, copy) 解析，页面不自行判断阶段。
// stepIndex 直接查 STEP_INDEX 得到进度段，缺映射时为 undefined。
// device.name 先 trim，空串时回退到本地化默认设备名。
// 组件只渲染 stage 与 stepIndex，不回写 transport 状态。
export function WebRemoteControlLoadingScreen({
  state,
  locale,
  device,
}: {
  state: WebRemoteControlTerminalTransportState;
  locale: WebRemoteControlScreenLocale;
  device?: WebRemoteControlConnectingDevice;
}) {
  // copyByLocale 同时维护 zh-CN 与 en-US 两份文案，键必须对齐。
  // STEP_INDEX 固定四段进度，新增阶段要同步扩段。
  // stages 的键与 WebRemoteControlTerminalTransportState 对齐，缺键会落 default。
  // description 只有 reconnecting 与 suspended 提供，线性阶段没有。
  // locale 入参决定整包文案，切语言即整页切换。
  const copy = copyByLocale[locale];
  const stage = resolveStage(state, copy);
  const stepIndex = STEP_INDEX[state];
  const name = device?.name?.trim();
  return (
    <div className="flex h-dvh min-h-dvh w-screen flex-col bg-background px-4 pt-[calc(env(safe-area-inset-top)+12px)] text-foreground">
      <div className="flex h-10 items-center">
        <WebRemoteControlBrand />
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="flex flex-1 flex-col items-center justify-center pb-24 text-center"
      >
        <span className="flex size-16 items-center justify-center rounded-xl border border-card-border bg-card">
          <DevicePlatformIcon platform={device?.platform} className="size-7" />
        </span>
        <h1 className="mt-5 max-w-full truncate text-ui-lg font-semibold">
          {name ? copy.connectingTo(name) : copy.connectingFallback}
        </h1>
        <p className="mt-2 flex items-center gap-2 text-ui-sm text-foreground-subtle">
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
          {stage.label}
        </p>
        {stage.description ? (
          <p className="mt-1.5 max-w-xs text-ui-sm text-foreground-subtlest">{stage.description}</p>
        ) : null}
        <ol className="mt-5 flex gap-1.5" aria-label={copy.steps.join(" → ")}>
          {copy.steps.map((step, index) => (
            <li
              key={step}
              aria-current={index === stepIndex ? "step" : undefined}
              data-step-state={
                stepIndex === undefined
                  ? "idle"
                  : index < stepIndex
                    ? "done"
                    : index === stepIndex
                      ? "active"
                      : "pending"
              }
              className={[
                "h-1 w-8 rounded-full",
                stepIndex === undefined || index > stepIndex
                  ? "bg-foreground-subtlest/50"
                  : index === stepIndex
                    ? "animate-pulse bg-foreground/60"
                    : "bg-foreground",
              ].join(" ")}
            >
              <span className="sr-only">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
