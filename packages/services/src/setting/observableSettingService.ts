// 职责边界：只在 Host 进程内为既有设置服务附加提交后通知，不会扩大 RPC 契约，也不新增持久化路径。
// INV：事件只在 base.update 成功返回后发布，更新失败时不得触达任何监听者。
// INV：空 patch 视为无效更新，不发布事件；监听者按注册顺序同步调用。
// 改错后果：提前或重复发布事件，会让 Host 内缓存与渲染层依据尚未落盘的设置做决策。
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "./setting.js";

export interface SettingServiceUpdatedEvent {
  readonly keys: readonly (keyof AppSettings)[];
}

export interface ObservableSettingService extends ISettingService {
  onDidUpdate(listener: (event: SettingServiceUpdatedEvent) => void): () => void;
}

/**
 * 为 Host 内的设置服务增加提交后通知，不扩大 Setting RPC 契约。
 * 底层 update 失败时不会发布事件。
 */
export function createObservableSettingService(base: ISettingService): ObservableSettingService {
  const listeners = new Set<(event: SettingServiceUpdatedEvent) => void>();
  return {
    ...base,
    onDidUpdate(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async update(patch, expectedAccountSettings): Promise<void> {
      if (expectedAccountSettings) await base.update(patch, expectedAccountSettings);
      else await base.update(patch);
      const keys = Object.freeze(Object.keys(patch) as (keyof AppSettings)[]);
      if (keys.length === 0) return;
      const event = Object.freeze({ keys });
      for (const listener of listeners) listener(event);
    },
  };
}
