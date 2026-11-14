"use client";

// 语音输入组件: 原生 Web Speech API 与 MediaRecorder 降级双实现, 对外只暴露一个录音按钮
// INV-01 模式在组件生命周期内只探测一次, 三态取 speech-recognition, media-recorder, none；守住位置: detectSpeechInputMode 与 mode 的惰性 useState；改错故障: 渲染中途换模式, 已绑定的识别器与录音器各留一份, 麦克风被两条链路抢。
// INV-02 探测顺序固定为 SSR 短路, 原生识别, MediaRecorder 降级, none；守住位置: detectSpeechInputMode 的三段分支；改错故障: 支持识别的浏览器被误判成录音模式, 用户说完要等一整段上传才出字。
// INV-03 识别与录音两条链路互斥, 同一时刻最多一条在跑；守住位置: toggleListening 的 mode 分支；改错故障: 两条链路同时持有麦克风, 录音文件里混入识别期间的空白。
// INV-04 卸载必须停掉识别器与 MediaRecorder, 并停止全部音轨；守住位置: mode 与 lang 依赖的 effect 清理, 以及空依赖卸载 effect；改错故障: 标签页常驻录音指示灯, 麦克风被幽灵占用。
// INV-05 清理顺序固定为先解绑监听, 再 stop, 最后置空 ref；守住位置: 识别 effect 的 return 分支；改错故障: stop 触发的 end 回调写到已卸载组件上, 状态更新落在被销毁的节点。
// INV-06 按钮只在 isRecognitionReady 为真后可用, 识别实例未就绪一律禁用；守住位置: setIsRecognitionReady 与 isDisabled 判断；改错故障: 在构造完成前点击, 抛 InvalidStateError 且按钮长时间无反应。
// INV-07 MediaRecorder 只在 recording 状态才调用 stop；守住位置: 卸载 effect 与 stopMediaRecorder 的 state 判断；改错故障: 重复 stop 抛异常并中断后续清理, 音轨从此不再被释放。
// INV-08 录音启动失败一律降级为未在监听, 不把异常抛到渲染层；守住位置: startMediaRecorder 的外层 catch；改错故障: 权限被拒时组件抛错, 整块输入区白屏。
// INV-09 麦克风流必须登记到 streamRef, 且每条退出路径都停止其音轨；守住位置: handleStop, handleError 与卸载 effect；改错故障: 采集持续进行, 隐私指示灯不灭, 用户以为已经关掉。
// INV-10 音频分片只在 dataavailable 且 size 大于 0 时累积；守住位置: handleDataAvailable 的判断；改错故障: 空分片混入数组, 最终 Blob 体积虚高且解码失败。
// INV-11 每次开始录音前清空分片数组, 不复用上一段音频；守住位置: startMediaRecorder 里 audioChunksRef 的赋值；改错故障: 两次录音拼成一个 Blob, 转录结果里重复前半段。
// INV-12 转录期间必须置 isProcessing, 并在 finally 里复位；守住位置: handleStop 的状态对与 isDisabled；改错故障: 等待转录时按钮仍可点, 第二次录音覆盖同一份分片。
// INV-13 异步路径只通过 ref 读取回调, 保证拿到最近一次渲染的 prop；守住位置: onAudioRecordedRef 与 onTranscriptionChangeRef；改错故障: 异步返回时调用旧闭包, 转录文本写进已经换掉的父组件。
// INV-14 只把 isFinal 的结果交出去, 空串不触发回调；守住位置: handleResult 里的 isFinal 分支与末尾判空；改错故障: 中间结果被当作最终文本, 输入框出现半句并被反复改写。
// INV-15 识别错误与 end 事件都只复位 isListening, 组件内不弹错误提示；守住位置: handleError 与 handleEnd；改错故障: 一次网络抖动弹窗打断输入, 或按钮永远卡在录音态。
// INV-16 lang 变化会整只重建识别器, 创建与销毁必须成对；守住位置: effect 的依赖数组；改错故障: 切换语言后旧实例继续按旧语种出结果, 中英文互相串。
// INV-17 没有 onAudioRecorded 时录音模式直接禁用, 不提前申请麦克风；守住位置: startMediaRecorder 开头的早退与 isDisabled；改错故障: 点了按钮才弹权限, 用户在不知情的情况下授权。
// INV-18 按钮的三态图标与禁用条件严格对应内部状态, 不额外推断；守住位置: isProcessing 与 isListening 的 JSX 条件；改错故障: 图标显示可录音而实际正在转录, 用户反复点击却毫无反馈。
// 读代码时先分清在哪条链路: 识别走事件回调, 录音走媒体流与分片, 清理逻辑各占一个 effect。
// 改任何一条不变量前先想清楚清理路径, 语音组件的故障几乎都以麦克风常开或按钮卡死收场。
//
import { Button } from "../ui/button.js";
import { Spinner } from "../ui/spinner.js";
import { cn } from "../lib/utils.js";
import { MicIcon, SquareIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// 三态是全局唯一分流依据: 原生识别优先, 其次录音上传, 两者都没有才整个禁用
// [权衡] 刻意不提供 setMode, 模式属于环境事实, 组件内任何状态变化都不该改写它
type SpeechInputMode = "speech-recognition" | "media-recorder" | "none";

// props 直接继承 Button, 外观、尺寸与无障碍行为全部复用现有按钮, 不另造一套
// onAudioRecorded 是录音链路唯一出口: 收到 Blob 后由调用方上传, 返回文本再转给 onTranscriptionChange
export type SpeechInputProps = ComponentProps<typeof Button> & {
  onTranscriptionChange?: (text: string) => void;
  /**
   * Callback for when audio is recorded using MediaRecorder fallback.
   * This is called in browsers that don't support the Web Speech API (Firefox, Safari).
   * The callback receives an audio Blob that should be sent to a transcription service.
   * Return the transcribed text, which will be passed to onTranscriptionChange.
   */
  onAudioRecorded?: (audioBlob: Blob) => Promise<string>;
  lang?: string;
};

// 探测只读全局能力标记, 不构造实例也不申请权限, 因此放在 useState 初始化里执行是安全的
// [失败路径] SSR 下没有 window, 必须最先短路返回 none, 否则服务端渲染直接抛引用错误
const detectSpeechInputMode = (): SpeechInputMode => {
  if (typeof window === "undefined") {
    return "none";
  }

  // [权衡] Chrome 早先只暴露带 webkit 前缀的名字, Safari 同样带前缀, 两个名字都必须认
  // 用 in 判断而不是取值判断, 避免个别环境把属性挂成 undefined 时被误判为可用
  // 识别判定排在录音之前, 因为识别是流式的, 能识别就不该走先录整段再上传的慢路径
  if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    return "speech-recognition";
  }

  if ("MediaRecorder" in window && "mediaDevices" in navigator) {
    return "media-recorder";
  }

  return "none";
};

export const SpeechInput = ({
  className,
  onTranscriptionChange,
  onAudioRecorded,
  lang = "en-US",
  ...props
}: SpeechInputProps) => {
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  // 传函数而不是调用结果, 探测只在首次渲染执行一次, 之后不再重复读全局能力
  // state 只留 mode 这一份, 识别器与录音器实例都放 ref, 不参与渲染
  const [mode] = useState<SpeechInputMode>(detectSpeechInputMode);
  const [isRecognitionReady, setIsRecognitionReady] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const onTranscriptionChangeRef = useRef<
    SpeechInputProps["onTranscriptionChange"]
  >(onTranscriptionChange);
  const onAudioRecordedRef =
    useRef<SpeechInputProps["onAudioRecorded"]>(onAudioRecorded);

  // Keep refs in sync
  // 在渲染期直接写 ref 而不是放进 effect, 异步回调早于 effect 执行时也能拿到最新回调
  // [权衡] 这是受控组件之外唯一允许的渲染期副作用, 写入幂等且不会引发重渲染
  onTranscriptionChangeRef.current = onTranscriptionChange;
  onAudioRecordedRef.current = onAudioRecorded;

  // Initialize Speech Recognition when mode is speech-recognition
  // [资源] 这个 effect 完整拥有识别器: 构造、配置、绑定、登记就绪、解绑与 stop 全在内部完成
  // 依赖只有 mode 与 lang, isListening 刻意不进依赖, 否则每次状态翻转都会整只重建
  useEffect(() => {
    // 录音模式与 none 都不该创建识别器, 早退能避免在 Firefox 上凭空申请麦克风权限
    // 早退时不置 ready, 按钮据此保持禁用, 用户不会点到构造未完成的实例
    if (mode !== "speech-recognition") {
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    const speechRecognition = new SpeechRecognition();

    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = lang;

    const handleStart = () => {
      setIsListening(true);
    };

    const handleEnd = () => {
      setIsListening(false);
    };

    // 事件类型是原生 Event, 这里只做一次断言, 浏览器实际给的是带 results 与 resultIndex 的识别事件
    // 从 resultIndex 向后遍历: 之前的片段已经消费过, 从头扫会把同一句重复追加
    // 只累加 isFinal 结果, 中间结果会让输入框在说话过程中反复回退再改写
    const handleResult = (event: Event) => {
      const speechEvent = event as SpeechRecognitionEvent;
      let finalTranscript = "";

      for (
        let i = speechEvent.resultIndex;
        i < speechEvent.results.length;
        i += 1
      ) {
        const result = speechEvent.results[i];
        // Bugfix: Web Speech API 的结果列表在 noUncheckedIndexedAccess 下会被视为可能缺项，
        // 直接读取 result.isFinal / result[0] 会触发未定义报错。这里先判空，再按浏览器实际返回值继续处理。
        if (!result) {
          continue;
        }
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? "";
        }
      }

      if (finalTranscript) {
        onTranscriptionChangeRef.current?.(finalTranscript);
      }
    };

    const handleError = () => {
      setIsListening(false);
    };

    speechRecognition.addEventListener("start", handleStart);
    speechRecognition.addEventListener("end", handleEnd);
    speechRecognition.addEventListener("result", handleResult);
    speechRecognition.addEventListener("error", handleError);

    recognitionRef.current = speechRecognition;
    setIsRecognitionReady(true);

    // [资源] 先逐个解绑监听再 stop, 顺序反了会在 stop 触发的 end 回调里写已卸载组件的状态
    // 同时置空 ref 并复位 ready, 让下一次 effect 重建时拿到的是干净空位
    return () => {
      speechRecognition.removeEventListener("start", handleStart);
      speechRecognition.removeEventListener("end", handleEnd);
      speechRecognition.removeEventListener("result", handleResult);
      speechRecognition.removeEventListener("error", handleError);
      speechRecognition.stop();
      recognitionRef.current = null;
      setIsRecognitionReady(false);
    };
  // lang 变化必须整只重建, 因为语种只能在构造时设置, 无法热改
  // [权衡] 重建期间按钮短暂不可用, 比留着一个语种错误的实例继续吐结果更可控
  }, [mode, lang]);

  // Cleanup MediaRecorder and stream on unmount
  // [资源] 空依赖 effect 专门兜住卸载: 识别器只管识别, 录音器与媒体流都由这里收尾
  // 卸载时不等待 stop 回调完成, 可能丢掉最后一片音频, 这是有意为之: 宁可丢一次也不让麦克风常开
  useEffect(
    () => () => {
      // [失败路径] 只有 recording 才能 stop, inactive 或 paused 再调会抛 InvalidStateError 并打断后续清理
      // 用可选链判空, 首次录音前 ref 一直是 null, 直接读 state 会抛
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
    },
    []
  );

  // Start MediaRecorder recording
  const startMediaRecorder = useCallback(async () => {
    if (!onAudioRecordedRef.current) {
      return;
    }

    try {
      // [失败路径] 权限被拒、没有输入设备、被其他应用独占都在此处抛出, 统一由外层 catch 收敛为未在监听
      // 拿到流后立刻登记到 streamRef, 保证后续每条退出路径都能找到它并停止音轨
      // 只请求 audio, 不附加 video, 避免多弹一次摄像头授权
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      const handleDataAvailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // [事务] stop 之后先停全部音轨再转录, 顺序颠倒会让指示灯在等待转录期间一直亮着
      // 处理函数是 async, 但事件监听并不等待它完成, 这一次失败只影响本次结果
      const handleStop = async () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;

        // 类型写死 audio/webm 与 MediaRecorder 的默认编码对应, 调用方据此决定上传与解码方式
        // [权衡] 不用分片自带类型, 因为部分浏览器返回空 type, 最终 Blob 会丢掉 MIME 提示
        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm",
        });

        if (audioBlob.size > 0 && onAudioRecordedRef.current) {
          // [并发] 置 processing 会立刻禁用按钮, 转录未返回前无法开始第二次录音
          // 只有真有音频且回调存在时才进入这个态, 空录音不会让按钮空转
          setIsProcessing(true);
          try {
            const transcript = await onAudioRecordedRef.current(audioBlob);
            if (transcript) {
              onTranscriptionChangeRef.current?.(transcript);
            }
          } catch {
            // Error handling delegated to the onAudioRecorded caller
          // [事务] finally 保证无论转录成功、返回空串还是抛错, 都会退出 processing
          // 漏掉这一步的后果是按钮永久禁用, 用户只能刷新页面才恢复
          } finally {
            setIsProcessing(false);
          }
        }
      };

      const handleError = () => {
        setIsListening(false);
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      };

      mediaRecorder.addEventListener("dataavailable", handleDataAvailable);
      mediaRecorder.addEventListener("stop", handleStop);
      mediaRecorder.addEventListener("error", handleError);

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }, []);

  // Stop MediaRecorder recording
  const stopMediaRecorder = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsListening(false);
  }, []);

  // [并发] 分发只看 mode 与 isListening 两个快照, 同一帧内连点两次会落进同一条分支
  // 识别链路在 start 时可能把异常抛到点击处理器, 录音链路则把失败吃在内部 catch, 两者行为并不对称
  const toggleListening = useCallback(() => {
    if (mode === "speech-recognition" && recognitionRef.current) {
      if (isListening) {
        recognitionRef.current.stop();
      } else {
        // 连续两次 start 会抛 InvalidStateError, 必须等 end 之后才能再次开始
        // 所以监听状态跟着 start 与 end 事件走, 而不是点击后立即假设已经开始
        recognitionRef.current.start();
      }
    } else if (mode === "media-recorder") {
      if (isListening) {
        stopMediaRecorder();
      } else {
        startMediaRecorder();
      }
    }
  }, [mode, isListening, startMediaRecorder, stopMediaRecorder]);

  // Determine if button should be disabled
  // 禁用来源汇总一处: 环境不支持、识别器未就绪、录音模式缺回调、正在转录
  // 识别模式看 ready 而不是 isListening, 因为实例构造与实际就绪之间存在窗口
  // isProcessing 优先级最高, 它可能与 isListening 短暂同时为真, 此时禁止任何点击
  const isDisabled =
    mode === "none" ||
    (mode === "speech-recognition" && !isRecognitionReady) ||
    (mode === "media-recorder" && !onAudioRecorded) ||
    isProcessing;

  return (
    <div className="relative inline-flex items-center justify-center">
      {/* Animated pulse rings */}
      {isListening &&
        [0, 1, 2].map((index) => (
          <div
            className="absolute inset-0 animate-ping rounded-full border-2 border-red-400/30"
            key={index}
            style={{
              animationDelay: `${index * 0.3}s`,
              animationDuration: "2s",
            }}
          />
        ))}

      {/* Main record button */}
      <Button
        className={cn(
          "relative z-10 rounded-full transition-all duration-300",
          isListening
            ? "bg-destructive text-white hover:bg-destructive/80 hover:text-white"
            : "bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground",
          className
        )}
        disabled={isDisabled}
        onClick={toggleListening}
        {...props}
      >
        {isProcessing && <Spinner />}
        {!isProcessing && isListening && <SquareIcon className="size-4" />}
        {!(isProcessing || isListening) && <MicIcon className="size-4" />}
      </Button>
    </div>
  );
};
