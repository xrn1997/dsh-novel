# 阅读位置统一到视口顶：落位与翻页都顶对齐

Status: accepted

导语：`ADR-0091` 让跟读在目标离开可视带时**居中**。居中把目标段放到视口中央，视口顶便落在目标之前，`readingPositionAt` 读回的是上一段甚至章首——「从阅读位置起播」与「听书」pill 因此给出两个起点，刚开始听时尤其看不清从哪一句开始。决定：**所有阅读位置的落位与翻页都对齐到带顶（顶条下方），不再居中；跟读只在当前段成为最后一个可见段时翻页。**

## 背景

阅读位置与听书位置对「在哪」的定义不同：

- 探针 `readingPositionAt` 按**视口顶**取最后一个已越过的 `[data-pidx]` 块；视口顶在首块之上时返回段 0。
- 播放层记的是**正在念的段**。
- `reveal` 居中后，视口顶被抬到目标段之前；下一次探针读到的就不是正在念的段。起播第一次落位若居中，读者看到的是「目标在屏幕中间」，而「从阅读位置起播」再采样时读到的是被抬高后的顶行，于是两个入口的起点不一致。

用户要求位置统一：**读视口顶，或者跳到视口顶**；顶条不能盖住目标。跟读推进不应每段都重置视野，只在当前段读到当前界面的最后一句时翻页；翻页后目标在顶部，而不是中间。

## 决定

1. **`RevealMode = 'locate' | 'follow'`**：`locate` 无条件把目标段块顶对齐到带顶；`follow` 只在翻页条件满足时顶对齐，普通段不滚。`ReaderSession.reveal` 的 `center` 参数退役。
2. **带顶 = `topInset`**：`settleReveal` 用 `bandTop = topInset`，目标 top 落到顶条下方；顶条遮挡高度与探针、恢复、目录跳章同一份读数。目标不会被标题栏盖住。
3. **起播首拍是 `locate`**：`FollowController` 记住最近落位的段（`placed`）。会话开始、回阅读器、手动定位、以及任何**不是同章下一段**的跳转都走 `locate`——用户刚点听书时，当前段直接被顶到带顶，从哪一句开始一目了然。
4. **只有自然推进走 `follow`**：同一章内 `paragraphIndex === placed.paragraphIndex + 1` 才是自然推进。`follow` 在目标已完全可见、且它不是当前最后一个可见段时不动；当它成为最后一个可见段并落在带的下半部（或已经离开带）时，翻页到带顶。跨章、回退、拖动滑杆、跳段一律 `locate`。
5. **探针不变**：`readingPositionAt` 仍读视口顶，返回章 + 段号。顶对齐之后，视口顶就是当前段，探针自然读到同一个位置；不需要缓存，也不需要第二个读口。
6. **进度写入口径不变**：`locate`/`follow` 的 `write` 仍区分「这一跳是不是阅读动作」；阅读器在场时 `progress` 归阅读会话（`ADR-0093`）。

## 边界

- 翻页判据需要下一段的几何：`ReaderPort.targetOffsetOfParagraph(index, paragraphIndex + 1)`；下一段不存在或已到带底之外 = 当前段是最后一个可见段。`ReaderPort` 的这一格仍可选，缺席时按「没有下一段」处理。
- 目标比带还高、或下一段几何不可靠时，`follow` 走「离开带」分支，仍顶对齐；不居中。
- 顶对齐只算 top，不改变段高、不改变 `progress` 的比例口径；`ratioWithin` / `anchorTop` 仍按 measured adapter。
- 目录 / 注释面板的浮层落位仍用 `centerInScroller`；那是浮层自己的容器，不是阅读位置。
- 不新增「跟随」开关；让位与重接仍按 `ADR-0091` 的入口。

## 代价

- 起播首拍会把当前段从屏幕中间顶到带顶，视野会动一次；这是用户明确要的「从哪一句开始」。
- 翻页只在最后一个可见段的下半部触发；不同字号 / 行距下触发点会变，但语义不变（读到当前界面最后一句）。
- 目标贴顶时，目标上方的内容不再可见；这是「读视口顶」的直接代价，换来起点唯一。

## 被否方案

- **保留居中**：视口顶被抬到目标之前，探针读回上一段/章首；「从阅读位置起播」与 pill 的起点不一致，正是本次要修的问题。
- **每段都无条件顶对齐**：播放是段粒度，每几秒滚一次会把视野不断重置；翻页判据只在最后一句触发。
- **只把显式定位改成顶对齐、跟读仍居中**：同一套 reveal 两种落点，位置读法仍不唯一。
- **顶对齐到 0 而不是 `topInset`**：目标会藏在 sticky 顶条后面；顶条高度是现有恢复/探针的同一份读数，必须扣。
- **改探针去读屏幕中心**：那会把「阅读位置」从顶行改成中心段，影响 progress 与恢复，代价大于收益。

锚点：`src/client/reader-session.ts` 的 `RevealMode` / `reveal` / `settleReveal`；`src/client/tts/follow-controller.ts` 的 `FollowRevealOptions.mode` / `onPlayback` / `onLocate`；`src/client/tts/reading-position.ts` 的 `readingPositionAt`；`src/client/views/ReaderView.tsx` 的 `locateListen` / `followBottomInset`；`src/client/reader-geometry.ts` 的 `targetOffsetOfParagraph`；`tests/client/reader-session.test.ts` 的「顶条下的带顶」用例；`tests/client/tts-seek.test.tsx` 的「跟读自动跟随」用例；`tests/client/tts-follow.test.ts`；`docs/ui-spec.md` §3.6；`ADR-0091`（被本篇取代）、`ADR-0093`、`ADR-0094`（精确段号交接保留，落点对齐由本篇改为带顶）、`ADR-0095`。