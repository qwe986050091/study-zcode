/* eslint-disable max-lines -- ProviderSettingsCard 集中维护 Bot 凭据、二维码和绑定状态机展示；后续拆分 provider 子组件后移除。 */
// ProviderSettingsCard —— BotsDialog 中单个 Bot provider 的凭据与绑定状态卡片。
// 做：根据 bot.provider 与运行态派生三块 UI：右上角 control 按钮组、卡片 detail 面板，
//     以及送达失败的额外告警块；同时承载 Telegram 二维码与绑定倒计时展示。
// 不做：不发请求、不写配置、不管理注册状态机；所有动作通过 on* 回调上抛给父组件。
// 依赖：@zcode/shared 的 isFeishuBotProvider、IntlProvider 文案、SettingsPageParts 骨架、
//       PrivateDeliveryRetry 控件；logger 仅用于二维码生成失败。
// 边界：纯展示层，禁止新增 useState 保存业务事实（唯一例外是二维码 dataUrl）。
// 入口：provider=webhook 时直接返回 null，该分支必须早于任何状态派生。
//
// INV-01 断言：provider=webhook 的 bot 必须直接返回 null —— 守住它的位置：函数体内第一个 if —— 改错故障：webhook 会渲染一张没有凭据意义的空卡片。
// INV-02 断言：isConnected 对 weixin 只看 hasSecret、其余看 providerUserId —— 守住它的位置：三元表达式 —— 改错故障：统一判 providerUserId 会让微信永远显示未连接。
// INV-03 断言：hasSecret 只来自 credentialRef 的真假 —— 守住它的位置：Boolean(bot.credentialRef) —— 改错故障：改用本地输入值会让「已保存」随打字变化。
// INV-04 断言：Feishu 运行态错误优先于 bindCode 与注册二维码 —— 守住它的位置：detail 的 if 链顺序 —— 改错故障：错误被绑定面板覆盖，用户看不到断连原因。
// INV-05 断言：descriptionText 只在 Feishu 且运行态错误时切到故障文案 —— 守住它的位置：isFeishuLike && hasRuntimeError —— 改错故障：扩散到 telegram 会显示不存在的连接故障。
// INV-06 断言：control 的四个分支互斥且顺序固定 —— 守住它的位置：isConnected → telegram 无密钥 → 飞书/微信无密钥 → 其余 —— 改错故障：顺序变化会让已连接 bot 显示「扫码」。
// INV-07 断言：detail 的五个分支与 control 分支不是同一组条件 —— 守住它的位置：两段独立的 if/else 链 —— 改错故障：合并成一个 switch 会出现「有 control 无 detail」的空洞。
// INV-08 断言：活动注册必须按 botId 匹配 —— 守住它的位置：feishuRegistration?.botId === bot.id —— 改错故障：只判非空会把别的 bot 的二维码展示到这张卡片。
// INV-09 断言：showBindCode 同样按 botId 匹配 —— 守住它的位置：bindCode?.botId === bot.id —— 改错故障：多 bot 并存时绑定命令会串台。
// INV-10 断言：错误码从 runtime.message 用 \b\d{7,}\b 提取 —— 守住它的位置：errorCode 的 match —— 改错故障：放宽正则会从长数字串里截出错乱码值。
// INV-11 断言：errorCode 缺失时不渲染 dt/dd 对 —— 守住它的位置：errorCode ? 片段 : null —— 改错故障：空 dd 会在布局里留下对齐空洞。
// INV-12 断言：bindCommand 由 bindCode.code 直接拼出、不做转义 —— 守住它的位置：const bindCommand —— 改错故障：加前缀装饰会让用户复制出不可执行的命令。
// INV-13 断言：倒计时用 scaleX(progress/100) 而不是宽度 —— 守住它的位置：style.transform —— 改错故障：改 width 会触发每帧布局抖动。
// INV-14 断言：进度条 key 必须是 bindCode.code —— 守住它的位置：进度 div 上的 key —— 改错故障：去掉 key 后刷新绑定码不会重置动画。
// INV-15 断言：剩余 ≤10s 用 warning、进度 ≤10 用 destructive、过期用 border —— 守住它的位置：三层三元 —— 改错故障：顺序颠倒会让最后一秒的颜色与文案不一致。
// INV-16 断言：deliveryError 块只在 bot.enabled 且送达失败时出现 —— 守住它的位置：SettingsRow 的 detail 三元 —— 改错故障：未启用的 bot 也会显示送达告警。
// INV-17 断言：PrivateDeliveryRetry 的 key 用 deliveryRetryId —— 守住它的位置：重试控件 —— 改错故障：换 id 不重建会让重试次数串到下一轮。
// INV-18 断言：二维码 dataUrl 是唯一允许的本地状态 —— 守住它的位置：TelegramBotFatherQrPanel 的 useState —— 改错故障：把凭据也存进状态会与父级受控值分叉。
// INV-19 断言：二维码副作用必须有 cancelled 守卫 —— 守住它的位置：useEffect 的 cleanup —— 改错故障：卸载后 setState 会告警并写入已移除组件。
// INV-20 断言：注册按钮禁用只由 loading 决定 —— 守住它的位置：disabled={loading} —— 改错故障：叠加其他条件会让用户无法在失败后重试。
//
// 阅读顺序：先看 isConnected 与 control/detail 分支，再看 JSX 里 SettingsRow 的 detail 组合，
// 最后看 TelegramBotFatherQrPanel 的二维码副作用。
// 常见误改：把 isConnected 推广到所有 provider、把 deliveryError 块挪进 control、删掉 webhook
// 的提前 return、给 bindCode 倒计时加本地 state。四处都会破坏单一事实源。
// 条件互斥：control 的四个分支与 detail 的五个分支是两组独立 if/else，不要合并。
// 优先级：Feishu 运行态错误覆盖 bindCode 与注册二维码，错误必须优先展示。
// 时序：bindCode 刷新时 key 变化会重建进度条，保证动画从头播放。
// 平台：provider 来自 shared 的联合类型，新增取值要同步四个分支与文案 key。
// 安全：凭据输入框 type=password，明文只存在于受控 value，本组件不缓存不打印。
// 维护提示：新增 detail 分支时必须与 control 保持互斥，否则会出现两个动作同时可用。
import {
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  QrCode,
  Unlink,
} from "lucide-react";
import QRCode from "qrcode";
// [契约] 只引入 useEffect/useState，不引入 useMemo：派生状态必须每次渲染现算。
// ReactNode 用于 control 与 detail 两个插槽，它们的类型是 ReactNode 而不是 Element。
// 新增 hook 前先确认它不是业务状态：业务事实应来自 props 或服务。
// 不要用 useRef 存倒计时：进度由父级以 bindCountdownProgress 传入。
// [权衡] 保持最小依赖，让该卡片能在任何 React 边界内被安全复用。
import { useEffect, useState, type ReactNode } from "react";
import type { BotConfig, BotServiceStatus } from "@zcode/shared";
import { isFeishuBotProvider } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { cn } from "@/components/lib/utils.js";
// [契约] logger 只用于二维码生成失败上报，不用于渲染或用户操作日志。
// 不要用 console.log：UI 日志统一走 logger，才能同时落本地文件。
// logger 记录时不得包含 credential 或二维码内容，只允许错误信息；上报问题时由本地日志文件附带上下文。
// 失败日志会进本地日志文件，便于用户上报问题时附带。
import { logger } from "@/logger.js";
import type { BindCodeState, FeishuRegistrationState, WeixinRegistrationState } from "./shared.js";
import { PrivateDeliveryRetry } from "@/BotsDialog/PrivateDeliveryRetry.js";
import { TELEGRAM_BOTFATHER_URL, formatBindCountdown } from "./shared.js";

// [契约] DetailPanel 是 detail 区域的统一内边距容器，调用点不要重复写内边距类。
// 它不接收 className：一旦允许覆盖，各分支的视觉就会持续漂移。
// children 必填，调用方负责给出内容，组件不做空态兜底。
// [权衡] 抽成小组件而不是内联 div，是为了让五个 detail 分支共享同一内边距。
function DetailPanel({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-background p-3">{children}</div>;
}

// [契约] 该面板只在 telegram 且尚无密钥时渲染，其他 provider 不得复用。
// 凭据输入是受控的：value/onChange 都来自父级，组件不保存输入副本。
// secretSaving 同时控制输入与按钮，保证保存期间不能改值。
// 保存按钮在输入为空时禁用，判空使用 trim 后的值。
// 面板本身不发请求，onSaveSecret 只是意图上抛。
function TelegramBotFatherQrPanel({
  credentialValue,
  secretSaving,
  onCredentialValueChange,
  onSaveSecret,
}: {
  credentialValue: string;
  secretSaving: boolean;
  onCredentialValueChange: (value: string) => void;
  onSaveSecret: () => void;
}) {
  // [契约] 文案一律通过 intl.formatMessage 获取，禁止在 JSX 里硬编码中英文。
  // id 使用 bots.* 命名空间，新增 key 需同步三套语言资源。
  // 不要缓存 intl 实例：locale 切换需要触发重渲染。
  // 带参数的文案用第二个实参传值，不要自行拼接字符串。
  const { intl } = useZCodeIntl();
  // [契约] 这是本文件唯一允许的本地状态，语义是「已生成的图片数据」，不是业务事实。
  // 初值必须是 null：空字符串会被 img 的 src 解析成当前页面地址。
  // 不要保存失败信息：失败只记日志并保持 null。
  // 二维码内容固定为 TELEGRAM_BOTFATHER_URL 常量，不接受外部注入。
  // 状态无需持久化，每次挂载重新生成即可。
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // [契约] 依赖数组必须为空：URL 是模块常量，重新生成只是浪费。
  // 不要在 effect 内读 props，否则依赖会变成隐性输入。
  // 生成是异步的，必须用 void 标记以通过 no-floating-promises。
  // effect 内不得 await 后直接 setState，必须先判 cancelled。
  // [权衡] QRCode.toDataURL 在挂载时调用而不是点击时调用，因此面板一出现就有图可扫，不必多一次交互。
  useEffect(() => {
    // [契约] cancelled 是卸载守卫，cleanup 里必须置为 true。
    // 没有它时 StrictMode 双挂载会写入已被丢弃的实例。
    // 守卫只覆盖 setState，不取消底层 Promise：qrcode 不支持中断。
    // 不要在 finally 里重置 cancelled：卸载后不会再执行。
    // 命名保持 cancelled 以与 React 生态惯例一致，便于检索。
    let cancelled = false;
    // [契约] margin/width 是视觉参数，改 width 会同时影响图片尺寸与清晰度。
    // toDataURL 返回 data: URL，可直接给 img，省去对象 URL 的释放责任。
    // 不要在参数里覆盖颜色：二维码对比度必须保持可扫。
    // [失败路径] 生成失败只记日志并保持 null，不展示破图占位。
    // 错误用 error instanceof Error 归一，避免打印出 [object Object]。
    void QRCode.toDataURL(TELEGRAM_BOTFATHER_URL, {
      margin: 1,
      width: 220,
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        logger.error(
          "[BotsDialog] 生成 Telegram BotFather 二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      });
    // [契约] cleanup 只做置位，不 setState：卸载阶段更新状态没有意义。
    // 不要在 cleanup 里 revoke URL：这里用的是 data URL。
    // 该返回必须与 effect 同层，放进条件分支会让守卫失效。
    // StrictMode 下 cleanup 会先执行一次，cancelled 必须在 effect 内重新声明。
    // 若将来改用对象 URL，回收责任要在这里补上。
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DetailPanel>
      <div className="flex flex-wrap items-start justify-center gap-4">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={intl.formatMessage({ id: "bots.telegramBotFatherQrAlt" })}
            className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
          />
        ) : null}
        <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
          <div>{intl.formatMessage({ id: "bots.telegramBotFatherScanHint" })}</div>
          <div className="rounded-md bg-surface px-2 py-1 font-mono text-foreground">
            @BotFather
          </div>
          <div className="flex w-full min-w-0 items-center gap-2">
            <Input
              size="lg"
              type="password"
              value={credentialValue}
              onChange={(event) => onCredentialValueChange(event.target.value)}
              placeholder={intl.formatMessage({
                id: "bots.credentialPlaceholder",
              })}
              className="min-w-0 flex-1"
              disabled={secretSaving}
            />
            <Button
              variant="outline"
              size="lg"
              onClick={onSaveSecret}
              disabled={secretSaving || !credentialValue.trim()}
            >
              {secretSaving ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              {intl.formatMessage({ id: "bots.saveSecret" })}
            </Button>
          </div>
        </div>
      </div>
    </DetailPanel>
  );
}

// [契约] props 全部由父级注入，本组件不持有 bot 的本地副本。
// ProviderSettingsCard 的 on* 回调只做意图上抛，是否允许由父级判定；禁用态由 Button 的 disabled 落实。
// 新增 prop 时同步更新内联类型，不要另建 interface 造成两处漂移。
// 不要在这个签名里给回调默认值：缺省会让「未接线」变成静默成功。
// [权衡] 参数多达 20 个是历史包袱，拆分前需确认父级状态也能一起收敛。
export function ProviderSettingsCard({
  bot,
  runtime,
  credentialValue,
  bindCode,
  bindExpired,
  bindRemainingMs,
  bindCountdownProgress,
  feishuRegistration,
  feishuRegistrationLoading,
  weixinRegistration,
  weixinRegistrationLoading,
  weixinActivated,
  secretSaving,
  onCredentialValueChange,
  onSaveSecret,
  onRemoveSecret,
  onOpenTelegramBotFather,
  onStartWeixinRegistration,
  onStartFeishuRegistration,
  onCreateBindCode,
  onUnbind,
  onCopyBindCommand,
}: {
  // [契约] bot 是唯一数据源，provider/credentialRef/providerUserId/enabled 都从这里读。
  // 不要解构后立即缓存派生值：派生必须每次渲染现算。
  // 跨 bot 匹配一律用 bot.id，不要用 name 或 provider 代替。
  // [契约] 可选字段（如 providerUserId）缺失表示该 provider 不用此概念，不要兜底成空串。
  bot: BotConfig;
  runtime: BotServiceStatus["botRuntime"][number] | undefined;
  credentialValue: string;
  bindCode: BindCodeState | null;
  bindExpired: boolean;
  bindRemainingMs: number;
  bindCountdownProgress: number;
  feishuRegistration: FeishuRegistrationState | null;
  feishuRegistrationLoading: boolean;
  weixinRegistration: WeixinRegistrationState | null;
  weixinRegistrationLoading: boolean;
  weixinActivated: boolean;
  secretSaving: boolean;
  onCredentialValueChange: (value: string) => void;
  onSaveSecret: () => void;
  onRemoveSecret: () => void;
  onOpenTelegramBotFather: () => void;
  onStartWeixinRegistration: () => void;
  onStartFeishuRegistration: () => void;
  onCreateBindCode: () => void;
  onUnbind: () => void;
  onCopyBindCommand: () => void;
}) {
  // [契约] 卡片主体同样走 intl，不要复用二维码面板里的实例。
  // locale 变化会触发重渲染，派生文案随之更新。
  // 错误文案 key 依赖 isConnected，连接态切换时 key 必须一起切换。
  // 不要在模板里拼接文案：带参数时用 formatMessage 的 values。
  // 文案缺失时回退为 id 本身，联调时据此定位漏配的 key。
  const { intl } = useZCodeIntl();
  // [契约] webhook 只读 provider 字符串，不读 runtime 或凭据。
  // 该 return 必须在所有派生计算之前，避免为不会渲染的卡片做无用工作。
  // 不要在 webhook 分支打日志：这是正常的配置形态。
  // 返回 null 而不是空 div：空节点会占住 SettingsRow 的布局位置。
  // 新增 provider 时不要顺手把 webhook 也纳入通用分支。
  if (bot.provider === "webhook") {
    return null;
  }
  // [契约] 只看 credentialRef 是否存在，不看输入框内容。
  // credentialRef 是服务端事实，输入框只是未提交草稿。
  // 不要改读 bot.credential 之类的旧字段，那是已废弃模型。
  // 该值决定「已连接」与「需要扫码」的分叉，改语义会影响四个分支。
  // [失败路径] credentialRef 为空字符串时同样视为无密钥，这是刻意的。
  const hasSecret = Boolean(bot.credentialRef);
  const isFeishuLike = isFeishuBotProvider(bot.provider);
  const isWeixin = bot.provider === "weixin";
  // [契约] 微信没有 providerUserId 概念，连接态只由凭据决定。
  // 其余 provider 以 providerUserId 为准：有凭据但未绑定仍算未连接。
  // 不要改成 && 或 || 的复合判断，两种语义不能合并。
  // isConnected 同时影响 control、detail 与故障文案三处。
  const isConnected = isWeixin ? hasSecret : Boolean(bot.providerUserId);
  const hasRuntimeError = runtime?.status === "error";
  // [契约] 故障描述只对 Feishu 系且运行态 error 生效。
  // isConnected 影响措辞（连接中断 vs 无法连接），不是两种错误。
  // 其余 provider 一律使用 botTokenDescription.<provider> 的静态文案。
  // 不要在这里追加动态错误详情：详情在 detail 面板里展示。
  // 模板形式的 key 依赖 provider 是有限联合，新增取值要补文案。
  const descriptionText =
    isFeishuLike && hasRuntimeError
      ? intl.formatMessage({
          id: isConnected
            ? "bots.runtime.boundConnectionInterruptedDescription"
            : "bots.runtime.credentialsSavedConnectionFailedDescription",
        })
      : intl.formatMessage({
          id: `bots.botTokenDescription.${bot.provider}`,
        });
  const hasActiveFeishuRegistration = feishuRegistration?.botId === bot.id;
  const hasActiveWeixinRegistration = weixinRegistration?.botId === bot.id;
  const showBindCode = bindCode?.botId === bot.id;

  // [契约] control 与 detail 都先声明为 null，再由互斥分支赋值。
  // 用 let 加赋值而不是三元套三元，分支需要在 JSX 之外也能读清。
  // 两者必须各自覆盖全部情况，否则会出现只有 control 没有 detail 的空洞。
  // 不要在分支里直接 return：后面还有 deliveryError 的组合逻辑。
  // 声明顺序固定为 control → detail，与 JSX 使用顺序一致。
  let control: ReactNode = null;
  let detail: ReactNode = null;

  // [契约] 已连接优先于一切：即使存在注册二维码也不应展示扫码入口。
  // 该分支内只有微信且未激活时补 detail，其他 provider 的 detail 由后续分支决定。
  // control 是「状态点 + 解绑按钮」，微信走解除凭据，其余走解绑。
  // [契约] 解绑按钮的 onClick 按 isWeixin 分叉，不要统一成 onUnbind。
  // 这里的 hasRuntimeError 只改颜色与文案，不改变可用性。
  if (isConnected) {
    control = (
      <div className="flex items-center justify-end gap-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-ui-base text-foreground-subtle">
          <span
            className={cn("size-2 rounded-full", hasRuntimeError ? "bg-destructive" : "bg-success")}
          />
          {intl.formatMessage({
            id: hasRuntimeError ? "bots.runtime.boundConnectionInterrupted" : "bots.connected",
          })}
        </span>
        <Button variant="outline" size="lg" onClick={isWeixin ? onRemoveSecret : onUnbind}>
          <Unlink className="size-4" />
          {intl.formatMessage({ id: "bots.unbind" })}
        </Button>
      </div>
    );
    if (isWeixin && !weixinActivated) {
      // [契约] 该 detail 只在已连接且微信未激活时赋值，属于「已连接后的补充提示」。
      // 赋值必须在 if (isWeixin && !weixinActivated) 内，外层无条件赋值会覆盖后续分支。
      // detail 初值 null，未被任何分支赋值时 SettingsRow 不渲染详情区域。
      // 不要在这里提前 return JSX，流程仍要落到最后的 SettingsGroupCard。
      // [权衡] 用赋值而非嵌套三元，是为了让五个 detail 分支彼此平级。
      detail = (
        <DetailPanel>
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "bots.weixinActivationHint" })}
          </div>
        </DetailPanel>
      );
    }
  } else if (bot.provider === "telegram" && !hasSecret) {
    control = (
      <Button variant="outline" size="lg" onClick={onOpenTelegramBotFather}>
        <ExternalLink className="size-4" />
        {intl.formatMessage({ id: "bots.openBotFather" })}
      </Button>
    );
    detail = (
      <TelegramBotFatherQrPanel
        credentialValue={credentialValue}
        secretSaving={secretSaving}
        onCredentialValueChange={onCredentialValueChange}
        onSaveSecret={onSaveSecret}
      />
    );
  } else if ((isFeishuLike && !hasSecret) || (isWeixin && !hasSecret)) {
    // [契约] 注册中状态按 provider 分叉，两个 loading 不能合并成一个。
    // 微信与飞书的注册状态机相互独立，合并会让另一侧加载态闪动。
    // loading 只能控制按钮禁用与图标，不能控制二维码展示，两者状态由不同分支维护。
    // 不要给按钮叠加「是否已有二维码」这类禁用条件；二维码未就绪时用户仍需重试入口，否则只能刷新页面。
    const loading = isWeixin ? weixinRegistrationLoading : feishuRegistrationLoading;
    control = (
      <Button
        variant="outline"
        size="lg"
        onClick={isWeixin ? onStartWeixinRegistration : onStartFeishuRegistration}
        disabled={loading}
      >
        {loading ? <LoaderCircle className="size-4 animate-spin" /> : <QrCode className="size-4" />}
        {intl.formatMessage({ id: "bots.scanQrCode" })}
      </Button>
    );
  } else {
    control = (
      <div className="flex w-full flex-wrap justify-end gap-2">
        {!showBindCode && !hasRuntimeError ? (
          <Button variant="outline" size="lg" onClick={onCreateBindCode}>
            {intl.formatMessage({ id: "bots.bind" })}
          </Button>
        ) : null}
        <Button variant="outline" size="lg" onClick={onRemoveSecret}>
          {intl.formatMessage({ id: "bots.removeSecret" })}
        </Button>
      </div>
    );
  }

  if (isFeishuLike && hasRuntimeError) {
    // [契约] 只从 message 提取 7 位以上连续数字，这是错误码的形态约定。
    // 使用 \b 边界，避免从更长的数字串中截断出假码。
    // 提取失败时保持 undefined，detail 中对应整块 dt/dd 不渲染。
    // 不要把 message 原文当错误码展示：可能含用户数据与内部地址。
    // [权衡] 用正则而不是结构化字段，是因为 runtime 只透传了字符串消息。
    const errorCode = runtime.message?.match(/\b\d{7,}\b/)?.[0];
    detail = (
      <DetailPanel>
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({
                id: isConnected
                  ? bot.provider === "lark"
                    ? "bots.runtime.larkConnectionInterrupted"
                    : "bots.runtime.feishuConnectionInterrupted"
                  : bot.provider === "lark"
                    ? "bots.runtime.cannotConnectLark"
                    : "bots.runtime.cannotConnectFeishu",
              })}
            </div>
            <div className="mt-1 text-ui-base leading-5 text-foreground-subtle">
              {intl.formatMessage({
                id: isConnected
                  ? bot.provider === "lark"
                    ? "bots.runtime.larkConnectionRecoverySuggestion"
                    : "bots.runtime.feishuConnectionRecoverySuggestion"
                  : "bots.runtime.connectionBlocksBinding",
              })}
            </div>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-base leading-5">
              {errorCode ? (
                <>
                  <dt className="text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.runtime.errorCode" })}
                  </dt>
                  <dd className="min-w-0 break-all font-mono text-foreground">{errorCode}</dd>
                </>
              ) : null}
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "bots.runtime.errorDetail" })}
              </dt>
              <dd className="min-w-0 break-words text-foreground">
                {runtime.message ?? intl.formatMessage({ id: "bots.runtime.unknownError" })}
              </dd>
            </dl>
          </div>
        </div>
      </DetailPanel>
    );
  } else if (showBindCode) {
    // [契约] 命令形态固定为 /bind + 空格 + code，不要加前缀或引号。
    // code 原样拼接、不做转义：转义后的命令在聊天窗口里不可执行。
    // 复制按钮与展示共用同一个变量，避免两处拼出不同结果。
    // [契约] 该变量只在 showBindCode 分支内计算，不要提升到函数顶部。
    const bindCommand = `/bind ${bindCode.code}`;
    detail = (
      <DetailPanel>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "bots.bindCommand" })}
            </div>
            <div className="mt-1 text-ui-base leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "bots.bindCommandGuide" })}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onCreateBindCode}>
            <QrCode className="size-3" />
            {intl.formatMessage({ id: "bots.setup.refreshBindCode" })}
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-surface px-2 py-1.5">
          <span
            className={cn(
              "min-w-0 break-all font-mono text-ui-base leading-5",
              bindExpired ? "text-foreground-subtle" : "text-foreground",
            )}
          >
            {bindCommand}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopyBindCommand}
            disabled={bindExpired}
            title={intl.formatMessage({ id: "bots.copyBindCommand" })}
          >
            <Copy className="size-4" />
            {intl.formatMessage({ id: "bots.copyBindCommand" })}
          </Button>
        </div>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-ui-base leading-5 text-foreground-subtle">
          <li>{intl.formatMessage({ id: "bots.bindCommandStep.copy" })}</li>
          <li>{intl.formatMessage({ id: "bots.bindCommandStep.openChat" })}</li>
          <li>{intl.formatMessage({ id: "bots.bindCommandStep.send" })}</li>
        </ol>
        <div className="mt-2 flex items-center gap-2 text-ui-base text-foreground-subtle">
          <Clock3 className="size-3" />
          {bindExpired
            ? intl.formatMessage({ id: "bots.bindCodeExpired" })
            : intl.formatMessage(
                { id: "bots.bindCodeExpires" },
                { time: formatBindCountdown(bindRemainingMs) },
              )}
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface">
          <div
            key={bindCode.code}
            className={cn(
              "h-full origin-left rounded-full transition-transform duration-300 ease-linear",
              bindExpired
                ? "bg-border"
                : bindCountdownProgress <= 10
                  ? "bg-destructive"
                  : bindRemainingMs <= 10_000
                    ? "bg-warning"
                    : "bg-primary",
            )}
            style={{ transform: `scaleX(${bindCountdownProgress / 100})` }}
          />
        </div>
      </DetailPanel>
    );
  } else if (hasActiveFeishuRegistration) {
    detail = (
      <DetailPanel>
        <div className="flex flex-wrap items-start justify-center gap-4">
          {feishuRegistration.qrDataUrl ? (
            <img
              src={feishuRegistration.qrDataUrl}
              alt={intl.formatMessage({ id: "bots.feishuRegistrationQrAlt" })}
              className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
            />
          ) : null}
          <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
            <div>
              {intl.formatMessage({
                id: `bots.feishuRegistrationScanHint.${feishuRegistration.domain}`,
              })}
            </div>
            <div className="rounded-md bg-surface px-2 py-1 font-mono text-foreground">
              {feishuRegistration.userCode}
            </div>
            <div>
              {feishuRegistration.status === "pending" ? (
                <span className="inline-flex items-center gap-1">
                  <LoaderCircle className="size-3 animate-spin" />
                  {intl.formatMessage({ id: "common.loading" })}
                </span>
              ) : (
                (feishuRegistration.message ??
                intl.formatMessage({
                  id: `bots.feishuRegistration.${feishuRegistration.status}`,
                }))
              )}
            </div>
          </div>
        </div>
      </DetailPanel>
    );
  } else if (hasActiveWeixinRegistration) {
    detail = (
      <DetailPanel>
        <div className="flex flex-wrap items-start justify-center gap-4">
          {weixinRegistration.qrDataUrl ? (
            <img
              src={weixinRegistration.qrDataUrl}
              alt={intl.formatMessage({ id: "bots.weixinRegistrationQrAlt" })}
              className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
            />
          ) : null}
          <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
            <div>{intl.formatMessage({ id: "bots.weixinRegistrationScanHint" })}</div>
            <div>
              {weixinRegistration.status === "pending" ||
              weixinRegistration.status === "scanned" ? (
                <span className="inline-flex items-center gap-1">
                  <LoaderCircle className="size-3 animate-spin" />
                  {intl.formatMessage({
                    id: `bots.weixinRegistration.${weixinRegistration.status}`,
                  })}
                </span>
              ) : (
                (weixinRegistration.message ??
                intl.formatMessage({
                  id: `bots.weixinRegistration.${weixinRegistration.status}`,
                }))
              )}
            </div>
          </div>
        </div>
      </DetailPanel>
    );
  }

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "bots.botToken" })}
        description={descriptionText}
        control={control}
        detail={
          bot.enabled && runtime?.deliveryError ? (
            <>
              <DetailPanel>
                <div role="alert" className="min-w-0 space-y-2 text-ui-base">
                  <div className="font-medium text-destructive">
                    {intl.formatMessage({ id: "bots.runtime.deliveryFailed" })}
                  </div>
                  <div className="text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.runtime.deliveryFailedDescription" })}
                  </div>
                  <div className="whitespace-pre-wrap break-all text-foreground-subtle">
                    {runtime.deliveryError}
                  </div>
                  {runtime.deliveryRetryId ? (
                    <PrivateDeliveryRetry
                      key={runtime.deliveryRetryId}
                      botId={bot.id}
                      deliveryId={runtime.deliveryRetryId}
                    />
                  ) : null}
                </div>
              </DetailPanel>
              {detail}
            </>
          ) : (
            detail
          )
        }
      />
    </SettingsGroupCard>
  );
}
