// INV-01 AUMID 只接受 Shell 标识而非路径：守住位置 SAFE_AUMID 正则；改错故障 任意路径被拼进 Powershell 命令。
// INV-02 必须走 SHCreateItemInKnownFolder：守住位置 C# 里的 P/Invoke；改错故障 图标退化成宿主 exe 缩略图。
// INV-03 AppsFolder 的 GUID 固定不可改：守住位置 appsFolder 常量；改错故障 Shell 找不到应用集合。
// INV-04 取图标志固定为 BIGGERSIZEOK 与 ICONONLY：守住位置 GetImage 的 0x5；改错故障 拿到的是缩略图不是应用图标。
// INV-05 GDI 位图必须释放：守住位置 finally 的 DeleteObject；改错故障 句柄泄漏。
// INV-06 COM 对象必须释放：守住位置 finally 的 ReleaseComObject；改错故障 Shell 引用计数只增不减。
// INV-07 失败一律返回 null：守住位置 三处 return null；改错故障 上层拿到半成品图标。
// INV-08 编码参数防注入：守住位置 createEncodedPowerShellArgs；改错故障 引号与换行破坏命令边界。
// INV-09 输出必须是纯 base64：守住位置 字符集正则；改错故障 警告文本被拼进 data URL。
// INV-10 输出体积设上限：守住位置 MAX_ICON_BASE64_CHARS；改错故障 异常大图标撑爆 IPC。
// INV-11 执行超时硬上限 5 秒：守住位置 execute 的 timeoutMs；改错故障 Powershell 挂住主进程。
// INV-12 依赖可注入以便测试：守住位置 默认参数；改错故障 单测被迫真的启动进程。
// INV-13 系统根目录兜底：守住位置 SystemRoot 默认值；改错故障 环境变量缺失时路径解析抛错。
//
// 模块职责：按 AUMID 通过 Shell 接口取出应用真实图标，转成 PNG 的 data URL。
// 阅读顺序：先看 AUMID 校验与 Powershell 调用，再看 C# 取图与资源释放，最后看输出校验。
import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { ApplicationIconInfo } from "@zcode/shared";
import { createEncodedPowerShellArgs } from "../../scripts/powershell-command.mjs";

// SAFE_AUMID 匹配形如「包族!应用」的两段式，必须禁止路径分隔符与空白，杜绝命令拼接面。
// SAFE_AUMID 放在模块顶层，正则无 g 标志，可安全复用。
const SAFE_AUMID = /^[^\\/\s!]+![^\\/\s!]+$/u;
// MAX_ICON_BASE64_CHARS 取 1 MiB 字符数，超过它的输出按异常处理并返回 null。
const MAX_ICON_BASE64_CHARS = 1024 * 1024;

// 不能把 AUMID 当文件路径交给 app.getFileIcon。AppsFolder 是 Shell namespace，
// 必须先由 SHCreateItemInKnownFolder 得到 IShellItem，再提取其真实应用图标。
// 整段脚本以 EncodedCommand 传入，避免命令行转义问题。
// C# 部分只用 System.Drawing 与 shell32，不依赖额外程序集。
// 创建失败时 C# 侧直接抛 HRESULT，由 PowerShell 统一转成进程非零退出。
// 取图固定 64x64：够任务栏与列表展示，再大只会增加 base64 体积。
// 脚本结构：C# 类 ZCodeAumidIcon 只暴露一个静态方法 Read(aumid)；取图链路是 SHCreateItemInKnownFolder → GetImage → HBITMAP → PNG 字节。
// 调用顺序：PowerShell 侧先 Add-Type System.Drawing 与内联 C#，再调用 Read 取字节，最后转 base64 写到 stdout。
// 失败语义：任一 HRESULT 非零即由 Marshal.ThrowExceptionForHR 抛出；PowerShell 随之非零退出且 stdout 为空，调用方拿到空串后返回 null。
const WINDOWS_AUMID_ICON_SCRIPT = String.raw`
Add-Type -AssemblyName System.Drawing;
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class ZCodeAumidIcon {
  [StructLayout(LayoutKind.Sequential)]
  private struct SIZE { public int cx; public int cy; }

  [ComImport]
  [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItemImageFactory {
    [PreserveSig]
    int GetImage(SIZE size, uint flags, out IntPtr bitmap);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  private static extern int SHCreateItemInKnownFolder(
    ref Guid folderId,
    uint flags,
    string item,
    ref Guid interfaceId,
    out IShellItemImageFactory shellItem);

  [DllImport("gdi32.dll")]
  private static extern bool DeleteObject(IntPtr value);

  public static byte[] Read(string aumid) {
    Guid appsFolder = new Guid("1e87508d-89c2-42f0-8a7e-645a0f50ca58");
    Guid imageFactory = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory shellItem;
    int created = SHCreateItemInKnownFolder(
      ref appsFolder, 0, aumid, ref imageFactory, out shellItem);
    if (created != 0 || shellItem == null) Marshal.ThrowExceptionForHR(created);
    IntPtr bitmap = IntPtr.Zero;
    try {
      // SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY，避免退化成宿主 exe 缩略图。
      int loaded = shellItem.GetImage(new SIZE { cx = 64, cy = 64 }, 0x5, out bitmap);
      if (loaded != 0 || bitmap == IntPtr.Zero) Marshal.ThrowExceptionForHR(loaded);
      using (Bitmap image = Image.FromHbitmap(bitmap))
      using (MemoryStream output = new MemoryStream()) {
        image.Save(output, ImageFormat.Png);
        return output.ToArray();
      }
    } finally {
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      Marshal.ReleaseComObject(shellItem);
    }
  }
}
'@;
$zcodeIconBytes=[ZCodeAumidIcon]::Read($zcodeArg0);
[Console]::Out.Write([Convert]::ToBase64String($zcodeIconBytes));
`;

// 依赖接口 WindowsAumidIconDependencies 只有执行器与系统根目录两项，测试可完全替换掉真实进程调用。
// execute 返回 stdout 原文，解码与校验都在调用方完成。
interface WindowsAumidIconDependencies {
  // execute 的签名只有 command 与 args 与 timeoutMs 三项，测试替换时无需启动真实进程。
  execute(command: string, args: readonly string[], timeoutMs: number): Promise<string>;
  // systemRoot 单独注入，环境变量缺失时由默认依赖兜底而不是让 win32.join 抛错。
  systemRoot: string;
}

// execFile 只接受参数数组，不能经过 shell 拼接，天然抗注入。
// windowsHide 保证不闪黑窗，timeout 直接杀掉挂住的子进程。
// SystemRoot 缺失时退回 C 盘默认路径，保证可解析。
const defaultDependencies: WindowsAumidIconDependencies = {
  // 默认 execute 用 execFile 加参数数组启动，命令串不经过 shell 解析。
  execute: (command, args, timeoutMs) =>
    // Promise 在 execFile 报错时 reject，工厂不把这个拒绝转换成 null。
    new Promise((resolve, reject) => {
      // execFile 的 timeout 由 Node 计时，超时会杀掉子进程并 reject，PowerShell 挂住不会拖死主进程。
      execFile(
        command,
        [...args],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    }),
  // SystemRoot 缺失时退回 C 盘默认路径，避免在精简环境里拼出相对路径。
  systemRoot: process.env.SystemRoot ?? "C:\\Windows",
};

// createWindowsAumidIconReader 返回闭包而不是导出函数，依赖只在工厂调用时绑定一次。
export function createWindowsAumidIconReader(
  // 默认参数让生产入口零参数可用，单测传入替身即可绕开真实 powershell.exe。
  dependencies: WindowsAumidIconDependencies = defaultDependencies,
) {
  // 每个 AUMID 独立走一次读取，函数不缓存结果，成功与失败都不留状态。
  return async (aumid: string): Promise<ApplicationIconInfo | null> => {
    // 先 trim 再校验，前导空格会让 SAFE_AUMID 把合法标识判成非法。
    const normalized = aumid.trim();
    // 非法的 AUMID 不进入外部进程，直接在边界拒绝。
    if (!SAFE_AUMID.test(normalized)) return null;
    // powershell 路径用 win32.join 拼接，即使宿主平台不是 Windows 也不会拼错分隔符。
    const powershell = win32.join(
      dependencies.systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    // encoded 取 stdout 并 trim，PowerShell 的换行不会混进 base64。
    const encoded = (
      await dependencies.execute(
        powershell,
        createEncodedPowerShellArgs(WINDOWS_AUMID_ICON_SCRIPT, [normalized]),
        5_000,
      )
    ).trim();
    // 非空与长度上限与字符集三条同时校验，任一不过都返回 null。
    if (
      !encoded ||
      encoded.length > MAX_ICON_BASE64_CHARS ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
    ) {
      // 校验失败返回 null，调用方拿到的是明确空值而不是拼坏的 data URL。
      return null;
    }
    // 到这里 encoded 已通过非空、长度与字符集三重校验。
    // 只能拼接 data URL，不能回传原始字节，避免 IPC 体积翻倍。
    return { iconDataUrl: `data:image/png;base64,${encoded}` };
  };
}

// 模块级单例绑定默认依赖，生产调用方直接引用 readWindowsAumidIcon 这个常量。
export const readWindowsAumidIcon = createWindowsAumidIconReader();
