import type { ExecutionShellSelection } from "@zcode/contracts";

// provider-visible embedded branch 已默认开启；执行层仅在明确支持 POSIX
// shell function 的 session shell 中注入 find()/grep() alias。
const ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE = true;

// 判断是否需要给 session shell 注入 find()/grep() 前缀函数。
// 当前恒为 true：provider-visible 分支默认开启，注入与否由 shell 方言另行收口。
// 无副作用，也不读取环境变量，调用方可在每次创建 shell 前调用。
export function shouldInjectEmbeddedSearchBashPrelude(): boolean {
  return ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE;
}

// 判断执行用 shell 是否支持注入 POSIX shell function。
// selection 为 undefined（尚未选定 shell）时返回 false，走无 prelude 的安全降级。
// 仅 posix 与 git-bash 两种方言可用；cmd/powershell 等不满足，避免语法不兼容。
export function supportsEmbeddedSearchShellSelection(
  selection: ExecutionShellSelection | undefined,
): boolean {
  return selection?.dialect === "posix" || selection?.dialect === "git-bash";
}
