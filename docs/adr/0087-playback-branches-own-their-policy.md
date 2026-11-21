# 出声分支的策略归分支实现，静音另一条的时序是「新分支出声那一刻」

Status: accepted

播放层两条出声分支（直出 / 字节）各自的准备、能力、静音与重来许可此前散在状态机的多个方法里，换参数那一刻就撤旧声音、切到字节引擎要先吃一段死腔。决定把这些策略收进出声分支的实现，并把「静音另一条」的时机定在新分支**出声那一刻**——加第三条声道只加一个分支实现，状态机一行不动。

## 决定

1. **分支策略住分支实现**（`PlaybackBranch`）：准备这一段、能力声明（段内计时 / 预取 / 回执续播 / 介质自愈 / 音色表来源）、起播资格（`ready`）、生命周期（`yieldForLoad` / `pause` / `stop` / `release`）都由分支自己回答；状态机只消费结局（started / cancelled / failed），不按模式分叉。
2. **「静音另一条」由各分支起播时自己做，时机 = 自己出声那一刻**：直出型起播是同步动作，先静音对侧再开口；字节型要等合成回执落地，先静音对侧再交介质。两条硬规则同时成立：**绝不叠音**、**能不出死腔就不出**（换槽接替：合成等待里旧声音继续到新声音就绪）。
3. **起播失败也要收口**：失败径先让两条介质闭嘴再记账——读数写「不在放」就不许还有声音；取消（cancelled）不碰对侧，晚到的作废回执不许掐掉新声音。
4. **组只管「两条都不该再响」的收口**：`pauseAll` / `stopAll` / `releaseAll` 落到两条介质，不认模式、不认业务字段。

## 边界

- 状态机仍住 `src/client/tts/listen-session.ts`：单元状态机、连败暂停、定时、位置落盘、两只 AbortController、回执缓存与取消管路。
- 介质适配器仍是两个家：分支管策略，适配器管槽与平台接口。
- 分支不读 store、不写盘、不推进段号；上屏读数归 `listen-readout.ts`。
- 章载入窗口的让位语义是分支自己的策略。

## 被否方案

- 维持散在状态机的分支判断：加第三条声道要改多处，漏一处不会报错、只会出怪声。
- 用 mode 枚举把差异留在状态机：分支差异不是参数值而是策略。
- 换参数那一刻就撤旧声音：合成等待期变成死腔，且与字节 ↔ 字节既有的「换槽接替」不对称。
- 只在成功径延迟静音、失败径不收口：屏幕写「不在放」耳朵里还在响。

## 代价

分支层多一层间接；「静音时机」是时序契约，必须用测试钉住（回执在途对侧不静音、落地先静音再交介质、失败径两条都闭嘴）。失败收口让失败径多一次全组暂停，换来读数与耳朵一致。

锚点：`src/client/tts/output-contract.ts` 的 `PlaybackBranch` / `ListenBranches` / `BranchHost`；`src/client/tts/playback-branches.ts` 的 `BytesBranch` / `DirectBranch` / `createListenBranches`；`src/client/tts/listen-session.ts` 的 `segmentFailed`；`tests/client/tts-playback-branch.test.ts`；`tests/client/tts-session.test.ts`；`CONTEXT.md`「直出型 / 字节型」；`ADR-0081`、`ADR-0082`。
