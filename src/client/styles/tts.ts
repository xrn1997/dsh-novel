/** 听书块（`NOVEL_CSS` 的第 11 块）：阅读器内嵌听书条、设置面板、选区起播按钮、全局迷你条与书架
 *  「正在听」徽标。阅读器内那条跟纸走（面板与控件复用控制器层 token）；迷你条与书架徽标读宿主语义
 *  token（暗底浮层），**不跟纸走**。 */
export const TTS_CSS = `
/* ── 听书条（阅读器内嵌）────────────────────────────────────────────────── */
/* 贴视口底：滚动容器在阅读器之外，sticky 让条在整段阅读里停在下沿。 */
.novel-tts-bar {
  position: sticky; bottom: 0; z-index: 1;
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--novel-sp-2);
  padding: var(--novel-sp-2) var(--novel-sp-4);
  border-top: 1px solid color-mix(in srgb, var(--novel-paper-ink) 12%, transparent);
  color: var(--novel-paper-ink);
}
/* 控制器层强制深色：整条让回宿主暗底（与 .novel-rdr-bar.novel-dark 同一档） */
.novel-tts-bar.novel-dark {
  background: var(--novel-bg); color: var(--novel-text);
  border-top-color: var(--novel-border);
}
.novel-tts-nav { display: flex; align-items: center; gap: var(--novel-sp-1); flex: none; }
/* 播放/暂停是条上唯一的主按钮：圆底、略大，与两侧跳段 pill 分主次 */
.novel-tts-play {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; cursor: pointer;
  border: none; border-radius: 999px; background: none; color: inherit;
  transition: background var(--novel-dur) var(--novel-ease);
}
.novel-tts-play:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
.novel-tts-play svg {
  width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round;
}
/* 段读数与预览：读数是听书自己的位置（与顶条的章进度互不相干），预览只露一行 */
.novel-tts-now { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.novel-tts-seg { font-size: var(--novel-fs-xs); opacity: .62; font-variant-numeric: tabular-nums; }
.novel-tts-preview {
  font-size: var(--novel-fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-tts-chips { display: flex; align-items: center; gap: var(--novel-sp-1); flex: none; }
/* 听书选中态 / 设置开关的回显色跟纸走（跟读字色，ReaderView 现算）；brand 只在强制深色那一档回退。 */
.novel-rdr-ctl.novel-tts-on { color: var(--novel-live-ink); opacity: 1; }
.novel-rdr-bar.novel-dark .novel-rdr-ctl.novel-tts-on,
.novel-tts-bar.novel-dark .novel-rdr-ctl.novel-tts-on { color: var(--novel-brand); }
/* 浮窗边栏同一判据：设置弹层开着，设置钮才亮 brand——开关要有回显 */
.novel-tts-mini-dock .novel-tts-ictl.novel-tts-on { color: var(--novel-brand); }
/* ── 设置面板（浮在条上方；与 Aa 面板同族卡片，不自造第二套浮层几何）──────── */
/* max-height 收两档：60vh 与现量余量（miniBarPopoverRoom）；后者是次要浮层的高度上界。 */
.novel-tts-panel {
  position: absolute; right: var(--novel-sp-3); bottom: calc(100% + var(--novel-sp-2));
  z-index: var(--novel-z-panel);
  display: flex; flex-direction: column; gap: var(--novel-sp-4);
  width: min(380px, calc(100vw - 48px)); max-height: min(60vh, var(--novel-tts-popover-room)); overflow-y: auto; overscroll-behavior: contain;
  /* 弹层自己可滚：外层浮窗是拖面（touch-action: none），这一层必须把触屏滚动还回来，
     否则设置卡在触屏上滑不动。 */
  touch-action: auto;
  padding: var(--novel-sp-5);
  background: var(--novel-layer-2); color: var(--novel-text);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  box-shadow: var(--novel-shadow-2);
}
.novel-tts-row { display: flex; align-items: center; gap: var(--novel-sp-3); min-width: 0; }
/* 卡片首行只有一颗中性关闭钮：非模态卡的可见出口，也是浮层契约给入场焦点的落点
   （第一颗钮若是定时档的「关闭」chip，定时在走时按 Enter 会静默取消定时）。 */
.novel-tts-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--novel-sp-2); min-height: 24px;
}
/* 卡名占住头行左侧：右上角孤零零一颗关闭钮会让整块看着像少了标题 */
.novel-tts-panel-title {
  flex: 1 1 auto; min-width: 0;
  font-size: var(--novel-fs-sm); font-weight: 600; color: var(--novel-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-tts-panel-close {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; padding: 0; border: none; border-radius: var(--novel-r-sm);
  background: none; color: var(--novel-text-3); cursor: pointer;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
.novel-tts-panel-close:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-tts-panel-close:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: 2px; }
.novel-tts-panel-close svg {
  width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round;
}
.novel-tts-label { flex: none; width: 3.2em; font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
.novel-tts-range { flex: 1 1 auto; min-width: 0; accent-color: var(--novel-brand); }
.novel-tts-val { flex: none; font-size: var(--novel-fs-xs); color: var(--novel-text-3); font-variant-numeric: tabular-nums; }
.novel-tts-select {
  flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--novel-fs-sm);
  color: var(--novel-text); background: var(--novel-layer-1);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-xs); padding: var(--novel-sp-1) var(--novel-sp-2);
}
.novel-tts-actions { flex-wrap: wrap; }
.novel-tts-note { font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
/* 连败暂停的提示（两个表面同一句读数）：用错误色——它是「为什么停了」，不是装饰。 */
.novel-tts-fail { font-size: var(--novel-fs-xs); color: var(--novel-err); line-height: 1.5; }
.novel-tts-bar > .novel-tts-fail { flex-basis: 100%; }
.novel-tts-mini-panel > .novel-tts-fail { flex: none; }
/* ── 听书进度（条上只有章内段滑杆，ADR-0075）───────────────────────────── */
/* 章内段滑杆独占一整行（flex-basis 100% 换行）：拖到任意段即起播。 */
.novel-tts-chapter-seek { flex-basis: 100%; display: flex; align-items: center; min-width: 0; }
.novel-tts-chapter-seek .novel-tts-range {
  flex: 1 1 auto; min-width: 0; height: 12px; accent-color: currentColor; opacity: .8;
}
/* ── 选区起播（「从本段听」）────────────────────────────────────────────── */
/* 浮在选区下方：反色是唯一能同时压住任意纸色与深浅控制器层的取法（纸墨互换）。 */
.novel-tts-from-here {
  position: fixed; transform: translateX(-50%); z-index: var(--novel-z-panel);
  padding: var(--novel-sp-2) var(--novel-sp-4); border: none; border-radius: 999px;
  background: var(--novel-paper-ink, var(--novel-text)); color: var(--novel-paper, var(--novel-bg));
  font: inherit; font-size: var(--novel-fs-sm); white-space: nowrap; cursor: pointer;
  box-shadow: var(--novel-shadow-2);
}
/* ── 全局听书浮窗（shell.overlay 常驻层；胶囊 / 展开两形态，尺寸走 miniBarLayout 值槽）──────── */
.novel-tts-mini-dock {
  position: fixed;
  z-index: var(--novel-z-status); pointer-events: auto;
}
.novel-tts-mini-dock[data-dragging='true'] { user-select: none; }
/* resize 命中带（ADR-0080）：只给左 / 右 / 下三条边 + 右下角；顶边是移动 / 收起面，不做把手。
   带子画在面板 padding 圈里（左右 12 / 底 10 ≥ 8），任何尺寸下都不与控件重叠，贴边时也不会被屏幕裁掉。 */
.novel-tts-mini-edge { position: absolute; z-index: var(--novel-z-panel); touch-action: none; }
.novel-tts-mini-edge[data-edge='left'] {
  left: 1px; top: 1px; bottom: 1px; width: 8px; cursor: ew-resize;
}
.novel-tts-mini-edge[data-edge='right'] {
  right: 1px; top: 1px; bottom: 1px; width: 8px; cursor: ew-resize;
}
.novel-tts-mini-edge[data-edge='bottom'] {
  left: 1px; right: 1px; bottom: 1px; height: 8px; cursor: ns-resize;
}
.novel-tts-mini-edge[data-edge='corner'] {
  right: 1px; bottom: 1px; width: 14px; height: 14px; cursor: nwse-resize;
}
.novel-tts-mini-dock[data-resizing='true'] { user-select: none; }
/* 拖动中整块都是抓手（grabbing）：cursor 是继承值，子元素显式声明过 cursor（拖面 hover 档
   的 pointer / grab、颗颗按钮）会盖过根上的继承值——用户拖动全程看到的就是拖面自己的 hover
   指针，所以根与全后代一起压。放在 resize 带之后有讲究：edge 带同为 (0,2,0)，靠后才压得过
   它们的 ew/ns/nwse-resize（移动拖动中指针扫过那 8px 带子时不该冒出 resize 指针）。
   悬停指针一律不动：点与拖要有区分（胶囊身份钮 hover = pointer，展开态拖面 hover = grab）。
   排在本块之后的后代规则不得再显式声明 cursor——同 (0,2,0) 靠后者反过来赢走 grabbing；
   悬停指针本就由各自 base 层规则携带（.novel-tts-mini-body 自带 grab），修饰档只补几何与颜色。 */
.novel-tts-mini-dock[data-dragging='true'],
.novel-tts-mini-dock[data-dragging='true'] * { cursor: grabbing; }
/* 拖边中整块都是所拖那条边的 resize 指针：指针滑出 8px 命中带落到正文 / 按钮上时，
   子元素的 hover 档（grab / pointer）不许顶上来——拖边没松手，手势仍是 resize。
   data-resize-edge 记正在拖的那条边（读数归 mini-bar-state 的指针会话）。 */
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='left'],
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='right'],
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='left'] *,
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='right'] * { cursor: ew-resize; }
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='bottom'],
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='bottom'] * { cursor: ns-resize; }
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='corner'],
.novel-tts-mini-dock[data-resizing='true'][data-resize-edge='corner'] * { cursor: nwse-resize; }

/* 收起态：完整身份条（ADR-0079）：环 + 书名与段号 + 底部一条章内进度细线；尺寸值槽由 miniBarLayout 给。 */
.novel-tts-mini-capsule {
  position: relative;
  display: flex; align-items: center; gap: var(--novel-sp-2);
  width: var(--novel-tts-capsule-w); height: var(--novel-tts-capsule-h); padding: 0 10px;
  border-radius: 999px;
  background: var(--novel-float); color: var(--novel-text);
  border: 1px solid var(--novel-border); box-shadow: var(--novel-shadow-2);
  touch-action: none;
  transition: border-color var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-tts-mini-capsule:hover { border-color: var(--novel-border-strong); }
/* 连败暂停：胶囊没有放正文的位置，靠描边与 title / data-failed 给同一读数（见 TtsMiniBar）。 */
.novel-tts-mini-dock[data-failed='true'] .novel-tts-mini-capsule { border-color: var(--novel-err-line); }
/* 展开钮吃掉身份区那一整块：容器自己不接点击，两颗按钮并列（按钮里不再套按钮）。 */
.novel-tts-mini-expand {
  flex: 1 1 auto; min-width: 0;
  display: flex; flex-direction: column; gap: 1px;
  background: none; border: 0; margin: 0; padding: 0;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.novel-tts-mini-expand:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: 2px; border-radius: 8px; }
.novel-tts-mini-capsule .novel-tts-ringplay { width: 32px; height: 32px; }
.novel-tts-mini-capsule .novel-tts-ring-core { width: 26px; height: 26px; }
.novel-tts-mini-capsule .novel-tts-ring-core svg { width: 12px; height: 12px; }
.novel-tts-mini-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
/* 身份区一行：书名贴左、段号贴右（space-between）。胶囊宽度是固定的（内容长短会跳宽、还会
   让贴边落位跟着抖），所以两端都要有落点——只贴左会让右边空出一大截，看着像没画完。 */
.novel-tts-mini-capsule .novel-tts-mini-row { justify-content: space-between; }
.novel-tts-mini-capsule .novel-tts-mini-title { flex: 1 1 auto; min-width: 0; }
.novel-tts-mini-badge {
  flex: none; padding: 0 5px; height: 15px; border-radius: 99px;
  border: 1px solid var(--novel-border); color: var(--novel-text-2); font-size: 8.5px;
  background: var(--novel-hover); line-height: 13px; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
/* 胶囊底边的章内进度细线：段粒度填充，只读不拖（与展开态那条同一算式） */
.novel-tts-mini-cap-line {
  position: absolute; left: 12px; right: 12px; bottom: 5px; height: 2px;
  border-radius: 99px; background: var(--novel-hover); overflow: hidden;
  pointer-events: none;
}
.novel-tts-mini-cap-line i {
  display: block; height: 100%; border-radius: 99px; background: var(--novel-brand);
}

/* 展开态：缺省 320×200，可拖到 260–520 / 162–420（ADR-0080；尺寸走 miniBarLayout 值槽）。 */
.novel-tts-mini-panel {
  position: relative;
  display: flex; flex-direction: column; gap: 8px;
  width: var(--novel-tts-panel-w); height: var(--novel-tts-panel-h);
  padding: 10px 12px; box-sizing: border-box;
  border-radius: 14px;
  background: var(--novel-float); color: var(--novel-text);
  border: 1px solid var(--novel-border);
  box-shadow: var(--novel-shadow-2); touch-action: none;
}
.novel-tts-mini-dock[data-flush='right'] .novel-tts-mini-panel {
  border-radius: 14px 0 0 14px; border-right: 0;
}
.novel-tts-mini-dock[data-flush='left'] .novel-tts-mini-panel {
  border-radius: 0 14px 14px 0; border-left: 0;
}
/* 顶行 28：身份钮（点收起 / 拖移动）+ 设置钮，两颗兄弟按钮，不嵌套（ADR-0079） */
.novel-tts-mini-head {
  display: flex; align-items: center; gap: 8px; min-width: 0; height: 28px; flex: none;
}
.novel-tts-mini-id {
  flex: 1 1 auto; min-width: 0; height: 28px;
  display: flex; align-items: center; gap: 6px;
  background: none; border: 0; margin: 0; padding: 0 4px; border-radius: var(--novel-r-sm);
  color: inherit; font: inherit; text-align: left; cursor: grab; touch-action: none;
}
.novel-tts-mini-id:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: 1px; }
.novel-tts-mini-chev { flex: none; display: inline-flex; color: var(--novel-text-3); }
.novel-tts-mini-chev svg {
  width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round;
}
.novel-tts-mini-panel .novel-tts-mini-title { line-height: 1.2; }
/* 正文区吃掉剩余高度；装不下就截断，尾行右下角挂「看全文」，不再做两行坑位 */
.novel-tts-mini-body {
  position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden;
  padding: 0 4px; overflow-wrap: anywhere;
  font-size: var(--novel-fs-md); line-height: 20px; color: var(--novel-text);
  cursor: grab; touch-action: none;
}
.novel-tts-mini-body.empty {
  display: grid; place-items: center;
  font-size: var(--novel-fs-sm); color: var(--novel-text-2);
}
.novel-tts-mini-more {
  position: absolute; right: 0; bottom: 0; margin: 0;
  padding: 0 0 0 var(--novel-sp-2);
  background: var(--novel-float); border: 0;
  color: var(--novel-brand-strong); font: inherit; font-size: var(--novel-fs-sm);
  cursor: pointer;
}


/* 图标钮与手柄：边栏里是 32×32（顶行设置钮 sm 28）；运输行五件 ≥32、播放环 44 的命中档
   归 ADR-0079，样式层不再自造一条「20px 下限」的抄本。 */
.novel-tts-ictl {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 32px; height: 32px; padding: 0; border: none; border-radius: var(--novel-r-sm);
  background: none; color: inherit; cursor: pointer;
  transition: background var(--novel-dur) var(--novel-ease);
}
.novel-tts-ictl.sm { width: 28px; height: 28px; }
.novel-tts-ictl:hover { background: var(--novel-hover); }
.novel-tts-ictl.quiet:hover { color: var(--novel-err); background: var(--novel-err-weak); }
.novel-tts-ictl svg {
  width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round;
}
/* 图标钮 / 定时 chip / 播放环都是交互件：与同面板的展开钮、手柄同一档焦点环。
   缺这一条，键盘用户看不到焦点落在哪一颗（触屏与指针用户不受影响，所以肉眼验收也漏得掉）。 */
.novel-tts-ictl:focus-visible, .novel-tts-chip:focus-visible, .novel-tts-ringplay:focus-visible {
  outline: 2px solid var(--novel-ring); outline-offset: 2px;
}
/* 环是圆形：给 outline 一个同形圆角，否则焦点框是个方角套在圆环外 */
.novel-tts-ringplay:focus-visible { border-radius: 999px; }
/* 书名只是身份标签，不是主体：小字、次要色，把宽度与视线让给当前句与控制 */
.novel-tts-mini-title {
  font-size: var(--novel-fs-xs); font-weight: 400; color: var(--novel-text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-tts-mini-sub {
  font-size: var(--novel-fs-xs); color: var(--novel-text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums;
}
/* 运输行：回阅读器 / 跳段 / 播放 / 跳段 / 停止，颗颗 ≥32；读数与进度在底行 */
.novel-tts-mini-acts {
  display: flex; align-items: center; justify-content: center; gap: 14px; height: 44px; flex: none;
}
.novel-tts-mini-panel .novel-tts-ringplay { width: 44px; height: 44px; }
.novel-tts-mini-panel .novel-tts-ring-core { width: 32px; height: 32px; }
.novel-tts-mini-panel .novel-tts-ring-core svg { width: 14px; height: 14px; }
/* 底行 = 纯读数行：语速 / 段号 / 章内进度 / 定时倒计时；右侧留出 14px 给右下角 resize 带 */
.novel-tts-mini-foot {
  display: flex; align-items: center; gap: 8px; height: 24px; flex: none;
  padding-right: 14px;
}
.novel-tts-ro {
  flex: none; white-space: nowrap; font-variant-numeric: tabular-nums;
  font-size: var(--novel-fs-xs); color: var(--novel-text-2);
}
.novel-tts-mini-foot .novel-tts-mini-chapseek { flex: 1 1 auto; }
.novel-tts-chip {
  display: inline-flex; align-items: center; gap: 3px; flex: none;
  height: 20px; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--novel-border); background: none; cursor: pointer;
  font-size: var(--novel-fs-xs); color: var(--novel-text-2); font-variant-numeric: tabular-nums;
  transition: border-color var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
.novel-tts-chip:hover { border-color: var(--novel-border-strong); color: var(--novel-text); }
.novel-tts-chip.on { border-color: var(--novel-brand); color: var(--novel-brand-strong); background: var(--novel-brand-tint); }
/* 章内进度：浮窗唯一的进度条（ADR-0079 / ADR-0080）——拖动即跳到目标段。 */
.novel-tts-mini-chapseek { position: relative; flex: none; display: flex; align-items: center; height: 24px; }
.novel-tts-mini-chapseek-track {
  position: absolute; left: 0; right: 0; height: 5px; border-radius: 99px;
  background: var(--novel-hover); overflow: hidden; pointer-events: none;
}
.novel-tts-mini-chapseek-track i { display: block; height: 100%; background: var(--novel-brand); }
.novel-tts-mini-chapseek-knob {
  position: absolute; top: 50%; width: 9px; height: 9px; margin-left: -4.5px;
  border-radius: 50%; background: var(--novel-brand); box-shadow: 0 0 0 2px var(--novel-float);
  transform: translateY(-50%); pointer-events: none;
}
.novel-tts-mini-chapseek-range {
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
  opacity: 0; cursor: pointer;
}
.novel-tts-mini-chapseek:focus-within .novel-tts-mini-chapseek-track {
  outline: 2px solid var(--novel-ring); outline-offset: 3px;
}
/* 设置弹层是次要浮层：相对边栏定位，左缘镜像，卡在上半时翻到下方。 */
.novel-tts-mini-dock[data-side='left'] .novel-tts-panel { right: auto; left: var(--novel-sp-3); }
.novel-tts-mini-dock[data-flip='true'] .novel-tts-panel { bottom: auto; top: calc(100% + var(--novel-sp-2)); }
/* 进度环包播放钮：环读段进度 store（组件自订阅），主钮读 primary fill + 配对前景口 */
.novel-tts-ringplay {
  position: relative; flex: none; display: grid; place-items: center;
  width: 42px; height: 42px; padding: 0; border: none; background: none; cursor: pointer;
}
.novel-tts-ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.novel-tts-ring-track { fill: none; stroke: var(--novel-border-strong); stroke-width: 2.5; }
.novel-tts-ring-val {
  fill: none; stroke: var(--novel-brand); stroke-width: 2.5; stroke-linecap: round;
  transition: stroke-dashoffset var(--novel-dur) linear;
}
.novel-tts-ring-val.direct { opacity: .18; }
.novel-tts-ring-core {
  display: grid; place-items: center; width: 32px; height: 32px; border-radius: 999px;
  background: var(--novel-primary-fill); color: var(--novel-fg);
  transition: background var(--novel-dur) var(--novel-ease);
}
.novel-tts-ringplay:hover .novel-tts-ring-core { background: var(--novel-primary-hover); }
.novel-tts-ring-core svg {
  width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.9;
  stroke-linecap: round; stroke-linejoin: round;
}
/* ── 书架「正在听」徽标（消费位置归 progress，这里只标播放态）──────────────── */
/* 徽标钉在**封面顶左**（角落分工与「多选态让位给勾选标记」归 shelf.ts 那处注释）。 */
.novel-card-head { display: block; }
.novel-card-now {
  position: absolute; top: var(--novel-sp-2); left: var(--novel-sp-2); z-index: 1;
  padding: 0 var(--novel-sp-2); border-radius: 999px;
  font-size: var(--novel-fs-xs); color: var(--novel-brand-strong);
  background: color-mix(in srgb, var(--novel-bg) 68%, transparent); white-space: nowrap;
}
/* ── 配置卡「引擎管理」（听书组内的对象数据管理区）────────────────────────── */
/* 与上方标量行用一条细分割线断开：上面是「缺省值」，下面是「订阅资产」。 */
.novel-tts-engines {
  display: flex; flex-direction: column; gap: var(--novel-sp-3);
  padding-top: var(--novel-sp-4); border-top: 1px solid var(--novel-border-faint);
}
.novel-tts-engines-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-2); }
.novel-tts-engines-head > strong { font-size: var(--novel-fs-md); }
.novel-tts-engines-count { font-size: var(--novel-fs-xs); color: var(--novel-text-3); white-space: nowrap; }
.novel-tts-engines-list { display: flex; flex-direction: column; gap: var(--novel-sp-2); }
/* 不可用源降不透明度而不造禁用态：灰显是「此刻没有」，不是「这行坏了」。 */
.novel-tts-engine {
  display: flex; align-items: center; gap: var(--novel-sp-3);
  padding: var(--novel-sp-2) var(--novel-sp-3);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-sm);
  background: var(--novel-layer-3);
}
.novel-tts-engine.dim { opacity: .55; }
.novel-tts-engine-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.novel-tts-engine-name {
  font-size: var(--novel-fs-md); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-tts-engine-desc {
  font-size: var(--novel-fs-xs); color: var(--novel-text-3); line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis;
}
.novel-tts-engine-badge { flex: none; font-size: var(--novel-fs-xs); white-space: nowrap; color: var(--novel-text-3); }
.novel-tts-engine-badge.ok { color: var(--novel-ok); }
.novel-tts-engine-acts { flex: none; display: flex; gap: var(--novel-sp-1); }
.novel-tts-import, .novel-tts-export {
  display: flex; flex-direction: column; gap: var(--novel-sp-2);
  padding: var(--novel-sp-3); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); background: var(--novel-layer-2);
}
.novel-tts-import label, .novel-tts-export label { font-size: var(--novel-fs-sm); color: var(--novel-text-2); }
.novel-tts-import-url { display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-2); }
.novel-tts-import-url .novel-input { flex: 1 1 220px; min-width: 0; }
.novel-tts-receipt {
  display: flex; flex-direction: column; gap: var(--novel-sp-1);
  padding: var(--novel-sp-2) var(--novel-sp-3);
  border-left: 3px solid var(--novel-ok); border-radius: var(--novel-r-sm);
  background: var(--novel-layer-2); font-size: var(--novel-fs-sm);
}
.novel-tts-receipt.has-failed { border-left-color: var(--novel-warn); }
.novel-tts-edit-form {
  display: flex; flex-direction: column; gap: var(--novel-sp-2);
  max-height: 60vh; overflow-y: auto;
  /* 展开组时滚动条会出现：预留槽位（不挤动布局）并留一点右缘呼吸。 */
  scrollbar-gutter: stable; padding-right: var(--novel-sp-2);
}
.novel-tts-edit-field { display: flex; flex-direction: column; gap: 2px; }
.novel-tts-edit-field > label { font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
.novel-tts-edit-section {
  margin-top: var(--novel-sp-2); font-size: var(--novel-fs-sm);
  font-weight: 600; color: var(--novel-text-2);
}
.novel-tts-edit-group {
  display: flex; flex-direction: column; gap: var(--novel-sp-2);
  border-top: 1px solid var(--novel-border-faint); padding-top: var(--novel-sp-2);
}
.novel-tts-edit-group-toggle {
  display: flex; align-items: center; gap: var(--novel-sp-2); width: 100%;
  border: none; padding: 0; background: none; font: inherit; text-align: left; cursor: pointer;
  font-size: var(--novel-fs-sm); font-weight: 600; color: var(--novel-text-2);
}
.novel-tts-edit-group-toggle:hover { color: var(--novel-text); }
.novel-tts-edit-group-toggle:focus-visible {
  outline: 2px solid var(--novel-brand); outline-offset: 2px; border-radius: var(--novel-r-sm);
}
.novel-tts-edit-chevron {
  width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor;
  stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
  transition: transform var(--novel-dur) var(--novel-ease);
}
.novel-tts-edit-group-toggle[aria-expanded="true"] .novel-tts-edit-chevron { transform: rotate(90deg); }
.novel-tts-edit-status {
  margin-left: auto; font-size: var(--novel-fs-xs); font-weight: 400; color: var(--novel-text-3);
}
.novel-tts-edit-group-body { display: flex; flex-direction: column; gap: var(--novel-sp-2); }
`
