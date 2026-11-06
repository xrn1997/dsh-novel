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
 *
 * 三条半径通道（裁决见 `ADR-0061` / `ADR-0063`）：**整本书读不出**走 `rejectBook`，**一份文档 / 一张资源**
 * 读不出走下面两个子类，**一条引用解不开**走 `EpubHrefError`。半径不进 catch 的写法：基类的
 * `instanceof` 会把已经收窄的子类一并接住，接住它的那一处就把「这一处坏」读成「这本书坏」——
 * 所以除归档层的 `wrapError`（只把非本层的异常披上本类的名）之外，本子树不许对基类做 `instanceof` 判定，
 * 要接住失败就按那个窄类接。
 */
export class EpubImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * **这一张资源**读不出来（格式不支持、容器损坏、超像素预算、被加密……）。
 *
 * 它是 `EpubImportError` 的子类，但含义相反一半：基类说「这本书作为一本书读不出」，本类只说
 * 「这一个资源读不出」——半径由类型带着，编排层因此可以只接住资源级的失败（该处不留 + 点名），
 * 而不必用消息文本猜失败属于哪一层。归档层连字节都取不出的那种失败**不是**本类：那是容器级事实。
 */
export class EpubResourceError extends EpubImportError {}

/**
 * **这一份内容文档**解不开（声明的编码与内容不符、XML 本身不合法、超节点/深度预算……）。
 *
 * 与资源级同理：主语是一份文档，落法是留空页加一条痕，而不是让整本书陪葬。字节连读都读不出
 * 的那种失败**不是**本类——那是容器级事实（`archive.ts` 的口径），仍按整本失败。
 */
export class EpubDocumentError extends EpubImportError {}

/**
 * **这一条引用解不开**（越出书根、含 NUL、反斜杠、坏百分号序列……）：主语是那条引用，不是这本书。
 *
 * 它刻意不是 `EpubImportError` 的子类：`resolveEpubHref` 是归档内寻址的唯一口，包层与正文层都走它，
 * 而两边的半径不同——包层一条声明解不开按书级拒收（在册待裁见 `ADR-0061`），正文层一条链接或
 * 一处插图解不开只作用在那一格。共用一个异常类的话，正文层只能靠 `instanceof` 基类去接，
 * 于是「引用解不开」与「这本书坏」在同一个 catch 里分不开；分开成两个类，各自接各自的。
 */
export class EpubHrefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * 整本拒收的**唯一出口**：`EpubImportError` 只能从这里出来（`bookError` 是它的构造面，供
 * 必须以 Promise 拒绝而非抛出的那两处用）。
 *
 * 为什么要具名函数而不是直接 `throw`：半径要数得着。名册门（`tests/services/epub-failure-radius.test.ts`）
 * 按这两个符号的调用点登记整本拒的位置，改一句报错措辞不该让门红，新增一处整本拒必须过名册与 ADR；
 * 直接抛类的话，名册只能去认消息文本里最长的散文，而那个锚点比它想钉住的判据还容易漂。
 */
export function bookError(message: string): EpubImportError {
  return new EpubImportError(message)
}

/** 见 `bookError`：抛出即整本拒 */
export function rejectBook(message: string): never {
  throw bookError(message)
}
