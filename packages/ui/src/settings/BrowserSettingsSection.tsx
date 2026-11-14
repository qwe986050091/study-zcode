/* oxlint-disable eslint(max-lines) -- Browser Plugin、Chrome 数据导入与清理共享同一平台状态机，拆分会扩大 pending/失败回收边界。 */
// BrowserSettingsSection —— 设置页「浏览器」分组：内置浏览器控制开关（browser-use 官方插件启停）、
// Chrome 登录数据导入、内置浏览器数据清理（缓存 / 全量），以及桌面端独有的不安全证书放行开关。
// 职责边界：只做「读投影 + 触发动作 + 展示结果」，不持有插件事实、不碰文件系统、不解析 Chrome 数据；
// 插件启用态归 pluginManagementStore，技能刷新归 skillStore，导入 / 清理归 platform 服务实现。
// 默认值来源：证书开关由父级受控传入（缺省 false，即按严格校验证书），导入结果与确认弹窗是本地瞬时态。
// 降级：非桌面端或 platform 未注入导入 / 清理能力时，数据区改显示 desktopOnly 提示且按钮全禁用。
// 并发：pendingOperation 非空即整组按钮禁用，导入与清理不会交叉；插件开关另由 togglingPluginId 门控。
//
// INV 表（每条都要能在下方找到对应断言，改动前逐条核对）：
// INV-01 断言：开关选中态只取自 browser-use 官方插件的 enabled 字段 —— 守住它的位置：Switch 的 checked 取值 —— 改错故障：加载中或插件缺失时被误显示为已开启。
// INV-02 断言：没有工作区、列表加载中或插件缺失时开关必须禁用 —— 守住它的位置：pluginUnavailable 的合并条件 —— 改错故障：工作区切换瞬间误触发启停。
// INV-03 断言：启停必须等平台写入并在回读后确认生效 —— 守住它的位置：handleBrowserEnabledChange 的回读分支 —— 改错故障：乐观更新让界面与插件事实不一致。
// INV-04 断言：回读状态与期望不符时不得刷新技能也不得提示成功 —— 守住它的位置：refreshedPlugin 的相等判断 —— 改错故障：假成功提示掩盖写入失败。
// INV-05 断言：启停成功后先失效延迟草稿会话再刷新技能 —— 守住它的位置：refreshAfterPluginChange 的语句顺序 —— 改错故障：旧草稿继续持有已失效的插件技能。
// INV-06 断言：技能刷新只在本组件工作区与技能仓库记录一致时执行 —— 守住它的位置：双字段比较分支 —— 改错故障：切换工作区途中把结果写进另一个工作区。
// INV-07 断言：工作区身份统一取 trim 后的值，空则退化 —— 守住它的位置：normalizedWorkspaceIdentity 的归一 —— 改错故障：带空白身份被当成不同工作区反复初始化。
// INV-08 断言：数据操作同一时刻至多一个进行中 —— 守住它的位置：BrowserDataOperation 与 pendingOperation —— 改错故障：导入与清理交错写同一原生目录。
// INV-09 断言：原生能力缺失时全部数据按钮禁用并显示桌面限定提示 —— 守住它的位置：nativeActionsAvailable 与 operationDisabled —— 改错故障：Web 端点出必然失败的操作。
// INV-10 断言：平台方法缺失时入口提前返回且不置位忙碌态 —— 守住它的位置：导入与清理开头的守卫 —— 改错故障：按钮永久卡在旋转状态。
// INV-11 断言：任何失败路径都必须在 finally 复位 pending —— 守住它的位置：两个 handle 的 finally —— 改错故障：异常后整组按钮无法再点。
// INV-12 断言：清全量必须先经确认弹窗，取消不得发起调用 —— 守住它的位置：confirmClearAll 与弹窗动作 —— 改错故障：误删用户登录态与站点数据。
// INV-13 断言：确认后的执行要阻止默认关闭，直到请求结束才收尾 —— 守住它的位置：弹窗动作的事件处理 —— 改错故障：请求未完成弹窗已关，界面状态错乱。
// INV-14 断言：导入入口仅在非 Windows 桌面显示，底层能力保留 —— 守住它的位置：isWindowsDesktop 的渲染分支 —— 改错故障：误删 Windows 的清理入口或暴露未就绪链路。
// INV-15 断言：不安全证书开关仅桌面端渲染且值完全受控于父级 —— 守住它的位置：isDesktop 分支与 checked —— 改错故障：Web 端出现无效开关或与启动配置不一致。
// INV-16 断言：导入结果只保留最近一次并同时体现在行内与提示 —— 守住它的位置：lastImportResult 的写入 —— 改错故障：结果丢失或摘要与提示口径不一致。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { ChromeBrowserDataImportResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useSkillStore } from "@/store/skillStore.js";
import { formatImportSummary } from "./browserImportSummary.js";

// [契约] 官方插件标识是唯一入口：启用态查询、开关门控、忙碌态比较全部复用它，不散落字面量。
// [边界] browser-use 随包分发，商店被禁用或未安装时这里查不到实体，整块开关必须降级禁用而不是隐式安装。
// [权衡] 用字符串常量而非导入插件清单，避免设置页把插件构建期元数据拖进渲染包。
// [失败路径] 标识与后端注册名不一致时开关会永久停在禁用态，排查先比对插件目录里的清单名。
const OFFICIAL_BROWSER_USE_PLUGIN_ID = "browser-use@zcode-plugins-official";

interface BrowserSettingsSectionProps {
  isDesktop: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  embeddedBrowserAllowInsecureCertificates?: boolean;
  onEmbeddedBrowserAllowInsecureCertificatesChange?: (enabled: boolean) => Promise<void>;
}

// [契约] BrowserDataOperation 是全组唯一互斥锁枚举：导入、清缓存、清全量三态至多一个生效。
// [并发] 三个操作共享同一份原生浏览器数据目录，串行是为了避免清理与导入交错损坏登录态。
// [权衡] 只用 null 表示空闲，不额外引入布尔 pending 标志，避免出现「有操作在跑但已无操作名」的半状态。
type BrowserDataOperation = "import" | "clear-cache" | "clear-all" | null;

// [契约] 操作按钮只接收「本次操作名 + 当前 pending 名」，自行推导忙碌态，不在父级重复计算禁用。
// [并发] 任一操作进行中时其余按钮一并禁用，DOM 层不给出可点击的假象。
// [资源] 忙碌图标仅在自身 pending 时挂载，避免三行按钮同时旋转造成状态误读。
// [失败路径] 按钮不自行捕获异常，失败提示由上层统一弹提示与记日志，组件保持纯展示。
function BrowserOperationButton({
  children,
  disabled,
  operation,
  pendingOperation,
  variant = "outline",
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  operation: Exclude<BrowserDataOperation, null>;
  pendingOperation: BrowserDataOperation;
  variant?: "outline" | "destructive";
  onClick: () => void;
}) {
  // [并发] pending 以操作名精确比较而非仅看非空，保证只有触发者显示旋转图标。
  // [契约] 图标与 aria 表达都由 pending 驱动，父级整体禁用另算，两者不合并。
  // [边界] 同一操作重复点击不会叠加状态，父级禁用已先行拦截。
  const pending = pendingOperation === operation;
  return (
    <Button
      type="button"
      size="lg"
      variant={variant}
      disabled={disabled || pendingOperation !== null}
      onClick={onClick}
      className="min-w-24"
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

// [契约] workspacePath 与 workspaceIdentity 由调用方注入，组件不自行读取路由或全局工作区。
// [契约] 证书开关是受控属性，默认 false；缺省回调为空异步函数，保证 Web 端不因未接线而抛错。
// [权衡] isWindowsDesktop 单独传入而非由 platform 推断，避免渲染进程猜宿主平台。
// [边界] 两个证书属性成对出现，只传值不传回调时开关可显示但改动无效果，需在调用方保证成对。
export function BrowserSettingsSection({
  isDesktop,
  isWindowsDesktop = false,
  workspacePath,
  workspaceIdentity,
  embeddedBrowserAllowInsecureCertificates = false,
  onEmbeddedBrowserAllowInsecureCertificatesChange = async () => {},
}: BrowserSettingsSectionProps) {
  // [资源] 文案全部走 intl 格式化，避免在组件内硬编码中英文。
  // [边界] 插值与摘要格式化共用同一 message 函数，保证行内摘要与提示文案口径一致。
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { pluginManagementService, skillsService } = useServices();
  // [契约] 只按插件标识在列表中查找实体，不订阅整个 plugins 数组，减少无关插件变更引发的重渲染。
  // [并发] 列表在 initialize 完成前为空，该选择器结果可能瞬时为 undefined，不可当作「未安装」结论。
  // [边界] 选择器返回对象引用，重渲染粒度取决于 store 是否重建实体，比较逻辑不要依赖引用相等。
  const browserUsePlugin = usePluginManagementStore((state) =>
    state.plugins.find((plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID),
  );
  const loading = usePluginManagementStore((state) => state.loading);
  const pluginError = usePluginManagementStore((state) => state.error);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const setPluginEnabled = usePluginManagementStore((state) => state.setEnabled);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const skillStoreWorkspacePath = useSkillStore((state) => state.workspacePath);
  const skillStoreWorkspaceIdentity = useSkillStore((state) => state.workspaceIdentity);
  // [并发] pendingOperation 是整组互斥锁，进入前置位、finally 中复位，任何提前返回都必须保证已复位。
  // [事务] 置位发生在平台调用之前，确保重复点击在第一个 await 之前就被拦住。
  // [失败路径] 平台方法缺失时函数先返回，不置位，避免按钮永久卡在忙碌态。
  // [边界] 组件卸载不取消原生请求，异步回调仍会执行，需由平台侧保证清理幂等。
  const [pendingOperation, setPendingOperation] = useState<BrowserDataOperation>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [lastImportResult, setLastImportResult] = useState<ChromeBrowserDataImportResult | null>(
    null,
  );
  // [契约] 身份键统一取 trim 后的 workspaceIdentity，空则退回 null，由下游决定是否退化到路径。
  // [边界] 身份里前后空白在不同入口可能不一致，这里统一收口，避免同一工作区被当作两个。
  // [权衡] 组件只做 trim 归一，identity 格式化由上层服务负责，不在渲染期拼字符串。
  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
  // [失败路径] 能力探测逐个检查 platform 上的导入与清理方法，任一缺失即判定原生动作不可用。
  // [契约] 该值同时决定数据区提示与两个按钮禁用，是唯一降级判据，不在别处重复判断。
  // [边界] isDesktop 为真但预加载未暴露方法（旧版壳）时同样降级，避免点击后抛类型错误。
  // [权衡] 判 typeof platform.importChromeBrowserData === "function" 而不比版本号，测试替身也能通过。
  const nativeActionsAvailable =
    isDesktop &&
    typeof platform.importChromeBrowserData === "function" &&
    typeof platform.clearEmbeddedBrowserData === "function";

  // [事务] 初始化以工作区为键：路径变化才触发插件列表拉取，避免空工作区发出无意义请求。
  // [并发] 调用不等待，失败由 store 自己落到 error 字段，再由本组件的 detail 展示。
  // [边界] 依赖里包含插件服务引用，服务实例更换（如重连）会重新初始化，这是预期而非抖动。
  // [失败路径] 初始化失败不阻塞渲染，开关显示为禁用并附带错误文案。
  useEffect(() => {
    if (!workspacePath) return;
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [initializePlugins, pluginManagementService, workspaceIdentity, workspacePath]);

  // [事务] 顺序固定：先失效延迟草稿会话，再刷新技能列表；反过来会拿到旧快照。
  // [契约] 失效原因固定为 settings-browser-use-plugin-enabled，供日志与诊断按来源过滤。
  // [并发] 技能刷新前校验技能仓库记录的工作区与本组件一致，避免在切换途中把结果写进新工作区。
  // [边界] 该回调只处理副作用，不负责弹成功提示，提示由调用方在确认状态后发出。
  const refreshAfterPluginChange = useCallback(async () => {
    await invalidateDeferredDraftSessionForSkillChange({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity ?? undefined,
      reason: "settings-browser-use-plugin-enabled",
    });
    if (
      workspacePath &&
      skillStoreWorkspacePath === workspacePath &&
      // [契约] 双字段比较（路径 + 归一身份）是避免跨工作区错刷的最小条件，缺一不可。
      // [并发] 比较与刷新之间没有锁，若期间再次切换工作区，由 store 自身的 workspacePath 守卫兜底。
      // [失败路径] 不一致时静默跳过刷新，不报错，因为这是并发切换的正常分支。
      skillStoreWorkspaceIdentity === normalizedWorkspaceIdentity
    ) {
      await refreshSkills(skillsService, normalizedWorkspaceIdentity ?? undefined);
    }
  }, [
    normalizedWorkspaceIdentity,
    refreshSkills,
    skillStoreWorkspaceIdentity,
    skillStoreWorkspacePath,
    skillsService,
    workspacePath,
  ]);

  // [事务] 单次切换是一条事务：平台写插件状态 → 回读确认 → 失效草稿 → 刷新技能 → 提示。
  // [失败路径] 平台异常时先标记诊断失败阶段再原样抛出，保持开关的受控值不被乐观改写。
  // [并发] 期间由 togglingPluginId 门控，重复点击被禁用，不会出现两次写入。
  // [边界] 回读结果与期望不一致时不刷新技能，说明写入未生效，避免提示与事实不符。
  const handleBrowserEnabledChange = useCallback(
    async (enabled: boolean) => {
      const trace = startUserAction({
        featureId: "settings.browser",
        action: "toggle_browser_use",
        trigger: "switch",
      });
      try {
        // [契约] 启停走 store 的动作而非直接调服务，保证加载与错误状态由 store 统一维护。
        // [失败路径] 该调用可能因插件未安装、清单校验失败、宿主拒绝而抛错，由外层统一记录。
        // [事务] 写入是远端事实，组件不缓存副本，成功后靠 store 里的实体重建驱动界面。
        // [并发] store 内部对同一插件标识的并发切换有保护，组件只需保证不重复发起。
        await setPluginEnabled(OFFICIAL_BROWSER_USE_PLUGIN_ID, enabled, pluginManagementService);
        const refreshedPlugin = usePluginManagementStore
          .getState()
          .plugins.find((plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID);
        // [契约] 只有回读到的启用态与期望一致，才认为切换成功，这是「平台结果」优先于「本地意图」。
        // [失败路径] 不一致时既不提示也不刷新技能，留给下一次进入设置页重新读真实状态。
        // [边界] 回读对象可能因列表重建而缺失，可选链保证缺失时同样走失败路径。
        if (refreshedPlugin?.enabled === enabled) {
          await refreshAfterPluginChange();
          toast(
            intl.formatMessage({
              id: enabled
                ? "settings.browser.control.enabledToast"
                : "settings.browser.control.disabledToast",
            }),
          );
        }
        trace.complete({
          resultSource: "platform_result",
          stateAfter: enabled ? "enabled" : "disabled",
        });
      } catch (error) {
        // [失败路径] 失败阶段固定为 plugin_update，便于在用户行为诊断里把插件写入失败与其他失败区分。
        // [契约] 记录后仍继续抛出，让上层既有提示也有错误边界，不在组件内吞掉。
        // [边界] 抛出不带敏感信息，错误对象原样传递，日志由上层统一脱敏。
        trace.fail({ failureStage: "plugin_update" });
        throw error;
      }
    },
    [intl, pluginManagementService, refreshAfterPluginChange, setPluginEnabled],
  );

  // [并发] 进入即置位导入，保证与清理操作互斥，且在第一帧就禁用其余按钮。
  // [事务] 结果是单次快照：导入完成即覆盖上一次结果，不做历史列表，避免长期持有用户数据摘要。
  // [失败路径] 平台抛错时只提示通用失败，不把原始错误文案暴露给用户，细节进日志。
  // [资源] 成功后提示固定 5 秒，行内同时保留摘要，用户离开设置页后不再回看。
  const handleImport = useCallback(async () => {
    // [失败路径] 方法缺失时直接返回，不置位、不提示，因为按钮本已因能力缺失而禁用。
    // [契约] 该守卫与 operationDisabled 同源，二者任一失效都会让用户点到必然失败的操作。
    // [边界] 保留可选的窄化写法，让类型系统确认后续调用时方法确实存在。
    if (!platform.importChromeBrowserData) return;
    setPendingOperation("import");
    const trace = startUserAction({
      featureId: "settings.browser",
      action: "import_browser_data",
      trigger: "button",
    });
    try {
      // [事务] 导入由平台串行读取 Chrome 的用户目录，组件只等待最终汇总，不感知中间进度。
      // [契约] 返回值是共享包定义的导入结果契约，行内摘要与提示都依赖它的字段。
      // [并发] 导入期间不禁用插件开关，但两个数据按钮互斥，避免同一原生目录被同时写。
      const result = await platform.importChromeBrowserData();
      trace.complete({ resultSource: "platform_result" });
      setLastImportResult(result);
      toast(formatImportSummary(result, intl.formatMessage), {
        durationMs: 5000,
      });
    // [失败路径] 导入失败必须落 error 日志并带错误消息字符串，便于定位是路径、权限还是解析失败。
    // [契约] 用户侧只看到统一失败文案，避免出现英文异常或本地路径。
    // [边界] 失败不写入上次导入结果，行内摘要保持上一次成功的内容不变。
    } catch (error) {
      trace.fail({ failureStage: "browser_data_import" });
      logger.error("[browser-settings] 导入 Chrome 数据失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.browser.import.failed" }));
    // [资源] 无论成功失败都在 finally 复位 pending，防止异常路径让按钮永久禁用。
    // [边界] 复位是整组唯一出口，不要在 try 内提前复位，否则会放开并发窗口。
    } finally {
      setPendingOperation(null);
    }
  }, [intl, platform]);

  // [事务] 清缓存与清全量共用一条链路，仅以 mode 区分动作名、pending 名与成功文案。
  // [并发] 置位使用与操作一致的枚举值，按钮的高亮与禁用都从同一状态推导。
  // [失败路径] 平台返回 success 为假时按失败提示，不因未抛异常就当成功。
  // [资源] 全量清理结束后由 finally 顺手关闭确认弹窗，避免弹窗停在已无意义的确认态。
  const handleClear = useCallback(
    async (mode: "cache" | "all") => {
      if (!platform.clearEmbeddedBrowserData) return;
      setPendingOperation(mode === "cache" ? "clear-cache" : "clear-all");
      const trace = startUserAction({
        featureId: "settings.browser",
        action: mode === "cache" ? "clear_cache" : "clear_all_data",
        trigger: "button",
      });
      try {
        // [失败路径] 清理可能抛错也可能返回 success 为假，两条失败路径都给用户同一个失败提示。
        // [契约] 成败判断以平台返回的 success 为准，不在前端推断目录是否存在。
        // [边界] 清理当前工作区的内置浏览器数据不影响外部 Chrome，提示文案需与作用域一致。
        const result = await platform.clearEmbeddedBrowserData(mode);
        trace.complete({ resultSource: "platform_result" });
        toast(
          intl.formatMessage({
            id: result.success
              ? mode === "cache"
                ? "settings.browser.clearCache.success"
                : "settings.browser.clearAll.success"
              : "settings.browser.clear.failed",
          }),
        );
      } catch (error) {
        trace.fail({ failureStage: "browser_data_clear" });
        logger.error("[browser-settings] 清理内置浏览器数据失败", {
          error: error instanceof Error ? error.message : String(error),
          mode,
        });
        toast(intl.formatMessage({ id: "settings.browser.clear.failed" }));
      // [资源] finally 同时复位 pending 与关闭确认弹窗，保证异常后界面回到可操作状态。
      // [并发] 关闭弹窗放在最后，防止弹窗在请求仍在进行时被重新打开造成二次提交。
      // [边界] 取消按钮只关弹窗不改 pending，因此这里的复位只服务真正发起过请求的路径。
      } finally {
        setPendingOperation(null);
        setConfirmClearAll(false);
      }
    },
    [intl, platform],
  );

  // [契约] 开关自身的忙碌态只认 togglingPluginId 与官方插件标识相等，与数据操作的 pending 完全解耦。
  // [并发] pluginTogglePending 与数据操作的 pending 各自独立，插件开关不被清理任务阻塞。
  // [边界] store 里该字段对其他插件切换也会变化，比较必须带标识，不能用非空判断。
  const pluginTogglePending = togglingPluginId === OFFICIAL_BROWSER_USE_PLUGIN_ID;
  // [权衡] pluginUnavailable 由 !workspacePath、loading 与 !browserUsePlugin 三项合并而成。
  // [失败路径] 合并成单个布尔会让提示不能区分原因，排查时需回到 store 的 error 与 loading。
  // [边界] 加载中短暂置为不可用，是防止在未知状态下误触发的保守选择。
  const pluginUnavailable = !workspacePath || loading || !browserUsePlugin;
  // [契约] 数据操作按钮的禁用只由原生能力推导，与插件开关状态无关。
  // [边界] Web 端始终为禁用并额外显示桌面限定提示，二者是同一判据的两种表达。
  // [权衡] 不把 pending 并入该值，忙碌态由子组件自行叠加，避免禁用原因混淆。
  const operationDisabled = !nativeActionsAvailable;

  // [契约] 渲染顺序即信息层级：控制开关 → 安全（仅桌面）→ 数据清理，导入入口跟随控制卡片。
  // [边界] 三块各自独立成段，任一能力缺失只影响自己那一段，不整体隐藏。
  // [资源] 弹窗常驻在树末，用 open 控制显隐，避免每次确认都重建焦点管理。
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.browser.control.title" })}
            description={intl.formatMessage({
              id: "settings.browser.control.description",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.browser.control.title",
                })}
                checked={browserUsePlugin?.enabled === true}
                disabled={pluginUnavailable || pluginTogglePending}
                onCheckedChange={(checked) => void handleBrowserEnabledChange(checked)}
              />
            }
            detail={
              pluginError ? (
                <div className="text-ui-base text-destructive">{pluginError}</div>
              ) : undefined
            }
          />
          {/* 导入登录状态是“开启内置浏览器控制”之后的配套动作，与开关同卡片表达先后关系；
              清除类破坏性操作仍留在“浏览器数据”分组。
              Windows App-Bound 导入链路暂未开放，先隐藏入口但保留底层实现和清理能力。*/}
          {!isWindowsDesktop ? (
            <SettingsRow
              label={intl.formatMessage({ id: "settings.browser.import.title" })}
              description={intl.formatMessage({
                id: "settings.browser.import.description",
              })}
              control={
                <BrowserOperationButton
                  operation="import"
                  pendingOperation={pendingOperation}
                  disabled={operationDisabled}
                  onClick={() => void handleImport()}
                >
                  {intl.formatMessage({ id: "settings.browser.import.action" })}
                </BrowserOperationButton>
              }
              detail={
                lastImportResult ? (
                  <div className="text-ui-base text-foreground-subtle">
                    {formatImportSummary(lastImportResult, intl.formatMessage)}
                  </div>
                ) : undefined
              }
            />
          ) : null}
        </SettingsGroupCard>
      </section>

      {/* 证书策略只在桌面端有内置浏览器时可配；改动由 main 在启动时装到 Session，需重启生效。 */}
      {isDesktop ? (
        <section className="space-y-3">
          <div className="text-ui-base font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "settings.browser.security.section" })}
          </div>
          <SettingsGroupCard>
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.embeddedBrowserAllowInsecureCertificates",
              })}
              description={intl.formatMessage({
                id: "settings.embeddedBrowserAllowInsecureCertificatesDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.embeddedBrowserAllowInsecureCertificates",
                  })}
                  checked={embeddedBrowserAllowInsecureCertificates}
                  onCheckedChange={(checked) => {
                    void onEmbeddedBrowserAllowInsecureCertificatesChange(checked);
                  }}
                />
              }
            />
          </SettingsGroupCard>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.data.section" })}
        </div>
        {!nativeActionsAvailable ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.browser.desktopOnly" })}
          </div>
        ) : null}
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.browser.clearCache.title",
            })}
            description={intl.formatMessage({
              id: "settings.browser.clearCache.description",
            })}
            control={
              <BrowserOperationButton
                operation="clear-cache"
                pendingOperation={pendingOperation}
                disabled={operationDisabled}
                onClick={() => void handleClear("cache")}
              >
                {intl.formatMessage({
                  id: "settings.browser.clearCache.action",
                })}
              </BrowserOperationButton>
            }
          />
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.browser.clearAll.title",
            })}
            description={intl.formatMessage({
              id: "settings.browser.clearAll.description",
            })}
            control={
              <BrowserOperationButton
                operation="clear-all"
                pendingOperation={pendingOperation}
                disabled={operationDisabled}
                variant="destructive"
                onClick={() => setConfirmClearAll(true)}
              >
                {intl.formatMessage({ id: "settings.browser.clearAll.action" })}
              </BrowserOperationButton>
            }
          />
        </SettingsGroupCard>
      </section>

      <AlertDialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmTitle",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmDescription",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingOperation !== null}>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pendingOperation !== null}
              onClick={(event) => {
                event.preventDefault();
                void handleClear("all");
              }}
            >
              {pendingOperation === "clear-all" ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmAction",
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
