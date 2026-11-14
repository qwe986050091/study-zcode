/* eslint-disable max-lines -- BotsDialog 现在保留数据加载、保存和轮询编排；右侧卡片已拆到 BotsDialog/* 子组件，后续再继续下沉状态 hook。 */
// ============================================================================
// BotsDialog.tsx — Bot 渠道设置弹窗的编排层
//
// 本文件只保留「数据加载 + 保存 + 轮询编排」，右侧卡片已下沉到 BotsDialog/* 子组件。
// 四类异步流程同时存在，阅读时必须先分清它们：
//   1) 状态轮询：每 2s 拉 getStatus，串行（setTimeout 链），只在弹窗打开时跑；
//   2) 绑定码轮询：绑定码展开期间每 2s 拉 getConfig，命中 providerUserId 即收起；
//   3) 飞书扫码注册：按服务端 interval 轮询，pending 时不制造新对象；
//   4) 微信扫码登录：服务端长等待，必须串行调度，不能 setInterval 堆叠。
//
// 五个 ref 是「幂等闸」，理解它们比理解 state 更重要：
//   botNameCompositionActiveRef：中文输入法组合态，Enter 不提交；
//   autoQrStartedBotIdsRef：同一 Bot 只自动拉起一次二维码流程；
//   autoBindCreatingBotIdsRef：同一 Bot 只自动创建一枚绑定码；
//   handledEntryProviderRef：快捷入口只处理一次；
//   其余 state 只做展示。
//
// INV 不变量表（每条注明守住它的位置）
// INV-01 轮询取消：所有轮询必须在 cleanup 里置 cancelled 并清定时器；
//         回调 await 之后的第一件事是检查 cancelled。
//         守住：四个轮询 effect 的 cleanup 与 cancelled 判断。
// INV-02 状态轮询必须串行：下一次 setTimeout 只在本次请求结束（finally）后注册。
//         守住：pollStatus 的 finally 分支。
// INV-03 微信轮询同理串行：runPoll 完成后才 scheduleNextPoll。
//         守住：scheduleNextPoll 只在 runPoll 尾部调用。
// INV-04 飞书 pending 结果必须做「值相等返回原对象」，否则会重启轮询形成 RPC 风暴。
//         守住：setFeishuRegistration 内的三字段比较。
// INV-05 微信 pending/scanned 同理只更新 interval 与 status，其余字段原样保留。
//         守住：setWeixinRegistration 的两字段比较。
// INV-06 自动拉起二维码/绑定码必须按 Bot 幂等，且成功后仍要保留集合（失败才删）。
//         守住：autoQrStartedBotIdsRef 与 finally 里只删 bind 集合。
// INV-07 自动绑定码只在「有凭据、未绑定、没有未过期绑定码」时创建。
//         守住：三个 provider 分支各自的三个前置 return。
// INV-08 绑定码只属于创建它的 Bot；切换 Bot 时旧码不得被新 Bot 复用。
//         守住：bindCode.botId 的三处比较 + 切换 Bot 的 effect。
// INV-09 绑定成功后立即收起绑定码，且不依赖轮询是否被打断。
//         守住：selectedBot.providerUserId 的 effect。
// INV-10 切换 Bot 时必须清空凭据草稿、保存中标记与两种扫码注册态。
//         守住：监听 selectedBotId 与 provider 的 effect。
// INV-11 saveBot 成功后才更新列表与选中项；失败必须向上抛给调用方提示。
//         守住：saveBot 内的顺序（先 await，后 setState）。
// INV-12 工作区访问采用乐观更新 + 失败回滚，回滚用的是 previousBot 快照。
//         守住：patchAllowedWorkspaces 的 try/catch。
// INV-13 空的工作区列表等价于「全部工作区」，保存前必须归一化。
//         守住：normalizedAllowedWorkspaces。
// INV-14 名称草稿在提交时才写盘，输入过程中不回写配置。
//         守住：commitBotNameDraft 与 setBotNameDraft 的分工。
// INV-15 IME 组合态的 Enter 只确认候选词，不提交、不失焦。
//         守住：handleBotNameKeyDown 的 isImeComposingKeyEvent。
// INV-16 重命名中的 Escape 只取消编辑，不关闭 Dialog。
//         守住：handleDialogEscapeKeyDown。
// INV-17 删除是破坏性操作，必须先经过统一 ConfirmDialog。
//         守住：handleDelete 的 confirmed 前置判断。
// INV-18 移除 secret 后要清空三个幂等集合，否则重新配置时自动流程不会启动。
//         守住：handleRemoveSecret 里的三处 delete。
// ============================================================================
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import QRCode from "qrcode";
import { Bot, Loader2, Plus } from "lucide-react";
import type {
  BotConfig,
  BotProvider,
  BotServiceStatus,
  BotState,
  BotWorkspaceRef,
  BotsConfigFile,
} from "@zcode/shared";
import {
  ALL_BOT_WORKSPACES,
  createUuid,
  DEFAULT_BOT_REPLY_GRANULARITY,
  isFeishuBotProvider,
  normalizeBotReplyGranularity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";
import {
  BOT_PROVIDERS,
  getBotProviderRegionTagLabelId,
  resolveBotProviderEntry,
  type BotProviderEntryId,
} from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";
import {
  BotDangerCard,
  BotReplyGranularityCard,
  BotSummaryCard,
} from "@/BotsDialog/BotSummaryCard.js";
import { ProviderSettingsCard } from "@/BotsDialog/ProviderSettingsCard.js";
import { BoundGroupsCard } from "@/BotsDialog/BoundGroupsCard.js";
import { WorkspaceAccessCard } from "@/BotsDialog/WorkspaceAccessCard.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  BIND_CODE_TTL_MS,
  ProviderIcon,
  TELEGRAM_BOTFATHER_URL,
  createDefaultCommands,
  formatBotDisplayName,
  isAllWorkspacesAllowed,
  runtimeDot,
  type BindCodeState,
  type FeishuRegistrationState,
  type WeixinRegistrationState,
} from "@/BotsDialog/shared.js";

// version 固定为 3：配置结构每次破坏性变更都要升版本，
// 服务层按 version 决定是否迁移。写死旧版本会让新字段在下次保存时被丢弃。
function createEmptyConfig(): BotsConfigFile {
  return { version: 3, bots: [] };
}

// 草稿 Bot 必须满足配置的最小合法形态，否则服务层校验会拒绝首次保存：
// id 唯一、enabled 默认真、allowedWorkspaces 显式收敛为「全部」、
// allowedCommands 用默认命令集、replyMode 按 provider 归一化。
// name 故意留空：空名称是合法的「未命名」状态，展示层用 fallback 名称兜底，
// 这样不会把「新 Bot」这类占位文案写进配置文件。
function createDraftBot(params: { provider: BotProvider }): BotConfig {
  // Bugfix: Bot id 只是配置实体身份，不应该带 provider 前缀；
  // 新建时如果看到 telegram-* 这类 id，容易误以为渠道被固定到了 Telegram。
  // id 前缀固定为 bot-，不带 provider：
  // id 是配置实体身份，不是渠道标识；带渠道前缀会让用户误以为渠道被锁定。
  // createUuid 而不是 Date.now：同一毫秒内连续新建两个 Bot 会撞 id。
  const id = `bot-${createUuid()}`;
  return {
    id,
    name: "",
    provider: params.provider,
    enabled: true,
    allowedWorkspaces: [ALL_BOT_WORKSPACES],
    allowedCommands: createDefaultCommands(),
    currentOptions: {},
    replyMode: normalizeBotReplyGranularity(params.provider, DEFAULT_BOT_REPLY_GRANULARITY),
  };
}

// 入口 props 只有三个：open 受控、onOpenChange 回传、entryProvider 表示快捷入口来源。
// entryProvider 为 null 表示从设置页正常进入；非空表示从远程控制弹窗跳转，
// 需要在配置加载完成后自动选中或新建对应渠道的 Bot。
// 组件内部不缓存「上一次打开时的 Bot」，每次打开都重新 refresh。
export function BotsDialog({
  open,
  onOpenChange,
  entryProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryProvider?: BotProvider | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { botsService } = useServices();
  // 初始值是空配置而不是 null：渲染期可以直接读 config.bots，
  // 避免每个使用点都写可选链。configLoaded 单独标记「是否真的从服务端读到」。
  const [config, setConfig] = useState<BotsConfigFile>(() => createEmptyConfig());
  const [workspaceRefs, setWorkspaceRefs] = useState<BotWorkspaceRef[]>([]);
  // 初始为 null 表示「尚未拿到整机快照」。
  // 侧栏运行态圆点依赖它区分「未启动」与「未加载」两种外观。
  const [status, setStatus] = useState<BotServiceStatus | null>(null);
  const [botStates, setBotStates] = useState<BotState[]>([]);
  // 选中项只存 id，不存对象引用：
  // 保存/刷新会替换 bots 数组，存对象会让选中项停留在旧快照上。
  // null 有两种语义：「正在新建」与「还没有可选项」，由 creatingBot 区分。
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  // 区分「配置为空」与「还没加载」：
  // 快捷入口判断依赖这个标记，否则空配置会被误判为需要新建 Bot。
  const [configLoaded, setConfigLoaded] = useState(false);
  // 既表示「哪个渠道正在创建」，也作为并发闸（非 null 即禁用全部渠道按钮）。
  // 创建成功后由 saveBot 间接结束该状态，失败则在 finally 里释放。
  const [creatingProvider, setCreatingProvider] = useState<BotProvider | null>(null);
  // 绑定码只保存当前展示的那一枚，且带 botId：
  // 切换 Bot 时旧码仍在内存中，靠 botId 比较来避免串用。
  const [bindCode, setBindCode] = useState<BindCodeState | null>(null);
  const [feishuRegistration, setFeishuRegistration] = useState<FeishuRegistrationState | null>(
    null,
  );
  const [feishuRegistrationLoading, setFeishuRegistrationLoading] = useState(false);
  const [weixinRegistration, setWeixinRegistration] = useState<WeixinRegistrationState | null>(
    null,
  );
  const [weixinRegistrationLoading, setWeixinRegistrationLoading] = useState(false);
  // nowMs 是「时钟快照」，不是真实当前时间：
  // 它只由定时器推进，用于让倒计时渲染有依赖。
  // 初值用惰性初始化，避免每次渲染都调用 Date.now。
  const [nowMs, setNowMs] = useState(() => Date.now());
  // 凭据草稿只存在于内存，且切 Bot 时清空。
  // 它不进入 config 对象，避免明文凭据随配置写入磁盘或日志。
  const [credentialValue, setCredentialValue] = useState("");
  // 保存中标记同时承担两个职责：按钮 loading 与防重复提交。
  // 两个用途共用一个 state 是有意的 —— 提交期间按钮本就必须禁用。
  const [secretSaving, setSecretSaving] = useState(false);
  // 工作区保存中标记独立于 secretSaving：
  // 两类保存可以并行，共用一个标记会让其中一类被误禁用。
  const [workspaceAccessSaving, setWorkspaceAccessSaving] = useState(false);
  // 草稿带 botId 而不是裸字符串：
  // 切换 Bot 后仍可能残留上一次的输入，带 id 才能安全地判断「这份草稿属于谁」。
  const [botNameDraft, setBotNameDraft] = useState<{
    botId: string;
    value: string;
  } | null>(null);
  // 重命名态同样按 id 记录，保证同一时刻只有一个 Bot 处于内联编辑。
  // Escape 拦截逻辑依赖它是否为 null。
  const [renamingBotId, setRenamingBotId] = useState<string | null>(null);
  // 输入法组合态必须用 ref 而不是 state：
  // compositionstart/end 与 keydown 在同一事件循环内判断，
  // setState 尚未生效时读到的仍是旧值，会导致中文 Enter 被误判为提交。
  const botNameCompositionActiveRef = useRef(false);
  // 二维码自动拉起的幂等集合，键是 botId:channel。
  // 只在拉起成功前置位、失败后不删除 —— 这是刻意的：
  // 失败会由用户手动点按钮重试，若自动流程失败后立刻允许重试，
  // 会与服务端限流叠加成循环请求。
  // 卸载不清理：组件重新打开时沿用同一份记忆，避免每次开窗都重新拉二维码。
  const autoQrStartedBotIdsRef = useRef(new Set<string>());
  // 绑定码自动创建的并发闸：进行中时禁止重复进入。
  // 与二维码集合不同，这里在 finally 里删除自己，
  // 因为绑定码 30 秒过期后必须允许自动续码。
  const autoBindCreatingBotIdsRef = useRef(new Set<string>());
  const handledEntryProviderRef = useRef<BotProvider | null>(null);

  // 所有派生值都从「当前 config + selectedBotId」即时计算，不另存副本。
  // Bot 被删除后 selectedBot 自然变 null，界面会回落到空态，无需清理逻辑。
  const selectedBot = config.bots.find((bot) => bot.id === selectedBotId) ?? null;
  const selectedBotState = botStates.find((state) => state.botId === selectedBotId) ?? null;
  // 名称有「草稿优先」语义：正在重命名时展示本地草稿，否则展示已保存值。
  // 草稿必须绑定 botId：切换 Bot 时如果草稿还留着，会把 A 的名字显示在 B 上。
  const selectedBotName =
    selectedBot && botNameDraft?.botId === selectedBot.id
      ? botNameDraft.value
      : (selectedBot?.name ?? "");
  // 未命名 Bot 的展示兜底统一从这里取，
  // 列表、摘要卡、删除确认框三处必须用同一个 fallback，
  // 否则确认框里的名称会和列表里看到的对不上。
  const fallbackBotName = intl.formatMessage({
    id: "bots.newBot.fallbackName",
  });
  const selectedBotDisplayName = formatBotDisplayName(selectedBotName, fallbackBotName);
  // 剩余时间夹到 >= 0：本地时钟回拨时 expiresAt - nowMs 可能为正的很大值，
  // 也可能因为服务端时钟超前直接为负。
  // bindExpired 由它派生，不要另外用 Date.now 判断，否则两个口径会不一致。
  const bindRemainingMs = bindCode ? Math.max(0, bindCode.expiresAt - nowMs) : 0;
  const bindExpired = Boolean(bindCode && bindRemainingMs <= 0);
  // 进度按剩余毫秒实时计算并夹到 [0, 100]。
  // ttlMs 用创建时的差值而不是常量：服务端可能调整有效期，
  // 写死 30s 会让进度条与实际过期时间脱节。
  const bindCountdownProgress = bindCode
    ? Math.max(0, Math.min(100, (bindRemainingMs / bindCode.ttlMs) * 100))
    : 0;

  useEffect(() => {
    // 250ms 刷新 nowMs 只服务于进度条动画。
    // 文字倒计时仍由 formatBindCountdown 按秒取整，
    // 因此这里的高频刷新不会造成文字抖动。
    // 弹窗关闭立即停表，避免后台空转。
    if (!open || !bindCode) return undefined;
    setNowMs(Date.now());
    // Bugfix: 绑定码缩短到 30 秒后，1 秒刷新会让进度条明显跳格。
    // 这里用更细的节奏驱动动画，文字仍由 formatBindCountdown 按秒展示。
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [bindCode, open]);

  useEffect(() => {
    if (!open || !bindCode || bindExpired) return undefined;
    let cancelled = false;

    // 绑定轮询的存在原因：/bind 由第三方聊天侧回写配置，UI 没有直接事件。
    // 每 2s 拉一次全量 config 是低频刷新，代价可接受。
    // 命中 providerUserId 后先 setConfig 再收起绑定码：
    // 顺序反了会出现「码已消失但 Bot 仍显示未绑定」的一帧。
    const pollBindResult = async () => {
      try {
        const nextConfig = await botsService.getConfig();
        if (cancelled) return;
        setConfig(nextConfig);
        const targetBot = nextConfig.bots.find((bot) => bot.id === bindCode.botId);
        if (targetBot?.providerUserId) {
          // Bugfix: /bind 是从第三方聊天回写配置，UI 没有直接事件。
          // 绑定码展开期间低频刷新配置，绑定成功后立即收起绑定区域。
          setBindCode(null);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] 轮询 Bot 绑定结果失败",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    void pollBindResult();
    const timer = window.setInterval(() => {
      void pollBindResult();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bindCode, bindExpired, botsService, open]);

  useEffect(() => {
    // 这是绑定成功后的兜底收起：即使轮询被切换打断，
    // 只要当前 Bot 已带 providerUserId，就立即清掉旧码。
    // 三个条件缺一不可：没有码、码属于别的 Bot、当前 Bot 仍未绑定，都不该清。
    if (!bindCode || bindCode.botId !== selectedBot?.id || !selectedBot.providerUserId) {
      return;
    }
    // Bugfix: /bind 成功是服务层异步回写配置；即使轮询刚好被切换/刷新打断，
    // 只要当前 Bot 已经带 providerUserId，就应该立即收起旧绑定码。
    setBindCode(null);
  }, [bindCode, selectedBot?.id, selectedBot?.providerUserId]);

  useEffect(() => {
    setCredentialValue("");
    setSecretSaving(false);
    setWorkspaceAccessSaving(false);
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  }, [selectedBotId, selectedBot?.provider]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 运行状态轮询。注意 finally 里的重新调度：
    // 必须等本次 RPC 结束再排下一次，否则慢请求会堆积成并发风暴。
    // cancelled 在 finally 里也要检查，避免关闭弹窗后仍排一个定时器。
    // 错误只记 debug 日志：状态轮询失败不该打扰用户，下一轮会自动重试。
    const pollStatus = async () => {
      try {
        const nextStatus = await botsService.getStatus();
        if (!cancelled) setStatus(nextStatus);
      } catch (error) {
        logger.debug("[BotsDialog] 刷新 Bot 运行状态失败", error);
      } finally {
        // 投递在后台完成；只在弹窗可见时串行刷新，避免慢 RPC 堆积或关闭后回写。
        if (!cancelled) timer = setTimeout(() => void pollStatus(), 2000);
      }
    };
    void pollStatus();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [botsService, open]);

  // 四路并发拉取：config、status、workspaceRefs、botStates。
  // 用 Promise.all 而不是逐个 await，首屏延迟由最慢一路决定而不是四路之和。
  // selectedBotId 的更新用函数式形式，且 creatingBot 为真时保持 current：
  // 用户点「添加」后立刻刷新，不能把选中项抢回第一个 Bot。
  // 任何一路失败都整体失败并提示，避免界面出现「有配置没状态」的半截数据。
  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextStatus, nextWorkspaces, nextBotStates] = await Promise.all([
        botsService.getConfig(),
        botsService.getStatus(),
        botsService.listWorkspaceRefs(),
        botsService.getBotStates(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setWorkspaceRefs(nextWorkspaces);
      setBotStates(nextBotStates);
      setConfigLoaded(true);
      setSelectedBotId((current) =>
        creatingBot ? current : (current ?? nextConfig.bots[0]?.id ?? null),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 加载 Bots 配置失败", message);
      toast(intl.formatMessage({ id: "bots.loadFailed" }, { error: message }));
    }
  }, [botsService, creatingBot, intl]);

  useEffect(() => {
    if (
      !open ||
      selectedBot?.provider !== "weixin" ||
      !selectedBot.credentialRef ||
      selectedBotState?.weixinActivatedAt
    ) {
      return undefined;
    }
    let cancelled = false;
    // 微信激活态轮询：只在「有凭据且尚未激活」时运行。
    // 它与运行状态轮询并行，因为激活是异步事件，getStatus 不一定立即反映。
    // 这里用 setInterval 而不是串行调度：getBotStates 是轻量快照接口，
    // 与微信扫码那条长等待接口不同，不存在请求堆叠风险。
    const pollActivationState = async () => {
      try {
        const nextBotStates = await botsService.getBotStates();
        if (!cancelled) {
          setBotStates(nextBotStates);
        }
      } catch (error) {
        logger.warn(
          "[BotsDialog] 轮询微信 Bot 激活状态失败",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const timer = window.setInterval(() => {
      void pollActivationState();
    }, 2000);
    void pollActivationState();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    botsService,
    open,
    selectedBot?.credentialRef,
    selectedBot?.id,
    selectedBot?.provider,
    selectedBotState?.weixinActivatedAt,
  ]);

  useEffect(() => {
    // 每次打开都重置 configLoaded 并重新拉全量：
    // Bot 配置可能被其他窗口或第三方聊天改写，复用上次快照会造成显示过期。
    // 先置 false 再 refresh，保证「加载中」状态至少渲染一帧，避免闪旧数据。
    if (open) {
      setConfigLoaded(false);
      void refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    // 入口幂等闸随 open/entryProvider 变化重置。
    // 不重置会让第二次从同一个快捷入口进入时不再自动选中/新建，
    // 表现为「点了一次能用，再点就没反应」。
    handledEntryProviderRef.current = null;
  }, [entryProvider, open]);

  // 保存的唯一入口。四件事顺序固定：
  //   1) await 服务端保存（失败直接抛出，由调用方提示）；
  //   2) 用返回值就地替换列表项（不整表刷新，避免列表闪烁）；
  //   3) 选中保存后的 Bot、退出新建态、清空凭据草稿；
  //   4) 后台 refresh 校正 status/workspaces。
  // 第 2 步用「先删同 id 再追加」而不是 map：
  // 新建的 Bot 不在旧列表里，map 会丢掉它。
  const saveBot = useCallback(
    async (bot: BotConfig, secrets?: { credentialValue?: string }) => {
      const saved = await botsService.saveBot({
        bot,
        credentialValue: secrets?.credentialValue,
      });
      setConfig((previous) => ({
        ...previous,
        bots: [...previous.bots.filter((item) => item.id !== saved.id), saved],
      }));
      setSelectedBotId(saved.id);
      // saveBot 成功后必须把 creatingBot 置回 false，否则右侧仍停在渠道选择页。
      // 新建态下 selectedBotId 为 null，点列表项时必须同时改两个状态，
      // 只改 selectedBotId 会让右侧仍停在渠道选择页。
      setCreatingBot(false);
      setCredentialValue("");
      void refresh();
      return saved;
    },
    [botsService, refresh],
  );

  // 创建绑定码时冻结四个字段：botId、code、createdAt、expiresAt。
  // ttlMs 由 expiresAt - createdAt 推导并夹到 >= 1：
  // 服务端返回的时钟与本地可能偏差，直接用常量会让进度条算出越界值。
  // setNowMs(createdAt) 让首次渲染的剩余时间等于完整 TTL，
  // 否则会用上一次的 nowMs 先渲染出一个偏小的值。
  const createBindCodeForBot = useCallback(
    async (bot: BotConfig) => {
      const createdAt = Date.now();
      const result = await botsService.createBindCode({
        botId: bot.id,
        ttlMs: BIND_CODE_TTL_MS,
        allowedWorkspaces: bot.allowedWorkspaces,
      });
      setNowMs(createdAt);
      setBindCode({
        botId: bot.id,
        code: result.code,
        createdAt,
        expiresAt: result.expiresAt,
        ttlMs: Math.max(1, result.expiresAt - createdAt),
      });
    },
    [botsService],
  );

  useEffect(() => {
    const registration = feishuRegistration;
    if (!open || !selectedBot || !isFeishuBotProvider(selectedBot.provider) || !registration) {
      return undefined;
    }
    // 非 pending 状态直接不建立轮询。
    // 这样错误/过期结果不会反复请求服务端，用户需要重新点「扫码」。
    if (registration.status !== "pending") {
      return undefined;
    }

    let cancelled = false;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    // 飞书扫码注册轮询。整体状态机：pending 继续、success 保存凭据、其余转错误。
    // 轮询间隔来自服务端 interval（秒），夹到 >= 1 防止 0 造成忙循环。
    // success 分支复用 saveBot 的 secret 写入路径，
    // 保证 App Secret 只进凭据存储，不会落到明文配置文件。
    // 保存后仍然 setConfig 一次：saveBot 内的替换可能早于本轮 config 快照，
    // 这里再对齐一次可避免列表与详情短暂不一致。
    const pollRegistration = async () => {
      try {
        const result = await botsService.pollFeishuRegistration({
          deviceCode: registration.deviceCode,
          domain: registration.domain,
          pollDomain: registration.pollDomain,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending") {
          setFeishuRegistration((current) => {
            if (current?.deviceCode !== registration.deviceCode) {
              return current;
            }
            if (
              // 三个字段全部相等时返回原对象引用，是整个飞书流程里最关键的一行。
              // 返回新对象会让 effect 依赖 feishuRegistration 变化，
              // 从而清理并重建 setInterval，表现为「每收到一次 pending 就多发一次请求」。
              // deviceCode 比较在前：这是防止旧请求结果覆盖新注册会话。
              current.interval === result.interval &&
              current.domain === result.domain &&
              current.pollDomain === result.pollDomain
            ) {
              return current;
            }
            // Bugfix: pending 轮询结果通常不变；如果每次都创建新对象，会触发 effect 依赖变化，
            // 进而立即重启轮询并造成毫秒级 RPC 风暴。
            return {
              ...current,
              interval: result.interval,
              domain: result.domain,
              pollDomain: result.pollDomain,
            };
          });
          return;
        }
        if (result.status === "success") {
          // Bugfix: 服务层一直支持飞书扫码注册，但 Bots 重构后的 UI 只保留了手填凭据。
          // 扫码成功后直接复用 saveBot 的 secret 写入路径，避免把 App Secret 留在明文配置文件里。
          // 扫码成功只写 feishuAppId 凭据，bindCode 仍由后续绑定阶段生成。
          // name 优先用远端 appName（去掉首尾空白），为空才保留原名称。
          // feishuAppId 写入后，后续绑定流程由「有凭据但未绑定」的统一状态机驱动。
          const savedBot = await saveBot(
            {
              ...selectedBot,
              provider: selectedBot.provider,
              name: result.appName?.trim() || selectedBot.name,
              feishuAppId: result.appId,
            },
            { credentialValue: result.appSecret },
          );
          if (!cancelled) {
            // Bugfix: 飞书/Lark 扫码成功只完成应用凭据接入；绑定码由“有凭据但未绑定”的统一状态机生成。
            // 这里仅收起二维码，避免二维码和 /bind 面板在一次状态更新里互相抢展示优先级。
            setConfig((previous) => ({
              ...previous,
              bots: previous.bots.map((bot) => (bot.id === savedBot.id ? savedBot : bot)),
            }));
            setFeishuRegistration(null);
            toast(intl.formatMessage({ id: "bots.feishuRegistrationSuccess" }));
          }
          return;
        }
        setFeishuRegistration((current) =>
          current?.deviceCode === registration.deviceCode
            ? {
                ...current,
                status: result.status,
                message:
                  result.message ??
                  intl.formatMessage({
                    id: `bots.feishuRegistration.${result.status}`,
                  }),
              }
            : current,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 飞书扫码注册轮询失败", message);
        if (!cancelled) {
          setFeishuRegistration((current) =>
            current?.deviceCode === registration.deviceCode
              ? { ...current, status: "error", message }
              : current,
          );
        }
      }
    };

    const timer = window.setInterval(() => {
      void pollRegistration();
    }, pollIntervalMs);
    void pollRegistration();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [botsService, createBindCodeForBot, feishuRegistration, intl, open, saveBot, selectedBot]);

  useEffect(() => {
    const registration = weixinRegistration;
    if (!open || !selectedBot || selectedBot.provider !== "weixin" || !registration) {
      return undefined;
    }
    if (registration.status !== "pending" && registration.status !== "scanned") {
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    // 微信轮询的串行调度器：上一次请求完成后才排下一次。
    // 用 setTimeout 而不是 setInterval，是因为服务端接口是长等待，
    // 定时器触发时上一个请求可能还没返回。
    // cancelled 检查放在最前：cleanup 之后到达的调度请求必须丢弃。
    const scheduleNextPoll = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        void runPoll();
      }, pollIntervalMs);
    };

    const pollRegistration = async () => {
      try {
        const result = await botsService.pollWeixinRegistration({
          qrCode: registration.qrCode,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending" || result.status === "scanned") {
          setWeixinRegistration((current) => {
            if (current?.qrCode !== registration.qrCode) {
              return current;
            }
            if (current.interval === result.interval && current.status === result.status) {
              return current;
            }
            return {
              ...current,
              interval: result.interval,
              status: result.status,
            };
          });
          return;
        }
        if (result.status === "success") {
          await saveBot(
            {
              ...selectedBot,
              webhookUrl: undefined,
              providerUserId: result.botId ?? selectedBot.providerUserId,
              displayName: result.botId ?? selectedBot.displayName,
              name: selectedBot.name,
            },
            { credentialValue: result.botToken },
          );
          if (!cancelled) {
            // Bugfix: 微信扫码成功即完成连接，保留 QR registration 会让用户看到过期的扫码区域。
            // 清掉临时状态后，Bot token 行会切到已连通的 Unbind 操作。
            setWeixinRegistration(null);
            toast(intl.formatMessage({ id: "bots.weixinRegistrationSuccess" }));
          }
          cancelled = true;
          return;
        }
        setWeixinRegistration((current) =>
          current?.qrCode === registration.qrCode
            ? {
                ...current,
                status: result.status,
                message:
                  ("message" in result ? result.message : undefined) ??
                  intl.formatMessage({
                    id: `bots.weixinRegistration.${result.status}`,
                  }),
              }
            : current,
        );
        cancelled = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 微信扫码登录轮询失败", message);
      }
    };

    // 先 poll 再 schedule，顺序不可反：
    // 反过来会在请求尚未返回时就排下一次，退化成 setInterval 的堆叠问题。
    const runPoll = async () => {
      await pollRegistration();
      scheduleNextPoll();
    };

    // Bugfix: 微信扫码状态接口会长等待，如果用 setInterval 会在上一次请求未返回时继续堆叠 RPC。
    // 串行轮询可以避免连续 timeout，也避免多个结果互相覆盖 UI 状态。
    void runPoll();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [botsService, intl, open, saveBot, selectedBot, weixinRegistration]);

  // 通用局部更新：展开当前 Bot 再应用 patch。
  // 不在这里做字段级校验：patch 来自受控子组件，取值范围已由组件契约约束。
  // void saveBot 表示「不等待也不处理失败」，失败提示由 saveBot 的调用方统一给。
  const patchSelectedBot = useCallback(
    (patch: Partial<BotConfig>) => {
      if (!selectedBot) return;
      void saveBot({ ...selectedBot, ...patch });
    },
    [saveBot, selectedBot],
  );

  const startBotNameRename = useCallback(() => {
    if (!selectedBot) return;
    setRenamingBotId(selectedBot.id);
    setBotNameDraft({ botId: selectedBot.id, value: selectedBot.name });
  }, [selectedBot]);

  // 提交顺序：先清草稿与重命名标记，再判断是否需要保存。
  // 必须先清再比较：保存是异步的，先 await 会让输入框在保存期间仍处于编辑态。
  // 名称与已保存值相同则不发请求，避免失焦即产生一次无意义写盘。
  const commitBotNameDraft = useCallback(() => {
    if (!selectedBot) return;
    const nextName = selectedBotName.trim();
    setBotNameDraft(null);
    setRenamingBotId(null);
    if (nextName === selectedBot.name) return;
    // Bugfix: Bot 名称输入过程中如果立即保存，服务层 trim 后的回写会吃掉刚输入的尾部空格，
    // 导致用户无法继续输入包含空格的名称；改为提交时保存，保留输入过程中的本地草稿。
    // 同时空名称是合法的未命名状态，展示层统一用多语言 fallback 名称兜底。
    void saveBot({ ...selectedBot, name: nextName });
  }, [saveBot, selectedBot, selectedBotName]);

  // 键盘处理只做三件事：Enter 失焦（触发 blur 提交）、IME Enter 忽略、Escape 取消。
  // Enter 走 blur 而不是直接 commit：
  // blur 是唯一的提交入口，保证「点别处」与「按回车」走同一条路径。
  // Escape 必须 stopPropagation，否则 Radix Dialog 会同时收到并关闭弹窗。
  const handleBotNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (
          isImeComposingKeyEvent({
            compositionActive: botNameCompositionActiveRef.current,
            nativeEvent: event.nativeEvent,
          })
        ) {
          // Bugfix: Bot 名称重命名时中文输入法 Enter 是候选词确认，不是提交重命名。
          // 这里避免触发 blur，否则 blur 会继续走 commitBotNameDraft。
          logger.debug("[BotsDialog] ignore bot name enter during IME", {
            botId: selectedBot?.id ?? null,
          });
          return;
        }
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        // Bugfix: 重命名输入框里的 Escape 只应该取消编辑，不能继续冒泡触发 Dialog 的关闭快捷键。
        setBotNameDraft(null);
        setRenamingBotId(null);
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [selectedBot?.id],
  );

  // Radix 在 React onKeyDown 冒泡之前处理 Escape，
  // 因此输入框里的 stopPropagation 拦不住弹窗关闭，必须在这一层拦截。
  // 只在重命名中拦截：其他时候 Escape 仍应关闭弹窗。
  const handleDialogEscapeKeyDown = useCallback(
    (event: Event) => {
      if (renamingBotId === null) return;
      // Bugfix: Radix Dialog 会在输入框 React onKeyDown 冒泡前处理 Escape 关闭。
      // 正在重命名时需要在 Dialog 的关闭入口拦截，Esc 只取消编辑，不关闭弹窗。
      event.preventDefault();
      setBotNameDraft(null);
      setRenamingBotId(null);
    },
    [renamingBotId],
  );

  // 工作区范围采用乐观更新：
  //   1) 空数组归一化为「全部工作区」，这是存储层的语义要求；
  //   2) 先把本地列表改成目标值，界面立即响应；
  //   3) 保存失败用 previousBot 快照整体回滚该条，并提示。
  // 回滚按 id 替换而不是把整个列表还原：期间可能有其他 Bot 的并发修改。
  const patchAllowedWorkspaces = useCallback(
    async (allowedWorkspaces: string[]) => {
      if (!selectedBot) return;
      setWorkspaceAccessSaving(true);
      const normalizedAllowedWorkspaces =
        allowedWorkspaces.length > 0 ? allowedWorkspaces : [ALL_BOT_WORKSPACES];
      const previousBot = selectedBot;
      const optimisticBot = {
        ...selectedBot,
        allowedWorkspaces: normalizedAllowedWorkspaces,
      };
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((bot) => (bot.id === optimisticBot.id ? optimisticBot : bot)),
      }));
      try {
        await saveBot(optimisticBot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 保存工作区访问范围失败", message);
        setConfig((previous) => ({
          ...previous,
          bots: previous.bots.map((bot) => (bot.id === previousBot.id ? previousBot : bot)),
        }));
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setWorkspaceAccessSaving(false);
      }
    },
    [intl, saveBot, selectedBot],
  );

  // allowedWorkspaces 里的「全部工作区」是哨兵值，不是真实 workspaceId。
  // 因此在勾选任一项前必须先展开成真实 id 列表，否则会把哨兵和真实 id 混在一起。
  // 展开依据是当前 workspaceRefs：
  // 未加载完时展开为空列表，会导致一次「取消所有」的误保存，
  // 这也是为什么该方法只在 WorkspaceAccessCard 加载完成后才可点。
  const toggleWorkspaceAccess = useCallback(
    async (workspaceId: string, checked: boolean) => {
      if (!selectedBot) return;
      const currentAllowed = isAllWorkspacesAllowed(selectedBot.allowedWorkspaces)
        ? workspaceRefs.map((workspace) => workspace.id)
        : selectedBot.allowedWorkspaces;
      const nextAllowed = checked
        ? [...new Set([...currentAllowed, workspaceId])]
        : currentAllowed.filter((id) => id !== workspaceId);
      await patchAllowedWorkspaces(nextAllowed);
    },
    [patchAllowedWorkspaces, selectedBot, workspaceRefs],
  );

  // 进入新建态时必须把与「当前 Bot」相关的临时态全部清掉：
  // 要清的是凭据草稿、feishuRegistration 与 weixinRegistration 三份临时态。
  // creatingProvider 置 null 而不是保留：新建页要展示完整渠道列表。
  const handleBeginAddBot = () => {
    setCreatingBot(true);
    setCreatingProvider(null);
    setSelectedBotId(null);
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  };

  // 创建 Bot：先占住 creatingProvider 防重复点击，再生成草稿并保存。
  // webhook 渠道额外写入默认鉴权头名，这是该渠道的必填项；
  // 其他渠道不写，避免把 webhook 专用字段带到飞书/微信配置里。
  // 失败统一提示 saveFailed，并在 finally 释放 creatingProvider，
  // 否则一次失败会让所有渠道按钮永久禁用。
  const handleAddBot = useCallback(
    async (provider: BotProvider) => {
      if (creatingProvider) return;
      setCreatingProvider(provider);
      const bot = createDraftBot({
        provider,
      });
      try {
        await saveBot({
          ...bot,
          name: "",
          ...(provider === "webhook" ? { webhookAuthHeaderName: "x-zcode-bot-secret" } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 创建 Bot 失败", message);
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setCreatingProvider(null);
      }
    },
    [creatingProvider, intl, saveBot],
  );

  useEffect(() => {
    // 快捷入口处理必须等 configLoaded：
    // 配置未到时 bots 为空，会把「已存在的 Bot」误判成「需要新建」。
    // handledEntryProviderRef 保证同一个入口只处理一次；
    // 每次 open 或 entryProvider 变化时由上一个 effect 重置。
    // select 模式只选中，create 模式才新建，两者的分支不能合并。
    if (!open || !entryProvider || !configLoaded) {
      return;
    }
    if (handledEntryProviderRef.current === entryProvider) {
      return;
    }

    const entry = resolveBotProviderEntry(config.bots, entryProvider);
    handledEntryProviderRef.current = entryProvider;
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);

    if (entry.mode === "select") {
      setCreatingBot(false);
      setCreatingProvider(null);
      setSelectedBotId(entry.botId);
      return;
    }

    // Bugfix: 远程控制弹窗新增 Bot Channel 快捷入口后，进入 BotsDialog 不能停在空白选择页。
    // 这里在配置加载完成后再判断并创建，避免异步刷新尚未拿到已有 bot 时重复新建。
    setCreatingBot(true);
    setSelectedBotId(null);
    void handleAddBot(entry.provider);
  }, [config.bots, configLoaded, entryProvider, handleAddBot, open]);

  const handleCreateBindCode = async () => {
    if (!selectedBot) return;
    await createBindCodeForBot(selectedBot);
  };

  // 保存 secret 的入口。secretSaving 同时作为按钮 loading 与重入保护。
  // 凭据值只在这里读取一次并交给 saveBot，不写进 config state，
  // 这样明文凭据不会随配置对象进入日志或持久化。
  const handleSaveSecret = async () => {
    if (!selectedBot || secretSaving) return;
    setSecretSaving(true);
    try {
      await saveBot(selectedBot, { credentialValue });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 保存 Bot secret 失败", message);
      toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
    } finally {
      setSecretSaving(false);
    }
  };

  // 飞书扫码分两步：先向服务端申请 deviceCode，再本地生成二维码图片。
  // 二维码生成失败不阻断流程：qrDataUrl 为 null 时子组件仍能展示 qrUrl 文本/链接。
  // 注意这里没有把 loading 放进依赖，
  // 因为 autoQrStartedBotIdsRef 已经承担了幂等，loading 只用于禁用按钮。
  const handleStartFeishuRegistration = useCallback(async () => {
    if (!selectedBot || !isFeishuBotProvider(selectedBot.provider)) return;
    setFeishuRegistrationLoading(true);
    try {
      const result = await botsService.beginFeishuRegistration({
        domain: selectedBot.provider,
      });
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成飞书注册二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setFeishuRegistration({
        botId: selectedBot.id,
        deviceCode: result.deviceCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        userCode: result.userCode,
        interval: result.interval,
        expiresAt: result.expiresAt,
        domain: result.domain,
        pollDomain: result.pollDomain,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.feishuRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动飞书扫码注册失败", message);
      toast(intl.formatMessage({ id: "bots.feishuRegistrationFailed" }, { error: message }));
    } finally {
      setFeishuRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  // 微信扫码与飞书结构对称，但返回的是 qrCode 而不是 deviceCode，
  // 轮询接口与成功后的字段写入也不同（token 走 credentialValue）。
  // 两者不能抽象成同一个函数：字段差异会让类型与错误提示都变得含混。
  const handleStartWeixinRegistration = useCallback(async () => {
    if (!selectedBot || selectedBot.provider !== "weixin") return;
    setWeixinRegistrationLoading(true);
    try {
      const result = await botsService.beginWeixinRegistration();
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成微信登录二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setWeixinRegistration({
        botId: selectedBot.id,
        qrCode: result.qrCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        interval: result.interval,
        expiresAt: result.expiresAt,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.weixinRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动微信扫码登录失败", message);
      toast(intl.formatMessage({ id: "bots.weixinRegistrationFailed" }, { error: message }));
    } finally {
      setWeixinRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  useEffect(() => {
    if (!open || creatingBot || !selectedBot) {
      return;
    }

    // useEffect 总闸：!open 或 creatingBot 或 !selectedBot 成立时直接 return。
    // 飞书/Lark 分两个阶段：
    //   !credentialRef -> 自动拉起一次扫码注册；
    //   有凭据但未绑定 -> 自动创建一枚绑定码（过期后自动续）。
    // 每个阶段都有三个前置 return，缺一个就会出现「自动流程与用户手动操作打架」。
    // Telegram 只有绑定阶段；微信只有扫码阶段。
    if (isFeishuBotProvider(selectedBot.provider)) {
      if (!selectedBot.credentialRef) {
        if (feishuRegistrationLoading) {
          return;
        }
        if (feishuRegistration?.botId === selectedBot.id) {
          return;
        }

        const autoKey = `${selectedBot.id}:feishu-registration`;
        if (autoQrStartedBotIdsRef.current.has(autoKey)) {
          return;
        }

        // Bugfix: 未配置 token 的飞书/Lark Bot 首次进入详情时只显示“扫码”按钮，
        // 用户会误以为还需要额外展开；自动启动一次二维码流程，让缺失凭据的默认状态直接可操作。
        autoQrStartedBotIdsRef.current.add(autoKey);
        void handleStartFeishuRegistration();
        return;
      }

      if (!selectedBot.providerUserId) {
        if (bindCode?.botId === selectedBot.id && !bindExpired) {
          return;
        }
        if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
          return;
        }

        // Bugfix: 飞书/Lark 的接入凭据和聊天绑定是两个阶段；已有凭据但未绑定时需要自动展示 /bind。
        // 绑定码现在只有 30 秒有效期，过期后如果还停在旧码会打断自动绑定流程；这里自动续一枚新码。
        autoBindCreatingBotIdsRef.current.add(selectedBot.id);
        void createBindCodeForBot(selectedBot).finally(() => {
          autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
        });
      }
      return;
    }

    if (selectedBot.provider === "telegram") {
      if (!selectedBot.credentialRef || selectedBot.providerUserId) {
        return;
      }
      if (bindCode?.botId === selectedBot.id && !bindExpired) {
        return;
      }
      if (autoBindCreatingBotIdsRef.current.has(selectedBot.id)) {
        return;
      }

      // Bugfix: Telegram 和飞书/Lark 一样分成凭据接入与私聊绑定两步；
      // token 保存后自动展示 /bind；绑定码过期也自动续码，避免 30 秒有效期让用户卡在旧码上。
      autoBindCreatingBotIdsRef.current.add(selectedBot.id);
      void createBindCodeForBot(selectedBot).finally(() => {
        autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      });
      return;
    }

    if (selectedBot.provider !== "weixin") {
      return;
    }
    if (selectedBot.credentialRef || weixinRegistrationLoading) {
      return;
    }
    if (weixinRegistration?.botId === selectedBot.id) {
      return;
    }

    const autoKey = `${selectedBot.id}:weixin-registration`;
    if (autoQrStartedBotIdsRef.current.has(autoKey)) {
      return;
    }

    // Bugfix: 微信 Bot 没有 token/绑定状态时需要立即给出登录二维码，
    // 否则新建后右侧默认只露出按钮，和“扫码接入”的主流程不一致。
    autoQrStartedBotIdsRef.current.add(autoKey);
    void handleStartWeixinRegistration();
  }, [
    creatingBot,
    feishuRegistration,
    feishuRegistrationLoading,
    bindCode,
    bindExpired,
    createBindCodeForBot,
    handleStartFeishuRegistration,
    handleStartWeixinRegistration,
    open,
    selectedBot,
    weixinRegistration,
    weixinRegistrationLoading,
  ]);

  // 外链统一走 platform.openExternal，不用 window.open：
  // 桌面端需要用系统浏览器打开，而不是在应用内新开窗口。
  const handleOpenTelegramBotFather = () => {
    platform.openExternal(TELEGRAM_BOTFATHER_URL);
  };

  // 复制的是完整命令 /bind <code>，而不是裸码：
  // 用户直接粘贴到聊天框即可，不用自己拼 /bind 前缀与 code。
  // 复制失败仍提示成功是已知取舍 —— clipboard 在非安全上下文可能静默失败，
  // 这里保留 toast 让用户至少知道命令文本是什么。
  const copyBindCommand = async () => {
    if (!bindCode || bindExpired) return;
    const command = `/bind ${bindCode.code}`;
    await navigator.clipboard?.writeText(command).catch((error: unknown) => {
      logger.warn(
        "[BotsDialog] 复制绑定命令失败",
        error instanceof Error ? error.message : String(error),
      );
    });
    toast(intl.formatMessage({ id: "bots.bindCommandCopied" }));
  };

  // 解绑 = 清掉 providerUserId 与 displayName + 重置服务端运行态。
  // 两步都必须完成：只清配置会让服务端继续向旧会话推送消息。
  // 这里不重置 credentialRef，凭据仍保留，用户可以直接重新绑定。
  const handleUnbind = async () => {
    if (!selectedBot) return;
    await saveBot({
      ...selectedBot,
      providerUserId: undefined,
      displayName: undefined,
    });
    await botsService.resetBotState(selectedBot.id);
  };

  // 移除凭据后必须清掉三个幂等集合：
  // 否则用户重新配置时，自动二维码/自动绑定码都不会再启动（集合里还留着旧键）。
  // 本地列表用返回值就地替换，再清空凭据草稿与绑定码，最后后台 refresh。
  const handleRemoveSecret = async () => {
    if (!selectedBot) return;
    try {
      const saved = await botsService.removeBotSecret(selectedBot.id);
      autoQrStartedBotIdsRef.current.delete(`${selectedBot.id}:feishu-registration`);
      autoQrStartedBotIdsRef.current.delete(`${selectedBot.id}:weixin-registration`);
      autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((item) => (item.id === saved.id ? saved : item)),
      }));
      setCredentialValue("");
      setBindCode(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 移除 Bot secret 失败", message);
      toast(intl.formatMessage({ id: "bots.removeSecretFailed" }, { error: message }));
    }
  };

  // 删除前必须二次确认，且 ConfirmDialog 的标题要带上 Bot 显示名：
  // 用户同时有多个 Bot 时，「删除机器人」这种泛化标题不足以确认目标。
  // 删除成功后清空选中项并 refresh，不就地删列表：
  // deleteBot 可能级联清理运行态，只有 refresh() 拿到的才是真实结果。
  const handleDelete = async () => {
    if (!selectedBot) return;
    // Bugfix: 删除机器人之前没有二次确认，误触会直接移除凭据和绑定入口。
    // 这里复用项目统一 ConfirmDialog，让破坏性操作和其它设置页保持一致。
    const confirmed = await confirmDialog({
      confirmVariant: "destructive",
      title: intl.formatMessage(
        { id: "bots.deleteConfirmTitle" },
        { name: formatBotDisplayName(selectedBot.name, fallbackBotName) },
      ),
      description: intl.formatMessage({ id: "bots.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "bots.delete" }),
    });
    if (!confirmed) return;

    try {
      await botsService.deleteBot(selectedBot.id);
      setSelectedBotId(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 删除 Bot 失败", message);
      toast(intl.formatMessage({ id: "bots.deleteFailed" }, { error: message }));
    }
  };

  // 运行态按 botId 从 status.botRuntime 里查，不从 botStates 推导。
  // status 是整机快照，botStates 是每 Bot 的激活/绑定明细，两者用途不同。
  const selectedRuntime = selectedBot
    ? status?.botRuntime.find((item) => item.botId === selectedBot.id)
    : undefined;
  // 渠道名按枚举拼 i18n key，而不是在数据表里存文案：
  // 这样新增语言不需要改 BOT_PROVIDERS。
  const formatChannelName = (provider: BotProviderEntryId) =>
    intl.formatMessage({ id: `bots.channel.${provider}` });
  // 渠道名 + 区域标签的组合渲染。区域标签（如国际版）是可选后缀，
  // 只有 getBotProviderRegionTagLabelId 返回 id 时才出现。
  // 外层 min-w-0 + 内层 truncate：窄侧栏里长渠道名必须省略而不是撑破布局。
  const renderChannelName = (provider: BotProviderEntryId) => {
    const regionTagLabelId = getBotProviderRegionTagLabelId(provider);

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate">{formatChannelName(provider)}</span>
        {regionTagLabelId ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
            {intl.formatMessage({ id: regionTagLabelId })}
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-6rem)] max-h-168 max-w-4xl flex-col overflow-hidden rounded-2xl"
        onEscapeKeyDown={handleDialogEscapeKeyDown}
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="size-5 text-foreground" />
            <DialogTitle className="text-ui-lg font-medium text-foreground">
              {intl.formatMessage({ id: "bots.title" })}
            </DialogTitle>
            <DialogDescription className="ml-3">
              {intl.formatMessage({ id: "bots.description" })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <aside className="flex max-h-40 w-full shrink-0 flex-col md:max-h-none md:w-64">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={handleBeginAddBot}
                className="mb-3 w-full justify-start gap-2 rounded-xl"
              >
                <Plus className="size-4" />
                <span className="min-w-0 truncate">
                  {intl.formatMessage({ id: "bots.addBot" })}
                </span>
              </Button>
              {config.bots.length === 0 ? (
                <div className="p-4 text-ui-base text-foreground-subtle">
                  {creatingBot
                    ? intl.formatMessage({
                        id: "bots.newBot.selectProviderHint",
                      })
                    : intl.formatMessage({ id: "bots.empty" })}
                </div>
              ) : (
                config.bots.map((bot) => {
                  const runtime = status?.botRuntime.find((item) => item.botId === bot.id);
                  // 列表选中态只比 id，不比对象：
                  // config 每次保存都会重建 bots 数组，对象比较会让选中高亮在保存后消失。
                  const selected = bot.id === selectedBotId;
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => {
                        setCreatingBot(false);
                        setSelectedBotId(bot.id);
                      }}
                      className={cn(
                        "mb-1 w-full rounded-xl px-2.5 pr-4 py-3 text-left transition-colors",
                        selected
                          ? "bg-surface-hover text-foreground"
                          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <ProviderIcon
                          provider={bot.provider}
                          className="size-10 shrink-0 object-contain text-foreground-subtle"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-foreground truncate text-ui-base font-medium">
                            {formatBotDisplayName(bot.name, fallbackBotName)}
                          </span>
                          <span className="mt-0.5 flex min-w-0 text-ui-base text-foreground-subtle">
                            {renderChannelName(bot.provider)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            runtimeDot(runtime, bot.enabled),
                          )}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background p-4">
            {creatingBot ? (
              <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-start gap-6">
                <div className="space-y-2">
                  <div className="text-ui-lg font-medium">
                    {intl.formatMessage({ id: "bots.newBot.title" })}
                  </div>
                  <p className="max-w-2xl text-ui-base leading-6 text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.newBot.description" })}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {BOT_PROVIDERS.filter((provider) => provider.id !== "webhook").map((provider) => {
                    // 渠道是否可用由 BOT_PROVIDERS 上的 implemented 决定，
                    // UI 不按 provider 枚举硬编码，新增渠道只需改数据源。
                    // 未实现的渠道按钮禁用但可见，用于表达「即将支持」。
                    const implemented = provider.implemented;
                    const isCreatingThisProvider = creatingProvider === provider.id;
                    const isCreatingAnyProvider = creatingProvider !== null;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        // 任一渠道创建中时禁用全部渠道按钮：
                        // 并发保存会让两次 setSelectedBotId 互相覆盖，最终只留下一个 Bot 被选中。
                        // aria-busy 只标当前渠道，让读屏能区分「这个在加载」与「其他被禁用」。
                        disabled={!implemented || isCreatingAnyProvider}
                        aria-busy={isCreatingThisProvider}
                        onClick={() => (implemented ? void handleAddBot(provider.id) : undefined)}
                        className={cn(
                          "flex items-start gap-3 rounded-lg border border-card-border bg-card py-4 px-3 text-left transition-colors",
                          implemented && !isCreatingAnyProvider
                            ? "hover:border-input-border-focused hover:bg-surface-hover"
                            : "cursor-not-allowed opacity-60",
                          isCreatingThisProvider &&
                            "border-input-border-focused bg-surface-hover opacity-100",
                        )}
                      >
                        {isCreatingThisProvider ? (
                          <div className="flex size-10 items-center justify-center">
                            <Loader2 className="size-6 shrink-0 animate-spin text-foreground-subtle" />
                          </div>
                        ) : (
                          <ProviderIcon
                            provider={provider.id}
                            className="size-10 shrink-0 text-foreground"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 text-ui-lg font-medium">
                            {renderChannelName(provider.id)}
                          </span>
                          <span className="mt-1 block text-ui-base text-foreground-subtle">
                            {implemented
                              ? intl.formatMessage({
                                  id: `bots.newBot.providerDescription.${provider.id}`,
                                })
                              : intl.formatMessage({
                                  id: "bots.newBot.comingSoon",
                                })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : !selectedBot ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
                <Bot className="size-8" />
                <div>{intl.formatMessage({ id: "bots.empty" })}</div>
                <Button variant="outline" size="lg" onClick={handleBeginAddBot}>
                  <Plus className="size-4" />
                  {intl.formatMessage({ id: "bots.addBot" })}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <BotSummaryCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  selectedBotDisplayName={selectedBotDisplayName}
                  selectedBotName={selectedBotName}
                  fallbackBotName={fallbackBotName}
                  renaming={renamingBotId === selectedBot.id}
                  onStartRename={startBotNameRename}
                  onCommitNameDraft={commitBotNameDraft}
                  onNameDraftChange={(value) => setBotNameDraft({ botId: selectedBot.id, value })}
                  onNameCompositionEnd={() => {
                    botNameCompositionActiveRef.current = false;
                  }}
                  onNameCompositionStart={() => {
                    botNameCompositionActiveRef.current = true;
                  }}
                  onNameInputKeyDown={handleBotNameKeyDown}
                  onPatchBot={patchSelectedBot}
                />

                <ProviderSettingsCard
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  credentialValue={credentialValue}
                  bindCode={bindCode}
                  bindExpired={bindExpired}
                  bindRemainingMs={bindRemainingMs}
                  bindCountdownProgress={bindCountdownProgress}
                  feishuRegistration={feishuRegistration}
                  feishuRegistrationLoading={feishuRegistrationLoading}
                  weixinRegistration={weixinRegistration}
                  weixinRegistrationLoading={weixinRegistrationLoading}
                  weixinActivated={Boolean(selectedBotState?.weixinActivatedAt)}
                  secretSaving={secretSaving}
                  onCredentialValueChange={setCredentialValue}
                  onSaveSecret={() => void handleSaveSecret()}
                  onRemoveSecret={() => void handleRemoveSecret()}
                  onOpenTelegramBotFather={handleOpenTelegramBotFather}
                  onStartWeixinRegistration={() => void handleStartWeixinRegistration()}
                  onStartFeishuRegistration={() => void handleStartFeishuRegistration()}
                  onCreateBindCode={() => void handleCreateBindCode()}
                  onUnbind={() => void handleUnbind()}
                  onCopyBindCommand={() => void copyBindCommand()}
                />

                <SettingsGroupCard>
                  <BotReplyGranularityCard bot={selectedBot} onPatchBot={patchSelectedBot} />

                  {/*
                    暂不暴露命令权限编辑入口，避免用户在 bot 可用前把关键命令关掉。
                    如果要恢复 UI，重新渲染 selectedBot.allowedCommands 的列表并用 patchSelectedBot 保存。
                  */}

                  <WorkspaceAccessCard
                    bot={selectedBot}
                    workspaceRefs={workspaceRefs}
                    loading={workspaceAccessSaving}
                    onPatchAllowedWorkspaces={patchAllowedWorkspaces}
                    onToggleWorkspaceAccess={toggleWorkspaceAccess}
                  />
                </SettingsGroupCard>

                {isFeishuBotProvider(selectedBot.provider) && (
                  <BoundGroupsCard
                    key={selectedBot.id + ":" + selectedBot.providerUserId}
                    bot={selectedBot}
                  />
                )}

                <BotDangerCard onDelete={() => void handleDelete()} />
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
