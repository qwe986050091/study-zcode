// ============================================================
// Read State Contract
// ============================================================
// read-before-edit 状态的外形：记录"模型看过这个文件的哪一部分、内容是什么"。生产者是 Read
// 的 handler（成功读取后写入 ReadFileStateMap，key = 路径 + offset + limit）；消费者是
// Edit/Write——它们据此确认模型确实看过当前内容，并在内容被截断时拒绝改写。
// 只读边界：它只是本地缓存/诊断数据，不进入模型可见输出，也不参与跨进程协议。
// 三条口径：缓存命中时返回 file_unchanged 桩而不重读；isPartialView 只表示输出被 token cap
// 截断（range view 不算）；offset/limit 界定模型实际看过的窗口，缺省表示从第 1 行读到末尾。

export interface ReadFileState {
  // 文件路径（写入时的原始/规范化路径）；同一文件的不同写法应落到同一条目。
  path: string;
  // 读取时的文件修改时间，epoch 毫秒；用于快速判断磁盘内容是否在读取后变化。
  mtime: number;
  // 读取时的内容快照；Edit 用它定位 old_string，也是"读过"这一事实的载体。
  content: string;
  // 读取起点（行偏移）；与 limit 构成 range view，不等价于 partial view。
  offset?: number;
  // 读取行数上限；缺席表示读到文件末尾。
  limit?: number;
  // 只表示"输出被 token cap 截断"：为真时模型看到的内容不完整，Write/Edit 必须拒绝。
  // range view（offset/limit 窗口）不会把它置真。
  isPartialView: boolean;
  // 读取发生时间；仅用于诊断/排序，陈旧性判定以 mtime 与 size/revision 为准，不刷新它。
  readAt: Date;
}
