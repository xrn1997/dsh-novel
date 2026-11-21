# 阅读器在场时消费位置归阅读器，播放层只写听书细节

Status: accepted

`ADR-0078` 把 `progress` 定为阅读与听书共用的消费位置，并让播放层在每个落盘节拍里写它；跟读落地后阅读器也在写同一个字段，两个自动写者还用两套比例公式。决定：**本书的阅读器子树在场时，`progress` 归阅读会话；播放层只写 `listen`。阅读器不在场时，播放层才补写 `progress`。**

## 背景

`ADR-0078` 的设计前提是「同一本书同一时刻只有一个自动写者」。`ADR-0091` 把跟读跟随做进阅读器后，这个前提不再成立：播放推进触发阅读器滚动，阅读会话按像素写 `progress`（`ratioWithin`），播放层按段数写 `progress`（`paragraphRatio`）。同一段在段高不等或长段被二次切成多个播放单元时是两个不同的数，两条 2s 防抖谁后落盘取决于 timer 顺序，服务端 last-write-wins；书架卡片因此可能在同一段上看到两个位置来回跳。

## 决定

1. **`progress` 仍是唯一的消费位置**：形状与读者不变；`listen` 仍是听书细节轨（段号 + 播放参数），不替代 `progress`。
2. **所有权按书键与阅读器子树在场判定**：`ListenPlatform` 新增 `readerPresent(bookKey)` 缝；生产实现读 `reader-present.ts` 的在场书键集合。返回真时，播放层的 `writePosition` 只写 `listen`。
3. **阅读器不在场时播放层写两笔**：迷你条听书、阅读器已卸载、阅读器开着另一本，都属于这一格；`progress` 由播放层按段号 → 比例补。
4. **在场读数失败按不在场处理**：`readerPresent` 抛错只让这一次多写一笔 `progress`，不阻断 `listen` 落盘。
5. **不改变跟读**：阅读器在场时它按真实视口 / 精确段写 `progress`；读者让位后写的是读者所在位置。
6. **回阅读器仍只站定不写**：精确段落位见 `ADR-0094`；那条走 `commit('restore')`。

## 边界

- 阅读器在场但读者在看别处：`progress` 跟读者的阅读位置，不跟音频；音频位置在 `listen` 里。
- 阅读器撤销时播放层不一定立刻补一笔：下一段推进、暂停、停止或关页时按正常节拍写。
- 同一本书的阅读器子树撤掉、另一本书的阅读器在场：按本书的书键判。
- `listen` 的写者仍只有播放层；阅读器不写听书细节。

## 代价

- 阅读器开着听书时，书架 `progress` 可能落后音频若干段（它跟视口）；`listen` 才是精确续听现场。
- 阅读器在场期间播放层少写一笔 `progress`；若阅读器一直没有滚动，这一段期间 `progress` 不动。
- 所有权规则引入一个平台缝；测试要注入 `readerPresent`。

## 被否方案

- 保留两个写者、只统一比例公式：谁拥有这一拍仍没有主人。
- 播放层永远不写 `progress`：迷你条听书、阅读器不在场时书架游标不前进。
- 播放层永远写 `progress`：本决定之前的现状，两套公式抢同一字段。
- 按时间戳 / 版本号做客户端 last-write-wins：只把竞态藏进另一个数。
- 把 `progress` 拆成读 / 听两条轨：回到 `ADR-0078` 已否掉的「书架同时说两个位置」。

## 承接

`ADR-0078` 的其余条款继续成立；因本条对「播放层在同一节拍写 progress」的翻转，`ADR-0078` 整篇由本篇取代。回阅读器的精确段落位见 `ADR-0094`。

锚点：`src/client/tts/listen-session.ts` 的 `ListenPlatform.readerPresent` / `writePosition`；`src/client/tts/player.ts` 的 `readerPresent`；`src/client/tts/reader-presence.ts` 的 `readerPresence`；`src/client/reader-session.ts` 的 `commit`；`tests/client/tts-session.test.ts`；`tests/client/tts-bar.test.tsx`；`CONTEXT.md`「消费位置」；`docs/architecture.md` 的「共用消费位置」行；`ADR-0078`、`ADR-0091`、`ADR-0094`。
