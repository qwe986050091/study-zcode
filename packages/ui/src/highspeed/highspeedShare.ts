// INV-01 分享资格以未取整倍率判定，边界严格大于 1.2：守住位置 isHighspeedShareEligible；改错故障 展示层四舍五入后资格来回跳。
// INV-02 资格要求输出量、耗时与两档吞吐全部为有限正数：守住位置 前置校验；改错故障 零耗时导致除零或虚假分享。
// INV-03 节省耗时优先取指标自带值，缺失才回退估算：守住位置 节省耗时解析；改错故障 新旧数据口径不一致。
// INV-04 加速倍率保留一位小数且不小于零：守住位置 倍率函数；改错故障 展示出现负倍率。
// INV-05 节省比例限制在 0 到 99：守住位置 比例函数；改错故障 出现 100% 或负数。
// INV-06 通知载荷必须携带毫秒事实值，不写秒级字段：守住位置 通知构造；改错故障 渲染侧由秒重建倍率产生边界低估。
// INV-07 载荷中的计数与时长都要夹到非负：守住位置 载荷字段；改错故障 负数进入看板。
// INV-08 通知去重键固定，过期时间为一天：守住位置 通知字段；改错故障 多张分享卡堆叠。
// INV-09 载荷判定必须兼容历史秒级字段：守住位置 载荷类型守卫；改错故障 旧通知无法还原。
// INV-10 还原指标时毫秒优先、秒级乘千兜底：守住位置 指标还原；改错故障 兼容读取出现千倍误差。
// INV-11 合成吞吐只为通过正数校验，不参与倍率计算：守住位置 还原函数的吞吐字段；改错故障 倍率随合成值漂移。
// INV-12 复制文本失败必须向上抛，由调用方提示：守住位置 文本复制函数；改错故障 静默失败让用户以为已复制。
// INV-13 图片剪贴板不可用时直接抛错：守住位置 默认图片写入器；改错故障 生成图片但无法粘贴。
// INV-14 图片中的动态文本必须转义：守住位置 转义函数；改错故障 标签或引号破坏图片结构。
// INV-15 光栅化倍率至少为 2，且跟随设备像素比：守住位置 导出倍率；改错故障 高分屏图片模糊。
// INV-16 临时对象地址必须在结束时释放：守住位置 收尾分支；改错故障 反复复制泄漏内存。
// INV-17 圆角只由矢量图形自带，画布不做二次裁剪：守住位置 绘制流程；改错故障 四角出现错位浅色弧线。
// INV-18 主题判定无文档环境时按暗色兜底：守住位置 主题检测；改错故障 导出图片与界面配色相反。
//
// 模块职责：计算高速生成的节省指标，并把分享卡渲染为可复制的文本、通知载荷与图片。
// 状态所有权：无持久状态；指标来自调用方，图片与通知都在一次调用内生成。
// 阅读顺序：先看资格与三个派生指标，再读通知载荷的构造与还原，最后看图形拼装与光栅化。
import type { GlobalNoticeEnvelope } from "@/global-notice/globalNoticeStore.js";
import type { HighspeedShareMetrics } from "@/highspeed/highspeedTurnStore.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";

export const HIGHSPEED_NOTICE_DISMISS_COOLDOWN_MS = 24 * 60 * 60_000;
export const HIGHSPEED_NOTICE_AUTO_CLOSE_MS = 24 * 60 * 60_000;
export const MIN_HIGHSPEED_SHARE_SPEEDUP = 1.2;
/**
 * 左下角分享卡通知的 payload。指标一律以毫秒事实携带（与发布门禁 isHighspeedShareEligible 同精度），
 * 秒级展示值由渲染侧派生；durationSeconds/savedDurationSeconds 只是 ≤24h 内遗留持久化通知的兼容读取字段。
 */
export interface HighspeedShareNoticePayload extends Record<string, unknown> {
  cardId: string;
  tokenUsage: number;
  durationMs?: number;
  savedDurationMs?: number;
  /** @deprecated 旧版秒级取整字段，只读兼容，不再写入。 */
  durationSeconds?: number;
  /** @deprecated 旧版秒级取整字段，只读兼容，不再写入。 */
  savedDurationSeconds?: number;
}

export async function copyHighspeedShareText(
  text: string,
  writeText: (value: string) => Promise<void> = async (value) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("text clipboard is unavailable");
    }
    await navigator.clipboard.writeText(value);
  },
): Promise<void> {
  await writeText(text);
}

/** 紧凑时长：>=60s 显示分钟，否则秒；加速标签与导出图片共用，跨语言保持一致的紧凑单位。 */
export function formatHighspeedDurationShort(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}min`;
  return `${totalSeconds}s`;
}

function resolveHighspeedSavedDurationMs(metrics: HighspeedShareMetrics): number {
  return metrics.savedDurationMs ?? calculateHighspeedSavedDurationMs(metrics);
}

/**
 * 分享入口只对完整且可信的卡级数据开放，避免低收益或缺少耗时的结果生成误导性分享卡。
 * 这里使用未四舍五入的倍率，确保 1.2x 边界稳定，展示层的格式化不会影响资格判断。
 */
// isHighspeedShareEligible 先排除 outputTokens/durationMs/regularTps/highspeedTps 任一非有限或 <= 0，再要求 savedDurationMs 有限且 >= 0；倍率取 (durationMs + savedDurationMs) / durationMs，与 MIN_HIGHSPEED_SHARE_SPEEDUP 用严格 > 比较，保证 1.2 倍整不通过，且不取整以免边界漂移。
export function isHighspeedShareEligible(metrics: HighspeedShareMetrics): boolean {
  if (
    !Number.isFinite(metrics.outputTokens) ||
    metrics.outputTokens <= 0 ||
    !Number.isFinite(metrics.durationMs) ||
    metrics.durationMs <= 0 ||
    !Number.isFinite(metrics.regularTps) ||
    metrics.regularTps <= 0 ||
    !Number.isFinite(metrics.highspeedTps) ||
    metrics.highspeedTps <= 0
  ) {
    return false;
  }
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  if (!Number.isFinite(savedDurationMs) || savedDurationMs < 0) return false;
  const overallSpeedup = (metrics.durationMs + savedDurationMs) / metrics.durationMs;
  return Number.isFinite(overallSpeedup) && overallSpeedup > MIN_HIGHSPEED_SHARE_SPEEDUP;
}

/** 优先使用 CLI 真实耗时；旧消息回退到工具 20% / 模型 80% 估算。 */
// highspeedSpeedup 把 durationMs 取 Math.max(metrics.durationMs, 1) 防除零，savedDurationMs 走 resolveHighspeedSavedDurationMs；结果 Math.round(ratio * 10) / 10 保留一位小数并 Math.max(0, ...) 夹到非负，只用于展示、不参与 isHighspeedShareEligible。
export function highspeedSpeedup(metrics: HighspeedShareMetrics): number {
  const durationMs = Math.max(metrics.durationMs, 1);
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  return Math.max(0, Math.round(((durationMs + savedDurationMs) / durationMs) * 10) / 10);
}

/** 时间节省比例（%），按真实拆分或兼容的 20/80 口径计算。 */
// highspeedSavedPercent 允许 durationMs 为 0，regularDurationMs = durationMs + savedDurationMs，<= 0 时返回 0；否则 Math.round(savedDurationMs / regularDurationMs * 100) 再用 Math.min(99, ...) 压上限，避免出现“全部节省”的表述。
export function highspeedSavedPercent(metrics: HighspeedShareMetrics): number {
  const durationMs = Math.max(metrics.durationMs, 0);
  const savedDurationMs = resolveHighspeedSavedDurationMs(metrics);
  const regularDurationMs = durationMs + savedDurationMs;
  if (regularDurationMs <= 0) return 0;
  return Math.max(0, Math.min(99, Math.round((savedDurationMs / regularDurationMs) * 100)));
}

const HIGHSPEED_CARD_IMAGE_SIZE = { width: 436, height: 304 } as const;

export interface HighspeedShareImageLabels {
  benefit: string;
  standardSpeed: string;
  speedSummary: string;
  lessWaiting: string;
  imageSummary: string;
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&apos;",
        '"': "&quot;",
      })[character] ?? character,
  );
}

/** 与 useTheme 的 applyTheme 一致：根节点 dark class 即暗色；无 DOM 时按暗色品牌卡兜底。 */
function detectHighspeedCardDarkTheme(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement?.classList?.contains("dark") ?? true;
}

/** 将统计区渲染为独立 SVG，复制图片时不会把弹框底部文案和按钮带进去。 */
// copyHighspeedCardImage 先汇总 savedDurationMs、倍率与比例供文案和 SVG 共用，labels 缺省用内置英文保证导出图可独立传播；画布取 HIGHSPEED_CARD_IMAGE_SIZE，配色走 detectHighspeedCardDarkTheme，轨道填充宽度按 savedDurationMs / regularDuration 计算，所有动态文本经 escapeXml 后才拼进 SVG。
export async function copyHighspeedCardImage(
  metrics: HighspeedShareMetrics,
  writeImage: (blob: Blob) => Promise<void> = async (blob) => {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof ClipboardItem === "undefined"
    ) {
      throw new Error("image clipboard is unavailable");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  },
  labels?: HighspeedShareImageLabels,
): Promise<void> {
  const savedSeconds = Math.max(0, Math.round(resolveHighspeedSavedDurationMs(metrics) / 1_000));
  const speedup = highspeedSpeedup(metrics);
  const savedPercent = highspeedSavedPercent(metrics);
  const imageLabels: HighspeedShareImageLabels = labels ?? {
    benefit: "ZCode & Coding Plan Exclusive Benefits",
    standardSpeed: "standard generation speed",
    speedSummary: `HighSpeed · ${formatHighspeedDurationShort(metrics.durationMs)}`,
    lessWaiting: `${savedPercent}% less waiting`,
    imageSummary: `${Math.floor(metrics.outputTokens).toLocaleString()} tokens · ${savedSeconds}s saved`,
  };
  const { width, height } = HIGHSPEED_CARD_IMAGE_SIZE;
  const fontStack = "Geist,-apple-system,'Segoe UI',Arial,sans-serif";
  // 深浅模式分别对应设计稿暗/亮两个变体的配色。
  const dark = detectHighspeedCardDarkTheme();
  const palette = dark
    ? {
        bg: "#101010",
        cardStroke: "",
        titleText: "#acacac",
        tagStroke: "rgba(255,255,255,0.16)",
        tagFillTop: "rgba(255,255,255,0.06)",
        tagFillBottom: "rgba(153,153,153,0.06)",
        title: "#ffffff",
        subtitle: "#b1b1b1",
        divider: "#ffffff",
        summary: "#8f8f8f",
        track: "#2b2b2b",
      }
    : {
        bg: "#ffffff",
        cardStroke: ` stroke="#0d0d0d" stroke-opacity="0.1"`,
        titleText: "#5c5c5c",
        tagStroke: "rgba(0,0,0,0.16)",
        tagFillTop: "rgba(0,0,0,0.06)",
        tagFillBottom: "rgba(0,0,0,0.04)",
        title: "#0d0d0d",
        subtitle: "#5c5c5c",
        divider: "#0d0d0d",
        summary: "#5c5c5c",
        track: "rgba(0,0,0,0.08)",
      };
  // 复制出的图片与弹窗一致：整条深色轨道 + 三段渐变填充到“相对耗时”占比，落点用细绿指针标记。
  const meterX = 24;
  const meterY = 186;
  const meterW = width - meterX * 2;
  const meterH = 8;
  const fillW = Math.max(0, meterW * Math.max(0, Math.min(1, (100 - savedPercent) / 100)));
  const markerX = meterX + fillW;
  const meter = `<rect x="${meterX}" y="${meterY}" width="${meterW}" height="${meterH}" rx="1" fill="${palette.track}"/><rect x="${meterX}" y="${meterY}" width="${fillW.toFixed(2)}" height="${meterH}" rx="1" fill="url(#hs-meter)"/><rect x="${(markerX - 1).toFixed(2)}" y="${meterY - 6}" width="2" height="20" rx="1" fill="#01c34b"/>`;
  // Title 行与弹窗一致（Figma 6403:11193）：Z logo 方块 + 权益文案 + HighSpeed 胶囊；logo 用矢量近似。
  const titleRow = `<rect x="24" y="27" width="16" height="16" rx="3.2" fill="#2d2d2d" stroke="rgba(255,255,255,0.12)" stroke-width="0.53"/><text x="32" y="39" text-anchor="middle" fill="#ffffff" font-family="${fontStack}" font-size="11" font-weight="700">Z</text><text x="48" y="39" fill="${palette.titleText}" font-family="${fontStack}" font-size="12">${escapeXml(imageLabels.benefit)}</text><rect x="286" y="25.5" width="69" height="19" rx="9.5" fill="url(#hs-tag)" stroke="${palette.tagStroke}" stroke-width="0.4"/><text x="320.5" y="38" text-anchor="middle" fill="${palette.titleText}" font-family="${fontStack}" font-size="11">HighSpeed</text>`;
  const defs = `<defs><linearGradient id="hs-tag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.tagFillTop}"/><stop offset="1" stop-color="${palette.tagFillBottom}"/></linearGradient><linearGradient id="hs-meter" x1="${meterX}" y1="0" x2="${markerX.toFixed(2)}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e05048"/><stop offset="0.52" stop-color="#e8b348"/><stop offset="1" stop-color="#34b769"/></linearGradient></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<rect width="${width}" height="${height}" fill="${palette.bg}"${palette.cardStroke}/>${titleRow}<text x="32" y="118" fill="${palette.title}" font-family="${fontStack}"><tspan font-size="52" font-weight="500" letter-spacing="-1">${speedup}</tspan><tspan font-size="24" font-weight="500">x</tspan><tspan dx="8" font-size="12" font-weight="300" fill="${palette.subtitle}">${escapeXml(imageLabels.standardSpeed)}</tspan></text><line x1="24" y1="140" x2="412" y2="140" stroke="${palette.divider}" stroke-opacity="0.1"/><path d="M28.7 154 24.6 160.5h3l-1.5 6.5 8-8h-4l1.5-5z" fill="#00a640"/><text x="44" y="165" fill="#00a640" font-family="${fontStack}" font-size="13" font-weight="500">${escapeXml(imageLabels.speedSummary)}</text><text x="412" y="164" text-anchor="end" fill="#00a640" font-family="${fontStack}" font-size="11" font-weight="500">${escapeXml(imageLabels.lessWaiting)}</text>${meter}<text x="24" y="270" fill="${palette.summary}" font-family="${fontStack}" font-size="12">${escapeXml(imageLabels.imageSummary)}</text></svg>`;
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  // Chromium 的图片剪贴板不接受 image/svg+xml；桌面端必须先光栅化为 PNG。
  if (
    typeof Image === "undefined" ||
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    !URL.createObjectURL
  ) {
    await writeImage(svgBlob);
    return;
  }
  const image = new Image();
  // Bug 根因：过去在 canvas 上再用 clip 裁第二层圆角——SVG 位图边缘（拉伸后模糊）与
  // 矢量 clip 边缘（锐利）在四角叠加，即使几何对齐也会残留浅色弧线错位。圆角透明角
  // 由 SVG rect rx 自带；正确做法是让浏览器按导出尺寸直接光栅化 SVG（矢量超采样，
  // viewBox 保持逻辑坐标），drawImage 1:1 落位，canvas 不做任何二次裁剪。
  const exportScale = Math.max(
    2,
    Math.ceil(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
  );
  const objectUrl = URL.createObjectURL(
    new Blob(
      [
        svg.replace(
          `width="${width}" height="${height}" viewBox=`,
          `width="${width * exportScale}" height="${height * exportScale}" viewBox=`,
        ),
      ],
      { type: "image/svg+xml" },
    ),
  );
  try {
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = HIGHSPEED_CARD_IMAGE_SIZE.width * exportScale;
        canvas.height = HIGHSPEED_CARD_IMAGE_SIZE.height * exportScale;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("canvas context unavailable"));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("canvas export failed"))),
          "image/png",
        );
      };
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = objectUrl;
    });
    await writeImage(pngBlob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// buildHighspeedShareNotice 的 now 取 params.now ?? Date.now()，payload 只写 Math.max(0, ...) 的 outputTokens/durationMs/savedDurationMs 毫秒事实值；noticeId 为 highspeed-share:${cardId}:${now}，dedupeKey 固定 "highspeed-share:latest" 保证同一时刻只保留一张卡，expiresAt 与 cooldownMs 都为一天。
export function buildHighspeedShareNotice(params: {
  cardId: string;
  metrics: HighspeedShareMetrics;
  now?: number;
}): GlobalNoticeEnvelope {
  const now = params.now ?? Date.now();
  // 分享卡展示完整 Turn 的实际工作时长；节省时间优先使用 CLI 持久化的高速模型耗时，
  // 普通 provider 的降级/重试耗时不会进入 Highspeed 节省计算。
  // Bug 根因：过去只写 ceil(duration)/round(saved) 的秒级字段，渲染侧由秒重建倍率会在
  // (1.2, ~1.25] 边界带系统性低估（6100ms/1225ms 实际 1.2008x → 8/7≈1.14x）而隐藏 View。
  // 这里原样携带发布门禁使用的毫秒值、不做任何取整，渲染侧复检才不可能与门禁相左（spec §9）。
  const payload: HighspeedShareNoticePayload = {
    cardId: params.cardId,
    tokenUsage: Math.max(0, Math.floor(params.metrics.outputTokens)),
    durationMs: Math.max(0, params.metrics.durationMs),
    savedDurationMs: Math.max(0, resolveHighspeedSavedDurationMs(params.metrics)),
  };
  return {
    noticeId: `highspeed-share:${params.cardId}:${now}`,
    dedupeKey: "highspeed-share:latest",
    type: "highspeed-share",
    schemaVersion: 1,
    scope: "user",
    priority: "normal",
    interruptPolicy: "passive",
    createdAt: now,
    expiresAt: now + HIGHSPEED_NOTICE_AUTO_CLOSE_MS,
    payload,
    actions: [],
    dismissPolicy: { kind: "cooldown", cooldownMs: HIGHSPEED_NOTICE_DISMISS_COOLDOWN_MS },
    persistencePolicy: "latest-only",
    source: "highspeed",
    revision: now,
  };
}

// isHighspeedShareNoticePayload 是类型守卫，只要求 typeof payload.cardId === "string"、typeof tokenUsage === "number" 且 durationMs 或 durationSeconds 至少一个是 number；不校验数值合法性，秒级字段只为兼容旧通知保留。
export function isHighspeedShareNoticePayload(
  payload: Record<string, unknown>,
): payload is HighspeedShareNoticePayload {
  return (
    typeof payload.cardId === "string" &&
    typeof payload.tokenUsage === "number" &&
    (typeof payload.durationMs === "number" || typeof payload.durationSeconds === "number")
  );
}

/**
 * 由通知 payload 还原分享指标：毫秒字段优先（与发布门禁同精度，复检结果必然一致）；
 * 遗留秒级 payload 按 ×1000 兜底。TPS 只为满足 isHighspeedShareEligible 的正数校验而合成，
 * 倍率与节省比例全部由 durationMs + savedDurationMs 计算，不依赖合成 TPS。
 */
// resolveHighspeedShareNoticeMetrics 用 payload.durationMs ?? (durationSeconds ?? 0) * 1_000，saved 同理；合成 regularTps 取 Math.max(1, tokenUsage / Math.max((durationMs + savedDurationMs) / 1_000, 1)) 只为通过资格校验，倍率与比例仍由两个时长字段计算。
export function resolveHighspeedShareNoticeMetrics(
  payload: HighspeedShareNoticePayload,
): HighspeedShareMetrics {
  const durationMs = payload.durationMs ?? (payload.durationSeconds ?? 0) * 1_000;
  const savedDurationMs = payload.savedDurationMs ?? (payload.savedDurationSeconds ?? 0) * 1_000;
  return {
    outputTokens: payload.tokenUsage,
    durationMs,
    regularTps: Math.max(
      1,
      payload.tokenUsage / Math.max((durationMs + savedDurationMs) / 1_000, 1),
    ),
    highspeedTps: Math.max(1, payload.tokenUsage / Math.max(durationMs / 1_000, 1)),
    savedDurationMs,
  };
}
