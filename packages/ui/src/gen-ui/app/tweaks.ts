// INV-01 注册表只保留每个 target 的最新条目：守住位置 owners 的覆盖写入；改错故障 同一 tweak 出现两份控件。
// INV-02 target 取 targets[0]：守住位置 三处首元素读取；改错故障 多目标注册的控件挂到错误节点。
// INV-03 两种接受态都走同一代际校验：守住位置 register 与 update 的三元；改错故障 update 被当成首次注册或反之。
// INV-04 注册上限 64：守住位置 registrations.size 判断；改错故障 异常页面持续注册耗尽内存。
// INV-05 更新不得改 target：守住位置 update 分支的 id 比较；改错故障 控件静默搬家。
// INV-06 回调名全局唯一：守住位置 otherCallbacks 集合；改错故障 两个 tweak 抢同一个回调。
// INV-07 选择前校验目标仍存在：守住位置 select 分支的 owners 查找；改错故障 已卸载组件的选择残留在状态里。
// INV-08 dispose 要清掉指向它的选择：守住位置 registrationId 判等；改错故障 标注引用已删除的注册。
// INV-09 非法输入一律抛错而非忽略：守住位置 四处 throw；改错故障 静默失败让页面以为已生效。
// INV-10 range 对外显示为 slider：守住位置 类型映射；改错故障 未知控件类型下发到渲染层。
// INV-11 回调名与当前值分别映射为 id 与 value：守住位置 解构重命名；改错故障 前端拿不到可提交字段。
// INV-12 标注恒为未激活：守住位置 active: false；改错故障 快照误报用户已确认。
// INV-13 只收集值与当前值不同且合法的变更：守住位置 isGenUiAnnotationValue；改错故障 非法值被写进补丁。
// INV-14 消息先过 zod 再分发：守住位置 schema.parse；改错故障 任意载荷进入状态机。
//
// 模块职责：页面内 Tweak 的注册、选择、列举与变更标注。
// 阅读顺序：先看 owners 的去重规则，再看 handle 的四个分支，最后看 groups 与 annotation 的输出形状。
import {
  genUiTweakMessageSchema,
  isGenUiAnnotationValue,
  type GenUiTweakMessage,
  type GenUiTweakResult,
  type GenUiTweakAnnotation,
  type GenUiTweak,
  type GenUiTweakValues,
} from "@zcode/shared/gen-ui";

type Registration = Extract<GenUiTweakMessage, { type: "register" | "update" }>;

/** 上游 helper 的接受状态归页面 owner；guest 只通过 ACK 得到绑定投影。 */
export function createGenUiTweakRegistry() {
  // 按 registrationId 保留原始注册消息，便于代际比较。
  const registrations = new Map<string, Registration>();
  // selection 是全局单值，同一时刻只能有一个控件被选中，切换由 register 覆盖。
  let selection: GenUiTweakAnnotation["selection"] = null;
  const owners = () => {
    const latest = new Map<string, Registration>();
    // 后写入覆盖先写入，实现同 target 的最新者胜。
    for (const entry of registrations.values()) latest.set(entry.targets[0]!.id, entry);
    return [...latest.values()];
  };
  return {
    handle(input: GenUiTweakMessage): GenUiTweakResult {
      // 入口先跑 genUiTweakMessageSchema.parse，后续分支可以放心按类型收窄。
      const message = genUiTweakMessageSchema.parse(input);
      if (message.type === "escape") {
        selection = null;
        return {};
      }
      if (message.type === "dispose") {
        registrations.delete(message.registrationId);
        if (selection?.registrationId === message.registrationId) selection = null;
        return {};
      }
      // 选择前必须证明该 target 仍在当前注册表里。
      if (message.type === "select") {
        if (
          !owners().some(
            (entry) =>
              entry.registrationId === message.registrationId &&
              entry.targets[0]!.id === message.targetId,
          )
        )
          throw new Error("Tweak target is no longer available");
        selection = { registrationId: message.registrationId, targetId: message.targetId };
        return {};
      }
      // 注册与更新共享同一条代际规则。
      const previous = registrations.get(message.registrationId);
      if (
        message.type === "register"
          // register 要求 id 未占用且未超上限。
          ? previous || registrations.size >= 64
          // update 要求已存在且 target 未变。
          : !previous || previous.targets[0]!.id !== message.targets[0]!.id
      )
        throw new Error("Invalid Tweak registration generation");
      // 收集其它注册占用的回调名，用于全局唯一性检查。
      const otherCallbacks = new Set(
        [...registrations.values()]
          .filter((entry) => entry.registrationId !== message.registrationId)
          .flatMap((entry) => entry.annotationControls.controls.map((control) => control.callback)),
      );
      if (
        message.annotationControls.controls.some((control) => otherCallbacks.has(control.callback))
      )
        throw new Error("Duplicate Tweak callback");
      // 校验通过后才落表，失败不会留下半成品。
      registrations.set(message.registrationId, message);
      return { annotationControls: message.annotationControls };
    },
    // 对外分组按 target 去重后的顺序输出。
    groups(): GenUiTweak[] {
      return owners().map((entry) => ({
        title: entry.targets[0]!.label,
        controls: entry.annotationControls.controls.map((control) => {
          // 回调名对前端暴露为 id，当前值暴露为 value。
          const { callback: id, currentValue: value, ...rest } = control;
          return {
            ...rest,
            id,
            value,
            type: control.type === "range" ? "slider" : control.type,
          } as GenUiTweak["controls"][number];
        }),
      }));
    },
    annotation(values: GenUiTweakValues): GenUiTweakAnnotation {
      return {
        active: false,
        selection,
        changes: owners().flatMap((entry) => {
          // 逐控件比较 annotationControls 的当前值与提交值，相同即跳过不发变更。
          const annotationControlChanges = entry.annotationControls.controls.flatMap((control) => {
            const value = values[control.callback];
            return value !== control.currentValue && isGenUiAnnotationValue(control, value)
              ? [{ callback: control.callback, previousValue: control.currentValue, value }]
              : [];
          });
          return annotationControlChanges.length
            ? [
                {
                  registrationId: entry.registrationId,
                  targetId: entry.targets[0]!.id,
                  annotationControlChanges,
                },
              ]
            : [];
        }),
      };
    },
  };
}
