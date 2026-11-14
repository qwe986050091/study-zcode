// 营销触达服务：负责向远端拉取活动快照并回传用户的确认/取消操作。
// 服务自身不缓存活动内容，只维护「账号身份 → 请求作用域」的对应关系，
// 让 UI 能在账号切换后识别并丢弃过期结果；网络与序列化细节交给 apiClient。
// 所有对外参数与响应都经 zod 校验，避免远端字段漂移悄悄进入 UI。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseMarketingTouchResponse, type ApiClient } from "@zcode/shared";
import { readApiJson } from "#src/providers/api/apiJson.js";
import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";

// 只允许受支持的两个 locale，未知语言直接拒绝，防止请求头被注入任意值。
const localeSchema = z.enum(["zh-CN", "en-US"]);
// 序号属于本次服务进程启动，不能随组件、账号或服务实例重建而归零。
// 计数器放在模块级而非服务实例内，保证同一进程的多次 query 序号单调递增；
// 远端可用它识别乱序/重复请求，实例重建不会让序号回退。
let bootRequestSeq = 0;
// 上报入参在这里收口：scope 必须是合法 UUID，campaignId 限长，
// actionType 只允许 confirm/cancel，避免自由文本被远端当成未知动作。
const reportSchema = z.object({
  locale: localeSchema,
  scope: z.string().uuid(),
  campaignId: z.string().trim().min(1).max(128),
  actionType: z.enum(["confirm", "cancel"]),
});

// 依赖全部由调用方注入（token、deviceId、baseUrl、版本号），服务本身不读取全局状态，
// 这样同一份实现可以跑在桌面、Web 与测试桩里。
export function createMarketingTouchService(options: {
  apiClient: ApiClient;
  getToken: () => Promise<string | null | undefined>;
  getDeviceMid: () => string | undefined;
  baseUrl: string;
  appVersion: string;
  onSnapshot?: (snapshot: ReturnType<typeof parseMarketingTouchResponse>) => void;
}): IMarketingTouchService {
// 记住上一次使用的 token，仅用于检测账号切换，不参与任何请求。
  let previousToken: string | undefined;
  let scope = randomUUID();
// 每次请求都重新读取 token：它可能在排队期间被刷新或登出；
// 这里统一生成 scope 与请求头，避免各方法各自拼装造成不一致。
  async function context(locale: "zh-CN" | "en-US") {
    const token = (await options.getToken())?.trim() || "";
// token 变化即视为账号身份变化，必须换新的 scope；
// 旧 scope 发出的响应随后会被 query/report 的比对拦下。
    if (previousToken !== token) {
      previousToken = token;
      scope = randomUUID();
    }
// [边界] device 必须先过 z.string().uuid()：缺失或非法直接抛错，不能发空 X-Device-Mid 让远端按空值匹配用户。
    const device = z.string().uuid().parse(options.getDeviceMid());
    return {
      scope,
      headers: {
        "X-Device-Mid": device,
        "X-Client-Language": localeSchema.parse(locale),
        "X-ZCode-App-Version": options.appVersion,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
  }
  return {
    async query({ locale }) {
      const identity = await context(locale);
      const url = new URL("/api/v1/marketing/touch", options.baseUrl);
// 每次 query 消耗一个新序号用于远端去重；序号在请求发出前自增，失败也不回退。
      url.searchParams.set("seq", String(bootRequestSeq++));
      const response = await readApiJson<unknown>(options.apiClient, url.href, {
        method: "GET",
        headers: identity.headers,
        timeoutMs: 15_000,
        redirect: "error",
      });
// 请求期间账号可能被切换：若当前 scope 已变，说明返回的是上一个账号的数据，
// 必须丢弃而不是交给 UI，否则会把 A 账号的活动展示给 B 账号。
      if ((await context(locale)).scope !== identity.scope)
        throw new Error("marketing_identity_changed");
      const snapshot = parseMarketingTouchResponse(response);
      options.onSnapshot?.(snapshot);
      return { ...snapshot, scope: identity.scope };
    },
    async report(input) {
      const parsed = reportSchema.parse(input);
      const identity = await context(parsed.locale);
      // 领取期间账号可能已切换；禁止把旧操作用新凭据上报，也不向 UI 暴露凭据。
// 同理，上报前再次校验 scope，防止用新凭据提交旧账号领取期间的点击。
      if (identity.scope !== parsed.scope) throw new Error("marketing_identity_changed");
      const response = await readApiJson<unknown>(
        options.apiClient,
        new URL("/api/v1/marketing/touch/action", options.baseUrl).href,
        {
          method: "POST",
          headers: { ...identity.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: parsed.campaignId, action_type: parsed.actionType }),
          timeoutMs: 15_000,
          redirect: "error",
        },
      );
// 远端成功约定为 code=0；其它结构一律视为失败并抛出，调用方据此提示重试。
      z.object({ code: z.literal(0) }).parse(response);
    },
  };
}
