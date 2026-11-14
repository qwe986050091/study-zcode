// ============================================================
// 文件定位：托管无头 CDP 后端的描述符工厂（告诉上层“这个 backend 能做什么/不能做什么”）。
// 输入输出：输入 browserId 与 generation，输出 BrowserBackendDescriptor 契约对象。
// 副作用：无（纯对象构造）。
// 失败语义：不抛出；能力限制以显式 false 覆盖表达，而不是隐瞒。
// 不变量：generation 必须来自当前 runtime；每次浏览器重连 +1，旧描述符因此自动失效。
// ============================================================
import type { BrowserBackendDescriptor } from "@zcode/contracts";

// 构造一次托管浏览器的描述符：id 与 generation 构成“后端身份”，用于识别过期请求。
// capabilities 留空表示由 apiSupportOverrides 白名单/黑名单细化，而非宣称全能力。
export function createManagedCdpDescriptor(
  browserId: string,
  generation: number,
): BrowserBackendDescriptor {
  return {
    id: browserId,
    generation,
    type: "cdp",
    name: "ZCode Headless Chromium",
    capabilities: {
      browser: [],
      tab: [],
    },
    // 显式关闭“无头托管模式下无法可靠支持”的能力，避免上层误用后得到含糊的运行时错误。
    apiSupportOverrides: {
      "BrowserUser.openTabs": false,
      "BrowserUser.history": false,
      "PlaywrightAPI.waitForEvent": false,
      "PlaywrightDownload.path": false,
      "PlaywrightFileChooser.setFiles": false,
      "PlaywrightLocator.downloadMedia": false,
      "PlaywrightLocator.evaluate": false,
      "CUAAPI.downloadMedia": false,
      "DomCUAAPI.downloadMedia": false,
    },
    metadata: {
      provider: "zcode-cli",
      launchMode: "managed",
      headless: "true",
    },
  };
}
