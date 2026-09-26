/**
 * EPUB 导入子树的**异常类**（唯一主人）。
 *
 * 为什么不复用服务层的 LocalImportError：`localbooks.ts` 的 `publishEpub` 要 import epub 导入器的
 * `importEpub`，若 epub 子树反过来 import `localbooks.ts` 的异常类，就成环（localbooks → epub/import → epub/archive → localbooks）。
 * 环不是风格问题：它让「本地书服务」与「EPUB 解析」互相绑死，谁都不能单独测。
 *
 * 类目映射（本类 → `local-import` 类目 / HTTP 400）由服务层分类表接（`services/errors.ts` 的 `classify`），
 * 本子树自己不碰 HTTP 口径。本类只保证**每次失败都点名出问题的条目/资源**：EPUB 导入失败
 * 十有八九是某一个条目的问题，不点名的报错让用户与日志都无从下手。
 */
export class EpubImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}
