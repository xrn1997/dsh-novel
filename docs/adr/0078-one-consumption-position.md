# 阅读与听书共用一条消费位置

Status: superseded by 0093

阅读进度不再只是「阅读器读到哪」，而是阅读与听书共用的**消费位置**：播放层在同一个落盘节拍里写 `progress`（章 + 由段号换算的章内比例）与 `listen`（段号 + 播放参数），阅读器起播听书时跟随眼下看得见的位置。理由：用户对一本书只有一条「读到哪」的游标，两条互不相干的轨会让书架同时说两个位置，还能把正在听的人拽回更早的章。决定：`progress` 是唯一消费位置；`listen` 降级为听书细节轨；起播跟随阅读（`resume: 'archive'` 保留在播放层但无界面入口）；同书边听边读的视口跟随归 `ADR-0091`；「回阅读器」仍只站定不写；书架只显示一条进度。被否决：维持两条轨只保留手动桥；只存一份表示；双向连续同步；合成一个混合 body 原子写两轨。代价：段号与比例换算有损；每次落盘从一笔 PUT 变两笔；书架少了「听至第 N 章 · M 段」的细节读数。

锚点：`src/client/tts/listen-session.ts` 的 `ListenSession.writePosition` / `ListenPlatform.saveProgress`；`src/client/tts/player.ts` 的 `saveProgress`；`src/client/views/ReaderView.tsx` 的 `onListenPill`；`src/client/shelf-view-model.ts` 的 `shelfCardMeta`；`src/client/panel-shelf.ts` 的 `patchPanelShelfProgress`；`src/shared/wire.ts` 的 `ShelfProgress` / `ListenState`；`src/services/shelf.ts` 的 `Shelf.updateProgress` / `Shelf.updateListen`；`tests/client/tts-session.test.ts`；`tests/client/tts-player.test.ts`；`tests/client/tts-bar.test.tsx`；`docs/ui-spec.md` §3.6；`ADR-0070`、`ADR-0075`、`ADR-0091`、`ADR-0093`。
