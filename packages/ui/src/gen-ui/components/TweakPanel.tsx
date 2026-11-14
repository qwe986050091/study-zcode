// INV-01 初始值由快照给出：守住位置 snapshot；改错故障 首次渲染为空白。
// INV-02 原值集合只在渲染时构建：守住位置 Object.fromEntries；改错故障 重置拿到旧值。
// INV-03 控件值以 id 为键：守住位置 change 入参；改错故障 同名控件互相覆盖。
// INV-04 修改即写回页面：守住位置 page.setTweaks；改错故障 预览不刷新。
// INV-05 重置回到原值：守住位置 重置按钮；改错故障 只能逐项手改。
// INV-06 原值预览是开关：守住位置 preview；改错故障 无法对照改动前后。
// INV-07 提交期间禁用按钮：守住位置 busy；改错故障 重复提交产生多份结果。
// INV-08 提交错误就地展示：守住位置 error 与 role=alert；改错故障 失败没有任何提示。
// INV-09 重试前先清空错误：守住位置 setError；改错故障 旧错误残留。
// INV-10 提交结束必复位忙碌：守住位置 finally；改错故障 按钮永久禁用。
// INV-11 三类控件分别渲染：守住位置 条件分支；改错故障 滑块被画成文本框。
// INV-12 滑块数值转数字：守住位置 Number；改错故障 字符串值进入参数。
// INV-13 颜色控件用原生取色：守住位置 type=color；改错故障 颜色格式不受控。
// INV-14 滑块显示当前值与单位：守住位置 output；改错故障 拖动没有反馈。
// INV-15 分组标题来自快照：守住位置 legend；改错故障 分组含义不明。
// INV-16 控件标签同时作可访问名：守住位置 aria-label；改错故障 读屏无法识别。
// INV-17 面板只做展示与转发：守住位置 组件体；改错故障 面板持有业务状态。
// INV-18 分组键用位置索引：守住位置 key；改错故障 分组重排后状态错位。
//
// 模块职责：TweakPanel 渲染生成式界面的调参面板，把改动交给 page.setTweaks 并驱动预览与提交。
// 状态所有权：参数值归页面快照；面板仅持有忙碌与错误两个局部态。
// 阅读顺序：先看原值与改动回调，再看三类控件渲染，最后看底部动作。
import { useState } from "react";

import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { GenUiPage, GenUiPageSnapshot } from "../contract.js";
export function TweakPanel({ snapshot, page }: { snapshot: GenUiPageSnapshot; page: GenUiPage }) {
  // groups 与 tweakValues 都从 snapshot 解构，面板不另存一份参数。
  // previewOriginal 作为 preview 开关，决定是否并排展示改动前的对照视图。
  // snapshot 引用更新触发整体重渲染，组件内没有做分片记忆化。
  // 面板不复制参数值，写入只经 page.setTweaks 回传。
  const { groups, tweakValues: values, previewOriginal: preview } = snapshot;
  const { intl } = useZCodeIntl();
  // original 用 flatMap 展平 groups 里的所有 controls。
  // Object.fromEntries 以 control.id 为键记录初始值，同名控件会互相覆盖。
  // 该集合每次渲染重建，不放进 state 缓存旧值。
  // 重置按钮读取 original，把面板恢复到首次渲染时的取值。
  const original = Object.fromEntries(
    groups.flatMap((group) => group.controls).map((control) => [control.id, control.value]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // change 只在 values 副本上覆盖目标 id，其余控件原样展开。
  // 新的 tweakValues 交给 page.setTweaks，写回责任在页面而不在面板。
  // 面板不做取值校验，类型与范围由控件 schema 保证。
  // 合并方式是浅拷贝，控件值按 string 或 number 直接写入 values。
  const change = (id: string, value: string | number | boolean) => {
    const next = { ...values, [id]: value };
    page.setTweaks(next);
  };
  // 外层 div 用 max-h-[40vh] 与 overflow-y-auto 限高，参数多时在面板内部滚动。
  // 每个分组渲染成 fieldset，图例取 group.title。
  // 底部按钮顺序固定为先重置后对照再提交，不随分组数量变化。
  // error 非空时把 role="alert" 提示放在最末，失败原因不被按钮挤走。
  // 外层容器固定 data-testid="gen-ui-tweaks"，E2E 据此定位整个面板。
  return (
    <div
      className="max-h-[40vh] space-y-3 overflow-y-auto p-3 text-ui-sm"
      data-testid="gen-ui-tweaks"
    >
      {groups.map((tweak, groupIndex) => (
        <fieldset key={groupIndex} className="space-y-3">
          <legend className="font-medium">{tweak.title}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {tweak.controls.map((control) => (
              <label key={control.id} className="flex items-center gap-3">
                <span className="min-w-20">{control.label}</span>
                {control.type === "select" ? (
                  <select
                    aria-label={control.label}
                    className="min-w-0 flex-1 rounded border bg-panel p-1"
                    value={String(values[control.id])}
                    onChange={(event) => change(control.id, event.target.value)}
                  >
                    {control.options.map((option) => (
                      <option
                        key={typeof option === "string" ? option : option.value}
                        value={typeof option === "string" ? option : option.value}
                      >
                        {typeof option === "string" ? option : option.label}
                      </option>
                    ))}
                  </select>
                ) : control.type === "toggle" ? (
                  <input
                    aria-label={control.label}
                    type="checkbox"
                    checked={Boolean(values[control.id])}
                    onChange={(event) => change(control.id, event.target.checked)}
                  />
                ) : (
                  <input
                    aria-label={control.label}
                    type={control.type === "color" ? "color" : "range"}
                    className="min-w-0 flex-1"
                    value={String(values[control.id])}
                    {...(control.type === "slider"
                      ? { min: control.min, max: control.max, step: control.step ?? 1 }
                      : {})}
                    onChange={(event) =>
                      change(
                        control.id,
                        control.type === "slider" ? Number(event.target.value) : event.target.value,
                      )
                    }
                  />
                )}
                {control.type === "slider" && (
                  <output>
                    {values[control.id]}
                    {control.unit}
                  </output>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            page.setTweaks(original);
          }}
        >
          {intl.formatMessage({ id: "genUi.reset" })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={preview}
          onClick={() => {
            page.previewTweaks(!preview);
          }}
        >
          {intl.formatMessage({ id: "genUi.original" })}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await page.submitTweaks(values);
            } catch (reason) {
              setError(String(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          {intl.formatMessage({ id: "genUi.submit" })}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
