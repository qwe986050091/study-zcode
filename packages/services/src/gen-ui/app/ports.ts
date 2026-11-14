// Gen UI 状态存储端口：抽象宿主侧 widget 状态的读写与变更广播，宿主实现持久化，UI 侧只依赖本契约。
// INV：get 未命中返回 null 而不是抛错；list 只返回指定 scope 内的条目，混用会导致跨 scope 的状态泄漏。
// INV：onChanged 是唯一变更通知通道，set 成功后必须触发对应 GenUiStateChange，否则界面会长期停留旧状态。
// 维护提示：target 与 scope 的构造规则由 shared 定义，此处不重复校验，协议变更需同步 GenUiStateTarget。
import type { Event } from "@zcode/rpc";
import type {
  GenUiScope,
  GenUiStateChange,
  GenUiStateEntry,
  GenUiStateTarget,
  GenUiWidgetState,
} from "@zcode/shared/gen-ui";
export interface GenUiStateStorage {
  get(target: GenUiStateTarget): Promise<GenUiWidgetState | null>;
  set(target: GenUiStateTarget, state: GenUiWidgetState): Promise<void>;
  list(scope: GenUiScope): Promise<GenUiStateEntry[]>;
  onChanged: Event<GenUiStateChange>;
// dispose 释放宿主订阅与缓存，调用后实例不可复用；重复调用的幂等由实现方兜住，契约不做额外保证。
  dispose(): void;
}
