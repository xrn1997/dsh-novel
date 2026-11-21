# 在线阅读是独立 module；门面只留本地分流与跨面动词

Status: superseded by 0047

目录与正文的缓存键、目录在途去重、代际、翻页闸、subContent 与空正文策略此前藏在 `ReadingService` 的私有方法里。现在这些语义归 `online-reading`，门面只做本地书分流与委托；在途表只服务目录（单章在途由阅读会话保证）。边界：本地书目录/正文仍归门面与 `LocalBooks`；搜索、发现、书架、导入、探针仍归 `ReadingService`；缓存有效性仍由 `cache-epoch` 给。被否决：按面拆成多个小 module（目录与正文共享代际、缓存与翻页语义）；把本地书也塞进 `online-reading`（它会扩大 interface）。

锚点：`src/services/online-reading.ts` 的 `OnlineReading`；`tests/services/online-reading.test.ts`；`src/services/reading.ts` 的 `getToc` / `getChapterContent`。
