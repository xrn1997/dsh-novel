/** 阅读器块（`NOVEL_CSS` 的第 6 块）：控制器条、正文列、目录抽屉、Aa 面板，以及 EPUB
 *  三组件（图文正文 / 目录树 / 注释面板）的规则。 */
export const READER_CSS = `
/* ── 阅读器：控制器条/正文列/目录抽屉/Aa 面板（z 序仍归 CTRL_Z 常量，布局归样式类）── */
/* 纸面 full-bleed：**纸张色涂满整个阅读区**（值槽 --novel-paper 由 ReaderView 行内写在阅读区根上）。 */
.novel-rdr { position: relative; display: flex; flex-direction: column; min-height: 100vh; }
/* 滚动补偿归会话：裁章/前插由 reader-session 在渲染后按实测高度补 scrollTop。 */
.novel-rdr, .novel-rdr * { overflow-anchor: none; }
/* 控制器条**跟纸走，不跟宿主 chrome 走**：条底 = 纸往墨压一档，整屏读作「一张纸的顶部折了一道」。 */
.novel-rdr-bar {
  display: flex; gap: var(--novel-sp-2); align-items: center; min-height: 40px;
  padding: var(--novel-sp-1) var(--novel-sp-4);
  border-bottom: 1px solid color-mix(in srgb, var(--novel-paper-ink) 12%, transparent);
  color: var(--novel-paper-ink);
}
/* 「控制器层跟随深色」仍是完整的一档：勾上即整条让回宿主暗底，纸色派生那一套整体作废。 */
.novel-rdr-bar.novel-dark {
  background: var(--novel-bg); color: var(--novel-text);
  border-bottom-color: var(--novel-border);
}
/* 读数：当前章在**主位**，书名退副位——书名刚在书架上点过，在条上是冗余。 */
.novel-rdr-title {
  flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--novel-sp-2);
  font-size: var(--novel-fs-md); overflow: hidden;
}
.novel-rdr-chap { min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-rdr-pos, .novel-rdr-book { flex: none; font-size: var(--novel-fs-xs); opacity: .62; white-space: nowrap; }
.novel-rdr-pos { font-variant-numeric: tabular-nums; }
.novel-rdr-book { max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
/* 返回入口与读数之间的发丝：把「去哪」和「在哪」分成两组，比一排同权重方框好扫读 */
.novel-rdr-sep { width: 1px; height: 14px; flex: none; background: currentColor; opacity: .25; }
/* 条上控件：去框的一档 pill；字形与汉字同高的一档。 */
.novel-rdr-ctl {
  font: inherit; font-size: var(--novel-fs-sm); padding: var(--novel-sp-1) var(--novel-sp-3);
  border: none; border-radius: 999px; background: none; cursor: pointer; color: inherit; opacity: .8;
  display: inline-flex; align-items: center; gap: var(--novel-sp-1); white-space: nowrap;
  transition: background var(--novel-dur) var(--novel-ease), opacity var(--novel-dur) var(--novel-ease);
}
.novel-rdr-ctl:hover { background: color-mix(in srgb, currentColor 10%, transparent); opacity: 1; }
.novel-rdr-ctl svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
/* 章进度：墨色凹槽（底槽 + 实心），不是压在纸上的第三条外来横带；brand 蓝只留给选中态。 */
.novel-rdr-trail {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: color-mix(in srgb, var(--novel-paper-ink) 9%, transparent);
}
.novel-rdr-trail::after {
  content: ''; display: block; width: 100%; height: 100%;
  background: color-mix(in srgb, var(--novel-paper-ink) 42%, transparent);
  transform-origin: left; transform: scaleX(var(--novel-pct, 0));
  transition: transform var(--novel-dur) var(--novel-ease);
}
.novel-rdr-bar.novel-dark .novel-rdr-trail { background: var(--novel-border-faint); }
.novel-rdr-bar.novel-dark .novel-rdr-trail::after { background: var(--novel-brand); }
.novel-rdr-acts { display: flex; gap: var(--novel-sp-1); align-items: center; }
.novel-rdr-main { position: relative; flex: 1 1 auto; min-height: 0; display: flex; align-items: flex-start; background: var(--novel-paper); }
/* 正文列宽随字号走：--novel-measure（缺省 36em，行内由 prefs.measure 覆写）。 */
.novel-rdr-body {
  flex: 1 1 auto; min-width: 0; max-width: var(--novel-measure); margin-inline: auto;
  overflow-y: auto; padding: var(--novel-sp-7) var(--novel-sp-5) calc(var(--novel-sp-7) * 3);
  color: var(--novel-paper-ink);
}
/* 章界：一条「发丝 + 小字 + 发丝」的分带，不是居中大标题。 */
.novel-rdr-body h2.novel-rdr-mark {
  display: flex; align-items: center; gap: var(--novel-sp-3);
  font-size: .72em; font-weight: 400; letter-spacing: .06em; opacity: .55;
  margin: 0 0 var(--novel-sp-5);
}
.novel-rdr-mark::before, .novel-rdr-mark::after { content: ''; flex: 1; height: 1px; background: currentColor; opacity: .35; }
.novel-rdr-body p { margin: .5em 0; text-indent: 2em; }
.novel-rdr-body [data-chapter] { margin-bottom: 1.2em; }
.novel-rdr-loading { padding: var(--novel-sp-7) 0; text-align: center; opacity: .6; font-size: var(--novel-fs-md); }
.novel-sentinel { opacity: .5; font-size: var(--novel-fs-sm); padding: var(--novel-sp-6) 0; text-align: center; }
/* 目录抽屉：锚视口靠外层 .novel-drawer-slot 的 sticky，抽屉本体 absolute 浮在正文右缘。
   外层宽度给 0 的 why：抽屉当「有宽度的 flex 兄弟」会从正文列切走宽度；absolute 锚 .novel-rdr-main
   是内容盒起点，阅读越深抽屉越画出视口；flex 列里的条目滚动前先被 flex-shrink 压扁——现形态的
   不变量正是防压扁的两处修正：条目 flex: none（守卫钉住）+ 槽宽 0（0 宽槽 + 绝对定位子件 = sticky
   跟随性保留、正文列不缩水、窄屏压字可接受而挤列不可接受）。
   槽几何是共用的一条（目录抽屉与注释 / 导入说明面板同住阅读区）：各抄一份 sticky 就会漂移成
   「面板锚在内容盒上、一滚飘出视口」，守卫是 ui-system 的「共用同一份槽几何」那条。 */
.novel-drawer-slot, .novel-notes-slot {
  position: sticky; align-self: flex-start; top: calc(var(--novel-sp-7) + var(--novel-sp-1));
  flex: none; width: 0; height: 0; z-index: var(--novel-z-panel);
}
.novel-drawer {
  position: absolute; right: var(--novel-sp-3); top: var(--novel-sp-3);
  width: min(280px, calc(100vw - 48px)); max-height: calc(100vh - 88px);
  overflow-y: auto; overscroll-behavior: contain;
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); padding: var(--novel-sp-2);
  display: flex; flex-direction: column; gap: var(--novel-sp-0);
  box-shadow: var(--novel-shadow-2);
}
.novel-drawer-item {
  flex: none;                                       /* 见上：可滚动容器里的 flex 条目必须先拒绝收缩 */
  background: none; border: none; text-align: left; width: 100%; color: var(--novel-text-2);
  font: inherit; font-size: var(--novel-fs-md); padding: var(--novel-sp-2) var(--novel-sp-4);
  cursor: pointer; border-radius: var(--novel-r-sm);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-drawer-item:hover { background: var(--novel-hover); color: var(--novel-text); }
/* 当前章：底色 + 左侧 brand 标记；选择器用 aria-current（语义与样式同一个源）。 */
.novel-drawer-item[aria-current="true"] {
  background: var(--novel-brand-tint); color: var(--novel-brand-strong); font-weight: 500;
  box-shadow: inset 3px 0 0 var(--novel-brand);
}
.novel-prefs {
  display: flex; flex-direction: column; gap: var(--novel-sp-4); padding: var(--novel-sp-5);
  width: 280px; background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); box-shadow: var(--novel-shadow-2);
}
.novel-prefs-label { font-size: var(--novel-fs-xs); color: var(--novel-text-3); margin-bottom: var(--novel-sp-2); }
.novel-prefs label { font-size: var(--novel-fs-sm); color: var(--novel-text-2); display: flex; gap: var(--novel-sp-3); align-items: center; }
.novel-prefs-color { width: 28px; height: 22px; padding: 0; border: 1px solid var(--novel-border-strong); border-radius: var(--novel-r-xs); background: none; cursor: pointer; }
/* ── 图文正文 / 目录树 / 注释面板（EPUB 三组件，规则一律住本层）───────────────
   三条口径：
   ① 正文组件**不钉颜色与字号**，只继承容器——它同在两处渲染（阅读流是纸张色 + 阅读设置字号，
      注释面板是控制器层 token），组件自己钉色必有一处不可读；下面这组规则只管结构与间距。
   ② 动态量走值槽（--novel-fig-ratio，由 ChapterBody 行内写可信比值），规则里不落行内像素。
   ③ 宽内容在阅读栏内滚（.novel-table-wrap / 图片 max-width），代价是内滚，不是整页横滚。 */
.novel-body { min-width: 0; }
.novel-body p { margin: .5em 0; text-indent: 2em; }
.novel-body h1, .novel-body h2, .novel-body h3, .novel-body h4, .novel-body h5, .novel-body h6 {
  margin: 1.1em 0 .5em; font-weight: 600; line-height: 1.35; text-indent: 0;
}
.novel-body ul, .novel-body ol { margin: .5em 0; padding-left: 2em; }
.novel-body li { margin: var(--novel-sp-1) 0; }
.novel-body blockquote {
  margin: .8em 0; padding-left: var(--novel-sp-5);
  border-left: 3px solid var(--novel-border-strong); text-indent: 0;
}
/* pre 的空白是内容不是排版：换行与缩进原样保留；折行靠 pre-wrap + word-break。 */
.novel-body pre {
  margin: .8em 0; padding: var(--novel-sp-4); border-radius: var(--novel-r-xs);
  background: var(--novel-skeleton); overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  text-indent: 0; font-family: ui-monospace, Consolas, monospace; font-size: .95em;
}
.novel-body code { font-family: ui-monospace, Consolas, monospace; font-size: .95em; }
.novel-body sup, .novel-body sub { font-size: .75em; line-height: 0; }
.novel-body hr { margin: 1.4em 0; border: none; border-top: 1px solid var(--novel-border); }
/* 宽表在栏内滚：滚动归容器，否则整页被一张表撑出横滚条。 */
.novel-table-wrap { margin: .8em 0; max-width: 100%; overflow-x: auto; text-indent: 0; }
.novel-body table { border-collapse: collapse; max-width: 100%; }
.novel-body th, .novel-body td {
  border: 1px solid var(--novel-border); padding: var(--novel-sp-1) var(--novel-sp-3); vertical-align: top;
}
.novel-body caption { color: var(--novel-text-3); font-size: var(--novel-fs-sm); text-align: left; }
/* 插图：按可信宽高比先占位，加载完成/失败都不收缩框（失败只换内容）。 */
.novel-fig {
  display: block; margin: var(--novel-sp-5) auto; width: 100%; max-width: 100%;
  aspect-ratio: var(--novel-fig-ratio, 4 / 3); text-indent: 0;
  background: var(--novel-skeleton); border-radius: var(--novel-r-xs); overflow: hidden;
}
.novel-fig img { display: block; width: 100%; height: 100%; object-fit: contain; }
.novel-fig-fail {
  display: grid; place-items: center; height: 100%;
  font-size: var(--novel-fs-sm); color: var(--novel-text-3);
}
/* 正文内链：不是 <a>（raw href = 可点击导航）而是按钮——字色继承、能聚焦。 */
.novel-ref {
  font: inherit; color: inherit; padding: 0; border: none; background: none; cursor: pointer;
  text-align: left; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: .18em;
}
/* 含块级内容的链接本身是块级容器，且**宽度要显式写满**（否则插图框塌成 0）。 */
.novel-ref-block { display: block; width: 100%; }
/* 链接内容里的块级子节点：button 只收短语级元素，降级成 span。 */
.novel-ref-part { display: block; }
.novel-ref-rule { border-top: 1px solid var(--novel-border-strong); margin: .8em 0; }
/* 目录树：深度靠嵌套列表（结构即层级，不写行内缩进值）；组头不可点，故不是按钮样。 */
.novel-nav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-nav .novel-nav { padding-left: var(--novel-sp-4); }
.novel-nav-group {
  padding: var(--novel-sp-2) var(--novel-sp-4) 0;
  color: var(--novel-text-3); font-size: var(--novel-fs-sm); font-weight: 600;
}
/* 注释面板（与导入说明面板同几何）：尺寸与锚定都走目录抽屉那一条。 */
.novel-notes {
  position: absolute; right: var(--novel-sp-3); top: var(--novel-sp-3); z-index: var(--novel-z-panel);
  display: flex; flex-direction: column; width: min(360px, calc(100vw - 48px));
  max-height: calc(100vh - 88px); overflow: hidden;
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); box-shadow: var(--novel-shadow-2);
}
.novel-notes-head {
  flex-wrap: nowrap; padding: var(--novel-sp-3) var(--novel-sp-4);
  border-bottom: 1px solid var(--novel-border-faint);
}
.novel-notes-title { flex: 1 1 auto; text-align: center; font-size: var(--novel-fs-sm); color: var(--novel-text-2); }
.novel-notes-body {
  padding: var(--novel-sp-2) var(--novel-sp-4) var(--novel-sp-4);
  overflow-y: auto; overscroll-behavior: contain;
  font-size: var(--novel-fs-md); line-height: 1.7;
}
/* 导入说明清单（导入回执与阅读器面板共用）：一条 = 码 + 资源 + 人读的交代。 */
.novel-warn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-warn-list li { text-indent: 0; }
.novel-warn-code { font-size: var(--novel-fs-xs); color: var(--novel-warn); font-family: ui-monospace, Consolas, monospace; }
/* 导入回执：只在有持久告警时出现；左缘竖条说「这是说明不是错误」。 */
.novel-import-note {
  display: flex; flex-direction: column; gap: var(--novel-sp-2);
  margin: var(--novel-sp-4) 0; padding: var(--novel-sp-4) var(--novel-sp-5);
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-left: 3px solid var(--novel-warn); border-radius: var(--novel-r-md); box-shadow: var(--novel-shadow-1);
}
.novel-import-head { display: flex; align-items: center; gap: var(--novel-sp-4); }
.novel-import-head > .novel-cover, .novel-import-head > .novel-cover-fallback {
  width: 44px; margin-bottom: 0; flex: none;
}
.novel-import-who { min-width: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-import-acts { display: flex; justify-content: flex-end; gap: var(--novel-sp-3); }
/* ── 跟读高亮（正在被念的那一段）───────────────────────────────────────── */
/* 换字色 + 段首一枚小三角（ADR-0076）；不铺底色、不画段内进度线。 */
.novel-tts-live { position: relative; color: var(--novel-live-ink); }
.novel-tts-live::before {
  content: ''; position: absolute; left: -1em; top: .38em;
  width: 0; height: 0; border-top: .4em solid transparent; border-bottom: .4em solid transparent;
  border-left: .5em solid currentColor; pointer-events: none;
}
/* 注释面板复用 ChapterBody 但不带听书语义（那里永不出现命中块）。 */
.novel-notes .novel-tts-live::before { display: none; }
/* ── 翻页阅读模式：厚实体书舞台、自适应单/双页摊开与三种翻页动效 ──────────── */
/* height: 100% 贴合 .novel-main 实测高度（不硬写 100vh，避免宿主顶栏存在时出现多余纵滚）。
   .novel-book-stage 设 z-index: 0 + isolation: isolate，把书页/书脊/翻页层全部关进独立层叠上下文，
   确保底部 .novel-tts-bar（z-index: 1）及其听书设置弹层、目录抽屉、注释面板、Aa/导出面板永远压在书页之上。 */
.novel-rdr.is-paged { height: 100%; min-height: 100%; overflow: hidden; }
.novel-rdr.is-paged .novel-rdr-main { flex: 1 1 0; min-height: 0; overflow: visible; align-items: stretch; }
.novel-book-stage {
  position: relative; z-index: 0; isolation: isolate;
  flex: 1 1 auto; min-width: 0; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  padding: var(--novel-sp-4) var(--novel-sp-5);
  background: radial-gradient(
    ellipse at 50% 42%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, var(--novel-paper)) 100%
  );
  color: var(--novel-paper-ink); overflow: hidden;
}
/* 外层硬壳书封：浅暖布纹质感的精装封面边 + 通透柔和的桌面投影，不发黑发脏。 */
.novel-book-cover {
  position: relative; display: flex; align-items: stretch; max-width: 100%;
  border-radius: 12px;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--novel-paper) 86%, #8c765a) 0%,
    color-mix(in srgb, var(--novel-paper) 78%, #735f47) 100%
  );
  border: 1px solid color-mix(in srgb, var(--novel-paper-ink) 12%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .45),
    0 18px 42px color-mix(in srgb, var(--novel-paper-ink) 11%, transparent),
    0 6px 16px color-mix(in srgb, var(--novel-paper-ink) 7%, transparent),
    0 2px 4px color-mix(in srgb, var(--novel-paper-ink) 5%, transparent);
}
.novel-book-cover.is-spread { padding: 7px 9px 15px; }
.novel-book-cover.is-single { padding: 7px 9px 15px 6px; }
/* 双页精装封面中央书脊衬底：清淡雅致，不抢正文视觉。 */
.novel-book-binding-back {
  position: absolute; top: 0; bottom: 0; left: 50%; width: 38px;
  transform: translateX(-50%); pointer-events: none; z-index: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 35%,
    color-mix(in srgb, var(--novel-paper-ink) 12%, transparent) 50%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 65%,
    transparent 100%
  );
}
/* 左右厚实叠页书口：左右完全对称（各 18px、内缩 3px），确保书壳中缝与封面中线严格重合。 */
.novel-book-edge { flex: none; position: relative; z-index: 1; }
.novel-book-cover.is-spread .novel-book-edge-left {
  width: 18px; margin: 2px -3px -7px 0;
  border-radius: 8px 0 0 10px / 14px 0 0 18px;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--novel-paper-ink) 5%, transparent) 0%,
      transparent 10%,
      transparent 88%,
      color-mix(in srgb, var(--novel-paper-ink) 8%, transparent) 100%
    ),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--novel-paper-ink) 11%, transparent) 0%,
      color-mix(in srgb, var(--novel-paper-ink) 3%, transparent) 38%,
      transparent 78%,
      color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 100%
    ),
    repeating-linear-gradient(
      90deg,
      var(--novel-paper) 0px,
      var(--novel-paper) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 2.5px
    );
  box-shadow:
    inset 1px 0 2px color-mix(in srgb, var(--novel-paper-ink) 7%, transparent),
    -1px 2px 5px color-mix(in srgb, var(--novel-paper-ink) 7%, transparent);
}
/* 单页模式左侧为柔和立体圆弧书脊。 */
.novel-book-cover.is-single .novel-book-edge-left {
  width: 15px; margin: 1px 0 -7px 0; border-radius: 7px 0 0 7px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper) 74%, #7a654c) 0%,
    color-mix(in srgb, var(--novel-paper) 86%, #8c765a) 38%,
    color-mix(in srgb, var(--novel-paper) 90%, #fff) 54%,
    color-mix(in srgb, var(--novel-paper) 80%, #7a654c) 86%,
    color-mix(in srgb, var(--novel-paper) 86%, #7a654c) 100%
  );
  box-shadow: inset -1px 0 3px color-mix(in srgb, var(--novel-paper-ink) 10%, transparent);
}
.novel-book-edge-right {
  width: 18px; margin: 2px 0 -7px -3px;
  border-radius: 0 8px 10px 0 / 0 14px 18px 0;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--novel-paper-ink) 5%, transparent) 0%,
      transparent 10%,
      transparent 88%,
      color-mix(in srgb, var(--novel-paper-ink) 8%, transparent) 100%
    ),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 0%,
      transparent 24%,
      color-mix(in srgb, var(--novel-paper-ink) 3%, transparent) 66%,
      color-mix(in srgb, var(--novel-paper-ink) 11%, transparent) 100%
    ),
    repeating-linear-gradient(
      90deg,
      var(--novel-paper) 0px,
      var(--novel-paper) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 2.5px
    );
  box-shadow:
    inset -1px 0 2px color-mix(in srgb, var(--novel-paper-ink) 7%, transparent),
    1px 2px 5px color-mix(in srgb, var(--novel-paper-ink) 7%, transparent);
}
/* 底部厚实弯曲叠页切面：挂在 .novel-book-shell 内与 .novel-book-arch 共用同一坐标系与圆角曲线，
   从下方恰好托出 8px 弯曲叠纸厚度，中缝零错位、零断层。 */
.novel-book-edge-bottom {
  position: absolute; bottom: -8px; height: 22px; pointer-events: none; z-index: 0;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--novel-paper-ink) 4%, transparent) 0%,
      transparent 48%,
      color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 100%
    ),
    repeating-linear-gradient(
      180deg,
      var(--novel-paper) 0px,
      var(--novel-paper) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 2.5px
    );
  box-shadow: 0 2px 5px color-mix(in srgb, var(--novel-paper-ink) 9%, transparent);
}
.novel-book-edge-bottom.is-left {
  left: 0; width: 50%;
  border-radius: 0 0 26px 10px / 0 0 9px 5px;
}
.novel-book-edge-bottom.is-right {
  right: 0; width: 50%;
  border-radius: 0 0 10px 26px / 0 0 5px 9px;
}
.novel-book-edge-bottom.is-single {
  left: 0; right: 0;
  border-radius: 0 0 10px 3px / 0 0 6px 3px;
}
/* 书页本体：双页外壳本身透明，由左右两片拱形书页底衬（.novel-book-arch）拼出干净通透的 M 型弯曲书页轮廓。 */
.novel-book-shell {
  position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center;
  padding: var(--novel-sp-5) var(--novel-sp-6) var(--novel-sp-3);
  max-width: 100%;
}
.novel-book-shell.is-spread,
.novel-book-shell.is-single {
  background: transparent;
}
/* 左右两片弯曲拱起的实体书页底衬：与下方 .novel-book-edge-bottom 使用完全一致的 50% 宽与拱弧半径。 */
.novel-book-arch {
  position: absolute; top: 0; bottom: 0; width: 50%; pointer-events: none; z-index: 1;
}
.novel-book-arch-single {
  left: 0; width: 100%;
  border-radius: 3px 10px 10px 3px / 3px 6px 6px 3px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 7%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, var(--novel-paper)) 5%,
    color-mix(in srgb, var(--novel-paper) 94%, #fff) 16%,
    var(--novel-paper) 82%,
    color-mix(in srgb, var(--novel-paper-ink) 3%, var(--novel-paper)) 95%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, var(--novel-paper)) 100%
  );
  box-shadow:
    inset 2px 0 6px color-mix(in srgb, var(--novel-paper-ink) 5%, transparent),
    0 1px 4px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
.novel-book-arch-left {
  left: 0;
  border-radius: 10px 26px 26px 10px / 5px 9px 9px 5px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 5%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 1.5%, var(--novel-paper)) 5%,
    var(--novel-paper) 16%,
    color-mix(in srgb, var(--novel-paper) 92%, #fff) 46%,
    var(--novel-paper) 78%,
    color-mix(in srgb, var(--novel-paper-ink) 3%, var(--novel-paper)) 91%,
    color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 97.5%,
    color-mix(in srgb, var(--novel-paper-ink) 13%, var(--novel-paper)) 100%
  );
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, .65),
    inset 2px 0 4px color-mix(in srgb, var(--novel-paper-ink) 4%, transparent),
    0 1px 3px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
.novel-book-arch-right {
  right: 0;
  border-radius: 26px 10px 10px 26px / 9px 5px 5px 9px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 14%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 7%, var(--novel-paper)) 3%,
    color-mix(in srgb, var(--novel-paper-ink) 2.5%, var(--novel-paper)) 11%,
    color-mix(in srgb, var(--novel-paper) 90%, #fff) 34%,
    var(--novel-paper) 68%,
    color-mix(in srgb, var(--novel-paper-ink) 1.5%, var(--novel-paper)) 94%,
    color-mix(in srgb, var(--novel-paper-ink) 5%, var(--novel-paper)) 100%
  );
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, .65),
    inset -2px 0 4px color-mix(in srgb, var(--novel-paper-ink) 4%, transparent),
    0 1px 3px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
/* 双页中央立体书脊沟槽：极细柔和的凹陷折痕线 + 轻盈两侧柔影，不再叠成一条黑炭带。 */
.novel-book-spine {
  position: absolute; top: 4px; bottom: 4px; left: 50%; width: 48px;
  transform: translateX(-50%); pointer-events: none; z-index: 3;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, transparent) 28%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 46%,
    color-mix(in srgb, var(--novel-paper-ink) 14%, transparent) 50%,
    color-mix(in srgb, var(--novel-paper-ink) 7%, transparent) 54%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, transparent) 72%,
    transparent 100%
  );
}
/* 裁剪视口：外层 viewport 保持 overflow:visible，让 3D 翻页抬起的书页顶底角自然舒展不被割开；
   静态多栏正文只由内层 .novel-book-track-clip 裁剪。 */
.novel-book-viewport {
  position: relative; z-index: 2; overflow: visible;
}
.novel-book-track-clip {
  position: relative; overflow: hidden;
}
/* 多栏轨道：浏览器原生排版切页，不截断半行字；纯 CSS 轻盈柔焦过渡。
   跨章首帧先静止就位（无 is-settled），只在同章稳定后开启水平位移过渡，防止跨章从末页倒滑回第 0 页。 */
.novel-book-track {
  column-fill: auto; box-sizing: border-box;
  will-change: transform, filter; color: var(--novel-paper-ink);
  transition: none;
}
.novel-book-stage[data-page-anim="slide"] .novel-book-track.is-settled {
  transition: transform 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="slide"] .novel-book-track.is-sliding {
  animation: novel-slide-motion-blur 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="slide"] .novel-book-chapter.is-slide-enter-next {
  animation: novel-slide-enter-next 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="slide"] .novel-book-chapter.is-slide-enter-prev {
  animation: novel-slide-enter-prev 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="flip"] .novel-book-track.is-flipping {
  animation: novel-flip-text-soften 560ms cubic-bezier(.32, .08, .22, 1);
}
.novel-book-stage[data-page-anim="none"] .novel-book-track,
.novel-book-stage[data-page-anim="flip"] .novel-book-track {
  transition: none;
}
.novel-book-track h2.novel-rdr-mark {
  display: flex; align-items: center; gap: var(--novel-sp-3);
  font-size: .72em; font-weight: 400; letter-spacing: .06em; opacity: .55;
  margin: 0 0 var(--novel-sp-4); break-after: avoid;
}
.novel-book-track p { margin: .5em 0; text-indent: 2em; orphans: 2; widows: 2; }
.novel-book-track h1, .novel-book-track h2, .novel-book-track h3,
.novel-book-track h4, .novel-book-track h5, .novel-book-track h6 { break-after: avoid; }
.novel-book-track .novel-fig {
  max-height: calc(var(--novel-book-page-h, 520px) - 3em);
  break-inside: avoid;
}
/* ── 纯 CSS 轻盈拟真翻页层（零正文 DOM 复制）：柔焦半透纸页轻掠 + 柔和扫影 ─── */
.novel-book-flip-stage {
  position: absolute; inset: 0; z-index: 4; pointer-events: none;
  background: transparent; overflow: visible;
  perspective: 2000px; perspective-origin: 50% 46%;
}
/* 单层轻盈纸页：带 backdrop-filter 柔和虚化与曲面纸光渐变，微带 skewY 模拟柔软纸角掠过。 */
.novel-book-leaf {
  position: absolute; top: 0; bottom: 0; z-index: 3; pointer-events: none;
  border-radius: 2px;
  backdrop-filter: blur(2.5px); -webkit-backdrop-filter: blur(2.5px);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 7%, transparent) 0%,
    color-mix(in srgb, var(--novel-paper) 72%, transparent) 16%,
    color-mix(in srgb, var(--novel-paper) 82%, #fff) 50%,
    color-mix(in srgb, var(--novel-paper) 68%, transparent) 84%,
    color-mix(in srgb, var(--novel-paper-ink) 9%, transparent) 100%
  );
  box-shadow: 0 8px 24px color-mix(in srgb, var(--novel-paper-ink) 11%, transparent);
  will-change: transform, opacity;
}
.novel-book-leaf.is-spread.dir-next {
  left: 50%; width: 50%; transform-origin: left center;
  animation: novel-leaf-spread-next 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-leaf.is-spread.dir-prev {
  left: 0; width: 50%; transform-origin: right center;
  animation: novel-leaf-spread-prev 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-leaf.is-single.dir-next {
  left: 0; width: 100%; transform-origin: left center;
  animation: novel-leaf-single-next 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-leaf.is-single.dir-prev {
  left: 0; width: 100%; transform-origin: left center;
  animation: novel-leaf-single-prev 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
/* 底层轻柔扫影：克制清透不发黑。 */
.novel-book-cast-shadow {
  position: absolute; inset: 0; z-index: 2; pointer-events: none;
}
.novel-book-cast-shadow.is-spread.dir-next {
  background: linear-gradient(
    90deg,
    transparent 18%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 48%,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 54%,
    transparent 82%
  );
  animation: novel-cast-spread-next 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-cast-shadow.is-spread.dir-prev {
  background: linear-gradient(
    90deg,
    transparent 18%,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 46%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 52%,
    transparent 82%
  );
  animation: novel-cast-spread-prev 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-cast-shadow.is-single.dir-next {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 4%, transparent) 42%,
    transparent 74%
  );
  animation: novel-cast-single-next 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-cast-shadow.is-single.dir-prev {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 4%, transparent) 42%,
    transparent 74%
  );
  animation: novel-cast-single-prev 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
@keyframes novel-leaf-spread-next {
  0% { transform: rotateY(0deg) skewY(0deg); opacity: 0; }
  14% { transform: rotateY(-20deg) skewY(-1.8deg); opacity: .82; }
  50% { transform: rotateY(-92deg) skewY(-2.4deg); opacity: .88; }
  84% { transform: rotateY(-164deg) skewY(-1.2deg); opacity: .55; }
  100% { transform: rotateY(-180deg) skewY(0deg); opacity: 0; }
}
@keyframes novel-leaf-spread-prev {
  0% { transform: rotateY(0deg) skewY(0deg); opacity: 0; }
  14% { transform: rotateY(20deg) skewY(1.8deg); opacity: .82; }
  50% { transform: rotateY(92deg) skewY(2.4deg); opacity: .88; }
  84% { transform: rotateY(164deg) skewY(1.2deg); opacity: .55; }
  100% { transform: rotateY(180deg) skewY(0deg); opacity: 0; }
}
@keyframes novel-leaf-single-next {
  0% { transform: rotateY(0deg) skewY(0deg); opacity: .12; }
  18% { transform: rotateY(-22deg) skewY(-1.6deg); opacity: .82; }
  60% { transform: rotateY(-88deg) skewY(-2.2deg); opacity: .68; }
  100% { transform: rotateY(-132deg) skewY(0deg); opacity: 0; }
}
@keyframes novel-leaf-single-prev {
  0% { transform: rotateY(-128deg) skewY(0deg); opacity: 0; }
  35% { transform: rotateY(-68deg) skewY(-2deg); opacity: .78; }
  82% { transform: rotateY(-14deg) skewY(-1deg); opacity: .48; }
  100% { transform: rotateY(0deg) skewY(0deg); opacity: 0; }
}
/* 翻页与平移期间的正文轻盈柔焦：不复制任何 DOM，丝滑省电。 */
@keyframes novel-flip-text-soften {
  0% { filter: blur(0px); opacity: 1; }
  32% { filter: blur(2.2px); opacity: .84; }
  68% { filter: blur(1px); opacity: .94; }
  100% { filter: blur(0px); opacity: 1; }
}
@keyframes novel-slide-motion-blur {
  0% { filter: blur(0px); opacity: 1; }
  35% { filter: blur(1.8px); opacity: .92; }
  100% { filter: blur(0px); opacity: 1; }
}
/* 跨章顺滑入场：往下一章从右往左滑入，往上一章从左往右滑入，避免从末页倒滚回 0px。 */
@keyframes novel-slide-enter-next {
  0% { transform: translate3d(72px, 0, 0); filter: blur(2px); opacity: .55; }
  100% { transform: translate3d(0, 0, 0); filter: blur(0px); opacity: 1; }
}
@keyframes novel-slide-enter-prev {
  0% { transform: translate3d(-72px, 0, 0); filter: blur(2px); opacity: .55; }
  100% { transform: translate3d(0, 0, 0); filter: blur(0px); opacity: 1; }
}
@keyframes novel-cast-spread-next {
  0% { opacity: 0; transform: translateX(18%); }
  48% { opacity: .9; transform: translateX(0%); }
  100% { opacity: 0; transform: translateX(-22%); }
}
@keyframes novel-cast-spread-prev {
  0% { opacity: 0; transform: translateX(-18%); }
  48% { opacity: .9; transform: translateX(0%); }
  100% { opacity: 0; transform: translateX(22%); }
}
@keyframes novel-cast-single-next {
  0% { opacity: .85; transform: translateX(18%); }
  55% { opacity: .55; transform: translateX(-8%); }
  100% { opacity: 0; transform: translateX(-32%); }
}
@keyframes novel-cast-single-prev {
  0% { opacity: 0; transform: translateX(-28%); }
  45% { opacity: .75; transform: translateX(-4%); }
  100% { opacity: 0; transform: translateX(14%); }
}
/* 底部页码与翻页控制条：去掉横穿书脊的硬分割线，让书脊自上而下自然贯通 */
.novel-book-footer {
  position: relative; z-index: 2;
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  gap: var(--novel-sp-3); margin-top: var(--novel-sp-2); padding-top: var(--novel-sp-1);
  font-size: var(--novel-fs-xs); color: color-mix(in srgb, var(--novel-paper-ink) 62%, transparent);
}
.novel-book-page-num { font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.novel-book-nav {
  font: inherit; color: inherit; background: none; border: none; border-radius: 999px;
  padding: 2px var(--novel-sp-3); cursor: pointer;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
.novel-book-nav:hover:not(:disabled) {
  background: color-mix(in srgb, var(--novel-paper-ink) 9%, transparent);
  color: var(--novel-paper-ink);
}
.novel-book-nav:disabled { opacity: .32; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  .novel-book-stage[data-page-anim="slide"] .novel-book-track,
  .novel-book-stage[data-page-anim="slide"] .novel-book-chapter,
  .novel-book-stage[data-page-anim="flip"] .novel-book-track { transition: none; animation: none; }
  .novel-book-flip-stage { display: none; }
}
`
