// useBuiltinAgentCli：内置 Agent CLI 的安装与卸载状态机，附带一段可控节奏的假进度动画。
//
// 职责（做什么）：从 useSettings 读取设置与更新能力，派生单个 provider 的启用状态、有效 provider
// `useBuiltinAgentCli` 派生 `getStatus` 的状态机枚举；`installProvider` 先跑 `simulateInstallProgress` 再 `update`，`uninstallProvider` 延迟后 `filter` 并回退偏好。
// 本 hook 不调用任何安装命令、不读写模型密钥，provider 是否可用由 `requiresBuiltinAgentCliInstall` 判定。
// 职责（依赖谁）：依赖 useSettings 的 settings、loading、refresh、update，builtinAgentCli 的纯判定函数，
// 以及 zcodeProviderPreference 的本地偏好读写；调用方是内置 CLI 设置区块。
// `activeMutatingProvider` 同一时刻只承载一个 provider，`installProgressByProvider` 只是观感，真实状态由 `update` 落盘决定。
//
// 真实安装没有进度回调，`simulateInstallProgress` 用 `createInstallProgressPlan` 的分阶段曲线加 `pauses` 造节奏；删掉它则 `setProgress` 无从更新。
// 但总时长有上下界，进度必须单调不跳号，避免用户看到数值回退或瞬间完成。
//
// 并发语义：enablingProvider 与 disablingProvider 互斥推进，canMutateProvider 让其他卡片在变更期间禁用；
// 卸载完成后若本地偏好仍指向该 provider，立即回退到始终可用的 glm。
//
// 阅读顺序：先看 INSTALL_TEMPLATES 与 createInstallProgressPlan，再看 simulateInstallProgress 的推进循环，最后看两个变更回调的错误与收尾分支。
//
// 以下不变量在改造时必须逐条自检，任一破坏都会让变更状态与设置事实脱节。
// INV-01 前置判断不可省：已启用不得重复安装，未启用不得卸载 —— 守住它的位置：两个变更回调开头的 requiresBuiltinAgentCliInstall 与 isEnabled 判断 —— 改错故障：启用列表里出现重复项或误删其他 provider。
// INV-02 并发闸门统一：变更前必须经过 canMutateProvider —— 守住它的位置：installProvider 与 uninstallProvider 的首个判断 —— 改错故障：两个 provider 同时写入设置，后写覆盖先写。
// INV-03 进度单调不跳号：每轮最多推进一个百分点 —— 守住它的位置：simulateInstallProgress 的推进分支 —— 改错故障：进度条回退或瞬间跳完，动画失去可信度。
// INV-04 先模拟后落盘：进度完成后才写设置 —— 守住它的位置：installProvider 中 update 的调用顺序 —— 改错故障：设置已改而动画还在跑，关闭页面后状态不自洽。
// INV-05 写设置必须用全量列表：不得增量追加或按索引修改 —— 守住它的位置：nextEnabledProviders 的构造 —— 改错故障：并发写导致列表丢失条目。
// INV-06 收尾必须清空进行中标记：无论成功失败都要复位 —— 守住它的位置：两个变更回调的 finally —— 改错故障：界面永久卡在安装中，所有卡片禁用。
// INV-07 安装收尾必须删除进度条目 —— 守住它的位置：installProvider 的 finally 中进度表清理 —— 改错故障：下次打开该 provider 直接显示上次的残留百分比。
// INV-08 错误必须重新抛出：不能只写 state.error 就吞掉 —— 守住它的位置：两个 catch 块末尾 —— 改错故障：调用方的 await 正常返回，误以为变更成功。
// INV-09 偏好回退必须在设置写入成功之后 —— 守住它的位置：uninstallProvider 中 update 之后的判断 —— 改错故障：设置写失败但偏好已改，界面与偏好不一致。
// INV-10 偏好回退只针对被卸载的 provider —— 守住它的位置：readLastSelectedAgentProvider 的比较 —— 改错故障：用户新选的 provider 被误改回 glm。
// INV-11 总时长必须有上下界：5 到 10 秒之间 —— 守住它的位置：createInstallProgressPlan 的随机区间 —— 改错故障：安装瞬间完成或久等不结束。
// INV-12 阶段时间轴必须首尾相接：后一段起点等于前一段终点 —— 守住它的位置：stages 数组的 startAtMs 与 endAtMs —— 改错故障：进度在阶段交界处停顿或倒退。
// INV-13 每个阶段至少 1 毫秒 —— 守住它的位置：pickInstallStageDurations 的取整下限 —— 改错故障：缓动函数除以零，进度变成 NaN。
// INV-14 停顿不得越过总时长 —— 守住它的位置：simulateInstallProgress 中停顿等待的取小值 —— 改错故障：动画超出预定结束时间仍不结束。
// INV-15 收尾必须补到 100：循环结束后逐点推到满格 —— 守住它的位置：simulateInstallProgress 末尾的补齐循环 —— 改错故障：任务已成功但进度停在 99。
// INV-16 启用列表必须 memo 化 —— 守住它的位置：enabledProviders 的 useMemo —— 改错故障：每次渲染重建数组，下游回调依赖全部失效并触发重复渲染。
// INV-17 两个进行中 provider 互斥 —— 守住它的位置：enablingProvider 与 disablingProvider 的赋值 —— 改错故障：安装与卸载同时进行，设置被反复改写。
// INV-18 返回值不得丢掉 error 与进度读取 —— 守住它的位置：hook 末尾的返回对象 —— 改错故障：消费方拿不到失败文案，也无法展示安装进度。
/* eslint-disable max-lines -- 内置 Agent CLI 的安装/卸载状态、随机进度模板与设置同步目前集中在同一 hook，先保持收口，避免把同一条交互链拆散。 */
import { useCallback, useMemo, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  resolveBuiltinAgentCliStatus,
  getEffectiveBuiltinAgentCliProvider,
  getEnabledBuiltinAgentCliProviders,
  requiresBuiltinAgentCliInstall,
  type BuiltinAgentCliStatus,
} from "@/lib/builtinAgentCli.js";
import {
  persistLastSelectedAgentProvider,
  readLastSelectedAgentProvider,
} from "@/lib/zcodeProviderPreference.js";

const MIN_INSTALL_DURATION_MS = 5_000;
const MAX_INSTALL_DURATION_MS = 10_000;
const MIN_UNINSTALL_DURATION_MS = 3_000;
const MAX_UNINSTALL_DURATION_MS = 5_000;
const INSTALL_PROGRESS_TICK_MS = 16;

type InstallStageKey = "warmup" | "accelerate" | "settle" | "finish";

type InstallStagePlan = {
  key: InstallStageKey;
  startProgress: number;
  endProgress: number;
  startAtMs: number;
  endAtMs: number;
  easing: (t: number) => number;
};

type InstallPausePlan = {
  triggerProgress: number;
  durationMs: number;
  consumed: boolean;
};

type InstallProgressPlan = {
  totalDurationMs: number;
  stages: InstallStagePlan[];
  pauses: InstallPausePlan[];
};

type InstallTemplateKey = "balanced" | "fastMiddle" | "heavyTail";

type InstallTemplate = {
  key: InstallTemplateKey;
  stage1EndRange: [number, number];
  stage2EndRange: [number, number];
  stage3EndRange: [number, number];
  stageDurationRatioRanges: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  stage2To3PauseDurationRange: [number, number];
  stage3To4PauseDurationRange: [number, number];
};

// `INSTALL_TEMPLATES` 的三套模板只改 `stageDurationRatioRanges` 与停顿区间，`pickInstallTemplate` 随机挑一套。
// stage1EndRange 等区间是百分比，必须保持递增且落在 0 到 100 之间
// stageDurationRatioRanges 的四段由代码归一化，不要假设它们相加等于 1
// 新增模板时保持 key 唯一，选择逻辑按下标随机
// 这几个区间只影响 `simulateInstallProgress` 的观感，不参与 `requiresBuiltinAgentCliInstall` 等任何业务判定。
const INSTALL_TEMPLATES: InstallTemplate[] = [
  {
    key: "balanced",
    stage1EndRange: [5, 8],
    stage2EndRange: [60, 72],
    stage3EndRange: [92, 97],
    stageDurationRatioRanges: [
      [14, 18],
      [34, 40],
      [28, 34],
      [12, 18],
    ],
    stage2To3PauseDurationRange: [250, 700],
    stage3To4PauseDurationRange: [900, 2200],
  },
  {
    key: "fastMiddle",
    stage1EndRange: [4, 7],
    stage2EndRange: [70, 78],
    stage3EndRange: [91, 96],
    stageDurationRatioRanges: [
      [12, 16],
      [30, 36],
      [30, 36],
      [14, 20],
    ],
    stage2To3PauseDurationRange: [220, 620],
    stage3To4PauseDurationRange: [1000, 2400],
  },
  {
    key: "heavyTail",
    stage1EndRange: [6, 8],
    stage2EndRange: [58, 66],
    stage3EndRange: [94, 99],
    stageDurationRatioRanges: [
      [15, 19],
      [32, 37],
      [29, 35],
      [15, 21],
    ],
    stage2To3PauseDurationRange: [280, 780],
    stage3To4PauseDurationRange: [1200, 2600],
  },
];

// [契约] 两端闭区间，返回值一定落在 min 与 max 之间
// 调用方需保证 min 不大于 max，本函数不做交换
// 使用 Math.random 而非加密随机，进度动画不需要密码学强度
// 浮点取整使用 floor，保证不会返回 max 加一
// 不要在此做副作用，它必须是可重复调用的纯函数
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// [资源] 定时器挂在 window 上，页面卸载时由浏览器统一回收
// `sleep` 不提供取消能力，调用方靠 `isCurrent` 一类运行标识在 `window.setTimeout` 唤醒后自行退出。
// 传入零或负数会立即兑现，不会报错
// `sleep` 内部不再轮询，`window.setTimeout(resolve, ms)` 一次兑现即可，多套轮询会让 `simulateInstallProgress` 的节奏漂移。
// 返回 promise 而不接受回调，方便与异步流程组合
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// [契约] 先取上界再取下界，保证返回值一定落在闭区间内
// min 大于 max 时结果等于 max，调用方需自行保证区间合法
// `clamp` 同时被 `getInstallTargetProgressAtElapsed` 与 `triggerProgress` 复用，取整必须留在调用方，否则停顿点会被二次取整错位。
// `clamp` 保持纯函数，只读 `value`/`min`/`max`，读外部配置会让同一入参得到不同结果。
// 边界值传入时原样返回，不做特殊分支
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t ** 3
    : 1 - ((-2 * t + 2) ** 3) / 2;
}

function easeInCubic(t: number): number {
  return t ** 3;
}

function linear(t: number): number {
  return t;
}

// `pickInstallTemplate` 以 `randomInt` 在 `INSTALL_TEMPLATES.length - 1` 区间均匀取模板，不给 `balanced` 加权。
// 数组为空时回退到第一个元素，防止空访问导致崩溃
// 选中哪套 `InstallTemplate` 只影响阶段占比，总时长仍由 `MIN_INSTALL_DURATION_MS`/`MAX_INSTALL_DURATION_MS` 卡住。
// `pickInstallTemplate` 返回的是 `INSTALL_TEMPLATES` 的元素引用，改它会污染后续每次安装的模板区间。
// 返回引用而非拷贝，调用方只读使用
function pickInstallTemplate(): InstallTemplate {
  const templateIndex = randomInt(0, INSTALL_TEMPLATES.length - 1);
  return INSTALL_TEMPLATES[templateIndex] ?? INSTALL_TEMPLATES[0]!;
}

// `pickInstallStageDurations` 前三段用 `randomInt` 取比例，第四段取 `1 - 前三段` 并夹到 `minStage4Ratio`。
// 归一化后按比例切分总时长，保证四段之和严格等于总时长
// `rawDurations` 每段套 `Math.max(1, ...)`，零时长会让 `stageDuration` 除零、缓动函数返回 NaN。
// `rawDurations[3]` 加上 `totalDurationMs - assignedDuration`，吸掉 `Math.floor` 误差，否则四段之和会偏离总时长。
// 返回元组顺序固定为四个阶段，调用方按位解构
function pickInstallStageDurations(
  totalDurationMs: number,
  template: InstallTemplate,
): [number, number, number, number] {
  const stage1Ratio =
    randomInt(template.stageDurationRatioRanges[0][0], template.stageDurationRatioRanges[0][1]) /
    100;
  const stage2Ratio =
    randomInt(template.stageDurationRatioRanges[1][0], template.stageDurationRatioRanges[1][1]) /
    100;
  const stage3Ratio =
    randomInt(template.stageDurationRatioRanges[2][0], template.stageDurationRatioRanges[2][1]) /
    100;
  const minStage4Ratio = template.stageDurationRatioRanges[3][0] / 100;
  const normalizedStage4Ratio = Math.max(minStage4Ratio, 1 - stage1Ratio - stage2Ratio - stage3Ratio);
  const ratioSum = stage1Ratio + stage2Ratio + stage3Ratio + normalizedStage4Ratio;
  const normalizedRatios: [number, number, number, number] = [
    stage1Ratio / ratioSum,
    stage2Ratio / ratioSum,
    stage3Ratio / ratioSum,
    normalizedStage4Ratio / ratioSum,
  ];
  const rawDurations: [number, number, number, number] = [
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[0])),
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[1])),
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[2])),
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[3])),
  ];
  const assignedDuration = rawDurations.reduce((sum, duration) => sum + duration, 0);
  rawDurations[3] += totalDurationMs - assignedDuration;
  return rawDurations;
}

// `createInstallProgressPlan` 先 `pickInstallTemplate` 与 `randomInt` 定总时长，再定 `stage1End`/`stage2End`/`stage3End`，最后 `pickInstallStageDurations` 切段。
// 阶段时间轴必须首尾相接，任一断点错位都会让进度回退
// 总时长夹在 `MIN_INSTALL_DURATION_MS` 与 `MAX_INSTALL_DURATION_MS` 之间，越界会让 `simulateInstallProgress` 的节奏失真。
// `stage1End`/`stage2End`/`stage3End` 依赖模板区间天然递增，`stages` 构造处不排序，乱序会让 `endAtMs` 时间轴交叠。
// `InstallProgressPlan` 含 `pauses[].consumed` 可变位，只有 `simulateInstallProgress` 单次持有，复用会让停顿不再触发。
function createInstallProgressPlan(): InstallProgressPlan {
  const template = pickInstallTemplate();
  const totalDurationMs = randomInt(
    MIN_INSTALL_DURATION_MS,
    MAX_INSTALL_DURATION_MS,
  );
  const stage1End = randomInt(template.stage1EndRange[0], template.stage1EndRange[1]);
  const stage2End = randomInt(template.stage2EndRange[0], template.stage2EndRange[1]);
  const stage3End = randomInt(template.stage3EndRange[0], template.stage3EndRange[1]);
  const [stage1Duration, stage2Duration, stage3Duration] =
    pickInstallStageDurations(totalDurationMs, template);

  const stages: InstallStagePlan[] = [
    {
      key: "warmup",
      startProgress: 0,
      endProgress: stage1End,
      startAtMs: 0,
      endAtMs: stage1Duration,
      easing: easeOutCubic,
    },
    {
      key: "accelerate",
      startProgress: stage1End,
      endProgress: stage2End,
      startAtMs: stage1Duration,
      endAtMs: stage1Duration + stage2Duration,
      easing: easeInOutCubic,
    },
    {
      key: "settle",
      startProgress: stage2End,
      endProgress: stage3End,
      startAtMs: stage1Duration + stage2Duration,
      endAtMs: stage1Duration + stage2Duration + stage3Duration,
      easing: easeInCubic,
    },
    {
      key: "finish",
      startProgress: stage3End,
      endProgress: 100,
      startAtMs: stage1Duration + stage2Duration + stage3Duration,
      endAtMs: totalDurationMs,
      easing: linear,
    },
  ];

  // `stage2To3PauseCount` 取 1~2，往 `pauses` 里塞 `triggerProgress` 落在 `phase2To3PauseStart`~`phase2To3PauseEnd` 的停顿。
  // `triggerProgress` 被 `clamp(..., stage2End + 1, stage3End - 3)` 夹住，越界会让停顿永远等不到推进。
  // 分段计算使用整数除法，保证多个停顿点不重叠
  // `pendingPause.consumed` 在首次命中后置 true，否则 `progress` 每加 1 都会重等同一段 `durationMs`。
  // `stage2To3PauseCount` 与 `stage2To3PauseDurationRange` 只改 `simulateInstallProgress` 观感，不影响 `update` 写入的启用列表。
  const stage2To3PauseCount = randomInt(1, 2);
  const phase2To3PauseStart = Math.min(stage2End + 2, stage3End - 4);
  const phase2To3PauseEnd = Math.max(phase2To3PauseStart, stage3End - 6);
  const pauses: InstallPausePlan[] = [];

  for (let index = 0; index < stage2To3PauseCount; index += 1) {
    const segmentStart =
      phase2To3PauseStart +
      Math.floor(((phase2To3PauseEnd - phase2To3PauseStart) * index) / stage2To3PauseCount);
    const segmentEnd =
      phase2To3PauseStart +
      Math.floor(
        ((phase2To3PauseEnd - phase2To3PauseStart) * (index + 1)) /
          stage2To3PauseCount,
      );

    pauses.push({
      triggerProgress: clamp(
        randomInt(segmentStart, Math.max(segmentStart, segmentEnd)),
        stage2End + 1,
        Math.max(stage2End + 1, stage3End - 3),
      ),
      durationMs: randomInt(
        template.stage2To3PauseDurationRange[0],
        template.stage2To3PauseDurationRange[1],
      ),
      consumed: false,
    });
  }

  pauses.push({
    // Bugfix: 之前尾段的停顿靠概率触发，偶发会完全错过“快完成但还要收尾”的重停感。
    // 这里改成在阶段 3 -> 4 交界前预排一个必定触发的重停点，让尾段节奏稳定可复现。
    triggerProgress: clamp(stage3End - randomInt(1, 2), stage2End + 1, 99),
    durationMs: randomInt(
      template.stage3To4PauseDurationRange[0],
      template.stage3To4PauseDurationRange[1],
    ),
    consumed: false,
  });

  return {
    totalDurationMs,
    stages,
    pauses,
  };
}

// `getInstallTargetProgressAtElapsed` 先用 `clamp(elapsedMs, 0, plan.totalDurationMs)`，`Date.now()` 抖动超界时按终点算。
// `plan.stages.find((stage) => clampedElapsed <= stage.endAtMs)` 取活动阶段，找不到时回退 `lastStage`。
// 找不到活动阶段时回退到最后一段，空数组则直接返回 100
// 阶段内耗时夹到零与阶段时长之间，避免缓动函数输入越界
// 返回值向下取整，调用方据此做逐点追赶
function getInstallTargetProgressAtElapsed(
  plan: InstallProgressPlan,
  elapsedMs: number,
): number {
  const clampedElapsed = clamp(elapsedMs, 0, plan.totalDurationMs);
  const lastStage = plan.stages[plan.stages.length - 1];
  if (!lastStage) {
    return 100;
  }
  const activeStage =
    plan.stages.find((stage) => clampedElapsed <= stage.endAtMs) ??
    lastStage;
  const stageDuration = Math.max(1, activeStage.endAtMs - activeStage.startAtMs);
  const stageElapsed = clamp(
    clampedElapsed - activeStage.startAtMs,
    0,
    stageDuration,
  );
  const easedProgress = activeStage.easing(stageElapsed / stageDuration);
  return Math.floor(
    activeStage.startProgress +
      (activeStage.endProgress - activeStage.startProgress) * easedProgress,
  );
}

// [资源] 该循环是唯一的进度写入口，外部只通过回调接收百分比
// `while` 每轮用 `nextProgressTarget` 与 `progress` 比较，落后才 `progress += 1` 并查 `plan.pauses`。
// `sleep` 前把 `pendingPause.durationMs` 与剩余时长取小，否则 `simulateInstallProgress` 会越过 `plan.totalDurationMs`。
// `elapsed >= plan.totalDurationMs` 时 `break`，再由末尾 `while (progress < 100)` 补齐。
// 循环内不读 React 状态，避免闭包持有过期值
async function simulateInstallProgress(
  provider: ZCodeProvider,
  setProgress: (provider: ZCodeProvider, progress: number | null) => void,
): Promise<void> {
  const plan = createInstallProgressPlan();
  const startedAt = Date.now();
  let progress = 0;

  setProgress(provider, progress);

  // [并发] 循环靠耗时判断退出，不依赖外部取消标志
  // `while (true)` 每轮最多 `progress += 1`，同一轮内连推多格会让 `setProgress` 跳号。
  // 停顿等待发生在推进之后，保证用户能看到停顿前的进度
  // `await sleep` 的入参取 `INSTALL_PROGRESS_TICK_MS` 与剩余时长的较小值，剩余不足时不再空转。
  // `simulateInstallProgress` 不做超时兜底，`plan.totalDurationMs` 上界已由 `createInstallProgressPlan` 卡死。
  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= plan.totalDurationMs) {
      break;
    }

    const nextProgressTarget = getInstallTargetProgressAtElapsed(plan, elapsed);
    if (progress < nextProgressTarget) {
      // Bugfix: 之前的百分比推进混杂了“目标曲线”和“随机停顿”两类职责，
      // 越调越难预测。这里拆成“计划目标 + 1% 追赶”模型，既能保证 0-100 不跳号，
      // 又能让四阶段节奏只由阶段曲线本身决定。
      progress += 1;
      setProgress(provider, progress);

      const pendingPause = plan.pauses.find(
        (pause) => !pause.consumed && progress >= pause.triggerProgress,
      );
      if (pendingPause) {
        pendingPause.consumed = true;
        await sleep(
          Math.min(
            pendingPause.durationMs,
            Math.max(0, plan.totalDurationMs - (Date.now() - startedAt)),
          ),
        );
      }

      continue;
    }

    const remaining = plan.totalDurationMs - elapsed;
    await sleep(Math.min(remaining, INSTALL_PROGRESS_TICK_MS));
  }

  while (progress < 100) {
    progress += 1;
    setProgress(provider, progress);
    await sleep(randomInt(30, 90));
  }
}

// `simulateUninstallDelay` 只 `sleep`，真正移除 provider 由 `uninstallProvider` 里的 `update` 完成。
// 卸载等待取 `MIN_UNINSTALL_DURATION_MS`~`MAX_UNINSTALL_DURATION_MS`，与安装的 5~10 秒保持同一量级。
// `simulateUninstallDelay` 不调 `setInstallProgressByProvider`，卸载期按钮靠 `disablingProvider` 显示禁用态。
// 不要在此加入失败注入，错误路径由调用方的 catch 承担
// `simulateUninstallDelay` 只等待，不改 `enablingProvider` 与 `disablingProvider`；副作用由调用方承担。
async function simulateUninstallDelay(): Promise<void> {
  await sleep(randomInt(MIN_UNINSTALL_DURATION_MS, MAX_UNINSTALL_DURATION_MS));
}

// [契约] 设置、加载态与刷新更新能力全部来自 useSettings，本 hook 不持有第二份设置
// enablingProvider 与 disablingProvider 互斥，同一时刻最多一个在变更
// `error` 只存最后一次文案，`installProvider`/`uninstallProvider` 入口各自 `setError(null)`。
// 进度表以 provider 为键，安装结束会删除对应条目
// 返回结构固定，新增动作时同步补充消费方
export function useBuiltinAgentCli() {
  const { settings, loading, refresh, update } = useSettings();
  const [enablingProvider, setEnablingProvider] = useState<ZCodeProvider | null>(null);
  const [disablingProvider, setDisablingProvider] = useState<ZCodeProvider | null>(null);
  const [installProgressByProvider, setInstallProgressByProvider] = useState<
    Partial<Record<ZCodeProvider, number>>
  >({});
  const [error, setError] = useState<string | null>(null);

  // [契约] 已启用列表由设置派生，不单独存一份 state
  // 依赖只有 settings，设置对象更新时列表才重算
  // 下游 isEnabled、getStatus 与两个变更回调都读这份列表
  // 不要在 memo 内过滤或排序，顺序即设置里的顺序
  // 删掉 memo 会让每次渲染都重建数组，击穿下游回调的依赖
  const enabledProviders = useMemo(
    () => getEnabledBuiltinAgentCliProviders(settings),
    [settings],
  );
  const activeMutatingProvider = enablingProvider ?? disablingProvider;
  const hasPendingMutation = activeMutatingProvider !== null;

  const isEnabled = useCallback(
    (provider: ZCodeProvider) => enabledProviders.includes(provider),
    [enabledProviders],
  );

  const getEffectiveProvider = useCallback(
    (provider: ZCodeProvider) => getEffectiveBuiltinAgentCliProvider(settings, provider),
    [settings],
  );

  // [契约] 状态由已启用列表与两个进行中的 provider 共同决定，不读取服务
  // 传入的 provider 与进行中的不一致时，状态仍要正确反映为未变更
  // 依赖包含两个进行中状态，任一变化都要重算
  // 不要在此写 state，它是纯查询
  // 新增状态枚举时同步扩充 resolveBuiltinAgentCliStatus
  const getStatus = useCallback(
    (provider: ZCodeProvider): BuiltinAgentCliStatus =>
      resolveBuiltinAgentCliStatus({
        provider,
        enabledProviders,
        enablingProvider,
        disablingProvider,
      }),
    [disablingProvider, enabledProviders, enablingProvider],
  );

  // [并发] 没有进行中的变更时任何 provider 都可操作
  // 有变更时只允许当前进行中的那个 provider，防止并发写设置
  // 依赖必须包含 activeMutatingProvider 与 hasPendingMutation
  // `canMutateProvider` 在 `installProvider` 与 `uninstallProvider` 开头各调一次，是 `update` 前的最后一道闸门。
  // 不要简化成只看 hasPendingMutation，那会锁死当前卡片
  const canMutateProvider = useCallback(
    (provider: ZCodeProvider) =>
      !hasPendingMutation || activeMutatingProvider === provider,
    [activeMutatingProvider, hasPendingMutation],
  );

  // `installProvider` 依次过 `canMutateProvider`、`requiresBuiltinAgentCliInstall`、`isEnabled`，任一步顺序颠倒都会重复安装。
  // 进度模拟完成后才写设置，保证动画与真实落盘顺序一致
  // `nextEnabledProviders` 由 `[...enabledProviders, provider]` 全量构造后交给 `update`，增量追加会漏掉并发写入的条目。
  // 失败时记录错误文案并重新抛出，让调用方能感知
  // `finally` 必须复位 `setEnablingProvider` 并清 `setInstallProgressByProvider`，跳过后界面永久停在安装中。
  const installProvider = useCallback(
    async (provider: ZCodeProvider) => {
      if (!canMutateProvider(provider)) {
        return;
      }

      if (!requiresBuiltinAgentCliInstall(provider) || isEnabled(provider)) {
        return;
      }

      setEnablingProvider(provider);
      setError(null);

      try {
        await simulateInstallProgress(provider, (targetProvider, progress) => {
          setInstallProgressByProvider((current) => {
            if (progress === null) {
              const { [targetProvider]: _ignoredProvider, ...restProgress } = current;
              return restProgress;
            }

            return {
              ...current,
              [targetProvider]: progress,
            };
          });
        });

        const nextEnabledProviders = [...enabledProviders, provider];
        await update({
          enabledBuiltinAgentCliProviders: nextEnabledProviders,
        });
      } catch (installError) {
        setError(
          installError instanceof Error
            ? installError.message
            : String(installError),
        );
        throw installError;
      } finally {
        setEnablingProvider((current) => (current === provider ? null : current));
        setInstallProgressByProvider((current) => {
          const { [provider]: _ignoredProvider, ...restProgress } = current;
          return restProgress;
        });
      }
    },
    [canMutateProvider, enabledProviders, isEnabled, update],
  );

  // [事务] 卸载同样先过并发闸门与启用判断，未启用时直接返回
  // 延迟模拟结束后才从列表里过滤掉目标 provider
  // 写设置后若本地偏好仍指向该 provider，立即回退到 glm
  // 失败路径记录错误并重新抛出，与安装保持一致
  // `uninstallProvider` 的 `finally` 只复位 `setDisablingProvider`，不碰 `installProgressByProvider`。
  const uninstallProvider = useCallback(
    async (provider: ZCodeProvider) => {
      if (!canMutateProvider(provider)) {
        return;
      }

      if (!requiresBuiltinAgentCliInstall(provider) || !isEnabled(provider)) {
        return;
      }

      setDisablingProvider(provider);
      setError(null);

      try {
        await simulateUninstallDelay();

        const nextEnabledProviders = enabledProviders.filter(
          (candidate) => candidate !== provider,
        );
        await update({
          enabledBuiltinAgentCliProviders: nextEnabledProviders,
        });

        // Bugfix: 卸载内置 CLI 后如果仍保留 localStorage 里的“最近一次选中的 provider”，
        // 新建 workspace / 新建草稿时默认 provider 还是会回到这个已卸载的值，
        // 菜单触发器看起来就像“它依然可用”。这里同步把持久化偏好回退到始终可用的 glm。
        // [失败路径] 只有本地偏好确实指向被卸载的 provider 时才回退，避免覆盖用户的新选择
        // 回退值是 glm，因为它始终可用，不会再次出现不可选状态
        // 回退发生在设置写入成功之后，避免写设置失败却已改偏好
        // `readLastSelectedAgentProvider` 是同步 `localStorage` 读取，异常在偏好模块内兜底，这里不包 try。
        // `installProvider` 不做 `persistLastSelectedAgentProvider` 回退，避免把用户新选的 provider 顶掉。
        if (readLastSelectedAgentProvider() === provider) {
          persistLastSelectedAgentProvider("glm");
        }
      } catch (uninstallError) {
        setError(
          uninstallError instanceof Error
            ? uninstallError.message
            : String(uninstallError),
        );
        throw uninstallError;
      } finally {
        setDisablingProvider((current) => (current === provider ? null : current));
      }
    },
    [canMutateProvider, enabledProviders, isEnabled, update],
  );

  return {
    settings,
    loading,
    refreshing: loading,
    error,
    enabledProviders,
    isEnabled,
    hasPendingMutation,
    activeMutatingProvider,
    canMutateProvider,
    getEffectiveProvider,
    getStatus,
    getInstallProgress: (provider: ZCodeProvider) =>
      installProgressByProvider[provider] ?? null,
    installProvider,
    uninstallProvider,
    refresh,
  };
}
