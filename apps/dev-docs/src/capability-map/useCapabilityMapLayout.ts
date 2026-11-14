import { useEffect, useState } from "react";
import {
  capabilityMapLayoutPromise,
  type CapabilityMapLayout,
} from "@/capability-map/capabilityMapLayout.js";

// 订阅模块级共享的 ELK 布局 Promise，向组件暴露 { layout, error }。
// 返回口径：加载中 layout 为 null 且 error 为空串；成功时 layout 为完整布局、error 仍为空串；
// 失败时 layout 保持 null、error 为 Error.message（非 Error 值用 String() 兜底），本 hook 不抛出也不重试。
// 副作用：只读取既有 Promise，不触发新的布局计算（计算在 capabilityMapLayout 模块求值时执行一次）。
// 维护不变量：组件卸载或 StrictMode 重挂载后回调被 active 标记丢弃，不会写入已卸载实例的状态。
export function useCapabilityMapLayout() {
  const [layout, setLayout] = useState<CapabilityMapLayout | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // 布局 Promise 是全局单例，可能晚于组件卸载才 resolve，因此用闭包标记过滤过期写入。
    let active = true;
    void capabilityMapLayoutPromise
      .then((nextLayout) => {
        if (active) {
          setLayout(nextLayout);
        }
      })
      // 失败只转成可展示文本，layout 保持 null，由调用方渲染布局失败面板。
      .catch((layoutError: unknown) => {
        if (active) {
          setError(layoutError instanceof Error ? layoutError.message : String(layoutError));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return { error, layout };
}
