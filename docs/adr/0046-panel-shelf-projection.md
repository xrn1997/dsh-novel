# 书架读取面与落架账归面板期投影；其余浏览器半仍只留可丢弃投影

Status: accepted

书架读取面、落架账与筛选/关键字此前没有同一个家（ShelfView 每次挂载整取、ReaderSession 为答一个在架布尔再整取、搜索落架账只活组件挂载期）。现在收进 `client/panel-shelf.ts` 的面板期投影：挂载 `loadPanelShelf` 重取，加架成功 `markPanelShelfLanded`，删除成功 `removePanelShelfBooks` 对账；`landed` 以服务端书架列表为基线，与写成功的架位取并集；在途读面按代际丢弃（面板卸载、删除对账与新记入的加架都作废更早的响应）；阅读器经 `ensurePanelShelf` 问在架读数与恢复进度，搜索结果页挂载时向同一个口要整份基线。落架账与书架读取面同住一份。搜索轮次、任务快照、瞬态队列不搬进这个 store；`ADR-0023` 仍成立的三条裁决由本篇承接（轮次身份与游标不可分开、反馈位置 = 点击位置、色值与尺寸只准住 token 层）。被否决：每个视图各取一份；不建投影、继续组件 state；把所有业务真相搬进 store。

锚点：`src/client/panel-shelf.ts`（`panelShelf` / `loadPanelShelf` / `ensurePanelShelf` / `readPanelShelf` / `markPanelShelfLanded` / `removePanelShelfBooks` / `resetPanelShelf` / `setPanelShelfFilter` / `setPanelShelfKeyword`）；`src/client/search-landing.ts` 的 `useSearchLanding`；`src/client/views/NovelView.tsx` 的卸载清理；`src/client/views/ShelfView.tsx`；`src/client/views/CityBookSheet.tsx` 的 `addToShelf`；`src/client/views/ReaderView.tsx` 的 `fetchShelf` / `addSeat`；`src/client/views/SearchView.tsx`；`tests/client/panel-shelf.test.ts`；`tests/client/search-landing.test.tsx`；`tests/client/city-view.test.tsx`；`tests/client/wiring-search.test.tsx`、`tests/client/wiring-reader.test.tsx`；`CONTEXT.md`「面板书架投影」。
