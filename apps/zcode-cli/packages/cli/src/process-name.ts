// 进程标识常量：命令行里用户输入的名字（用于文案与 usage）与系统进程表中展示的名字分开维护。
export const CLI_COMMAND_NAME = "zcode";
// 写入操作系统进程标题的值，避免在 ps/top/任务管理器里显示为 node。
export const CLI_PROCESS_NAME = "zcode-cli";

// 进程标题写入目标的最小接口，便于测试注入普通对象而非真实 process。
interface ProcessTitleTarget {
  // 可读写的进程标题；赋值后由 OS 决定是否实际生效（Windows 仅影响窗口/控制台标题）。
  title: string;
}

// 把当前进程标题改写为 CLI_PROCESS_NAME。
// 输入：target 默认 process，可注入替身。
// 副作用：直接修改 target.title；不涉及 IO、不返回状态。
// 失败语义：不抛错；不支持进程标题的平台只会静默不生效，调用方无需感知。
export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
