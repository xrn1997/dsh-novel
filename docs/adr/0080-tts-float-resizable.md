# 听书浮窗展开态尺寸可调：拖边 + 三档，现场记意图

Status: accepted

展开态宽高交给用户：左 / 右 / 下三条边与右下角可拖（对边锚定），尺寸范围与三档预设住实现；设置弹层给三档与复位，作为不用指针的人的等价入口。现场只记**意图**（`w` / `h`，null = 缺省），呈现时再夹取，夹取不回写。背景：`ADR-0073` 的自由落位只给了位置两维，形态尺寸仍由常量钉死；`ADR-0079` 把展开态改成整段可读后，遮挡预算无法再由一个常量替所有人决定。

## 决定

1. **可拖的边**：左、右、下三条边 + 右下角；顶边不做把手——顶行是移动 / 收起面，同一方向上两种拖意会打架。
2. **命中带画在面板 padding 圈里**：任何尺寸下都不与控件重叠，贴边时也不会被屏幕裁掉；因此不需要「控件优先还是 resize 优先」的仲裁。具体宽度与角尺寸住 `mini-bar-state.ts` 的常量，不在本文抄读数。
3. **对边 / 对角锚定**：拖右边时左缘不动，拖下边时顶缘不动；每轴夹进范围后把中心夹回视口。松手不做近边吸附——吸附只属于移动。
4. **范围与最小高由骨架算出**：最小高 = 边框 + padding + 顶行 + 正文一行 + 运输行 + 底行 + gap 之和；最小宽要容得下运输行的控件。缺省尺寸同样住实现。
5. **呈现尺寸独立于意图**：`resolvedMiniBarSize` 每轴夹到 `[min, min(max, 视口可用范围)]`，视口比下限还小就取下限；夹取**不回写**——缩窗口再拉大，用户的值原样回来。
6. **现场字段**：`w` / `h` 与 `cx` / `cy` 同语义（`number | null`）；解析认有限数，范围夹取只发生在呈现时。
7. **拖边期间不落 localStorage**：与移动同一条节拍，松手 / 取消时统一 `persistMiniBarState()`。
8. **三档与复位只投影给浮窗**：设置弹层里「小 / 中 / 大 / 复位大小」一行只在浮窗那份设置卡出现；`TtsSettings.tsx` 仍是唯一一份行清单，加的是 `surface` 投影。
9. **收起态不参与**：胶囊固定尺寸——能调的胶囊就不是「不挡事」那一档了。
10. **尺寸走值槽**：`miniBarLayout` 把呈现尺寸写进 `--novel-tts-panel-w` / `--novel-tts-panel-h`，样式层只读变量。

## 被否方案

- 数值滑杆放进设置弹层：面板浮在浮窗上方，调的时候看不见结果，反馈链是断的。
- 只给三档预设：不是用户要的「调整宽高」，中间值永远到不了；三档保留为等价入口。
- 胶囊也参与调整：收起态失去「不挡事」这个唯一卖点。

## 边界

- 尺寸是浮窗自己的现场，不进 wire、不进 `SHELF_META`，不跨端同步。
- 顶边不是 resize 把手；键盘改尺寸只走设置弹层的三档（方向键仍负责移动）。
- 位置（`cx` / `cy`）的裁决仍归 `ADR-0073`；本篇把「现场只有中心 + 收起态」扩展为「中心 + 收起态 + 宽高」。

锚点：`src/client/tts/mini-bar-state.ts` 的 `DEFAULT_MINI_BAR_SIZE` / `MIN_MINI_BAR_SIZE` / `MAX_MINI_BAR_SIZE` / `SIZE_PRESETS` / `resolvedMiniBarSize` / `frameFromDrag` / `setMiniBarFrame` / `setMiniBarSize` / `resetMiniBarSize`；`src/client/tts/TtsMiniBar.tsx` 的 `beginResize` 与 resize 命中带；`src/client/tts/TtsSettings.tsx` 的 `TtsSettingsRows`；`tests/client/tts-mini-state.test.ts`；`tests/client/tts-mini.test.tsx`；`tests/browser/tts-layout.test.tsx`；`docs/ui-spec.md` §3.6；`ADR-0073`、`ADR-0079`。
