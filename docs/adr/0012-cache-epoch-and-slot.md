# 缓存有效性靠「代际 + 槽位」入文件名，不做删除式失效；章名进槽位、URL 不进

Status: accepted

两条正交的缺陷各自挡：「规则变了」与「站点侧目录变了」。**代际入文件名**：按引擎面细分的规则指纹 + baseUrl 算出代际，**写进缓存文件名**，不删除旧缓存——同址替换复用 `sourceId` 保书架引用，于是「身份没变」曾被当成「内容仍有效」，而全仓没有清缓存出口、阅读器也从不发 `refresh=1`，脏命中是永久的；入文件名后，在途请求写的是起飞时那个代际的文件名，旧在途写回自动无害。指纹**刻意不含** `auth`（登录态刷新会让整源缓存全灭）。**正文槽位 = 代际 + 章名**：正文曾按章序存，前面插一章则全体位移，旧文件端给读者的是另一章；章名只存在于目录，所以 `getChapter` 的目录读取必须上移到缓存读取之前；带时效 token 的站点每次刷目录都换 url，故**不含章节 url**。接受的代价：目录缺失（首次或被 LRU 淘汰）时一次章读会退化成一次目录抓取；越界章序先抛 `ChapterNotFoundError`；注入脚本的 `book.name` / `author` 取自书架，改书架书名后旧正文照样命中、吐旧书名（记录不修）；代际只覆盖规则、不覆盖代码版本。被否决：删除式失效、`JSON.stringify(rules)` 整体入指纹、槽位含章节 url、只靠代际。看起来矛盾但已写明不矛盾的一处：正文代际同时收目录面字段（正文的输入是目录的产物）——那里排除的是**站点侧** url 抖动，这里是**规则侧**的 url 变更。

锚点：`src/services/cache-epoch.ts`（`rulesEpoch` / `contentSlot` / `EpochImpact` / `FACES_OF`）；`src/services/cache.ts`；`src/services/online-reading.ts` 的 `OnlineReading`；`src/services/reading.ts` 的 `getChapter`；`src/services/source-eval.ts` 的 `bookMirrorOf`；`CONTEXT.md`「缓存代际」「正文槽位」；`tests/services/cache-epoch.test.ts`。
