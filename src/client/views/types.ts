/**
 * client 侧 API 值形状：全部来自 wire 契约（src/shared/wire.ts）——与 Node 半共用同一份定义，
 * 漂移即编译错误。
 * **旧路径兼容桶，不是 client 值形状的入口**：只为既有 `import … from './views/types.js'` 继续可用，
 * 清单不承诺完备；新代码要值形状直接 import `../../shared/wire.js`，别在这里登记，更别在这里加第二份。
 * type-only：纯度门不涉（且 shared 本身零依赖，可安全 inline 进 client bundle）。 */
export type {
  // 枚举与状态
  SourceStatus, SourceContentKind, ProbeErrorCode,
  // 书源面
  SourcePublic, ProbeResult, JobState, JobIssue,
  // 阅读面
  SearchHit, SearchGroup, ChapterEntry, BookDetail,
  // 按书视图（呈现层派生）：上限常量 SEARCH_BOOKS_CAP 是**值**，不走这个类型桶，直接从 shared/wire 引
  MergedBook, MergedSource,
  // 书架面
  ShelfProgress, ShelfBook, ShelfEntry,
  // 本地图文面（EPUB 导入）：正文树 / 阅读目标 / 目录树 / 导入回执 / 链接角色
  ChapterContent, ContentNode, ContentTag, LinkRole, ReadingTarget, SupplementTarget, NavigationItem, BookNavigation,
  LocalImportWarning, LocalImportResponse,
  // 信封
  ApiEnvelope, ApiErrorBody,
} from '../../shared/wire.js'
