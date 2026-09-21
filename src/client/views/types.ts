/**
 * client 侧 API 值形状：全部来自 wire 契约（src/shared/wire.ts）——与 Node 半共用同一份定义，
 * 漂移即编译错误。
 * 本文件只是再导出桶：保持既有 `import … from './views/types.js'` 路径可用；改形状去 shared，别在这里加第二份。
 * type-only：纯度门不涉（且 shared 本身零依赖，可安全 inline 进 client bundle）。
 */
export type {
  // 枚举与状态
  SourceStatus, SourceContentKind, ProbeErrorCode,
  // 书源面
  SourcePublic, ProbeResult, JobState, JobIssue,
  // 阅读面
  SearchHit, SearchGroup, ChapterEntry, BookDetail,
  // 书架面
  ShelfProgress, ShelfBook, ShelfEntry,
  // 信封
  ApiEnvelope, ApiErrorBody,
} from '../../shared/wire.js'
