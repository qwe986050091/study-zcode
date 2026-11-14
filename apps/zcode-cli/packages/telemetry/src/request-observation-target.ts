/**
 * 请求观测目标的最小接口。
 *
 * 职责：把「记录一次对外请求」抽象成两个动作，供 recorder 在请求前后写入属性与事件，
 * 而不直接依赖具体的 OpenTelemetry Span 实现。
 * 口径：setAttribute 用于覆盖单值属性（同名后写覆盖前写）；addEvent 用于追加带时间点的离散事件。
 * 边界：本文件只声明能力，不保证实现是否采样、是否异步提交；调用方不得假设写入会立即落盘。
 */

import type { Attributes } from "@opentelemetry/api";

/**
 * 观测目标契约。
 * 实现方通常是 OTel Span 适配器；测试可用内存桩替换，因此接口刻意只保留这两个最常用的写入能力。
 */
export interface RequestObservationTarget {
  setAttribute(name: string, value: unknown): void;
  addEvent(name: string, attributes?: Attributes): void;
}
