// INV-01 资源即用即弃：守住位置 release 的幂等释放；改错故障：重复释放导致服务端句柄二次回收。
// INV-02 超时必结算：守住位置 图片与视频的十秒计时器；改错故障：资源永远卡在加载中。
// INV-03 迟到回调丢弃：守住位置 超时分支先清空地址；改错故障：超时后图片又被挂回。
// INV-04 单次结算：守住位置 监听器置空；改错故障：load 与 error 同时触发两次 resolve。
// INV-05 降级不抛：守住位置 顶层 catch；改错故障：营销资源失败打断整个对话框。
// INV-06 回退独立：守住位置 fallbackSrc 的单独 try；改错故障：回退图失败连带主资源也放弃。
// INV-07 桌面才打包：守住位置 desktop 判断；改错故障：Web 端尝试启动沙箱包。
// INV-08 计划容错：守住位置 非对象入参处理；改错故障：旧版字符串计划让格式化崩溃。
// INV-09 权益上限：守住位置 三十二条截断；改错故障：异常载荷遍历数万条拖慢首屏。
// INV-10 只统计按量：守住位置 meter 比较；改错故障：订阅制权益被算进额度。
// INV-11 数值有限：守住位置 Number.isFinite；改错故障：NaN 进入格式化显示为 NaN 单位。
// INV-12 语言兜底：守住位置 locale 分支；改错故障：非中文环境出现中文前缀。
// INV-13 时间单位：守住位置 秒乘一千；改错故障：有效期显示到 1970 年。
// INV-14 金额单位固定：守住位置 tokens 常量；改错故障：不同计划单位不一致。
// INV-15 空英雄可用：守住位置 empty 的默认释放；改错故障：调用方对空对象调用释放而报错。
// INV-16 事件名稳定：守住位置 replay 事件键；改错故障：宿主与英雄页事件对不上。
// INV-17 释放只一次：守住位置 released 标志；改错故障：关闭对话框时重复请求释放。
// INV-18 失败可观测：守住位置 降级日志；改错故障：线上只有空图，无法定位是网络还是格式问题。
//
// 模块职责：把营销视觉资源准备成对话框可直接渲染的英雄对象，并给出幂等释放函数。
// 状态所有权：无全局状态；图片、视频与沙箱租约都在单次准备内创建。
// 阅读顺序：图片准备 → 空英雄 → 计划格式化 → 主准备流程 → 降级。
import type { ICloudContentService } from "@zcode/services";
import type { MarketingAsset, MarketingVisual } from "@zcode/shared";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import { logger } from "@/logger.js";

// 图片走三态：加载成功、解码失败、十秒超时。
// 超时先清空地址再拒绝，避免迟到的回调把已释放的图挂回来。
//
export async function prepareMarketingImage(asset: MarketingAsset, service: ICloudContentService) {
  const src = await service.readPublishedMedia({ asset, kind: "image" });
  // 监听器在首次终态后置空，防止重复进入成功或失败分支。
  // 超时计时器与事件回调共用清理，保证只结算一次。
  //
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      img.src = "";
      reject(new Error("marketing_image_timeout"));
    }, 10_000);
    img.onload = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve();
    };
    // 解码失败统一成同一错误码，调用方只区分资源不可用。
    // 失败不抛到渲染层，由上层决定是否降级。
    //
    img.onerror = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      reject(new Error("marketing_image_decode"));
    };
    img.src = src;
  });
  return src;
}

export interface PreparedMarketingHero {
  hero: CloudDialogHero | null;
  release: () => Promise<void>;
}
// `empty()` 自带空操作 `release`：调用方不必先判空再释放。
// 每次调用返回新对象，避免共享可变引用。
//
const empty = (): PreparedMarketingHero => ({ hero: null, release: async () => {} });

// 计划参数可能来自旧版协议，非对象一律按空计划处理。
// 入参原样展开，只在计划字段上覆盖计算后的值。
//
function heroData(args: Record<string, unknown> | undefined, locale: string) {
  const raw = args?.zcode_plan;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return args ?? {};
  const plan = raw as Record<string, unknown>;
  const entitlements = Array.isArray(plan.entitlements) ? plan.entitlements : [];
  const benefits: string[] = [];
  let maximum = 0;
  // `entitlements` 只取前 32 条：避免异常载荷拖慢格式化。
  // 只累计 `meter === "model_usage"` 的权益：其余类型不进 `maximum`。
  //
  for (const rawEntry of entitlements.slice(0, 32)) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    if (entry.meter !== "model_usage") continue;
    const units =
      typeof entry.grant_units === "number" && Number.isFinite(entry.grant_units)
        ? entry.grant_units
        : 0;
    maximum = Math.max(maximum, units);
    if (typeof entry.show_name === "string")
      benefits.push(
        `${entry.show_name} · ${new Intl.NumberFormat(locale).format(units)} ${typeof entry.unit_type === "string" ? entry.unit_type : ""}`,
      );
  }
  return {
    ...args,
    // 金额按语言格式化，单位固定为 tokens。
    // 截止时间从秒换算为本地时间，缺失时返回空串由上层隐藏。
    //
    planName: typeof plan.name === "string" ? plan.name : "",
    amountValue: new Intl.NumberFormat(locale).format(maximum),
    amountUnit: "tokens",
    benefits,
    endsAtLabel:
      typeof plan.ends_at === "number" ? new Date(plan.ends_at * 1000).toLocaleString(locale) : "",
    endsAtPrefix: locale === "zh-CN" ? "有效期至" : "Valid until",
    replayLabel: locale === "zh-CN" ? "重播" : "Replay",
  };
}

// 视觉缺失或服务未就绪时返回空英雄，不抛错。
// 服务是可选依赖：没有云服务就不尝试任何资源准备。
//
export async function prepareMarketingHero(
  visual: MarketingVisual | null | undefined,
  service: ICloudContentService | undefined,
  locale: "zh-CN" | "en-US",
  desktop: boolean,
): Promise<PreparedMarketingHero> {
  if (!visual || !service) return empty();
  // 按类型取回退资源：打包与视频才有回退图。
  // 回退资源失败只记日志，不影响主资源继续加载。
  //
  const fallback =
    visual.type === "bundle"
      ? visual.bundle.fallback
      : visual.type === "video"
        ? visual.video.fallback
        : null;
  let fallbackSrc: string | undefined;
  if (fallback) {
    try {
      fallbackSrc = await prepareMarketingImage(fallback, service);
    } catch {
      /* 主资源仍可独立成功。 */
    }
  }
  try {
    if (visual.type === "image") {
      const src = await prepareMarketingImage(visual.image.default, service);
      const darkSrc = visual.image.dark
        ? await prepareMarketingImage(visual.image.dark, service).catch(() => undefined)
        : undefined;
      return { hero: { type: "image", src, darkSrc, alt: "" }, release: async () => {} };
    }
    if (visual.type === "video") {
      const src = await service.readPublishedMedia({ asset: visual.video.src, kind: "video" });
      const video = document.createElement("video");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          video.onloadeddata = null;
          video.onerror = null;
          video.removeAttribute("src");
          video.load();
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("marketing_video_timeout"));
        }, 10_000);
        video.onloadeddata = () => {
          cleanup();
          resolve();
        };
        video.onerror = () => {
          cleanup();
          reject(new Error("marketing_video_decode"));
        };
        video.preload = "auto";
        video.muted = true;
        video.src = src;
      });
      return {
        hero: {
          type: "video",
          src,
          poster: fallbackSrc ?? "",
          muted: true,
          autoplay: true,
          loop: true,
        },
        release: async () => {},
      };
    }
    if (!desktop) throw new Error("marketing_web_bundle_unavailable");
    const bundle = {
      format: "zip" as const,
      url: visual.bundle.bundle.src,
      sha256: visual.bundle.bundle.sha256,
      entry: visual.bundle.entry,
    };
    const lease = await service.prepare({ bundle });
    let released = false;
    return {
      hero: {
        type: "interactive_bundle",
        runtime: "zcode-hero-sandbox-v1",
        bundle,
        resolvedUrl: lease.url,
        viewport: { aspectRatio: "4:3" },
        data: heroData(visual.args, locale),
        events: { replay: "replay" },
        ...(fallbackSrc ? { fallback: { type: "image" as const, src: fallbackSrc, alt: "" } } : {}),
      },
      release: async () => {
        if (!released) {
          released = true;
          await service.release({ leaseId: lease.leaseId });
        }
      },
    };
  // 任何失败都降级为回退图或空英雄，绝不向上抛。
  // 降级路径记录原因码，便于区分网络与解码问题。
  //
  } catch (error) {
    logger.warn("[marketing-touch] hero degraded", {
      reason: error instanceof Error ? error.message : "resource_failed",
    });
    return {
      hero: fallbackSrc ? { type: "image", src: fallbackSrc, alt: "" } : null,
      release: async () => {},
    };
  }
}
