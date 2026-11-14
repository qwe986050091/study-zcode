/**
 * request-security-edition 版本的观测入口（占位实现）。
 *
 * 职责：为「安全版」构建提供与主实现同名的 recordRequestObservation，使调用方无需按版本分支。
 * 口径：本版本不采集任何请求观测数据，因此函数体为空；入参以 `_` 前缀声明为有意未使用。
 * 副作用：无——不写 span、不建属性、不发事件。
 * 失败语义：不抛错；任何调用都静默成功，调用方不得依赖此处产生可查询的观测数据。
 * 不变量：签名必须与主实现保持一致，否则安全版构建会在调用点出现类型不匹配。
 */

import type { ModelRequestObservation } from "@zcode/contracts/model";
import type { RequestObservationTarget } from "../request-observation-target.js";

/**
 * 空实现的请求观测记录。
 * 保留完整参数签名以维持接口一致性；参数刻意不使用，避免误以为此处会做脱敏或上报。
 */
export function recordRequestObservation(
  _writer: RequestObservationTarget,
  _observation: ModelRequestObservation,
): void {}
