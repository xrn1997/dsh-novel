# 阅读器在场时消费位置归阅读器，播放层只写听书细节

Status: accepted

导语：ADR-0078 把 `progress` 定为阅读与听书共用的消费位置，并让播放层在每个落盘节拍里写它；跟读落地后阅读器也在写同一个字段，两个自动写者还用两套比例公式。决定：**本书的阅读器子树在场时，`progress` 归阅读会话；播放层只写 `listen`。阅读器不在场时，播放层才补写 `progress`。**

## 背景

ADR-0078 的设计前提是「同一本书同一时刻只有一个自动写者」。ADR-0091 把跟读跟随做进阅读器后，这个前提不再成立：播放推进触发阅读器滚动，阅读会话按像素写 `progress`（`client/progress.ts` 的 `ratioWithin`，measured adapter），播放层按段数写 `progress`（同文件的 `paragraphRatio`，uniform adapter）。同一段在段高不等或长段被二次切成多个播放单元时是两个不同的数，两条 2s 防抖谁后落盘取决于 timer 顺序，服务端 last-write-wins。书架卡片因此可能在同一段上看到两个位置来回跳，重新开书也可能落回另一套口径算出的位置。

两边同时写还有一个不显眼的不对称：播放层的写口成功后会把 `panelShelf` 投影更新到新位置，阅读器的写口不更新。同一份客户端副本，两条写者口径不同。

## 决定

1. **`progress` 仍是唯一的消费位置**：形状与读者（书架卡片、最近阅读排序、开书恢复）不变；`listen` 仍是听书细节轨（段号 + 播放参数），不替代 `progress`。
2. **所有权按书键与阅读器子树在场判定**：`ListenPlatform` 新增 `readerPresent(bookKey)` 缝；生产实现读 `client/tts/reader-presence.ts` 的在场书键集合。返回真时，播放层的 `writePosition` 只写 `listen`，不写 `progress`。
3. **阅读器不在场时播放层写两笔**：迷你条听书、阅读器已卸载、阅读器开着另一本，都属于这一格；`progress` 由播放层按段号 → 比例补，书架游标仍随听书前进。
4. **在场读数失败按不在场处理**：`readerPresent` 抛错只让这一次多写一笔 `progress`，不阻断 `listen` 落盘；听书落盘不因一次在场探测整条断掉。
5. **不改变跟读**：阅读器在场时它按真实视口 / 精确段写 `progress`；读者让位后写的是读者所在位置，这正是「最后一次显式动作」。播放层继续按自己的节拍写 `listen`，精确续听不受影响。
6. **回阅读器仍只站定不写**：精确段落位见 ADR-0094；那条走 `commit('restore')`，不因所有权变化而写 `progress`。

## 边界

- 阅读器子树在场但读者在看别处：`progress` 跟读者的阅读位置，不跟音频；音频位置在 `listen` 里。这是所有权规则的预期结果，不是丢位置。
- 阅读器撤销时播放层不一定立刻补一笔：下一段推进、暂停、停止或关页时按正常节拍写；若用户听在段中直接关掉阅读器，`listen` 仍准，`progress` 停在读者最后看见的位置。
- 同一本书的阅读器子树撤掉、另一本书的阅读器在场：按「本书的书键」判，后者不影响前者的播放层写入。
- `listen` 的写者仍只有播放层；阅读器不写听书细节。
- 面板投影的回写仍只住播放层写口；阅读器写口不新增第二份投影更新。

## 代价

- 阅读器开着听书时，书架 `progress` 可能落后音频若干段（它跟视口）；`listen` 才是精确续听现场。
- 阅读器在场期间播放层少写一笔 `progress`；如果阅读器一直没有滚动（目标在可视带内），这一段期间 `progress` 不动，是「阅读位置」语义的应有结果。
- 所有权规则引入一个平台缝；测试要注入 `readerPresent`，生产要保证在场信号与书键同步。

## 被否方案

- **保留两个写者，只统一比例公式**：比例公式统一后两个写者仍会在同段上写同一个数，但「谁拥有这一拍」仍没有主人；阅读器让位后播放层下一拍仍会盖掉读者的位置。
- **播放层永远不写 `progress`**：只在迷你条听书、阅读器不在场的场景下书架游标不会前进，直接违背 ADR-0078 的「听到第二章就是读到第二章」。
- **播放层永远写 `progress`**：这是本决定之前的现状；阅读器跟随时两套公式抢同一字段，timer 顺序决定落盘值。
- **按时间戳 / 版本号做客户端 last-write-wins**：只把竞态藏进另一个数，两个写者的位置语义仍不同；服务端也没有可比较的版本。
- **把 `progress` 拆成读 / 听两条轨**：回到 ADR-0078 已否掉的「书架同时说两个位置」。

## 承接

ADR-0078 的其余条款继续成立：`progress` 是唯一消费位置、`listen` 是听书细节、起播跟随阅读、跟读跟随与让位、书架只显示一条进度。ADR-0078 因本条对「播放层在同一节拍写 progress」的翻转而整篇由本篇取代。回阅读器的精确段落位见 ADR-0094。

锚点：`src/client/tts/listen-session.ts` 的 `ListenPlatform.readerPresent` / `writePosition`；`src/client/tts/player.ts` 的 `readerPresent` 生产接线；`src/client/tts/reader-presence.ts` 的 `readerPresence`；`src/client/reader-session.ts` 的 `commit`；`tests/client/tts-session.test.ts` 的「阅读器子树在场」用例；`tests/client/tts-bar.test.tsx` 的「改语速」用例；`CONTEXT.md` 的「消费位置」；`docs/architecture.md` 的「共用消费位置」行；`ADR-0078`、`ADR-0091`、`ADR-0094`。