// EmbeddedBrowserPermissionPrompts.tsx —— 内置浏览器权限弹窗层：把 main 的权限请求渲染成气泡或 Dialog
//
// INV-01 渲染只读取 store 中的 prompts，决策一律经 resolve 回传 main 后再本地出队；守住位置：resolve 函数；改错故障：只删本地条目不回传，main 侧请求悬挂到超时，页面权限请求永久 pending
// INV-02 resolve 必须先调用平台接口再出队，顺序不可颠倒；守住位置：resolve 的两行；改错故障：先出队则弹窗消失但平台未收到决策，权限请求无主等待
// INV-03 20s 兜底计时器与条目一一对应，prompts 变化时整组重建；守住位置：首个 useEffect；改错故障：计时器被复用导致旧条目提前出队，用户还在选择时弹窗消失
// INV-04 effect 返回值必须是清理函数并逐条 clearTimeout；守住位置：首个 useEffect 的返回；改错故障：卸载后计时器仍触发 dropPrompt，已卸载的订阅被写入造成状态错乱
// INV-05 平台缺少 onEmbeddedBrowserPermissionPrompt 时只告警不注册；守住位置：第二个 useEffect 的空值分支；改错故障：强行调用空方法抛 TypeError，整个弹窗层白屏
// INV-06 平台订阅的清理函数直接作为 effect 返回值，不再包一层；守住位置：第二个 useEffect 的 return dispose；改错故障：漏解除订阅，重挂载后同一事件被 receivePrompt 多次入队，出现重复弹窗
// INV-07 prompts 过滤分两类且互不重叠：permission 走气泡，其余走 Dialog；守住位置：两个 useMemo 的谓词；改错故障：同一条目同时渲染气泡与对话框，用户在两个入口给出互相覆盖的决策
// INV-08 guestWebContentsId 不匹配的请求不得在当前 tab 渲染，缺省归属 id 的请求兜底渲染；守住位置：两个 useMemo 的过滤条件；改错故障：后台 tab 的权限请求显示在前台，用户批准了并非当前页面发起的能力
// INV-09 两个过滤 useMemo 的依赖数组必须同时含 prompts 与 guestWebContentsId；守住位置：两个 useMemo 尾部；改错故障：切换 tab 后仍展示上个 tab 的请求，批准动作落到错误 guest
// INV-10 selection 以 requestId 为键，多弹窗并存时互不干扰；守住位置：useState 与两处 setSelection；改错故障：共用单一选中项，选第二个设备时第一个弹窗的选择被清空
// INV-11 selection 只增不清，条目出队后残留键无害且不得当作待处理队列；守住位置：渲染与提交按钮；改错故障：已结算的请求被重新提交，main 收到第二个无效决策
// INV-12 提交按钮在未选中任何源或设备时保持 disabled；守住位置：DialogFooter 的 disabled 属性；改错故障：空选择触发 share-screen 或 select-device，main 收到无效 id 后只能判为取消
// INV-13 提交前必须二次读取 selection 并在空值处提前退出；守住位置：分享按钮 onClick 首行；改错故障：disabled 与点击之间存在竞态，空值直接进入 resolve 构造非法决策
// INV-14 screen-share 的载荷是 sourceId，device 的载荷是 deviceId，两者不可互换；守住位置：提交按钮的三元分支；改错故障：字段错位使 main 找不到源，用户点击共享后无反应
// INV-15 关闭按钮与「不允许」都映射为 dismiss 而非 cancel；守住位置：气泡的关闭按钮与第三颗胶囊；改错故障：同一拒绝产生两种动作，main 侧是否记忆的判定分叉
// INV-16 Dialog 的 onOpenChange 在 open 为 false 时映射为 cancel，Esc 与点击遮罩都走这条路径；守住位置：Dialog 的 onOpenChange；改错故障：用户按 Esc 后弹窗关闭但请求未结算，一直挂到 20s 超时
// INV-17 气泡不提供「永久阻止」，持久拒绝只存在于站点权限设置；守住位置：竖排三胶囊区；改错故障：误点永久拒绝后站点能力长期失效，用户无法在弹窗内自愈
// INV-18 气泡容器是 pointer-events-none，只有卡片自身 pointer-events-auto；守住位置：气泡外层 div；改错故障：透明容器挡住浏览器视图的点击，页面整体不可交互
// INV-19 气泡卡片带 role="dialog" 与 aria-label，关闭与三颗胶囊按钮都有可读名称；守住位置：卡片与按钮属性；改错故障：屏幕阅读器只念出无名称按钮，用户无法判断自己批准了哪项能力
// INV-20 所有可见文案来自 formatMessage 的 i18n key，PERMISSION_LABEL 与 MEDIA_LABEL 只存 key；守住位置：常量表与全部渲染点；改错故障：新增语言缺翻译时界面回退成 key 原文
import { useEffect, useMemo, useState } from "react";
import { MonitorUp, Paperclip, ShieldAlert, Usb, X } from "lucide-react";
import {
  type EmbeddedBrowserPermissionPromptEvent,
  type EmbeddedBrowserPermissionResolution,
} from "@zcode/shared";
import {
  TID_BROWSER_PERMISSION_ALLOW_ALWAYS,
  TID_BROWSER_PERMISSION_ALLOW_ONCE,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_DISMISS,
  TID_BROWSER_PERMISSION_PROMPTS,
} from "@zcode/shared/test-ids";
import { BrowserPermissionIcon } from "@/browser-use/BrowserPermissionIcon.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { logger } from "@/logger.js";
import { useEmbeddedBrowserPermissionStore } from "@/store/embeddedBrowserPermissionStore.js";

/**
 * 内置浏览器权限弹窗层（spec：docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md）。
 * permission → Chrome 式锚定气泡（地址栏下方左侧，自动弹出；卡片为 origin 标题 + ✕ 关闭 +
 * 能力图标列表 + 竖排三胶囊：访问此网站时允许（持久）/ 仅本次允许 / 不允许（本次拒绝不记忆）；
 * 不做「永久阻止」——误点后站点异常难以自愈，持久 deny 只保留在站点权限设置里管理）；
 * screen-share / device → Dialog 选择器（源按「整个屏幕 / 窗口」分组）。
 * 取消与超时统一由 main 结算，renderer 只回传决策。
 */

// 两张表只存 i18n key 不存译文：翻译在渲染时由 formatMessage 解析，新增语言不必改本文件
// key 与能力名分离，使 media 的 video/audio 能拆成两行而普通 permission 只占一行
// [权衡] 用 Record<string, string> 而非字面量联合键，是为了让查表兜底 unknownCapability 时不触发类型错误
// midi 与 midiSysex 共用同一 key：对用户是同一项能力，分开命名会产生两行同义文案
// storage-access 与 top-level-storage-access 同理，语义差异属于协议细节，不暴露给用户
// fileSystem 与 select-hid-device 等 device 类目在这里也有条目：能力列表按 permission 名直接查表，不区分弹窗形态
const MEDIA_LABEL: Record<string, string> = {
  video: "browser.permission.mediaVideo",
  audio: "browser.permission.mediaAudio",
};

const PERMISSION_LABEL: Record<string, string> = {
  media: "browser.permission.media",
  "clipboard-read": "browser.permission.clipboardRead",
  geolocation: "browser.permission.geolocation",
  notifications: "browser.permission.notifications",
  midi: "browser.permission.midi",
  midiSysex: "browser.permission.midi",
  "idle-detection": "browser.permission.idleDetection",
  "speaker-selection": "browser.permission.speakerSelection",
  "window-management": "browser.permission.windowManagement",
  "storage-access": "browser.permission.storageAccess",
  "top-level-storage-access": "browser.permission.storageAccess",
  keyboardLock: "browser.permission.keyboardLock",
  fileSystem: "browser.permission.fileSystem",
  "select-hid-device": "browser.permission.deviceHid",
  "select-usb-device": "browser.permission.deviceUsb",
  "select-serial-port": "browser.permission.deviceSerial",
  "select-bluetooth-device": "browser.permission.deviceBluetooth",
};

// media 是多能力总称，只有拿到 mediaTypes 才能细分成摄像头或麦克风，否则退回总称文案
// ids 长度为 1 才使用细分 key，为 2 时切到 mediaBoth，避免出现两段文案拼接
// 过滤掉未知 media 类型：未知能力按总称展示，好过把 undefined 交给 formatMessage
// [失败路径] mediaTypes 为空数组与缺失等价，都落到 media 总称，不抛错
// 非 media 的能力一律单行，即使它本身可带子类型也不在气泡里拆行
// 查表未命中返回 unknownCapability 而非原样回显 permission 名：英文标识符对用户无意义
// 返回值是 i18n key 而非译文，调用方负责翻译，因此本函数能在渲染路径之外被复用
function permissionLabelId(permission: string, mediaTypes?: string[]): string {
  if (permission === "media" && mediaTypes && mediaTypes.length > 0) {
    const ids = mediaTypes.map((type) => MEDIA_LABEL[type]).filter(Boolean);
    if (ids.length === 1) return ids[0]!;
    if (ids.length > 1) return "browser.permission.mediaBoth";
  }
  return PERMISSION_LABEL[permission] ?? "browser.permission.unknownCapability";
}

/** 气泡能力列表：media 按 mediaTypes 拆成摄像头/麦克风独立行，其余一类一行。 */
function promptCapabilities(
  prompt: Extract<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }>,
): { key: string; labelId: string }[] {
  if (prompt.permission === "media") {
    const types = prompt.mediaTypes?.length ? prompt.mediaTypes : ["video", "audio"];
    return types.map((type) => ({
      key: type === "video" ? "camera" : "microphone",
      labelId: MEDIA_LABEL[type] ?? "browser.permission.media",
    }));
  }
  return [{ key: prompt.permission, labelId: permissionLabelId(prompt.permission) }];
}

function promptIcon(event: EmbeddedBrowserPermissionPromptEvent) {
  if (event.kind === "screen-share") return <MonitorUp className="size-4 shrink-0" />;
  if (event.kind === "device") return <Usb className="size-4 shrink-0" />;
  if (event.permission === "clipboard-read") return <Paperclip className="size-4 shrink-0" />;
  return <ShieldAlert className="size-4 shrink-0" />;
}

/**
 * guestWebContentsId 是当前 tab 的 guest 身份：permission 请求带归属 id 且不匹配
 * 当前 tab 时不在本 tab 渲染（后台 tab 的请求不显示在当前 tab，避免误批准）。
 * 当前 tab 无 guest（空 tab）时任何带归属的请求都不属于它，同样不渲染；
 * 请求缺归属 id（device/screen-share 等无 tab 锚定语义的弹窗）兜底渲染，
 * 气泡正文始终展示 origin 供用户确认来源。
 */
// guestWebContentsId 由外层按当前 tab 传入，本组件不自行读取路由或 tab 状态
// store 订阅全部走 selector，action 引用在 Zustand 中稳定，不会引发额外的重渲染
// [并发] store 的写入方只有平台事件与超时兜底两处，二者都以 requestId 为键，重复入队由 store 收敛
// selection 是纯 UI 局部状态，不进入 store：它只在点击提交前有意义，不需要跨组件共享
// 平台方法缺失时全部走可选链，缺平台降级为不展示而不是崩溃
// [权衡] 不做上一次 prompts 的差量动画：弹窗是阻断性交互，淡入淡出期间允许点击反而危险
// 不做权限去重合并：两个 tab 的同类请求必须各自展示，合并会让用户以为只批准了一次
// [资源] 本组件不持有任何订阅或定时器的全局句柄，全部生命周期都绑定在下面两个 useEffect 上
export function EmbeddedBrowserPermissionPrompts({
  guestWebContentsId,
}: {
  guestWebContentsId?: number;
}) {
  const platform = usePlatform();
  const {
    intl: { formatMessage },
  } = useZCodeIntl();
  const prompts = useEmbeddedBrowserPermissionStore((state) => state.prompts);
  const receivePrompt = useEmbeddedBrowserPermissionStore((state) => state.receivePrompt);
  const dropPrompt = useEmbeddedBrowserPermissionStore((state) => state.dropPrompt);
  // 键是 requestId，值是 sourceId 或 deviceId，一条弹窗一个选中项，天然支持多弹窗并存
  // 初值为空对象而不是 undefined，渲染与提交处可以直接下标访问
  // setSelection 一律用函数式更新并展开旧值：连续点击不同分组时闭包里的旧值可能已过期
  // [权衡] 不做选中项清理：出队后残留键只是少量内存，清理需要在每次 prompts 变化时做全量比对
  // 该状态没有持久化语义，重挂载后用户必须重新选择，符合一次性授权的心智
  // 同一 requestId 重复点击是覆盖而非新增，data-selected 用相等比较即可高亮唯一项
  const [selection, setSelection] = useState<Record<string, string>>({});

  useEffect(() => {
    // main 侧超时结算后不会主动通知 renderer；渲染层对超时同样按 20s 出队兜底，
    // 避免条目残留（下次同请求是新的 requestId，不受影响）。
    // [并发] 每个条目一个独立计时器，prompts 数组变化时整组重建，不按 requestId 缓存复用
    // 20s 与 main 侧超时同量级但相互独立：这里的兜底只负责本地出队，不向 main 回传决策
    // [失败路径] prompts 变化导致计时器重置时已等待的时间丢失，最坏情况是条目多停留一个周期
    // dropPrompt 是 store 的稳定 action 引用，放进依赖数组不会造成 effect 反复重建
    // 计时器回调只带 requestId，不捕获 prompt 对象，避免超时后读到已被替换的条目
    // [资源] 组件卸载时 disposers 全量执行，clearTimeout 之后不会再有回调落到已卸载的订阅上
    // 清理函数是嵌套数组摊平的结果：每个元素只清自己那一个定时器，执行顺序无关
    // [权衡] 不用 setInterval 轮询过期时间：条目量级是个位数，一请求一 timer 的精度足够且开销更低
    const disposers = prompts.map((prompt) => {
      const timer = setTimeout(() => dropPrompt(prompt.requestId), 20_000);
      return () => clearTimeout(timer);
    });
    return () => disposers.forEach((dispose) => dispose());
  }, [prompts, dropPrompt]);

  useEffect(() => {
    // 平台订阅返回清理函数，直接作为 effect 返回值，中间不额外包装，保证订阅与解绑一一对应
    // [资源] 依赖里有 platform：平台服务实例变化时必须重订阅，旧解绑函数留在旧实例上
    // receivePrompt 是稳定引用，不会因 prompts 变化触发重订阅，避免订阅抖动丢事件
    // [失败路径] 平台未实现该能力时返回 undefined，此处只记 warn 不发请求，弹窗层降级为不可用
    // [权衡] 用 warn 而不是 error：Web 端可能本就没有内置浏览器，缺订阅属于预期而非故障
    // 订阅回调不做 guest 归属过滤：过滤放在渲染层的 useMemo，store 保留全部事件供其它消费者读取
    // 解除订阅必须由本 effect 的返回值完成，卸载后再手动调用会重复解绑，是否安全取决于平台实现
    const dispose = platform.onEmbeddedBrowserPermissionPrompt?.((event) => receivePrompt(event));
    if (!dispose) {
      logger.warn("[embedded-browser-permission] platform prompt subscription unavailable");
      return;
    }
    return dispose;
  }, [platform, receivePrompt]);

  // 顺序固定：先回传决策再本地出队；颠倒时弹窗先消失而 main 仍在等待，用户看到页面卡住
  // 平台调用用可选链：走到这里说明宿主缺少该能力，静默跳过优于抛错中断整个渲染
  // [事务] 回传与出队不是原子的，回传成功而出队失败时条目会在 20s 后被兜底清掉，不会永久残留
  // 不做本地存在性校验：requestId 是否仍有效交给 store 的幂等删除，重复点击不会重复结算
  // [失败路径] 平台调用抛错会中断出队，因此平台实现内部必须自行容错，不能让异常穿过本函数
  // [权衡] 不弹二次确认：点击即表达意图，确认框只会拖长这段阻断时间
  // 所有决策共用这一个出口，气泡与对话框的差异只体现在传入的 resolution 字段
  const resolve = (requestId: string, resolution: EmbeddedBrowserPermissionResolution) => {
    platform.resolveEmbeddedBrowserPermissionPrompt?.({ requestId, resolution });
    dropPrompt(requestId);
  };

  // 类型谓词收窄到 kind 为 permission 的分支，后面的 promptCapabilities 才能直接读 mediaTypes
  // 归属过滤留了 undefined 的口子：缺归属 id 的请求在气泡里仍要展示，否则请求无人应答
  // [并发] 过滤是纯函数，不含时间与随机因素，同一份 prompts 与 guestWebContentsId 必得同一结果
  // [权衡] 用 useMemo 而不是渲染内联过滤：每次 selection 变化都会重渲染，过滤结果应当稳定
  // 依赖数组必须含 prompts，缺失时新请求不会进入列表，弹窗永远不出现
  // 过滤不改写原数组元素，条目仍保留完整字段供 Dialog 分支使用
  const permissionPrompts = useMemo(
    () =>
      prompts.filter(
        (prompt): prompt is Extract<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }> =>
          prompt.kind === "permission" &&
          (prompt.guestWebContentsId === undefined ||
            prompt.guestWebContentsId === guestWebContentsId),
      ),
    [prompts, guestWebContentsId],
  );
  // device 弹窗与 permission 同样按 guest 归属过滤（serial/蓝牙可取到归属；
  // hid/usb 与屏幕共享缺省归属 id 时兜底渲染，正文 origin 标明来源）。
  // 谓词用 Exclude 排除 permission，与气泡分支互斥，同一条目只能进一条渲染路径
  // device 与 screen-share 共用归属过滤：serial 与蓝牙能取到归属，hid 与 usb 常常缺省
  // [失败路径] 缺归属 id 时兜底渲染，卡片正文展示 origin，用户据此判断来源是否可信
  // 此处不排序也不去重：多台设备要保持 main 传入的枚举顺序，便于用户按位置记忆
  // [权衡] 两个 useMemo 分别过滤而非一次分组：各自类型收窄独立，代价是多遍历一次小数组
  // 结果为空数组时不渲染任何 Dialog，避免常驻空壳抢走焦点
  const selectorPrompts = useMemo(
    () =>
      prompts.filter(
        (
          prompt,
        ): prompt is Exclude<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }> =>
          prompt.kind !== "permission" &&
          (prompt.guestWebContentsId === undefined ||
            prompt.guestWebContentsId === guestWebContentsId),
      ),
    [prompts, guestWebContentsId],
  );

  return (
    <>
      {permissionPrompts.length > 0 ? (
        <div
          className="pointer-events-none absolute left-3 top-1.5 z-40 flex w-80 max-w-[calc(100%-24px)] flex-col gap-2"
          data-testid={TID_BROWSER_PERMISSION_PROMPTS}
        >
          {permissionPrompts.map((prompt) => (
            <div
              key={prompt.requestId}
              className="pointer-events-auto rounded-xl border border-popover-border bg-popover p-4 shadow-md"
              role="dialog"
              aria-label={formatMessage({ id: "browser.permission.promptAriaLabel" })}
            >
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-ui-lg leading-relaxed font-medium break-words">
                  <span className="text-foreground">{prompt.origin}</span>
                  <span className="text-ui-base text-foreground-subtle">
                    {" "}
                    {formatMessage({ id: "browser.permission.wantsToUse" })}
                  </span>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={formatMessage({ id: "browser.permission.close" })}
                  data-testid={TID_BROWSER_PERMISSION_DISMISS}
                  onClick={() => resolve(prompt.requestId, { action: "dismiss" })}
                >
                  <X />
                </Button>
              </div>
              <ul className="mt-2 space-y-2">
                {promptCapabilities(prompt).map((capability) => (
                  <li
                    key={capability.key}
                    className="flex items-center gap-2 text-ui-base text-foreground break-all"
                  >
                    <BrowserPermissionIcon capability={capability.key} />
                    {formatMessage({ id: capability.labelId })}
                  </li>
                ))}
              </ul>
              {/* 竖排三胶囊（fix/missing_tool 视觉）：持久允许 / 仅本次允许 / 不允许（不记忆）。
                  不提供「永久阻止」：误点后站点异常难自愈，持久 deny 只在站点权限设置管理。 */}
              <div className="mt-3 flex flex-col gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_ALLOW_ALWAYS}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "allow-always" })}
                >
                  {formatMessage({ id: "browser.permission.allowAlways" })}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_ALLOW_ONCE}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "allow-session" })}
                >
                  {formatMessage({ id: "browser.permission.allowOnce" })}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_DENY}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "dismiss" })}
                >
                  {formatMessage({ id: "browser.permission.denyThisTime" })}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {selectorPrompts.map((prompt) => (
        <Dialog
          key={prompt.requestId}
          open
          onOpenChange={(open) => {
            if (!open) resolve(prompt.requestId, { action: "cancel" });
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {promptIcon(prompt)}
                {prompt.kind === "screen-share"
                  ? formatMessage(
                      { id: "browser.permission.screenShareTitle" },
                      { origin: prompt.origin },
                    )
                  : formatMessage(
                      { id: "browser.permission.deviceTitle" },
                      { origin: prompt.origin },
                    )}
              </DialogTitle>
              <DialogDescription>
                {prompt.kind === "screen-share"
                  ? formatMessage({ id: "browser.permission.screenShareDescription" })
                  : formatMessage({ id: permissionLabelId(prompt.permission) })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {prompt.kind === "screen-share" ? (
                (["screen", "window"] as const).map((group) => {
                  const screens = prompt.screens.filter((screen) => screen.kind === group);
                  if (screens.length === 0) return null;
                  return (
                    <div key={group}>
                      <p className="px-2 pb-1 pt-2 text-ui-xs text-foreground-subtlest">
                        {formatMessage({
                          id:
                            group === "screen"
                              ? "browser.permission.screenGroup.screen"
                              : "browser.permission.screenGroup.window",
                        })}
                      </p>
                      {screens.map((screen) => (
                        <button
                          type="button"
                          key={screen.sourceId}
                          className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-menu-hover data-[selected=true]:bg-selected"
                          data-selected={selection[prompt.requestId] === screen.sourceId}
                          onClick={() =>
                            setSelection((current) => ({
                              ...current,
                              [prompt.requestId]: screen.sourceId,
                            }))
                          }
                        >
                          {screen.thumbnailDataUrl ? (
                            <img
                              src={screen.thumbnailDataUrl}
                              alt=""
                              className="h-[45px] w-20 rounded-sm border border-border object-cover"
                            />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                            {screen.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })
              ) : (
                prompt.devices.map((device) => (
                  <button
                    type="button"
                    key={device.deviceId}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-menu-hover data-[selected=true]:bg-selected"
                    data-selected={selection[prompt.requestId] === device.deviceId}
                    onClick={() =>
                      setSelection((current) => ({
                        ...current,
                        [prompt.requestId]: device.deviceId,
                      }))
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui-sm text-foreground">
                        {device.name ?? device.deviceId}
                      </span>
                      {device.vendorId !== undefined || device.serialNumber ? (
                        <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
                          {[
                            device.vendorId !== undefined && device.productId !== undefined
                              ? `${device.vendorId.toString(16).padStart(4, "0")}:${device.productId.toString(16).padStart(4, "0")}`
                              : undefined,
                            device.serialNumber,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolve(prompt.requestId, { action: "cancel" })}
              >
                {formatMessage({ id: "browser.permission.cancel" })}
              </Button>
              <Button
                size="sm"
                // [失败路径] 空选择必须禁用提交：share-screen 缺 sourceId 时 main 只能把请求判为取消
                // disabled 只是交互层的第一道闸，onClick 里仍要重新读取并判空，两者不能互相替代
                // 选中项取自当前渲染的 selection 快照，弹窗重渲染时同步刷新，不存在读到旧值的窗口
                // [权衡] 不预选第一项：屏幕共享默认选中会把一次随手点击误判为明确授权
                // 按钮文案按 kind 在「共享」与「连接」之间切换，与上方标题保持同一语义
                // 取消按钮与关闭走同一个 cancel 动作，且都不写入站点持久权限
                disabled={!selection[prompt.requestId]}
                onClick={() => {
                  const picked = selection[prompt.requestId];
                  if (!picked) return;
                  resolve(
                    prompt.requestId,
                    prompt.kind === "screen-share"
                      ? { action: "share-screen", sourceId: picked }
                      : { action: "select-device", deviceId: picked },
                  );
                }}
              >
                {formatMessage({
                  id:
                    prompt.kind === "screen-share"
                      ? "browser.permission.share"
                      : "browser.permission.connect",
                })}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ))}
    </>
  );
}
