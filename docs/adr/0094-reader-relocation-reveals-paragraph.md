# 回阅读器按段号精确落位，不按章内比例恢复

Status: accepted

`ADR-0078` 让「回阅读器」走一次性重定位现场，实现却把段号换成段数比例、再由阅读器按像素比例恢复——同一件事在阅读器里已有按 `[data-pidx]` 找段的精确路径。决定：交接现场直接带**章 + 段号**，阅读器用一个 `reveal` 按段块落位；回阅读器不写 `progress`，定位 / 跟随仍写。落点对齐由 `ADR-0096` 统一为带顶。

## 背景

「把阅读器带到正在念的段」在代码里有两条实现：迷你条切回阅读器时，`requestReaderRelocation` 把段号按 `paragraphRatio` 换成段数比例，`ReaderSession.open` 再用 `anchorTop` 按像素比例恢复；阅读器内的定位按钮则用 `listenParagraphElement` 找 `[data-pidx]` 块并居中。前一条落在「比例对应的像素」，不是段首；段高不等或长段被二次切成多个播放单元时，两者差得很远。一次性现场还只活在播放层里，`ReaderView` 为 StrictMode 双挂载再留一份 `relocationRef`——同一意图有第二份状态。

## 决定

1. **交接 target 是章 + 段号**：`ReaderRevealTarget` = `{ index, paragraphIndex }`；`requestReaderRelocation` / `takeReaderRelocation` 原样携带，不再换算成比例。
2. **开书只按章站定**：阅读器收到现场后，`ReaderSession.open` 用 `{ chapterIndex, offsetRatio: 0 }` 走 `restore`（不写 `progress`），把目标章载进来并站到章首。
3. **精确段由一个 `reveal` 落位**：`ReaderSession.reveal` 收到章 + 段号后，等目标章 DOM 提交，再由 `ReaderPort.targetOffsetOfParagraph` 量块，按 `mode` 的 `locate` / `follow` 写一次 `scrollTop`；落点统一对齐到顶条下方的带顶，并按 `write` 走 `commit('jump')` 或 `commit('restore')`。
4. **回阅读器 `write: false`**：这一跳只站定、不写消费位置；定位按钮与跟读 `write: true`。
5. **定位与跟读共用同一条 reveal**：视图不再维护 `pendingLocateRef` / `followJumpRef` / 章节到货后的落位分支；目标章未载由 `reveal` 自己载，DOM 未提交由 `afterRender` 的 `settleReveal` 收口。
6. **测量口只加一格**：`ReaderPort` 增可选的 `targetOffsetOfParagraph`，由 `client/reader-geometry.ts` 实现；段落命中判据从 `client/tts/reading-position.ts` 搬到 `client/reader-paragraph.ts`。
7. **落位排在滚动补偿之后**：`afterRender` 先结 `settleJump`、重测锚点、结前插 / 裁章补偿，再 `settleReveal`。

## 边界

- reveal 只服务听书定位 / 跟随 / 回阅读器；目录与内链仍走 `requestJump` / `settleJump` 的章 + 节点锚点路径，两套 target 不合并。
- `write: false` 只表示这一跳不写 `progress`；它仍会让会话的 `position` 站到目标段。
- 回阅读器取的是**点击那一刻**的章段快照；若听书在开书窗口里继续推进，后续跟读 effect 会按 live 段再 reveal 一次。
- 目标章载入失败时清掉 `pendingReveal`，失败后果与 `settleJump` 同半径。
- 不新增「回到上次听书处」入口；`resume: 'archive'` 仍无界面入口。

## 代价

- `ReaderSession` 多一个待落位 target 与一次「DOM 提交后重测」；DOM 层多一个可选测量口。换来的是一条可解释的落位次序。
- 回阅读器首屏可能先看到章首、下一拍才顶对齐到段（章未载时）；目标章已在 DOM 时是当场落。
- 快照与 live 段在开书窗口里可能短暂不一致；跟读负责收敛。

## 被否方案

- 继续用比例恢复：段高不等时落不到段首；两套口径之间的有损往返。
- 在视图里保留 pendingLocate / followJump 账：与 `pendingReveal` 各记一份，失败重试与「用户接管」要逐处对齐。
- 把目标居中后的视口顶当听书位置写进 `progress`：居中会把视口顶抬到目标段之前。
- 用 `scrollIntoView`：会连可滚祖先一起滚，越过阅读器自己的滚动容器。
- 把段落命中判据留在 `tts/`：阅读几何与高亮都要它，放在 `client/reader-paragraph.ts` 才不让阅读器反向依赖听书模块。

## 承接

`ADR-0078` 的「回阅读器只站定不写」由本篇的 `write: false` 承接；消费位置的所有权另见 `ADR-0093`。

锚点：`src/client/reader-session.ts` 的 `ReaderRevealTarget` / `reveal` / `settleReveal`；`src/client/reader-geometry.ts` 的 `targetOffsetOfParagraph`；`src/client/reader-paragraph.ts` 的 `paragraphSlotOf` / `listenParagraphElement`；`src/client/views/ReaderView.tsx` 的 `relocationRef` / `locateListen`；`src/client/tts/follow-controller.ts` 的 `onRelocation` / `onPlayback`；`src/client/tts/listen-session.ts` 的 `requestReaderRelocation` / `takeReaderRelocation`；`tests/client/tts-mini.test.tsx`；`tests/client/tts-bar.test.tsx`；`docs/architecture.md` 的「跟读高亮与视口跟随」行；`ADR-0078`、`ADR-0091`、`ADR-0093`、`ADR-0096`。
