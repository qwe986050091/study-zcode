import type { ZCodeApp } from "../app/types.js";

const modelConfigMutationTails = new WeakMap<ZCodeApp, Promise<void>>();

// 输入：session App 身份 + 一个异步 mutation；输出：该 mutation 的返回值。
// 副作用：不改 App，只在 WeakMap 中挂“上一条 tail”；同 App 的所有模型/thought 变更
// 因此按调用顺序串行，跨 App 并发互不阻塞。
// 失败：某次 operation 抛错只影响它自己的返回值；tail 已归一为 void，后续不会被污染。
// 生命周期：tail 在最后一次 mutation 结束时删除；WeakMap 不延长 App/session 的存活。
/**
 * 同一个 session App 的模型配置只有一个串行化临界区。
 *
 * provider registry fallback 与用户 `switchModelConfig` 过去分别直接调用
 * `setModel`，两条异步链可能交错成“后开始的目录兜底覆盖用户选择”，事件顺序也会与
 * runtime 最终值不一致。这里按 App 身份串行化所有模型/thought 变更；失败只结束本次
 * operation，不污染后续 tail。WeakMap 不延长 session 生命周期。
 */
export async function runSessionModelConfigMutation<T>(
  app: ZCodeApp,
  operation: () => Promise<T>,
): Promise<T> {
  // 等待前一条（无论成败）再执行本次：失败的前置操作不能卡死或跳过后续变更。
  const previousTail = modelConfigMutationTails.get(app) ?? Promise.resolve();
  const currentOperation = previousTail.catch(() => undefined).then(operation);
  const currentTail = currentOperation.then(
    () => undefined,
    () => undefined,
  );
  modelConfigMutationTails.set(app, currentTail);
  try {
    return await currentOperation;
  } finally {
    // 只有自己仍是队尾才删除：否则会抹掉后来者的排队链，造成并发交叠。
    if (modelConfigMutationTails.get(app) === currentTail) {
      modelConfigMutationTails.delete(app);
    }
  }
}
