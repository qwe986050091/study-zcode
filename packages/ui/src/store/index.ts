/**
 * Zustand Store —— 全局状态管理
 *
 * 需要跨窗口同步的状态通过 BroadcastService 广播。
 * 广播频道前缀 "state:" 表示状态同步类消息。
 */
// INV-01 全局只能存在由 createZCodeStore 产出的 store，任何模块不得另建第二份；守住位置：工厂末尾返回处；改错故障：两个 Provider 读到不同 theme 与 locale，界面外观和文案互相打架。
// INV-02 每个字段只有唯一 setter 可写，组件只经 selector 读；守住位置：ZCodeState 上成对的字段与 set 方法声明；改错故障：绕过 setter 的写入不落存储，刷新后偏好回退到旧值。
// INV-03 持久化字段必须先写存储再 set，保持存储为准的顺序；守住位置：setTheme、setLocale、setUiFontSizePx 分支；改错故障：写入失败时内存与磁盘分叉，重启后设置跳变。
// INV-04 只有 BROADCAST_FIELDS 中的五个字段跨窗口广播，新增同步字段须同时改集合与联合类型；守住位置：BROADCAST_FIELDS 定义；改错故障：字段只在本窗口生效，多窗口显示不一致。
// INV-05 应用广播期间 applyingBroadcast 必须为真且最终复位；守住位置：入站消息回调的 try 与 finally；改错故障：回声广播形成回环，窗口互刷造成卡顿。
// INV-06 远端字段变更必须回调本地 setter，不得直接改 state；守住位置：广播字段分发链；改错故障：存储与 DOM 副作用不执行，其他窗口主题只变一半。
// INV-07 authSessionSeq 仅在未登录转为登录时自增，连接额外 provider 不得自增；守住位置：setUser 的写回分支；改错故障：误判为重新登录，额度重置提示重复播放。
// INV-08 登录请求 id 由闭包计数器单调分配，后续动作只按 id 续接；守住位置：loginEntryRequestSeq 与 requestLoginEntry；改错故障：迟到的旧请求关掉新入口，登录弹窗闪退。
// INV-09 清空登录请求必须校验 id，不匹配时返回空对象而非清空；守住位置：clearLoginEntryRequest 的提前返回；改错故障：旧请求的回调清掉当前入口，用户点击无反应。
// INV-10 登录尝试状态只能由匹配 id 的调用推进，未知 id 一律忽略；守住位置：markLoginEntryAttemptStatus 的入口守卫；改错故障：并发登录把状态改回 waiting，按钮卡在加载态。
// INV-11 额度重置的 ui、observations、autoPlayed 三张表按 source 分桶且不持久化；守住位置：slice 动作展开处；改错故障：跨账号残留他人额度提示，刷新后又出现已消费提示。
// INV-12 自动播放走 reservation 两段式，展示前 reserve、确认后 commit、失配必须 release；守住位置：三个额度动作；改错故障：同一 used_at 重复播放，或 reservation 泄漏导致此后永不播放。
// INV-13 已播记录合并分支先于 state: 前缀判断执行；守住位置：入站回调首段；改错故障：多窗口同时播放同一提示，用户被重复打扰。
// INV-14 文件导航偏好按去空白的 workspace key 存储，空 key 直接丢弃；守住位置：setFileManagerNavigationOpen 归一化分支；改错故障：空 key 污染存储，展开状态在工程之间串味。
// INV-15 代码预览字号在任何写入口都夹到 12 至 20，读写共用同一规则；守住位置：加载函数与 setCodePreviewSettings；改错故障：手改存储绕过钳制，设置面板与预览显示不一致。
// INV-16 interfaceMode 只影响展示细节，不得改写 Agent 权限或执行能力；守住位置：接口字段注释与 setInterfaceMode；改错故障：切到 office 模式后疑似功能被禁用，用户以为丢了能力。
// INV-17 每次切换主题都要先解绑旧系统监听，保证最多一份订阅；守住位置：syncSystemThemeListener 开头清理段；改错故障：监听叠加，切系统主题时 DOM class 抖动。
// INV-18 构造期不得引用尚未初始化的局部变量，回调一律靠闭包后置赋值；守住位置：syncSystemThemeListener 的初值与其后重赋值；改错故障：早期带副作用调用抛错，首次启动白屏。
// INV-19 导出面只增不改：ZCodeState、createZCodeStore、ZCodeStore 与双类型 re-export 路径保持稳定；守住位置：文件末尾导出与类型转发段；改错故障：外部包按旧路径引用失败，构建直接中断。
//
// 本文件是 packages/ui 的唯一状态出口：字段声明、持久化读写与跨窗口广播都在此处收敛。
// 建议阅读顺序：ZCodeState 字段与归属注释 → 各 setter 的写入顺序 → 订阅广播 → 构造期副作用。
// 要新增跨窗口字段时，先扩 BROADCAST_FIELDS 与联合类型，再补分发分支，最后补默认值与重置路径。
import { create } from "zustand";
import type { IBroadcastService, BroadcastMessage } from "@zcode/services";
import type { OAuthProviderId, UserInfo } from "@zcode/shared";
import type { CodingPlanResetType } from "@zcode/shared";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  applyCodingPlanQuotaResetAutoPlayedBroadcast,
  createCodingPlanQuotaResetStoreActions,
  parseCodingPlanQuotaResetAutoPlayedBroadcastMessage,
  type CodingPlanQuotaResetAutomaticObservations,
  type CodingPlanQuotaResetAutoPlayReservation,
  type CodingPlanQuotaResetAutoPlayReservationAttempt,
  type CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  applyUiFontSizePx,
  loadUiFontSizePx,
  normalizeUiFontSizePx,
  UI_FONT_SIZE_STORAGE_KEY,
} from "@/lib/uiFontSize.js";
import {
  isTaskNotificationEnabled,
  isTaskNotificationSoundPreferenceEnabled,
  persistTaskNotificationEnabled,
  persistTaskNotificationSoundEnabled,
} from "@/lib/taskNotificationPreferences.js";
import type { Theme } from "../useTheme.js";
import { applyTheme, normalizeThemePreference, resolveTheme } from "../useTheme.js";

import {
  INTERFACE_MODE_STORAGE_KEY,
  normalizeInterfaceMode,
  type InterfaceMode,
} from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";

export type LoginEntryPurpose = "app-login";

// v4 重构：类型与默认值下沉到 @/lib/codePreviewSettings.ts，
// 让纯展示组件不依赖 store；这里保留 re-export 兼容既有 import 路径。
export type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
export { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

export type LoginEntryAttemptStatus =
  | "requested"
  | "waiting"
  | "succeeded"
  | "cancelled"
  | "failed";

// 一次登录尝试的身份由 id 承载，providerId 与 purpose 只是发起瞬间的快照；
// 状态机按 requested、waiting、succeeded、cancelled、failed 推进，外部只能推进后四态。
export interface LoginEntryAttempt {
  id: number;
  providerId?: OAuthProviderId;
  purpose?: LoginEntryPurpose;
  status: LoginEntryAttemptStatus;
}

// 存储键集中在此，读取与写入两侧共用同一常量，避免字符串手写漂移；
// 改键名等价于丢弃用户已有偏好，必须配迁移逻辑而非直接改名。
const CODE_PREVIEW_SETTINGS_KEY = "zcode-code-preview-settings";
const PERFORMANCE_MODE_STORAGE_KEY = "zcode-performance-mode";
export const FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY =
  "zcode-file-manager-navigation-preferences";

// 读取侧做防御式解析：非对象、数组、非布尔值一律丢弃，坏数据降级为空表；
// 解析抛错时同样回退，保证存储被污染也不阻断启动流程。
function loadFileManagerNavigationPreferences(): Record<string, boolean> {
  try {
    const raw = readSafeLocalStorage(FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY);
    // [失败路径] 键缺失与空串同样回退空表，让调用方按默认展开而不是拿到 undefined
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    // [权衡] 逐项过滤后重建普通对象，丢弃原型链与多余键，不保留存储里的原引用
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] =>
          entry[0].trim().length > 0 && typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

// 先铺默认值再覆盖已存字段，缺失键不会变成 undefined 而击穿下游读取；
// fontSizePx 在此已钳制一次，与写入侧保持同一区间，避免两侧规则分叉。
function loadCodePreviewSettings(): CodePreviewSettings {
  try {
    const raw = readSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_CODE_PREVIEW_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<CodePreviewSettings>;
    return {
      ...DEFAULT_CODE_PREVIEW_SETTINGS,
      ...parsed,
      fontSizePx:
        typeof parsed.fontSizePx === "number"
          ? Math.min(20, Math.max(12, Math.round(parsed.fontSizePx)))
          : DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx,
    };
  } catch {
    return DEFAULT_CODE_PREVIEW_SETTINGS;
  }
}

function loadPerformanceMode(): boolean {
  // [权衡] 只认字面量 true，历史写入的 1 与 on 一律按关闭处理，避免旧值被误判为开启
  return readSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY) === "true";
}

// ============================================================================
// State 定义
// ============================================================================

// 这个接口是 store 的唯一契约：字段、setter 与归属注释必须整体阅读，不可拆开理解；
// 新增字段要同步补齐默认值、setter、广播集合（若跨窗口）与重置路径，缺一即产生悬挂状态。
export interface ZCodeState {
  /** 展示详情偏好，不改变 Agent 权限或执行能力。 */
  interfaceMode: InterfaceMode;
  setInterfaceMode: (mode: InterfaceMode) => void;

  /** 当前主题 */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  /** 当前语言 */
  locale: string;
  setLocale: (locale: string) => void;

  /** 代码预览设置 */
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) => void;

  /** 各 workspace 的文件导航显隐偏好；缺席时默认展开。 */
  fileManagerNavigationOpenByWorkspace: Record<string, boolean>;
  setFileManagerNavigationOpen: (workspaceKey: string, open: boolean) => void;

  /** UI 根 rem 字号（px） */
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;

  /** 是否启用性能模式 */
  performanceMode: boolean;
  setPerformanceMode: (enabled: boolean) => void;

  /** 是否启用任务通知（桌面通知；提示音由子开关控制） */
  notificationEnabled: boolean;
  setNotificationEnabled: (enabled: boolean) => void;

  /** 是否启用任务通知声音（依附于任务通知总开关） */
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (enabled: boolean) => void;

  /** 当前用户信息 */
  user: UserInfo | null;
  /** 用户由未登录进入登录态时递增；连接额外 provider 不会误判为重新登录。 */
  authSessionSeq: number;
  setUser: (user: UserInfo | null) => void;

  /** 启动阶段是否仍在恢复 OAuth 登录态 */
  isRestoringOAuthSession: boolean;
  setIsRestoringOAuthSession: (restoring: boolean) => void;

  /** OAuth 回调错误（Root 层写入，统一登录入口读取） */
  oauthError: string | null;
  setOAuthError: (error: string | null) => void;
  oauthPollingActive: boolean;
  setOAuthPollingActive: (active: boolean) => void;
  oauthSuccessSeq: number;
  lastOAuthSuccessProvider: OAuthProviderId | null;
  markOAuthSuccess: (provider?: OAuthProviderId) => void;
  apiKeyLoginSuccessSeq: number;
  lastApiKeyLoginModel: string | null;
  markApiKeyLoginSuccess: (preferredModel?: string | null) => void;
  /** 请求打开统一登录入口，可携带需要自动发起登录/连接的 provider */
  loginEntryRequest: {
    id: number;
    providerId?: OAuthProviderId;
    purpose?: LoginEntryPurpose;
  } | null;
  /** 当前统一登录尝试；购买等后续动作通过 id 只续接自己发起的 OAuth。 */
  loginEntryAttempt: LoginEntryAttempt | null;
  requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => number;
  clearLoginEntryRequest: (requestId?: number) => void;
  markLoginEntryAttemptStatus: (
    requestId: number,
    status: Exclude<LoginEntryAttemptStatus, "requested">,
  ) => void;

  /** Coding Plan 额度重置 UI 状态；entry/观察记录只在当前窗口内共享，不持久化。 */
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  /** 自动/运营完成首次被观察时所属的鉴权会话，用于区分同会话后挂载和重新登录。 */
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  /** 自动完成提示"多窗口只播一次"的已播 used_at 记录；窗口内存态，可被广播合并。 */
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
  /** 写入服务端 status / 手动 use 对账后的状态；entry 为 null 表示清空该类型。 */
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  /** Composer 展示前申请临时 reservation；此阶段不写 played。 */
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** 组件仍有效且即将展示时提交 reservation、played 与广播。 */
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  /** 组件失效时释放尚未 commit 的 reservation。 */
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;

  /** 手动请求打开 onboarding 弹窗 */
  newUserOnboardingOpen: boolean;
  setNewUserOnboardingOpen: (open: boolean) => void;
  onboardingDialogRequested: boolean | "migration";
  requestOnboardingDialog: (entry?: "migration") => void;
  clearOnboardingDialogRequest: () => void;
}

// ============================================================================
// 需要广播的字段 —— 只有这些字段的变更会发送给其他窗口
// ============================================================================

// 集合决定什么值得跨窗口，与下方 BroadcastField 联合类型必须字面一致；
// 增删成员时两处同改，否则订阅循环里的类型断言会漏发或错发字段。
const BROADCAST_FIELDS = new Set([
  "theme",
  "locale",
  "uiFontSizePx",
  "interfaceMode",
  "notificationEnabled",
]);

type BroadcastField =
  | "theme"
  | "locale"
  | "uiFontSizePx"
  | "interfaceMode"
  // 任务通知开关跨窗口同步：角标是应用级表面，A 窗口关通知而 B 窗口仍上报未读时，
  // 主进程 max 聚合会让任务栏/托盘继续亮，设置与提醒状态错位。
  | "notificationEnabled";

/** 广播频道名前缀 */
// 频道前缀是状态同步与业务消息的分界线，入站解析按前缀分流；
// 前缀一旦变更，已部署窗口的旧消息将无法解析，解析侧需同时兼容新旧格式。
const STATE_CHANNEL_PREFIX = "state:";

// ============================================================================
// Store 创建工厂
// ============================================================================

/**
 * 创建 Zustand store，连接广播服务实现跨窗口状态同步
 *
 * @param broadcastService - 广播服务。Desktop 走 RPC，Web 可传 no-op 实现
 */
// 工厂每次调用产出一份独立 store，广播服务以参数注入而非模块级单例；
// 桌面走 RPC、Web 可传空实现，因此这里不得假设广播一定产生副作用。
export function createZCodeStore(
  broadcastService: IBroadcastService,
  options: {
    initialIsRestoringOAuthSession?: boolean;
  } = {},
) {
  /** 标记：正在应用来自广播的更新，此时不再重复广播（防止循环） */
  // 防回环标记刻意留在闭包而非 store，避免它的变更自身触发订阅广播；
  // 它与 loginEntryRequestSeq 同属私有可变状态，任何 slice 都不应读取或改写。
  let applyingBroadcast = false;
  let loginEntryRequestSeq = 0;
  let cleanupSystemThemeListener: (() => void) | null = null;
  let syncSystemThemeListener = (_theme: Theme) => {};

  // 构造时一次性求值 fontFamily，存储偏好与实际字体由此刻定格，
  // 这里只放纯读取，不写存储、不改 DOM，否则会与构造收尾的副作用互相抢先。
  const useStore = create<ZCodeState>()((set, get) => ({
    interfaceMode: normalizeInterfaceMode(readSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY)),
    setInterfaceMode: (mode) => {
      const interfaceMode = normalizeInterfaceMode(mode);
      if (get().interfaceMode !== interfaceMode) {
        logger.debug("[InterfaceMode] 切换界面模式", {
          interfaceMode,
          source: applyingBroadcast ? "broadcast" : "local",
        });
      }
      writeSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY, interfaceMode);
      set({ interfaceMode });
    },
    // 默认主题统一收敛到 Zai dark，避免首次启动时 store 与其他主题入口表现不一致。
    // 仍然优先尊重 localStorage 中已保存的用户选择，不覆盖已有偏好。
    // 默认收敛到 zai-dark，但已存偏好优先，这两者的顺序不可颠倒；
    // 归一化函数兜住历史脏值，其返回值才是后续系统监听与 DOM 同步的依据。
    theme: normalizeThemePreference((readSafeLocalStorage("zcode-theme") as Theme) || "zai-dark"),
    // 顺序固定为：归一化、写存储、同步系统监听、应用 DOM、set；
    // 任一步提前中断都会让内存与 DOM 分叉，切主题看起来只变一半。
    setTheme: (theme: Theme) => {
      const normalizedTheme = normalizeThemePreference(theme);
      // [失败路径] 存储写失败不阻断后续监听与 DOM 同步，代价是下次启动回落到旧主题
      writeSafeLocalStorage("zcode-theme", normalizedTheme);
      syncSystemThemeListener(normalizedTheme);
      applyTheme(normalizedTheme);

      set({ theme: normalizedTheme });
    },

    locale: readSafeLocalStorage("zcode-locale") || "zh-CN",
    setLocale: (locale: string) => {
      writeSafeLocalStorage("zcode-locale", locale);
      set({ locale });
    },

    codePreviewSettings: loadCodePreviewSettings(),
    setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) =>
      set((state) => {
        const next = {
          ...state.codePreviewSettings,
          ...patch,
          fontSizePx:
            typeof patch.fontSizePx === "number"
              ? Math.min(20, Math.max(12, Math.round(patch.fontSizePx)))
              : state.codePreviewSettings.fontSizePx,
        };
        writeSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY, JSON.stringify(next));
        return { codePreviewSettings: next };
      }),

    fileManagerNavigationOpenByWorkspace: loadFileManagerNavigationPreferences(),
    setFileManagerNavigationOpen: (workspaceKey, open) => {
      const normalizedWorkspaceKey = workspaceKey.trim();
      if (!normalizedWorkspaceKey) return;
      set((state) => {
        const next = {
          ...state.fileManagerNavigationOpenByWorkspace,
          [normalizedWorkspaceKey]: open,
        };
        writeSafeLocalStorage(
          FILE_MANAGER_NAVIGATION_PREFERENCES_STORAGE_KEY,
          JSON.stringify(next),
        );
        return { fileManagerNavigationOpenByWorkspace: next };
      });
    },

    uiFontSizePx: loadUiFontSizePx(),
    setUiFontSizePx: (fontSizePx: number) => {
      const normalizedFontSizePx = normalizeUiFontSizePx(fontSizePx);
      writeSafeLocalStorage(UI_FONT_SIZE_STORAGE_KEY, String(normalizedFontSizePx));
      applyUiFontSizePx(normalizedFontSizePx);
      set({ uiFontSizePx: normalizedFontSizePx });
    },

    performanceMode: loadPerformanceMode(),
    setPerformanceMode: (enabled: boolean) => {
      writeSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY, enabled ? "true" : "false");
      set({ performanceMode: enabled });
    },

    notificationEnabled: isTaskNotificationEnabled(),
    setNotificationEnabled: (enabled: boolean) => {
      persistTaskNotificationEnabled(enabled);
      set({ notificationEnabled: enabled });
    },

    notificationSoundEnabled: isTaskNotificationSoundPreferenceEnabled(),
    setNotificationSoundEnabled: (enabled: boolean) => {
      persistTaskNotificationSoundEnabled(enabled);
      set({ notificationSoundEnabled: enabled });
    },

    user: null,
    authSessionSeq: 0,
    // 只有从未登录进入登录态才推进 authSessionSeq，用于识别真正的重新登录；
    // 连接额外 provider 或刷新用户资料不得自增，否则额度提示会被重新播放。
    setUser: (user: UserInfo | null) =>
      set((state) => ({
        user,
        authSessionSeq:
          state.user === null && user !== null ? state.authSessionSeq + 1 : state.authSessionSeq,
      })),

    isRestoringOAuthSession: options.initialIsRestoringOAuthSession ?? false,
    setIsRestoringOAuthSession: (restoring: boolean) => set({ isRestoringOAuthSession: restoring }),

    oauthError: null,
    setOAuthError: (error: string | null) => set({ oauthError: error }),
    oauthPollingActive: false,
    setOAuthPollingActive: (active: boolean) => set({ oauthPollingActive: active }),
    oauthSuccessSeq: 0,
    lastOAuthSuccessProvider: null,
    markOAuthSuccess: (provider?: OAuthProviderId) =>
      set((state) => ({
        oauthSuccessSeq: state.oauthSuccessSeq + 1,
        lastOAuthSuccessProvider: provider ?? state.lastOAuthSuccessProvider,
      })),
    apiKeyLoginSuccessSeq: 0,
    lastApiKeyLoginModel: null,
    markApiKeyLoginSuccess: (preferredModel?: string | null) =>
      set((state) => ({
        apiKeyLoginSuccessSeq: state.apiKeyLoginSuccessSeq + 1,
        lastApiKeyLoginModel: preferredModel?.trim() || null,
      })),
    loginEntryRequest: null,
    loginEntryAttempt: null,
    // id 由闭包计数器分配，保证同一窗口内单调递增且绝不复用；
    // 请求与尝试必须在同一次 set 中写入，拆成两次会让订阅者看到半成品状态。
    requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => {
      const id = ++loginEntryRequestSeq;
      const attempt: LoginEntryAttempt = {
        id,
        providerId,
        purpose,
        status: "requested",
      };
      set({
        loginEntryRequest: {
          id,
          providerId,
          purpose,
        },
        loginEntryAttempt: attempt,
      });
      return id;
    },
    // 带 id 时只清自己发起的请求，不匹配就返回空对象保留现状；
    // 不带 id 视为强制清理，仅供登出等语义明确的场景调用。
    clearLoginEntryRequest: (requestId?: number) =>
      set((state) => {
        if (requestId !== undefined && state.loginEntryRequest?.id !== requestId) {
          return {};
        }
        return { loginEntryRequest: null };
      }),
    // 推进前先比对 id，避免迟到的回调覆盖新一轮登录尝试；
    // 写回时保留其余字段再覆盖 status，防止 provider 信息在推进过程中丢失。
    markLoginEntryAttemptStatus: (requestId, status) =>
      set((state) => {
        if (state.loginEntryAttempt?.id !== requestId) {
          return {};
        }
        return {
          loginEntryAttempt: {
            ...state.loginEntryAttempt,
            status,
          },
        };
      }),

    codingPlanQuotaResetUiBySource: {},
    codingPlanQuotaResetAutomaticObservationsBySource: {},
    codingPlanQuotaResetAutoPlayedBySource: {},
    // 额度重置的状态与动作由独立 slice 提供，这里只做展开合并，不重复实现；
    // 注入的 readState 与 writeState 是 slice 唯一读写通道，换成裸 set 会破坏广播合并语义。
    ...createCodingPlanQuotaResetStoreActions({
      broadcastService,
      readState: get,
      writeState: (updater) => set((state) => updater(state)),
    }),

    newUserOnboardingOpen: false,
    setNewUserOnboardingOpen: (open) => set({ newUserOnboardingOpen: open }),
    onboardingDialogRequested: false,
    requestOnboardingDialog: (entry) => set({ onboardingDialogRequested: entry ?? true }),
    clearOnboardingDialogRequest: () => set({ onboardingDialogRequested: false }),
  }));

  // 每次调用先解绑旧监听，保证任意时刻最多存在一份系统主题订阅；
  // 仅 system 主题才注册，其余主题直接返回，避免无谓的系统配色订阅。
  syncSystemThemeListener = (theme: Theme) => {
    cleanupSystemThemeListener?.();
    cleanupSystemThemeListener = null;

    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (useStore.getState().theme !== "system") {
        return;
      }

      // system 模式需要持续订阅系统亮暗变化，不能只在切换到 system 的瞬间应用一次。
      // 否则用户后续切系统主题时，DOM 上的 dark class 不会同步更新，看起来就像“跟随系统失效”。
      applyTheme("system");
    };

    // [失败路径] 新旧监听 API 二选一，只注册一份回调，避免切换配色时同一处理函数触发两次
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      cleanupSystemThemeListener = () => {
        mediaQuery.removeEventListener("change", handleSystemThemeChange);
      };
      return;
    }

    // 某些 Electron / Chromium 组合仍然只支持旧版 MediaQueryList listener API。
    // 如果这里只调用 addEventListener，system 模式切系统主题时会完全收不到通知。
    mediaQuery.addListener(handleSystemThemeChange);
    cleanupSystemThemeListener = () => {
      mediaQuery.removeListener(handleSystemThemeChange);
    };
  };

  // Zustand v5 的 setState 在 replace=true/false 上使用了不同重载，
  // 之前直接包一层并透传 replace，会在严格类型下落到互不兼容的签名分支。
  // 这里改成订阅状态变化后再广播，只比较真正需要跨窗口同步的字段，逻辑更直观，也避免重载冲突。
  // 用订阅比较代替包装 setState，绕开 Zustand v5 在 replace 重载上的签名冲突；
  // 只逐字段比对广播白名单，值相等直接跳过，减少无效跨窗口消息。
  useStore.subscribe((state, prevState) => {
    if (applyingBroadcast) {
      return;
    }

    for (const field of BROADCAST_FIELDS as Set<BroadcastField>) {
      if (state[field] === prevState[field]) {
        continue;
      }

      broadcastService.send({
        channel: `${STATE_CHANNEL_PREFIX}${field}`,
        payload: state[field],
      });
    }
  });

  // 监听来自其他窗口的广播
  // 入站消息先处理额度自动播放，再判断频道前缀，两件事互不阻塞；
  // 广播字段白名单二次校验，未知频道静默丢弃，避免旧版本字段引发越界写入。
  broadcastService.onMessage((msg: BroadcastMessage) => {
    // 自动完成"多窗口只播一次"。其他窗口广播已播 used_at 后，本窗口合并
    // played 记录并收起正在播放的同 used_at 提示；本地回声已在解析阶段被忽略。
    // 解析失败返回空值，据此区分是否为本类消息，非本类继续走状态同步；
    // 命中后只合并已播记录并收起同 used_at 提示，不再向外重复广播。
    const autoPlayed = parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(msg);
    if (autoPlayed) {
      useStore.setState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, autoPlayed));
      return;
    }

    if (!msg.channel.startsWith(STATE_CHANNEL_PREFIX)) return;

    const field = msg.channel.slice(STATE_CHANNEL_PREFIX.length) as BroadcastField;
    if (!BROADCAST_FIELDS.has(field)) return;

    applyingBroadcast = true;
    try {
      // 调用对应的 setter，确保副作用（localStorage、DOM）也执行
      const state = useStore.getState();
      if (field === "theme" && typeof msg.payload === "string") {
        state.setTheme(msg.payload as Theme);
      } else if (field === "locale" && typeof msg.payload === "string") {
        state.setLocale(msg.payload);
      } else if (
        field === "interfaceMode" &&
        (msg.payload === "office" || msg.payload === "coding")
      ) {
        state.setInterfaceMode(normalizeInterfaceMode(msg.payload));
      } else if (field === "uiFontSizePx" && typeof msg.payload === "number") {
        state.setUiFontSizePx(msg.payload);
      } else if (field === "notificationEnabled" && typeof msg.payload === "boolean") {
        state.setNotificationEnabled(msg.payload);
      }
    } finally {
      applyingBroadcast = false;
    }
  });

  // 构造收尾按固定顺序执行：订阅系统主题、应用主题、应用字号、同步 dark class；
  // 这些副作用必须在返回前完成，确保首个渲染时 DOM 已与 store 一致。
  syncSystemThemeListener(useStore.getState().theme);
  applyTheme(useStore.getState().theme);
  applyUiFontSizePx(useStore.getState().uiFontSizePx);
  document.documentElement.classList.toggle(
    "dark",
    resolveTheme(useStore.getState().theme) === "dark",
  );

  return useStore;
}

// 对外只暴露工厂返回类型，闭包变量与 slice 内部形状都不外泄；
// 消费方按此类型取 selector，内部字段调整不会波及调用点。
export type ZCodeStore = ReturnType<typeof createZCodeStore>;
