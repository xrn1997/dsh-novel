/**
 * EPUB 导入子树的**异常类**（唯一主人）。
 *
 * 为什么不复用服务层的 LocalImportError：它住在 `localbooks.ts`（本地书门面 / 书架那一层），
 * 而本子树是纯解析与存储层——仓内依赖只有 `shared/wire` 的类型，不认识书架也不认识 HTTP 面。
 * 让子树反向 import 服务层的异常类，等于把「本地书服务」与「EPUB 解析」互相绑死，谁都不能单独测；
 * 分层方向因此是单向的（门面 → 子树，永不反向）。
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
