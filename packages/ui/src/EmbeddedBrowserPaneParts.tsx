// EmbeddedBrowserPaneParts —— 内嵌浏览器面板的纯展示部件集合：把 browserState 与回调投影成工具栏、空态、加载错误态、guest 崩溃态。
// 不负责：webview 的创建与销毁、导航执行、历史栈维护、权限授予、元素拾取、响应式尺寸计算，这些都在宿主 EmbeddedBrowserPane 与浏览器服务里。
// 本文件无 state、无 effect、无副作用，只渲染入参；任何需要「记住」的东西都必须留在宿主，避免出现第二份可变事实。
//
// 标记约定：[契约] 对外 props/testid/i18n key 的稳定性；[失败路径] 错误展示与重试；[资源] DOM 节点与菜单生命周期；[权衡] 选择与代价。
//
// 不变量表（INV-01 ~ INV-14，逐条对应下方真实函数或分支）：
// INV-01 断言：后退/前进按钮的可用性只取 browserState.canGoBack 与 canGoForward —— 守住它的位置：BrowserToolbar 前两个 BrowserIconButton 的 disabled —— 改错故障：用户能点进无历史的导航，宿主收到越界 goBack 后停在 chrome-error 白页。
// INV-02 断言：刷新按钮在未就绪时必须禁用 —— 守住它的位置：BrowserToolbar 第三个 BrowserIconButton 的 disabled={!browserState.isReady} —— 改错故障：对空 guest 调 reload，控制台刷出 webview 方法不存在并留下未完成导航。
// INV-03 断言：提交路径必须经 runUserAction 包裹且保留 featureId/action/failureStage 三元组 —— 守住它的位置：form 的 onSubmit —— 改错故障：导航埋点断流，navigate 计数归零，线上回归无法归因到具体阶段。
// INV-04 断言：包装器里的 operation 必须原样调用 onSubmit(event)，不得吞事件、不得自行 preventDefault —— 守住它的位置：onSubmit 箭头函数 —— 改错故障：地址栏回车既不导航也不报错，或宿主拿不到原始事件导致整页跳转。
// INV-05 断言：地址栏聚焦时 permissionControl 只隐藏不卸载 —— 守住它的位置：地址栏右侧 group-has-[input:focus] 容器 —— 改错故障：权限入口的状态随卸载丢失，用户重新聚焦后申请被重置为未决。
// INV-06 断言：地址输入框的 px-14 / text-center 与 focus:px-3 组合不可改 —— 守住它的位置：地址栏 Input 的 className —— 改错故障：左侧权限图标压住 URL 文本，长域名被裁切且无法点击定位。
// INV-07 断言：响应式模式按钮的 disabled 恒为 false —— 守住它的位置：第四个 BrowserIconButton —— 改错故障：guest 未就绪时无法预先切换响应式视图，恢复后布局与用户预期不一致。
// INV-08 断言：元素拾取按钮在未就绪时禁用，active 同时决定标题文案与取消语义 —— 守住它的位置：第五个 BrowserIconButton 的 disabled/active/title —— 改错故障：对空 guest 发起拾取，宿主挂起的 picker 在导航后残留并吞掉首次点击。
// INV-09 断言：「在外部打开」必须同时校验 isReady 与 isDefaultBrowserOpenableUrl —— 守住它的位置：BrowserToolbar 传给 MoreMenu 的 canOpenExternal —— 改错故障：javascript:/file:/data: 地址被交给系统浏览器，构成可被网页利用的越权打开。
// INV-10 断言：更多菜单的两个动作项用 disabled 表达不可用，不做条件渲染 —— 守住它的位置：BrowserToolbarMoreMenu 的两个 DropdownMenuItem —— 改错故障：未就绪时菜单项消失，用户以为功能缺失，按固定项数断言的测例同时失败。
// INV-11 断言：空态默认 isGuestStarting = !isReady，只有显式传 false 才显示地球图标 —— 守住它的位置：BrowserEmptyState 的默认参数 —— 改错故障：guest 启动中显示静态空态，用户以为已加载完成而反复点击地址栏。
// INV-12 断言：证书指引只在 isCertificateError 为真时渲染 —— 守住它的位置：BrowserLoadErrorState 的条件分支 —— 改错故障：普通 DNS 失败也提示放行证书，诱导用户忽略真实安全警告。
// INV-13 断言：加载错误态与 guest 崩溃态都不自动重试，只暴露显式 onRetry —— 守住它的位置：BrowserLoadErrorState 与 BrowserGuestFailureState —— 改错故障：崩溃被自动重建形成失败循环，CPU 飙高且日志刷屏。
// INV-14 断言：aria-pressed 只透传调用方给的 pressed，不补默认 false —— 守住它的位置：BrowserIconButton 的 aria-pressed —— 改错故障：非切换按钮被读屏播报为「可按下、未按下」，语义与视觉提示相反。
//
// 覆盖层纪律：空态、加载错误态、guest 崩溃态统一 absolute inset-0 z-10 加不透明 bg-background，必须完整遮住 webview 的 chrome-error 白页。
// 它们只是宿主状态的一种投影，渲染错误态不代表 guest 已销毁；不要在覆盖层里做任何重建或清理。
// 文案纪律：所有可见文本走 formatMessage 的 descriptor id，禁止内联中英文串，漏翻时宁可显示 key 也不要硬编码。
// 选择器纪律：data-testid 一律取 @zcode/shared/test-ids 常量，字符串写死会让 E2E 静默失配。
// 尺寸纪律：图标统一 h-4 w-4 或 size-4，工具栏固定 h-12；改尺寸会把地址栏挤出换行并破坏截图基线。
// 按钮纪律：仅工具栏 form 内的提交具有 submit 语义，其余按钮必须 type="button"，否则误触会触发重复导航。
// 无障碍纪律：交互按钮同时给出 aria-label 与 tooltip，两者取同一 i18n key，避免读屏与视觉提示分叉。
// 签名纪律：工具栏的 formatMessage 只收 descriptor，错误类组件允许带插值 values；两处签名按需声明，不要互相收紧。
// 重渲染纪律：本文件没有 memo，父级任意状态翻转（含 isLoading）都会重渲染全部部件；加 memo 前先确认 permissionControl 的引用稳定性。
// 顺序纪律：工具栏从左到右为后退、前进、刷新、地址栏、响应式、拾取、更多；E2E 与截图基线依赖该顺序。
// 扩展纪律：新增动作优先收进更多菜单，工具栏平铺只留给高频操作，否则地址栏可用宽度会被挤压。
//
// 改动自检：先定位受影响的 INV 编号，再看对应函数是否仍在约定位置；打破任何一条都必须在 PR 中显式说明并补 E2E。
import type { FormEvent, ReactNode } from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  ExternalLink,
  Globe,
  LoaderIcon,
  MonitorSmartphone,
  MousePointerClick,
  RefreshCw,
  TriangleAlertIcon,
} from "lucide-react";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_BACK_BUTTON,
  TID_BROWSER_DEVTOOLS_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_FORWARD_BUTTON,
  TID_BROWSER_LOAD_ERROR,
  TID_BROWSER_LOAD_ERROR_CERT_HINT,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_RESPONSIVE_BUTTON,
} from "@zcode/shared/test-ids";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import {
  isDefaultBrowserOpenableUrl,
  type BrowserGuestFailure,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

// [契约] 工具栏只做投影：按钮可用性全部来自 browserState，事件全部上抛，组件内不维护任何导航状态。
// 看起来可以根据 currentUrl 或 isLoading 推导按钮可用性，但历史栈只有 guest 知道，本地推导会与真实栈错位一格。
// formatMessage 整份下传而不是在此预翻译，语言热切换时工具栏文案才能跟着变。
// 没有 memo 是有意的：父级每次 browserState 翻转都会重渲染，加 memo 会漏掉 permissionControl 这类 ReactNode 的隐式变化。
// 新增按钮时插入位置要遵守从左到右的顺序约定，工具栏固定 h-12，多一个平铺项就会挤压地址栏。
export function BrowserToolbar({
  addressValue,
  browserState,
  permissionControl,
  formatMessage,
  onAddressChange,
  onGoBack,
  onGoForward,
  onOpenExternal,
  onOpenDevTools,
  onPickElement,
  onReload,
  onToggleResponsiveMode,
  onSubmit,
  isElementPickerActive,
  isResponsiveMode,
}: {
  addressValue: string;
  browserState: BrowserState;
  /** 地址栏左侧的站点设置入口；聚焦编辑 URL 时隐藏但不卸载。 */
  permissionControl?: ReactNode;
  formatMessage: (descriptor: { id: string }) => string;
  onAddressChange: (value: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenExternal: () => void;
  onOpenDevTools: () => void;
  onPickElement: () => void;
  onReload: () => void;
  onToggleResponsiveMode: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isElementPickerActive: boolean;
  isResponsiveMode: boolean;
}) {
  // [失败路径] onSubmit 先包 runUserAction 再调 onSubmit：宿主抛错时由遥测层记录失败，不阻断表单默认流程。
  // failureStage 固定 browser_navigate，改动会让看板把导航失败归到未知阶段。
  // trigger 固定 keyboard 是因为这条路径只由地址栏回车触发，将来若加点击提交要新增 trigger 而不是复用。
  // 这里不要抢先 preventDefault：是否阻止默认行为由宿主 onSubmit 决定，抢在前面会让宿主看不到原始事件。
  // completed 标 optimistic_projection 表示导航尚未得到 guest 确认；改成真实结果会把失败导航记成成功。
  return (
    <form
      onSubmit={(event) =>
        runUserAction({
          input: { featureId: "workbench.browser", action: "navigate", trigger: "keyboard" },
          operation: () => onSubmit(event),
          completed: { resultSource: "optimistic_projection" },
          failureStage: "browser_navigate",
        })
      }
      className="flex items-center h-12 px-3 gap-2"
    >
      <BrowserIconButton
        icon={<ChevronLeft className="h-4 w-4" />}
        title={formatMessage({ id: "browser.back" })}
        disabled={!browserState.canGoBack}
        dataTestId={TID_BROWSER_BACK_BUTTON}
        onClick={onGoBack}
      />
      <BrowserIconButton
        icon={<ChevronRight className="h-4 w-4" />}
        title={formatMessage({ id: "browser.forward" })}
        disabled={!browserState.canGoForward}
        dataTestId={TID_BROWSER_FORWARD_BUTTON}
        onClick={onGoForward}
      />
      <BrowserIconButton
        icon={<RefreshCw className={`h-4 w-4 ${browserState.isLoading ? "animate-spin" : ""}`} />}
        title={formatMessage({ id: "browser.reload" })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_REFRESH_BUTTON}
        onClick={onReload}
      />
      <div
        className="group/browser-address relative min-w-0 flex-1"
        data-testid="browser-address-bar"
      >
        <Input
          type="text"
          value={addressValue}
          data-testid={TID_BROWSER_ADDRESS_INPUT}
          size="sm"
          className="h-8 rounded-full px-14 text-center focus:px-3 focus:text-left"
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder={formatMessage({ id: "browser.addressPlaceholder" })}
          spellCheck={false}
        />
        {/* 编辑 URL 时隐藏入口但不卸载，避免将隐藏图标误当成关闭权限申请。 */}
        <div className="absolute top-1/2 left-0.5 -translate-y-1/2 group-has-[input:focus]/browser-address:hidden">
          {permissionControl}
        </div>
      </div>
      <BrowserIconButton
        icon={<MonitorSmartphone className="h-4 w-4" />}
        title={formatMessage({
          id: isResponsiveMode ? "browser.responsive.exit" : "browser.responsive.enter",
        })}
        disabled={false}
        dataTestId={TID_BROWSER_RESPONSIVE_BUTTON}
        onClick={onToggleResponsiveMode}
        active={isResponsiveMode}
        pressed={isResponsiveMode}
      />
      <BrowserIconButton
        icon={<MousePointerClick className="h-4 w-4" />}
        title={formatMessage({
          id: isElementPickerActive
            ? "browser.elementPicker.cancel"
            : "browser.elementPicker.start",
        })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_ELEMENT_PICKER_BUTTON}
        onClick={onPickElement}
        active={isElementPickerActive}
      />
      <BrowserToolbarMoreMenu
        canOpenExternal={
          browserState.isReady && isDefaultBrowserOpenableUrl(browserState.currentUrl)
        }
        canOpenDevTools={browserState.isReady}
        formatMessage={formatMessage}
        onOpenExternal={onOpenExternal}
        onOpenDevTools={onOpenDevTools}
      />
    </form>
  );
}

// [契约] 菜单只收两个布尔与两个回调，URL 合法性判断留在调用方：安全规则不能在本文件出现第二份实现。
// 两个布尔由 BrowserToolbar 计算后传入，菜单内再做二次判断会让禁用态与点击后行为出现分叉。
// 菜单是低频动作的收容处，高频动作必须平铺在工具栏；把常用动作挪进来会让地址栏回车之外的路径被隐藏。
// 本组件不接管 open 状态，依赖 DropdownMenu 的非受控收起；改成受控需同步处理点击外部与 ESC，否则菜单会卡在打开态。
// 菜单宽度 w-52 与靠右对齐是视觉契约，收窄会让「在外部打开」换行并撑高浮层。
function BrowserToolbarMoreMenu({
  canOpenDevTools,
  canOpenExternal,
  formatMessage,
  onOpenDevTools,
  onOpenExternal,
}: {
  canOpenDevTools: boolean;
  canOpenExternal: boolean;
  formatMessage: (descriptor: { id: string }) => string;
  onOpenDevTools: () => void;
  onOpenExternal: () => void;
}) {
  // [契约] moreLabel 同时喂给 ControlHintTooltip 与 aria-label，改 key 会同时影响视觉提示与读屏文案。
  // 只取一次而不是两处各调一次：语言热切换时两次调用可能取到不同 locale，导致提示与无障碍标签不一致。
  // 常量紧贴渲染前计算，保证跟随最新 locale；提到模块顶层会把首个语言冻结下来。
  // 不要在这里拼接图标名或快捷键：菜单提示需保持单句，长文案在工具栏里无法完整展示。
  // 该 key 属于工具栏命名空间，与空态、错误态的 key 不同域，混用会让漏翻检测报错。
  const moreLabel = formatMessage({ id: "browser.more" });
  // [契约] DropdownMenuTrigger 用 asChild 复用 Button，因此 aria-label 与 data-testid 必须落在 Button 上而不是触发器外层。
  // ControlHintTooltip 包在触发器外侧，菜单未展开时也能出现提示；挪进 Content 会被浮层遮挡。
  // 两个菜单项顺序（外部打开、开发者工具）被截图与 E2E 锁定，调换会让关键字定位到相邻项。
  // 菜单项文案用 span 包裹，保证图标与文字同处一条 flex 基线；去掉 span 会让图标垂直居中偏移。
  // 选中后的收起交给 DropdownMenuItem 的 onSelect 语义，额外手动关闭会重复触发 onOpenChange。
  return (
    <DropdownMenu>
      <ControlHintTooltip title={moreLabel}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={moreLabel}
            data-testid={TID_BROWSER_MORE_BUTTON}
          >
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          data-testid={TID_BROWSER_OPEN_EXTERNAL_ITEM}
          disabled={!canOpenExternal}
          onSelect={onOpenExternal}
        >
          <ExternalLink className="size-4" />
          <span>{formatMessage({ id: "browser.openExternal" })}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={TID_BROWSER_DEVTOOLS_BUTTON}
          disabled={!canOpenDevTools}
          onSelect={onOpenDevTools}
        >
          <Bug className="size-4" />
          <span>{formatMessage({ id: "browser.devtools" })}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// [契约] 空态覆盖 webview 尚未建立时的区域，isGuestStarting 区分「正在启动」与「尚未输入地址」两种场景。
// 不要在空态里放外部打开入口：此时还没有可用 URL，点击必然失败，入口统一收在工具栏更多菜单。
// 覆盖层铺满面板且不处理指针穿透；将来若允许点击唤回地址栏，要显式恢复交互而不是去掉不透明背景。
// 标题与描述的间距跟随 text-ui-base 变量，硬编码像素在字体缩放时会错位。
// 组件不接收 onRetry：空态不是失败，给出重试会诱导用户重复触发启动。
export function BrowserEmptyState({
  browserState,
  formatMessage,
  isGuestStarting = !browserState.isReady,
}: {
  browserState: BrowserState;
  formatMessage: (descriptor: { id: string }) => string;
  isGuestStarting?: boolean;
}) {
  // [权衡] 用 isLoading 派生旋转图标，而不是新增一份「启动中」布尔值，避免两处状态漂移出现旋转与地球同时为真。
  // 默认参数 isGuestStarting = !isReady 只在调用方省略时生效；显式传 false 会立刻显示地球图标，默认值不能删。
  // 旋转图标与地球图标共用 size-16 加 opacity-30，只改其中一处会让空态在两种状态间跳动。
  // 外层 z-10 加不透明 bg-background，保证 webview 的 chrome-error 白页不会透出；改半透明会露出底层错误页。
  // 文案只用 browser.title 与 browser.empty，新增文案先补 i18n，否则运行时直接显示原始 key。
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col pb-10 items-center text-center">
        {isGuestStarting ? (
          <LoaderIcon className="mb-6 size-16 animate-spin text-foreground opacity-30" />
        ) : (
          <Globe className="mb-6 size-16 text-foreground opacity-30" />
        )}
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.empty" })}
        </p>
      </div>
    </div>
  );
}

/**
 * 页面加载失败时的可读错误态。
 *
 * Electron 的 `<webview>` 不带 Chrome 的安全插页，被拒的导航只落到一张空的
 * chrome-error 页；过去 errorMessage 只写进 state 没有渲染消费者，空置态又同时被关掉，
 * 用户最终只看到纯黑。证书类失败额外给出放行指引，避免用户无从下手。
 */
// [失败路径] 入参只有错误文案与证书标记，不接收原始 error：错误分类是宿主的职责，展示层再判一次必然漂移。
// formatMessage 在此允许插值参数，与工具栏的窄签名不同；为统一签名而收窄会让后续本地化失去上下文。
// 错误原文不截断不折叠：用户需要原文去检索，宽度只靠 break-all 与 max-w-sm 控制。
// 证书指引与重试按钮的 mt-3 与 mt-6 递进间距不可合并，合并后两类错误的视觉层级趋同。
// 覆盖层不提供 ESC 或点击关闭：错误需要用户显式决策，静默关掉会让失败被误认为已恢复。
export function BrowserLoadErrorState({
  errorMessage,
  formatMessage,
  isCertificateError,
  onRetry,
}: {
  errorMessage: string;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isCertificateError: boolean;
  onRetry: () => void;
}) {
  // [失败路径] 必须把 errorMessage 真正渲染出来：Electron 的 webview 没有 Chrome 安全插页，被拒导航只留下空 chrome-error 页。
  // 错误文本用 font-mono 加 break-all，长 URL 强制断行，否则会把 max-w-sm 容器撑出横向滚动。
  // 证书分支除了换标题 key，还要单独渲染 certHint；把 hint 提到公共区域会让普通错误给出误导性的放行建议。
  // 重试按钮是唯一出口，不要在此自动重试：错误多由网络或证书决定，自动重试只会让失败态闪烁。
  // data-testid 挂最外层容器，E2E 据此判断错误态是否顶替了空态；挪到内层会在过渡帧误判。
  return (
    <div
      data-testid={TID_BROWSER_LOAD_ERROR}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6"
    >
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({
            id: isCertificateError ? "browser.loadError.certTitle" : "browser.loadError.title",
          })}
        </h3>
        <p className="mt-2 font-mono text-ui-sm break-all text-foreground-subtlest">
          {errorMessage}
        </p>
        {isCertificateError ? (
          <p
            data-testid={TID_BROWSER_LOAD_ERROR_CERT_HINT}
            className="mt-3 text-ui-base text-foreground-subtle"
          >
            {formatMessage({ id: "browser.loadError.certHint" })}
          </p>
        ) : null}
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.loadError.retry" })}
        </Button>
      </div>
    </div>
  );
}

/** guest 启动失败时由宿主接管画面；自动重建会形成失败循环，因此只提供显式重试。 */
// [资源] 本组件只做解释与出口，不销毁也不重建 guest；渲染此态意味着宿主已判定启动失败。
// guestFailure 是结构化对象，展示层直接取字段；宿主若改成传字符串，这里会静默丢字段而不是报错。
// exitCode 与 reason 一起插值到 detail，缺一不可：只给退出码时用户无法区分被杀还是自崩。
// 三角警告图标与加载错误态同尺寸同色，保证两类故障视觉权重一致；差异化会让用户误判严重程度。
// 此态下地址栏的可用性由宿主决定，本文件不假设它已隐藏，避免出现输入了却没反应的错觉。
export function BrowserGuestFailureState({
  formatMessage,
  guestFailure,
  onRetry,
}: {
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  guestFailure: BrowserGuestFailure;
  onRetry: () => void;
}) {
  // [失败路径] 自动重建会形成崩溃与重建的循环，因此这里只给显式重试；不要在渲染期或挂载时触发 onRetry。
  // 描述与详情分成两个段落：描述解释发生了什么，详情给出退出码与原因，合并后长文本会挤爆居中列。
  // 重试按钮复用 outline 加 RefreshCw，与加载错误态保持一致；两处分叉会让用户以为是两种性质的故障。
  // 本态与加载错误态互斥由宿主决定，组件内不做优先级判断，避免两个覆盖层同时挂载后互相遮挡。
  // 错误详情不加 break-all 而外层限宽 max-w-sm，是因为 reason 通常较短；若将来塞入长 stderr 需要重新评估换行策略。
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.guestFailed.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.guestFailed.description" })}
        </p>
        <p className="mt-2 font-mono text-ui-sm text-foreground-subtlest">
          {formatMessage(
            { id: "browser.guestFailed.detail" },
            { exitCode: guestFailure.exitCode, reason: guestFailure.reason },
          )}
        </p>
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.guestFailed.retry" })}
        </Button>
      </div>
    </div>
  );
}

// [契约] 所有图标按钮收口到这里，签名固定为 dataTestId / disabled / icon / onClick / title，加可选 active 与 pressed。
// active 决定样式，pressed 决定无障碍语义，两者不可合并：只传 active 的切换按钮会被读屏当成普通按钮。
// disabled 设计为必填而非可选，强制每个调用点回答何时不可用；默认 false 会让遗漏变成静默放行。
// icon 以 ReactNode 传入而非组件类型，尺寸类由调用方给；在此统一尺寸会覆盖刷新按钮的 animate-spin。
// 不给按钮加原生 title，只走 ControlHintTooltip 加 aria-label：两者并存会出现原生黄框与自定义提示叠影。
function BrowserIconButton({
  dataTestId,
  disabled,
  icon,
  onClick,
  title,
  active = false,
  pressed,
}: {
  dataTestId: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  pressed?: boolean;
}) {
  // [契约] variant 由 active 在 secondary 与 ghost 之间切换，不使用 primary：工具栏同时最多一个激活态，高对比会与主操作抢视觉。
  // aria-pressed 在未传时保持 undefined，按钮不会被读屏当作切换键；补默认 false 会改变无障碍语义。
  // disabled 直接透传，不在此追加未就绪判断，否则规则分叉后会出现看着可点但没反应的按钮。
  // aria-label 与 tooltip 用同一份 title，分开取值会在国际化后出现提示与读屏不一致。
  // size 取 icon-md 与工具栏 h-12 匹配，改成更小尺寸会让点击热区低于设计规范的最小值。
  return (
    <ControlHintTooltip title={title}>
      <Button
        type="button"
        size="icon-md"
        variant={active ? "secondary" : "ghost"}
        aria-label={title}
        aria-pressed={pressed}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </Button>
    </ControlHintTooltip>
  );
}
