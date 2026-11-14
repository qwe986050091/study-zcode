// INV-01 容量上限固定：守住位置 常量；改错故障 内存环无限增长。
// INV-02 容量下限为一：守住位置 最大值包裹；改错故障 零容量导致写入即丢。
// INV-03 非法容量退回首值：守住位置 有限数判断；改错故障 传入无穷时环失效。
// INV-04 超出容量从头裁剪：守住位置 裁剪调用；改错故障 旧事件不淘汰。
// INV-05 负载深拷贝：守住位置 属性复制；改错故障 调用方后续修改污染记录。
// INV-06 读取也拷贝：守住位置 逐条复制；改错故障 外部修改历史条目。
// INV-07 序号单调递增：守住位置 自增计数；改错故障 排序依据重复。
// INV-08 抑制名单去重：守住位置 集合构造；改错故障 重复项放大内存。
// INV-09 抑制名单类型校验：守住位置 类型判断；改错故障 非字符串混入名单。
// INV-10 名单长度上限：守住位置 数组长度判断；改错故障 超长名单拖慢匹配。
// INV-11 空名与超长名拒绝：守住位置 裁剪后判断；改错故障 空串抑制所有事件。
// INV-12 平台归类三档：守住位置 分支判断；改错故障 未知平台被算作 Linux。
// INV-13 指标默认值一：守住位置 空值合并；改错故障 无值事件统计为零。
// INV-14 属性统一转字符串：守住位置 逐项转换；改错故障 上报类型不一致。
// INV-15 未定义属性被跳过：守住位置 空值判断；改错故障 出现未定义字样。
// INV-16 先记录再发送：守住位置 调用顺序；改错故障 发送失败时丢失证据。
// INV-17 抑制只跳过发送：守住位置 条件分支；改错故障 抑制后连记录也没有。
// INV-18 共享环按门禁创建：守住位置 启用函数；改错故障 生产环境也常驻捕获。
//
// 模块职责：main 进程的 ARMS 自定义事件捕获环与上报分发。
// 状态所有权：环实例由 sharedFinalArmsCustomEventE2E 共享变量持有，其余均为函数内局部状态。
// 阅读顺序：先看环的创建与容量，再看负载构造，最后看分发与抑制。
import type {
  ArmsCustomEventPayload,
  ArmsRumEnv,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  FinalArmsCustomEventPayload,
} from "@zcode/shared";

export const MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES = 200;
const MAX_SUPPRESSED_EVENT_NAMES = 100;
const MAX_EVENT_NAME_LENGTH = 256;

export interface FinalArmsCustomEventE2EController {
  record(payload: FinalArmsCustomEventPayload): void;
  read(): FinalArmsCustomEventE2EEntry[];
  clear(): void;
  configure(request: ConfigureFinalArmsCustomEventE2ERequest): void;
  shouldSuppress(eventName: string): boolean;
}

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function cloneFinalPayload(payload: FinalArmsCustomEventPayload): FinalArmsCustomEventPayload {
  return {
    ...payload,
    properties: { ...payload.properties },
  };
}

function normalizeSuppressedEventNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUPPRESSED_EVENT_NAMES) {
    throw new Error("suppressedEventNames 必须是最多 100 项的字符串数组");
  }
  const names = value.map((item) => {
    if (typeof item !== "string") {
      throw new Error("suppressedEventNames 只能包含字符串");
    }
    const normalized = item.trim();
    if (!normalized || normalized.length > MAX_EVENT_NAME_LENGTH) {
      throw new Error("suppressedEventNames 包含空值或超长 event name");
    }
    return normalized;
  });
  return [...new Set(names)];
}

/** Main-process 内存 ring；不写磁盘，也不进入 renderer store。 */
// 容量必须先夹到合法区间；now 可注入便于测试；record 时必须复制 payload；超出容量时 entries.splice 从头裁剪；read 必须返回独立副本。
export function createFinalArmsCustomEventE2EController(
  options: {
    capacity?: number;
    now?: () => number;
  } = {},
): FinalArmsCustomEventE2EController {
  const requestedCapacity = options.capacity ?? MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES;
  const capacity = Math.max(
    1,
    Math.min(
      Number.isFinite(requestedCapacity)
        ? Math.trunc(requestedCapacity)
        : MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES,
      MAX_FINAL_ARMS_CUSTOM_EVENT_E2E_ENTRIES,
    ),
  );
  const now = options.now ?? Date.now;
  const entries: FinalArmsCustomEventE2EEntry[] = [];
  let nextSequence = 1;
  let suppressedEventNames = new Set<string>();

  return {
    record(payload) {
      entries.push({
        sequence: nextSequence,
        recordedAt: now(),
        payload: cloneFinalPayload(payload),
      });
      nextSequence += 1;
      if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity);
      }
    },
    read() {
      return entries.map((entry) => ({
        ...entry,
        payload: cloneFinalPayload(entry.payload),
      }));
    },
    clear() {
      entries.splice(0, entries.length);
    },
    configure(request) {
      suppressedEventNames = new Set(normalizeSuppressedEventNames(request?.suppressedEventNames));
    },
    shouldSuppress(eventName) {
      return suppressedEventNames.has(eventName);
    },
  };
}

/**
 * main 侧共享的 E2E 捕获环。
 *
 * renderer 经 IPC 来的自定义事件与 main 自己发出的资源 / 稳定性事件必须进同一个环，
 * 否则 E2E 只能看到 renderer 那一半。由 `desktopMainIpcRemote` 在双门禁下开启。
 */
let sharedFinalArmsCustomEventE2E: FinalArmsCustomEventE2EController | null = null;

// 每次启用都必须重建 sharedFinalArmsCustomEventE2E 实例；旧实例随即不再被引用；options 必须与 createFinalArmsCustomEventE2EController 的入参一致。
// 由 IPC 层在门禁后调用。
export function enableSharedFinalArmsCustomEventE2EController(
  options?: Parameters<typeof createFinalArmsCustomEventE2EController>[0],
): FinalArmsCustomEventE2EController {
  sharedFinalArmsCustomEventE2E = createFinalArmsCustomEventE2EController(options);
  return sharedFinalArmsCustomEventE2E;
}

export function getSharedFinalArmsCustomEventE2EController(): FinalArmsCustomEventE2EController | null {
  return sharedFinalArmsCustomEventE2E;
}

// metric_value 缺省为 1；rawProperties 先用 context 属性铺底；params.payload.properties 展开在后可覆盖同名键；值为 undefined 时必须跳过；其余统一经 String 转换。
export function buildFinalArmsCustomEventPayload(params: {
  payload: ArmsCustomEventPayload;
  context: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
    rendererId: number;
  };
}): FinalArmsCustomEventPayload {
  const metricValue = params.payload.value ?? 1;
  const rawProperties: Record<string, string | number | boolean | undefined> = {
    event_name: params.payload.name,
    app_version: params.context.appVersion,
    arms_env: params.context.armsEnv,
    device_mid: params.context.deviceMid,
    platform: normalizeOsCategory(params.context.platform),
    renderer_id: params.context.rendererId,
    metric_value: metricValue,
    ...params.payload.properties,
  };
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawProperties)) {
    if (value !== undefined) {
      properties[key] = String(value);
    }
  }

  return {
    name: params.payload.name,
    type: "custom",
    group: params.payload.group,
    value: metricValue,
    properties,
  };
}

/** 捕获发生在 sendCustom 调用前，网络抑制只跳过目标 event name。 */
// 必须先 buildFinalArmsCustomEventPayload 再 record；suppressed 按 payload.name 判断；未抑制才调用 sendCustom；返回值必须含 suppressed 标记；sendCustom 由调用方注入。
export function dispatchFinalArmsCustomEvent(params: {
  payload: ArmsCustomEventPayload;
  context: Parameters<typeof buildFinalArmsCustomEventPayload>[0]["context"];
  e2eController?: FinalArmsCustomEventE2EController | null;
  sendCustom: (payload: FinalArmsCustomEventPayload) => void;
}): { payload: FinalArmsCustomEventPayload; suppressed: boolean } {
  const payload = buildFinalArmsCustomEventPayload(params);
  params.e2eController?.record(payload);
  const suppressed = params.e2eController?.shouldSuppress(payload.name) ?? false;
  if (!suppressed) {
    params.sendCustom(payload);
  }
  return { payload, suppressed };
}
