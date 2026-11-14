// 职责边界（WebRemoteControlDialog）：手机远控弹窗的展示与本地交互层。
// 做：打开时同步/启动远控、1s 轮询状态、生成二维码、复制链接、停止远控、跳转 Bot 配置入口。
// 不做：main/relay 侧状态机、配对与鉴权、扫码端渲染；本组件只经由 platform 端口读写。
// 依赖：usePlatform 的远控方法、useZCodeStore 的登录入口、useOAuth、i18n、logger。
// 边界：status 是宿主状态的投影，不是本地权威；本地只保留 loading/qrDataUrl 等瞬时 UI 态。
// 关闭弹窗不停止远控：关闭只是隐藏 UI，远控会话的生命周期由平台侧决定。
// 两种链路（desktop-continuous 与 web-remote-replayable）在本文件内不可区分，只消费统一 status。
// 二维码只是入口：真正的连接建立与状态迁移都在平台侧完成，本组件不参与握手。
//
// INV 不变量表（每条都对应一种静默故障，改前先确认它守的是什么）
// INV-01 断言：status 只能由平台结果写入，不在本地推断 —— 守住它的位置：三处 setStatus —— 改错故障：用户看到一条实际未建立的连接
// INV-02 断言：打开同步 effect 的 cancelled 必须覆盖所有 setState —— 守住它的位置：该 effect —— 改错故障：关闭后异步回写，重开时闪现旧状态
// INV-03 断言：只有同目标或可复用会话才沿用当前状态 —— 守住它的位置：isSameWebRemoteControlTarget 判断 —— 改错故障：切到别的 workspace 仍显示上一会话二维码
// INV-04 断言：auth-required 不触发 start，直接采用 —— 守住它的位置：复用条件分支 —— 改错故障：未登录也发启动请求并刷日志
// INV-05 断言：start 返回 cancelled 归一为 idle —— 守住它的位置：nextStatus 三元 —— 改错故障：UI 停在非法的 cancelled 状态
// INV-06 断言：启动失败先复查 auth-required 再报错 —— 守住它的位置：catch 分支 —— 改错故障：401 被当成启动失败并弹错误 toast
// INV-07 断言：catch 内的复查请求自带 catch —— 守住它的位置：getWebRemoteControlStatus().catch —— 改错故障：二次失败冒泡成未捕获 rejection
// INV-08 断言：轮询保持 1s 固定间隔，不因状态变化重建 —— 守住它的位置：setInterval —— 改错故障：每次状态更新都重置定时器，轮询漂移
// INV-09 断言：轮询只接受 target 匹配、可复用、auth-required、idle、error —— 守住它的位置：shouldApplyStatus —— 改错故障：别的 workspace 状态覆盖当前弹窗
// INV-10 断言：状态相同必须返回原对象 —— 守住它的位置：setStatus updater —— 改错故障：每秒重渲染整棵弹窗
// INV-11 断言：轮询单次失败必须静默 —— 守住它的位置：catch 空块 —— 改错故障：网络抖动弹 toast 打断用户操作
// INV-12 断言：qrUrl 为空时清空 qrDataUrl —— 守住它的位置：二维码 effect 首分支 —— 改错故障：旧二维码残留，用户扫到过期链接
// INV-13 断言：二维码生成后必须判 cancelled —— 守住它的位置：then 回调 —— 改错故障：qrUrl 切换后旧图覆盖新图
// INV-14 断言：二维码失败只记日志不弹 toast —— 守住它的位置：catch 回调 —— 改错故障：后台加载失败打断主流程
// INV-15 断言：复制前必须判 connectUrl 存在 —— 守住它的位置：handleCopyLink 开头 —— 改错故障：复制 undefined 或上一次的旧链接
// INV-16 断言：停止成功后先置 idle 再关闭弹窗 —— 守住它的位置：handleStop —— 改错故障：关闭动画期间仍显示旧连接状态
// INV-17 断言：loading 必须由 finally 复位 —— 守住它的位置：handleStop —— 改错故障：失败后按钮永久转圈
// INV-18 断言：关闭弹窗不调用 stop —— 守住它的位置：handleDialogOpenChange —— 改错故障：一关 UI 就断远控，手机端掉线
// INV-19 断言：登录必须指定当前渠道 —— 守住它的位置：WebRemoteControlLoginButton —— 改错故障：统一入口把缓存用户当成登录成功
// INV-20 断言：Bot 总入口先清空 provider 再打开 —— 守住它的位置：handleOpenBotsDialog —— 改错故障：沿用上次 provider 打开错误渠道
//
// 阅读顺序：状态派生 → 打开同步 effect → 轮询 effect → 二维码 effect → 各 handler → JSX。
// .tsx 限制：新增注释只落在语句之间，不能进入 JSX 子节点或开标签属性行。
import {
  isSameWebRemoteControlTarget,
  isReusableWebRemoteControlSession,
  getStatusLabel,
  getStatusDetail,
  getStatusDotClassName,
  getWebRemoteControlStatusTagLabel,
  isSameWebRemoteControlStatus,
  getFailureDescription,
} from "@/web-remote-control/domain/presentation.js";
import { memo, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { BotProvider, WebRemoteControlStatus } from "@zcode/shared";
import {
  Bot as BotIcon,
  CopyIcon,
  LoaderCircle,
  MonitorSmartphone,
  Smartphone,
  Unplug,
  XIcon,
} from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOAuth } from "@/hooks/useOAuth.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<BotProvider, "weixin" | "feishu" | "lark" | "telegram">;

// [契约] Bot 入口顺序即展示顺序：weixin → feishu → lark → telegram，不要按地区重排。
// provider 用 RemoteControlBotProvider 收窄，新增渠道必须同时出现在数组与类型里。
// 每一项只有 provider 字段：标题与描述由 i18n key 推导，不在这里存文案。
// 不要把图标放进数组：ProviderIcon 按 provider 自行解析品牌 logo。
// 该数组是模块级常量，渲染期不得 map 出新数组。
// `REMOTE_CONTROL_BOT_ENTRIES` 不补占位项：入口列表就是能力清单。
const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

// [契约] 登录按钮只在 auth-required 分支渲染，其他状态不出现。
// hasUser 与 activeProvider 的组合决定是否先刷新渠道：有用户但无当前渠道时不能直接跳登录。
// 先 toast 再 refreshProviders 再 return：任何顺序变化都会让用户看不到提示。
// onOpenChange(false) 必须早于 requestLoginEntry：先关弹窗再跳登录，避免叠层。
// requestLoginEntry 的第二个参数是固定入口标识，不要按状态动态拼。
// disabled 只绑 loadingProviders：登录进行中允许重复点击会由 OAuth 层忽略。
// 本组件不复用外层的 status：它只关心登录相关的两个 store 字段。
// handle 内不做 await：跳登录是事件语义，不是异步流程。
function WebRemoteControlLoginButton({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { intl } = useZCodeIntl();
  const hasUser = useZCodeStore((state) => Boolean(state.user));
  // [契约] requestLoginEntry 从 store 取，不在组件内直接调服务。
  // 两个 selector 分开订阅：合并成对象会让 user 变化时重建组件。
  // hasUser 用 Boolean 包裹，避免把对象引用本身当依赖。
  // refreshProviders 是 OAuth hook 提供的方法，不要换成直接调服务。
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const { activeProvider, loadingProviders, refreshProviders } = useOAuth();

  return (
    <Button
      type="button"
      data-testid="web-remote-control-login"
      className="enabled:cursor-pointer"
      disabled={loadingProviders}
      onClick={() => {
        // 远控401不清全局用户；必须指定当前渠道建立新登录尝试，避免统一入口把缓存用户当作成功。
        if (hasUser && !activeProvider) {
          toast(intl.formatMessage({ id: "login.oauth.loginFailure" }));
          void refreshProviders();
          return;
        }
        onOpenChange(false);
        requestLoginEntry(activeProvider ?? undefined, "app-login");
      }}
    >
      {intl.formatMessage({ id: "webRemoteControl.authRequired.login" })}
    </Button>
  );
}

// [契约] workspacePath 与 workspaceIdentity 是远控目标身份，缺一会导致跨 workspace 串台。
// remoteSessionId 只影响启动参数与目标匹配，不参与路径展示。
// initialTaskId 只在首次启动时传，轮询不能带它重新启动。
// memo 要求父层回调引用稳定；否则每次渲染都会重跑状态同步 effect。
// 组件不接收 status：状态由本组件从 platform 读取并持有，避免双写。
// onOpenChange 是唯一开合出口，内部一律经 handleDialogOpenChange 记录日志。
// props 不设默认空串：undefined 与空串在目标匹配里语义不同。
// 组件名保留 Component 后缀，memo 包裹不影响 displayName 的调试可读性。
// 新增 prop 必须先确认它是否参与 effect 依赖，否则会出现读到旧值的闭包。
// 这里不读全局 store 的 workspace：目标身份必须由调用方显式传入。
export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}) {
  // [依赖] platform 从 usePlatform 获取，组件内不直接访问 window.zcode。
  // usePlatform 的返回值在窗口生命周期内稳定，可作为 effect 依赖。
  // 远控方法都是异步且可能 reject，调用点必须处理失败路径。
  // 不要缓存 platform 方法或状态：状态必须每次重新读取。
  // 本文件的 platform 只用于远控五个方法，不承担窗口与原生操作。
  // 换平台实现时只替换注入，不改本组件：这是桌面与 Web 共用同一弹窗的前提。
  // effect 依赖里写 platform 而不是它的某个方法，避免方法引用变化导致重复启动。
  // platform 缺席时组件不渲染？不：由 usePlatform 保证在场，缺失应在 hook 层抛错。
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  // [状态] status 是宿主状态投影；loading/qrDataUrl/botsDialogOpen 是纯 UI 态。
  // 初始 status 必须带 status:"idle"，缺字段会让派生函数读到 undefined。
  // qrDataUrl 与 status.qrUrl 分离：前者是异步产物，后者是事实。
  // botsDialogOpen 与 botEntryProvider 必须成对设置，避免打开错误渠道。
  // 不要把 loading 合进 status：它不来自平台，合并会污染状态比较。
  // 这里不初始化 lastSyncedAt 之类的派生字段：轮询会用真实状态覆盖。
  // setStatus 只在 effect 与 handler 内调用，渲染期不得写状态。
  // status 的类型来自 shared，不要在本地另造一个宽松结构。
  const [status, setStatus] = useState<WebRemoteControlStatus>({
    status: "idle",
  });
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] = useState<RemoteControlBotProvider | null>(null);

  // [契约] 四个派生值都用 useMemo，依赖是 intl.formatMessage 与 status（或 failure）。
  // formatMessage 的引用来自 i18n 上下文，必须进依赖数组，否则切语言不刷新。
  // statusDotClassName 不必 memo：它只读 status.status，开销可忽略。
  // failureDescription 只依赖 status.failure，减少无效重算。
  // 不要把派生值写回 state：它们是渲染期投影，写回会引入第二份事实。
  // 派生函数的入参顺序固定为 status 在前、formatMessage 在后，与 presentation 模块一致。
  // 空 failure 时返回空串而不是 undefined，渲染分支依赖真假值判断。
  // statusTagLabel 与 statusLabel 分开计算：标签是状态机映射，不是标题。
  const statusLabel = useMemo(
    () => getStatusLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDetail = useMemo(
    () => getStatusDetail(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const failureDescription = useMemo(
    () => getFailureDescription(status.failure, intl.formatMessage),
    [intl.formatMessage, status.failure],
  );
  const statusTagLabel = useMemo(
    () => getWebRemoteControlStatusTagLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDotClassName = getStatusDotClassName(status);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    // [并发] 打开同步 effect 是“启动或复用”的唯一入口，轮询只读取不启动。
    // cancelled 必须覆盖所有 setState 与日志：关闭后异步回来不能改状态。
    // 复用条件三选一：同目标、可复用会话、auth-required；三者都不能漏。
    // auth-required 不调用 start：未登录时启动必然失败并刷日志。
    // startResult.status === "cancelled" 归一为 idle，cancelled 不是合法展示态。
    // catch 里先复查状态：401 可能发生在 start 之外，必须优先展示登录态。
    // 复查请求自带 catch(() => null)：二次失败不能再抛成未捕获 rejection。
    // catch 分支的 setStatus 必须带 workspacePath 与 remoteSessionId，错误态也属于目标。
    // toast 与 logger 只在非 cancelled 时执行，避免关闭后仍提示。
    // finally 只复位 loading，不碰 status：状态由上面的分支决定。
    // 依赖数组必须含 initialTaskId：换任务时要重新启动。
    // 不要在 await 之后重新读 open：闭包里的 open 已过期，用 cancelled 判定。
    // logger 字段全部是标识，禁止记录二维码 URL 等敏感内容。
    // 启动函数包成局部 async 再 void 调用：effect 本身不能是 async。
    // cleanup 只置 cancelled，不停止远控：关闭 UI 不等于断开连接。
    // 若改成“总是启动”，每次开关弹窗都会新建会话并逼手机端重扫。
    const syncWebRemoteControlStatus = async () => {
      setLoading(true);

      try {
        const currentStatus = await platform.getWebRemoteControlStatus();
        let nextStatus: WebRemoteControlStatus;
        if (
          currentStatus.status === "auth-required" ||
          isSameWebRemoteControlTarget(
            currentStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(currentStatus)
        ) {
          nextStatus = currentStatus;
        } else {
          const startResult = await platform.startWebRemoteControl({
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            initialTaskId,
          });
          // 兼容仍可返回 cancelled 的平台实现；当前 Desktop 不再叠加原生确认。
          nextStatus = startResult.status === "cancelled" ? { status: "idle" } : startResult;
        }
        // Bugfix: 手机端默认主题已统一收敛到 dark，不再依赖二维码 URL 透传 theme。
        // 这里去掉启动参数里的 theme，避免桌面端主题无意义地参与远控链路。

        if (!cancelled) {
          setStatus(nextStatus);
          logger.info("[WebRemoteControlDialog] Web 远程控制状态已同步", {
            workspacePath,
            workspaceIdentity: workspaceIdentity ?? "none",
            remoteSessionId: remoteSessionId ?? "none",
            initialTaskId: initialTaskId ?? "none",
            status: nextStatus.status,
            sessionId: nextStatus.sessionId ?? "none",
          });
        }
      } catch (error) {
        const currentStatus = await platform.getWebRemoteControlStatus().catch(() => null);
        if (currentStatus?.status === "auth-required") {
          if (!cancelled) setStatus(currentStatus);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setStatus({
            status: "error",
            workspacePath,
            remoteSessionId,
            error: message,
          });
          toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
        }
        logger.error("[WebRemoteControlDialog] 启动 Web 远程控制失败", {
          workspacePath,
          workspaceIdentity: workspaceIdentity ?? "none",
          remoteSessionId: remoteSessionId ?? "none",
          initialTaskId: initialTaskId ?? "none",
          error: message,
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void syncWebRemoteControlStatus();

    return () => {
      cancelled = true;
    };
  }, [intl, open, platform, remoteSessionId, workspaceIdentity, workspacePath, initialTaskId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    // [并发] 轮询从打开开始，1s 固定间隔，不因状态变化重建。
    // 每次轮询先判 cancelled 再 setStatus，避免关闭后回写。
    // shouldApplyStatus 的五个条件缺一不可：idle/error 用于感知外部停止与失败。
    // target 不匹配且不可复用时直接 return，不能把别的 workspace 状态盖进来。
    // setStatus updater 用 isSameWebRemoteControlStatus 保持引用，否则每秒重渲染。
    // 轮询失败静默：状态刷新是增益能力，不能打断用户操作。
    // 轮询绝不触发 start：启动只属于打开同步。
    // 轮询不修改 loading：loading 只描述打开时的启动过程。
    // interval 用 window.setInterval，cleanup 必须 clearInterval。
    // 依赖不含 status：状态经 updater 读取，加了会让定时器反复重建。
    // 不要在轮询里写 logger.info：每秒一条会把日志刷爆。
    // auth-required 也在接受列表里：登录态变化要立刻反映到弹窗。
    // setStatus 必须返回同一对象或新对象，不能返回 undefined。
    // 轮询不判 loading：启动中也可以先看到别的窗口写入的状态。
    const pollWebRemoteControlStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        if (cancelled) {
          return;
        }

        const shouldApplyStatus =
          isSameWebRemoteControlTarget(
            nextStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(nextStatus) ||
          nextStatus.status === "auth-required" ||
          nextStatus.status === "idle" ||
          nextStatus.status === "error";
        if (!shouldApplyStatus) {
          return;
        }

        setStatus((currentStatus) =>
          isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
        );
      } catch {
        // Bugfix: Web 远程控制的状态变化发生在 main / relay 侧，
        // 如果弹层只在打开时同步一次，状态会长期停在“等待连接”。
        // 这里用轻量轮询补齐状态刷新；单次失败时静默忽略，避免打断用户操作。
      }
    };

    // [资源] 定时器句柄只在 effect 内创建与清理，不能存进 ref 复用。
    // 1s 是产品给的刷新节奏，改快会放大 relay 压力，改慢会让状态滞后。
    // 卸载时先置 cancelled 再 clearInterval，顺序反了可能多跑一次回调。
    // 定时器回调必须 void 包 async：setInterval 不等待 Promise。
    // 不要在回调里重新创建定时器：间隔会随状态变化漂移。
    const intervalId = window.setInterval(() => {
      void pollWebRemoteControlStatus();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [open, platform, remoteSessionId, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!status.qrUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    setQrDataUrl(null);

    // [资源] 二维码生成是异步资源，qrUrl 变化必须取消上一轮结果。
    // qrUrl 为空时先清 dataUrl：否则旧二维码会继续展示。
    // 生成前主动 setQrDataUrl(null)，让 UI 回到 loading 态而不是停留旧图。
    // then 里判 cancelled 再写 state，避免旧图覆盖新图。
    // catch 只记日志：二维码失败不阻塞状态展示。
    // margin/width 是展示参数，不要随主题变化，否则缓存失效。
    // cleanup 只置 cancelled，不取消底层 Promise（qrcode 不支持取消）。
    // 依赖只有 status.qrUrl，不要加整个 status 对象。
    void QRCode.toDataURL(status.qrUrl, {
      margin: 1,
      width: 320,
    })
      .then((dataUrl: string) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[WebRemoteControlDialog] 生成二维码失败", message);
      });

    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  // [失败路径] 复制前必须判 connectUrl 存在，空值时直接返回且不弹 toast。
  // navigator.clipboard 可能因权限或非安全上下文 reject，必须走 catch。
  // 成功与失败各一条 toast，文案 key 不可复用。
  // 日志字段只记 sessionId 与 workspace，不记完整链接。
  // catch 里把 message 归一化后再交给 i18n，避免把 Error 当字符串插值。
  // 不要在 finally 复位 loading：复制不占用启动 loading。
  // 复制成功不改变 status：链接可用不代表连接状态变化。
  // 这里不重试：剪贴板失败多数是权限问题，重试只会连续弹错。
  const handleCopyLink = async () => {
    if (!status.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(status.connectUrl);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLink.copied" }));
      logger.info("[WebRemoteControlDialog] 已复制 Web 远程控制链接", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        sessionId: status.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLinkFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] 复制 Web 远程控制链接失败", message);
    }
  };

  // [事务] 停止是破坏性操作，先 setLoading 再调用平台，避免重复点击。
  // 成功后先置 idle 再关闭弹窗：关闭动画期间不应残留连接状态。
  // 失败只 toast + 日志，不把 status 改成 error：真实状态仍由轮询反映。
  // finally 必须复位 loading，否则失败后按钮永久转圈。
  // 不要在停止前清 qrDataUrl：平台失败时用户仍需看到原二维码。
  // stopWebRemoteControl 不接收目标参数：它停的是当前窗口的远控。
  // 日志字段只记标识，不记连接 URL。
  // 关闭弹窗调用 onOpenChange(false) 而不是 handleDialogOpenChange，避免重复记录“用户关闭”。
  // 停止成功后不再触发一次手动轮询：下一次定时轮询会自然收敛。
  // 如果平台实现需要幂等，重复点击由 loading 挡住，而不是在 handler 内加锁。
  const handleStop = async () => {
    setLoading(true);
    try {
      await platform.stopWebRemoteControl();
      setStatus({ status: "idle" });
      onOpenChange(false);
      toast(intl.formatMessage({ id: "webRemoteControl.stopSuccess" }));
      logger.info("[WebRemoteControlDialog] 已关闭 Web 远程控制", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.stopFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] 关闭 Web 远程控制失败", message);
    } finally {
      setLoading(false);
    }
  };

  // [契约] 所有开合都必须经过 handleDialogOpenChange，保证日志与上层回调一致。
  // 不要在内部直接调 onOpenChange：绕过这里会丢失开关日志。
  // nextOpen=false 不触发 stop：关闭 UI 与断开连接是两件事。
  // 日志在回调之前写：上层若同步卸载组件，之后的日志会丢失。
  // 这里不清理 status/qrDataUrl：下次打开需要先展示旧状态再同步。
  // 参数只接受 boolean，不做取反兜底。
  const handleDialogOpenChange = (nextOpen: boolean) => {
    logger.info("[WebRemoteControlDialog] 弹层开关状态变化", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      nextOpen,
    });
    onOpenChange(nextOpen);
  };

  const handleDismiss = () => {
    logger.info("[WebRemoteControlDialog] 用户点击右上角关闭按钮", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      sessionId: status.sessionId ?? "none",
      status: status.status,
    });
    handleDialogOpenChange(false);
  };

  // [契约] Bot 入口先记录 provider 再打开弹窗，顺序反了会让 BotsDialog 收到 null。
  // provider 类型已收窄，不再接受任意字符串。
  // 日志只记 provider 与 workspace 标识。
  // 两个 setState 连续调用会合并成一次渲染，不要拆成 await。
  // 这里不关闭远控弹窗：配置渠道与弹窗展示可以共存。
  // provider 不清空：单渠道入口本来就要带渠道。
  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bot Channel 配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  // [契约] 总入口必须把 botEntryProvider 清空，否则会沿用上次渠道。
  // 清空与打开必须放在同一事件里，中间不能 await。
  // 总入口与单渠道入口共用 botsDialogOpen，但入口语义不同。
  // BotsDialog 关闭只复位 open，不复位 provider：下次单渠道入口会重新赋值。
  // 日志不带 provider：总入口没有渠道语义。
  // 不要在这里预加载 Bot 列表：BotsDialog 自己负责数据。
  // 调用顺序固定为“清空 → 打开 → 记日志”，便于日志反映最终状态。
  // 该 handler 不做防抖：重复点击只会重复打开同一弹窗。
  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bots 总配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          showCloseButton={false}
          // Bugfix: Mobile Remote Control 弹窗之前比 Remote Connect 更宽也更贴近窗口边缘，
          // 启动二维码和 Bot Channel 内容时会显得层级不一致。这里复用 Remote Connect 的外层尺寸，
          // 但不强制撑满高度；远控内容比 Remote Connect 少，内容自适应能避免窗口显得空。
          className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix: 这个弹窗会贴近桌面窗口顶部显示，默认 close 在 Electron drag 区里容易点不中。
            // 这里改成显式点击关闭，并把按钮本身标成 no-drag，保证右上角关闭动作能稳定命中。
            // Bugfix: 远控弹层内可点击控件之前没有显式 pointer cursor，桌面端 hover 时不像可操作元素。
            // 这里仅给启用态补手指指针，禁用态仍沿用 Button 的 disabled 交互语义。
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={handleDismiss}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
          <div
            data-testid="web-remote-control-dialog-scroll"
            className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5"
          >
            <DialogHeader className="space-y-2 pr-8">
              <div className="flex items-center gap-2">
                <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                  <MonitorSmartphone className="size-5" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>{intl.formatMessage({ id: "webRemoteControl.title" })}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "webRemoteControl.description" })}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div
              data-testid="web-remote-control-main-grid"
              className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]"
            >
              <section
                data-testid="web-remote-control-scan-card"
                className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4"
              >
                {status.status === "auth-required" ? (
                  <div
                    data-testid="web-remote-control-auth-required"
                    className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-6 text-center"
                  >
                    <MonitorSmartphone className="size-8 text-foreground-subtle" />
                    <div className="space-y-2">
                      <h3 className="text-ui-base font-medium text-foreground">
                        {intl.formatMessage({ id: "webRemoteControl.authRequired.title" })}
                      </h3>
                      <p className="text-ui-base/relaxed text-foreground-subtle">
                        {intl.formatMessage({ id: "webRemoteControl.authRequired.description" })}
                      </p>
                    </div>
                    <WebRemoteControlLoginButton onOpenChange={onOpenChange} />
                  </div>
                ) : (
                  <>
                    <div className="mb-4 flex items-start gap-2">
                      <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                      <div className="min-w-0 space-y-1">
                        <div className="text-ui-base font-medium text-foreground">
                          {intl.formatMessage({
                            id: "webRemoteControl.mobileQr.title",
                          })}
                        </div>
                        <p className="text-ui-base/relaxed text-foreground-subtle">
                          {intl.formatMessage({
                            id: "webRemoteControl.mobileQr.description",
                          })}
                        </p>
                      </div>
                    </div>
                    <div
                      data-testid="web-remote-control-connection-card"
                      className="mb-3 rounded-lg bg-surface px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="text-ui-base font-medium text-foreground">
                              {statusLabel}
                            </div>
                            <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                              <span
                                className={`size-1.5 shrink-0 rounded-full ${statusDotClassName}`}
                              />
                              <span className="truncate">{statusTagLabel}</span>
                            </div>
                          </div>
                          <div className="text-ui-base/relaxed text-foreground-subtle">
                            {statusDetail}
                          </div>
                        </div>
                        {loading ? (
                          <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="default"
                            className="shrink-0 gap-2 enabled:cursor-pointer"
                            onClick={() => void handleStop()}
                            disabled={status.status === "idle"}
                          >
                            <Unplug className="size-3.5" />
                            {intl.formatMessage({ id: "webRemoteControl.stop" })}
                          </Button>
                        )}
                      </div>
                      {failureDescription ? (
                        <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-ui-base/relaxed text-destructive">
                          <p>{failureDescription}</p>
                          {status.failure?.message &&
                          status.failure.message !== failureDescription ? (
                            <p className="mt-1 text-ui-xs/relaxed opacity-80">
                              {status.failure.message}
                            </p>
                          ) : null}
                        </div>
                      ) : status.error ? (
                        <p className="mt-3 text-ui-base/relaxed text-destructive">{status.error}</p>
                      ) : null}
                      <div
                        data-testid="web-remote-control-copy-link-row"
                        className="mt-3 flex min-h-10 flex-wrap items-center gap-3 border-t border-border pt-3"
                      >
                        <div className="min-w-48 flex-1 text-ui-base/relaxed text-foreground-subtle">
                          {intl.formatMessage({
                            id: "webRemoteControl.copyLink.description",
                          })}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="default"
                          className="shrink-0 gap-2 enabled:cursor-pointer"
                          onClick={() => void handleCopyLink()}
                          disabled={!status.connectUrl || loading}
                        >
                          <CopyIcon className="size-3.5" />
                          {intl.formatMessage({ id: "webRemoteControl.copyLink" })}
                        </Button>
                      </div>
                    </div>
                    <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background-alt p-4">
                      {qrDataUrl ? (
                        <img
                          src={qrDataUrl}
                          alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
                          className="size-64 max-w-full rounded-lg bg-white p-3"
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-3 text-center text-ui-base text-foreground-subtle">
                          <LoaderCircle className="size-5 animate-spin" />
                          <span>
                            {intl.formatMessage({
                              id: "webRemoteControl.generating",
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </section>

              <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-4 flex items-start gap-2">
                  <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.title",
                      })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.description",
                      })}
                    </p>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 gap-3">
                  {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
                    const regionTagLabelId = getBotProviderRegionTagLabelId(entry.provider);

                    return (
                      <button
                        key={entry.provider}
                        type="button"
                        className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                        onClick={() => handleOpenBotEntry(entry.provider)}
                      >
                        {/* Bugfix: 远控 Bot Channel 入口原来用通用 lucide 图标，用户无法一眼区分微信、飞书和 Telegram。
                            这里直接复用 BotsDialog 的渠道 logo，不再额外包裹容器，保证品牌图标本身作为视觉识别。 */}
                        <ProviderIcon provider={entry.provider} className="size-12 shrink-0" />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                            <span className="min-w-0 truncate">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${entry.provider}.title`,
                              })}
                            </span>
                            {regionTagLabelId ? (
                              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                {intl.formatMessage({ id: regionTagLabelId })}
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-ui-base/relaxed text-foreground-subtle">
                            {intl.formatMessage({
                              id: `webRemoteControl.botChannel.${entry.provider}.description`,
                            })}
                          </span>
                          <span className="block text-ui-base font-medium text-primary">
                            {intl.formatMessage({
                              id: "webRemoteControl.botChannel.configure",
                            })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    data-testid="web-remote-control-open-bots"
                    className="w-full justify-center gap-2 enabled:cursor-pointer"
                    onClick={handleOpenBotsDialog}
                  >
                    <BotIcon className="size-3.5" />
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.manageBots",
                    })}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
