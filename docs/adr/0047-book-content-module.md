# 书内容读面独立成 module；门面只留跨面动词

Status: accepted

目录、导航与正文的本地/在线分流此前散在 `ReadingService` 的三个读动词里，正文文字规约又只挂在在线阅读那条路上——本地 TXT 把 CRLF 与连续空行原样交给导出与 AI。现在分流与文字规约收进 `services/book-content.ts` 的 `BookContent`，门面只委托。ADR 0043 已被本篇取代；仍成立的「在线阅读独立成 module」由本篇承接。

## 决定

- `BookContent` 收 `LocalBooks` / `OnlineReading` 两个适配器：目录、导航、正文按来源分流只在这一处；三个读动词不再各自判 `__local__`。
- 正文 `text` 出口统一过 `chapter-content.ts` 的 `normalizeChapterText`：本地 TXT 与在线正文同一份行规约，幂等；EPUB 的 rich 树原样通过，不解释结构。`chapterContentToText` 的 text 分支调用同一函数，不另立第二份算式。
- 在线阅读的缓存、目录在途去重、翻页、subContent 与空正文策略仍归 `OnlineReading`；本地包内解析仍归 `LocalBooks`；缓存有效性仍归 `cache-epoch`。门面保留搜索、发现、书架、导入、登录、详情等跨面动词。

## 边界

- 来源**展示**判据（门面的 `sourceNameOf`、书架的本地筛选）仍按 `LOCAL_SOURCE_ID` 判来源身份；那是呈现层事实，不是内容读取分流。
- `book-content` 不拥有取数语义：在线缓存与翻页、本地文件解析都不搬进来。

## 被否方案

- 把本地书也塞进 `OnlineReading`：在线那条只认识 HTTP 与文件缓存，本地适配器会扩大它的 interface。
- 保留门面三处分流、只把文字规约抽出来：新读动词又会各判一次来源，分流仍有两个主人。
- 把行规约抄成两份实现（门面一份、书内容读面一份）：两处会漂移；唯一实现住 `chapter-content.ts`，两个应用点都只调用它。

锚点：`src/services/book-content.ts` 的 `BookContent`；`src/services/chapter-content.ts` 的 `normalizeChapterText` / `chapterContentToText`；`src/services/reading.ts` 的 `getToc` / `getNavigation` / `getChapterContent`；`tests/services/book-content.test.ts`；`tests/services/chapter-content.test.ts`；`docs/adr/0043-online-reading-module`。
