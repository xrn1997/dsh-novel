# 书架读取面与落架账归面板期投影；其余浏览器半仍只留可丢弃投影

Status: accepted

书架读取面、落架账与筛选/关键字此前没有同一个家：ShelfView 每次挂载整取、ReaderSession 为答一个在架布尔再整取、搜索落架账只活组件挂载期；切去阅读器再回来，行上又写「＋ 加书架」。现在这三样收进 `client/panel-shelf.ts` 的面板期投影：挂载拉一次、加架并入落架账、删除对账，面板卸载即丢；业务真相仍在服务端。其余边界不变——浏览器半只留可丢弃投影，跨卸载现场（视图内路由、偏好、任务面镜像、瞬态队列、搜索轮次）仍归各自的模块级 store / 观察通道。

## 决定

- 书架读取面 + 落架账 + 筛选/关键字住一个模块级 store；挂载 `loadPanelShelf` 重取，加架成功 `markPanelShelfLanded`（搜索、书城与阅读器入架三处调用方），删除成功 `removePanelShelfBooks` 对账；`landed` 以服务端书架列表为基线，与写成功的架位取并集。在途读面按代际丢弃：面板卸载、删除对账与**新记入的加架**都作废起始更早的响应（删前/加前快照不许把书架读数打回去）；同一发地址第二次记入不再抬代际——早于第一次记入的那些读面那时已经作废过了。
- 阅读器向投影问在架读数与**恢复进度**（`ensurePanelShelf`；有在途刷新先等它落地，投影缺当前书或上次读面失败时重取一次）；搜索结果页挂载时向同一个 `ensurePanelShelf` 要**整份基线**（不带当前书身份）——`routeStore` 跨卸载存活而投影随面板清空，重开面板直接落在结果页时不能指望书架 tab 或阅读器替它取。落架账与书架读取面同住一份，「都加架」与行上「＋ 加书架」读同一份。
- 搜索轮次、任务快照、瞬态队列不搬进这个 store。ADR 0023 已被本篇取代，仍成立的三条裁决由本篇承接：**轮次身份与游标不可分开**（每个回包先验 `job.id`；旧观察者跟随最近一轮；关键词不是身份）；**反馈位置就是点击位置**（秒级乐观操作不进全局泳道，失败回滚并带行锚点）；**色值与尺寸只准住 token 层**（视图与逻辑层不内联颜色字面量）。

## 被否方案

- **每个视图各取一份（旧形态）**：三个读者三份生命周期，落架账随卸载蒸发，阅读器为布尔再取全表。
- **不建投影、继续组件 state**：切 tab 就丢筛选与账；搜索页重挂载后又把已在架的书写成「＋ 加书架」。
- **把所有业务真相搬进 store**：会把搜索轮次与任务镜像也变成第二份真相，和本篇承接的轮次身份裁决冲突。

锚点：`src/client/panel-shelf.ts` 的 `panelShelf` / `loadPanelShelf` / `ensurePanelShelf` / `readPanelShelf` / `markPanelShelfLanded` / `removePanelShelfBooks` / `resetPanelShelf` / `setPanelShelfFilter` / `setPanelShelfKeyword`；`src/client/search-landing.ts` 的 `useSearchLanding`；`src/client/views/NovelView.tsx` 的卸载清理；`src/client/views/ShelfView.tsx`；`src/client/views/CityBookSheet.tsx` 的 `addToShelf`；`src/client/views/ReaderView.tsx` 的 `fetchShelf` / `addSeat`；`src/client/views/SearchView.tsx` 的挂载基线；`tests/client/panel-shelf.test.ts`；`tests/client/search-landing.test.tsx`；`tests/client/city-view.test.tsx`；`tests/client/views-wiring.test.tsx`；`CONTEXT.md`「面板书架投影」。
