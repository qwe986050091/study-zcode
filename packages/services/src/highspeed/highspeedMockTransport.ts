import type {
  HighspeedCardUsage,
  HighspeedDrawResponse,
  HighspeedMockScenario,
} from "@zcode/shared";
import type { HighspeedServiceTransport } from "./highspeedCardService.js";

// E2E 用的高速通道假传输层：不发起任何网络请求，按场景返回可预期的抽卡结果。
// 它实现 HighspeedServiceTransport，使上层卡片服务在测试中无需感知真实网关，
// 同时把冷却与有效期做成常量，方便断言时间相关的 UI 行为。
const MOCK_DRAW_COOLDOWN_MS = 2 * 60_000;
// 卡有效期与线上保持一致量级，测试里用 now 注入即可精确构造过期场景。
const MOCK_CARD_LIFETIME_MS = 5 * 60_000;

// 工厂：scenario 决定返回哪种边界情况，now 与 delay 可注入以获得确定性时序；
// 默认值对应最常用的「立即命中」路径，调用方不传参数也能直接跑通。
export function createHighspeedMockTransport(options?: {
  scenario?: HighspeedMockScenario;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}): HighspeedServiceTransport {
// 默认命中场景：大多数用例只关心成功路径，边界场景由测试显式点名。
  const scenario = options?.scenario ?? "hit-fast";
// 时钟可替换，过期与冷却断言不依赖真实时间流逝。
  const now = options?.now ?? Date.now;
// [契约] delay 由 options 注入：测试可传零延迟跳过等待，默认实现用 setTimeout 模拟网络耗时。
// 超时场景刻意放大延迟，让调用方的超时分支先于响应触发。
  const delay =
    options?.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  return {
// 抽卡：先按场景模拟耗时，再基于同一时间戳组装响应，
// 返回值结构与真实网关一致（code/msg/data），调用方无需区分 mock 与真实实现。
    async draw(request): Promise<HighspeedDrawResponse> {
// 该场景故意晚于调用方超时阈值返回，用于验证超时后不会重复发卡。
      if (scenario === "hit-after-timeout") await delay(1200);
      else await delay(80);
// 单次取时并复用，保证 issued_at、expires_at 与 next_draw_at 的相对关系稳定。
      const current = now();
// 未命中时 card 为 null，但仍返回下一次可抽时间，UI 据此展示冷却倒计时。
      if (scenario === "miss") {
        return {
          code: 0,
          msg: "success",
          data: { card: null, next_draw_at: current + MOCK_DRAW_COOLDOWN_MS },
        };
      }
// 该场景返回属于其他任务的卡，用于验证调用方按 task_id 做归属校验。
      const taskId =
        scenario === "existing-foreign-task-card" ? "mock-foreign-task" : request.task_id;
// 过期场景把有效期设为当前时间之前 1ms，避免依赖时钟精度。
      const expiresAt = scenario === "expired-card" ? current - 1 : current + MOCK_CARD_LIFETIME_MS;
      return {
        code: 0,
        msg: "success",
        data: {
          card: {
            card_id: `hsc_mock_${current}`,
            task_id: taskId,
            provider: request.provider,
            model:
              scenario === "hit-invalid-model"
                ? "E2E-HIGHSPEED-MODEL-NOT-IN-REGISTRY"
                : request.model,
            issued_at: current,
            expires_at: expiresAt,
          },
          next_draw_at: current + MOCK_DRAW_COOLDOWN_MS,
        },
      };
    },
// 用量查询：返回固定数值而非读取真实额度，避免测试消耗配额；
// 字段与线上响应对齐，便于断言用量展示与阈值告警。
    async healthy(cardId): Promise<HighspeedCardUsage> {
      return {
        cardId,
// 固定示例用量：token 与时长组合保持自洽，便于快照测试稳定。
        promptTokens: 12_000,
        completionTokens: 8_000,
        durationSeconds: 90,
      };
    },
  };
}
