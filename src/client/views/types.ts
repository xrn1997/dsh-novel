/**
 * client 侧 API 值形状：全部来自 wire 契约（src/shared/wire.ts）——与 Node 半共用同一份定义，
 * 漂移即编译错误。
 * 本文件只是再导出桶：保持既有 `import … from './views/types.js'` 路径可用；改形状去 shared，别在这里加第二份。
 * type-only：纯度门不涉（且 shared 本身零依赖，可安全 inline 进 client bundle）。
 * 唯一的例外是 `LinkRole`（文件末尾那行）：它不是第二份形状，而是**从 wire 的 link 节点派生**的别名——
 * 消费方（阅读会话 / 视图）不该为了拿它去反向依赖某个视图组件（wire 才是形状主人）。 */
import type { ContentNode } from '../../shared/wire.js'

export type {
  // 枚举与状态
  SourceStatus, SourceContentKind, ProbeErrorCode,
  // 书源面
  SourcePublic, ProbeResult, JobState, JobIssue,
  // 阅读面
  SearchHit, SearchGroup, ChapterEntry, BookDetail,
  // 书架面
  ShelfProgress, ShelfBook, ShelfEntry,
  // 本地图文面（EPUB 导入）：正文树 / 阅读目标 / 目录树 / 导入回执
  ChapterContent, ContentNode, ContentTag, ReadingTarget, NavigationItem, BookNavigation,
  LocalImportWarning, LocalImportResponse,
  // 信封
  ApiEnvelope, ApiErrorBody,
} from '../../shared/wire.js'

/** 内部链接角色（normal 交叉引用 / noteref 脚注引用 / backlink 返回链接），从 wire 的 link 节点派生 */
export type LinkRole = Extract<ContentNode, { kind: 'link' }>['role']
