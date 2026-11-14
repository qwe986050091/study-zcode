// CUA 画中画会话契约：只负责发布焦点与生命周期事件，不持有会话状态。
// INV：focus-changed 与其余生命周期事件必须分流到不同方法，不能合并成通用 publish。
// 改错后果：混发会让订阅方按错误顺序处理，导致画中画层级与主窗口焦点不一致。
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import { ServiceChannels } from "@zcode/shared";

import { createServiceDescriptor } from "../descriptors.js";

type FocusEvent = Extract<PipSessionEvent, { kind: "focus-changed" }>;
type LifecycleEvent = Exclude<PipSessionEvent, FocusEvent>;

export interface CuaPipSessionService {
  publishFocus(event: FocusEvent): Promise<void>;
  publishLifecycle(event: LifecycleEvent): Promise<void>;
  dispose(): void;
}

// 描述符绑定 CuaPipSession 频道，频道标识变化需同步更新所有订阅端。
export const ICuaPipSessionService = createServiceDescriptor<CuaPipSessionService>(
  ServiceChannels.CuaPipSession,
);
