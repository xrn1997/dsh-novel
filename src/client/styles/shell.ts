/** 宿主壳块（`NOVEL_CSS` 的第 2 块）：五分支共用的 overflow 链、宿主 composer 收口、
 *  顶部 tab 与全局状态条浮层，以及控制器层强制暗的 `.novel-dark` token 重钉
 *  （暗层字面量只此一处：自定义属性在声明处算完即继承，派生色不重钉就跟不上暗层）。 */
export const SHELL_CSS = `
/* ── 布局与宿主壳收口（与配色无关，别在改主题时弄丢）──────────────────────
   五分支共用同一条 overflow 链：.novel-root 定高 overflow:hidden、.novel-main
   flex:1 + overflow-y:auto 自己滚（阅读器一视同仁），谁在滚由 src/client/scrollport.ts
   向上探测判定（现即 .novel-main）。注意本文件是模板字符串：注释里不写反引号。
   **别把放开规则加回来**：若把这两层 overflow 放开交给宿主 scrollport 承载，全局面板链上
   没有 scrollport，结果就是整条链没人滚（滚轮无效、正文裁在首屏、scroll 事件永不发生，
   进度落盘/预取/回跳一并死）。 */
.novel-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.novel-main { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
/* 「小说」视图在场时收掉宿主常驻 composer（AI 输入框）：它是会话壳的固定座位，view 环切换不卸载
   它，切到小说 tab 后仍贴在底部压在正文上；宿主没有「本视图不需要输入框」的钩子，故本样式层用
   :has 判在场性（data-novel-root 进 DOM 才命中，切回「对话」即时恢复）。
   只藏「默认 composer」那一层（chain 的 overlay fallback 包裹层）而不是整个 [data-composer-seat]
   ——宿主给该层写的是 inline display:contents 故必须 !important；而 ui-approval /
   ui-user-questions / ui-subagent 的接管组件是它的**兄弟节点**，照样渲染：小说 tab 里 agent 提问与
   审批提示不会被吞掉（整座 display:none 会吞掉，用户在等待中看不到提问 → 卡死）。 */
[data-conversation-scroll]:has([data-novel-root]) [data-chain-overlay-fallback="conversation.composer"] { display: none !important; }
/* 配套控件：会话列宽拖拽把手（40px 透明 col-resize 条，调 AI 输入框宽度）。输入框收掉后它没对象
   可调，留着只剩一条会在正文上冒光标的假控件。用兄弟选择器而非后代：对话视图里的同名把手不受影响。 */
[data-conversation-scroll]:has([data-novel-root]) ~ [data-width-handle] { display: none; }
/* 「控制器层跟随深色」：勾上即把本层局部 token 钉成暗底值（正文纸张色不受影响）。
   宿主没有「强制暗层」的现成 token，故这一处允许字面量——它表达的是用户显式选择，不是主题推导。
   novel-dark 挂在阅读器控制器条根，整个控制器层（条 / Aa 面板 / 导出面板 / 抽屉）同底。
   条自己那一档另见 .novel-rdr-bar.novel-dark：它**默认跟纸色**，勾上才让回这里的 --novel-bg。 */
.novel-dark {
  --novel-layer-1: #1b1b1d;
  --novel-layer-2: #232325;
  --novel-border: #ffffff1f;
  --novel-border-strong: #fff3;
  --novel-hover: #ffffff14;
  --novel-active: #ffffff24;
  --novel-text: #f9fafb;
  --novel-text-2: #cfd3d6;
  --novel-text-3: #adb2b8;
  --novel-fg: #0f1115;
  --novel-brand: #f9fafb;
  --novel-primary-fill: #f9fafb;
  --novel-primary-hover: #e5e5e5;
  /* 派生色在此层必须重钉：自定义属性在声明处算完就继承下去，暗层换 --novel-brand 不会回填上层派生值
     --novel-ring 同理（它按 var(--novel-brand) 在 token 层算完即继承）——不重钉则暗层焦点环仍是亮蓝 */
  --novel-brand-soft: color-mix(in srgb, #f9fafb 8%, transparent);
  --novel-brand-tint: color-mix(in srgb, #f9fafb 12%, transparent);
  --novel-brand-line: color-mix(in srgb, #f9fafb 27%, transparent);
  --novel-brand-strong: #f9fafb;
  --novel-ring: #f9fafb;
  --novel-skeleton: #ffffff14;
  /* 控制器层强制暗：阅读器条在 .novel-rdr-bar.novel-dark 里读它（条默认跟纸色，勾上才让回暗底），
     浮层底那几条也读它——不重钉就是「暗面板 + 亮工具栏」 */
  --novel-bg: #1b1b1d;
  color: var(--novel-text);
}
[data-novel] { font-size: var(--novel-fs-base); }
/* ── border-box 守卫（作用域：插件自己的两棵树，不碰宿主）──
   没有 box-sizing 声明则默认 content-box，凡「显式 width/max-width + padding」的件外廓都比
   容器宽（padding 量）——.novel-wrap 窄列下横向溢出 + .novel-main 把另一轴也算成可滚 →
   底部横滚条 + 网格右侧截断（用户真机反馈「书架宽度怎么回事」的根因）；modal/drawer/prefs
   定宽同病都肥一圈。reset 只圈 .novel-root 与 [data-novel-scope] 两棵树。
   （本文件注释里别写反引号：NOVEL_CSS 是模板字符串，反引号会当场截断它。） */
.novel-root, .novel-root *, .novel-root *::before, .novel-root *::after,
[data-novel-scope], [data-novel-scope] *, [data-novel-scope] *::before, [data-novel-scope] *::after {
  box-sizing: border-box;
}
.novel-view { padding: var(--novel-sp-4) var(--novel-sp-5); display: flex; flex-direction: column; gap: var(--novel-sp-4); }
/* ── 顶部 tab 导航（书架 | 书城 | 书源管理）：IA 上三者并列，选择即切换下方内容。
   不做「书城预留位占位 chip」：占位不如真导航（书城已是两级分类浏览页本身）；书源管理 =
   宿主设置「小说」区块整体搬入（settings.section 注册撤除，单一归属）。
   reader/search 是 tab 之下的沉浸内容流，各有自己的返回导航，本行不随行。 */
.novel-tabs { display: flex; gap: var(--novel-sp-0); padding: var(--novel-sp-4) var(--novel-sp-5) 0; }
.novel-tabs button {
  background: none; border: none; color: var(--novel-text-2); font-size: var(--novel-fs-base);
  padding: var(--novel-sp-1) var(--novel-sp-5); border-radius: var(--novel-r-sm);
  cursor: pointer; font-family: inherit; white-space: nowrap;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
.novel-tabs button:hover { color: var(--novel-text); }
.novel-tabs button.on { color: var(--novel-brand-strong); background: var(--novel-brand-tint); font-weight: 600; }
/* ── 全局状态条＝浮层 ─────────────────────────
   状态条必须是**浮层**：作为普通流内元素，泳道一挂就把下面内容顶下去、settle 再弹回
   （逐帧实测 +35px、每次启停 2 条 layout-shift），而单源启停往返 ≈1 帧 = 肉眼可见的闪烁。
   做法：容器 position:relative + 状态条 absolute——泳道来去不再参与布局。代价是条目浮在上方
   一小条（自带底/描边/投影），仍可点（任务条=跳转、错误条=定位/忽略）。
   锚点住宿主 shell.overlay 的 .novel-shell-status——中央呈现座位一次只渲染一个面板，
   住在视图环内切走即失去读数。该层默认 click-through，故条目自己收回
   pointer-events。**条身锚右下而非顶部通栏**：overlay 铺满整个 frame，顶部通栏会正盖在宿主
   会话标题行上（pointer-events:auto ⇒ 任务在跑时宿主钮点不到）；右下角落无宿主 chrome。 */
.novel-shell-status {
  position: fixed; inset: 0; pointer-events: none; z-index: var(--novel-z-status);
}
.novel-shell-status .novel-status-bar { pointer-events: auto; }
.novel-status-bar {
  position: absolute; bottom: var(--novel-sp-3); right: var(--novel-sp-3);
  max-width: min(420px, calc(100% - 2 * var(--novel-sp-3)));
  z-index: var(--novel-z-status);
  display: flex; flex-direction: column;
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); overflow: hidden; box-shadow: var(--novel-shadow-2);
}
.novel-toolbar { display: flex; flex-wrap: wrap; gap: var(--novel-sp-3); align-items: center; }
.novel-btn {
  font: inherit; font-size: var(--novel-fs-md); padding: var(--novel-sp-1) var(--novel-sp-4);
  border-radius: var(--novel-r-sm); cursor: pointer;
  border: 1px solid var(--novel-border); background: transparent; color: inherit;
  transition: background var(--novel-dur) var(--novel-ease), border-color var(--novel-dur) var(--novel-ease),
    color var(--novel-dur) var(--novel-ease);
}
.novel-btn:hover { background: var(--novel-hover); }
.novel-btn:active { background: var(--novel-active); }
.novel-btn:disabled { opacity: .45; cursor: default; }
.novel-btn.sm { font-size: var(--novel-fs-sm); padding: var(--novel-sp-0) var(--novel-sp-3); }
.novel-btn.primary {
  background: var(--novel-primary-fill); border-color: var(--novel-primary-fill);
  color: var(--novel-fg);
}
.novel-btn.primary:hover { background: var(--novel-primary-hover); }
/* 选中/在态的 ghost 钮（状态 chips、表头「编辑」）：brand 描边 + brand 弱底 */
.novel-btn.on { border-color: var(--novel-brand); background: var(--novel-brand-tint); color: var(--novel-brand-strong); }
/* 危险动作：红字红边，但底不刷红——危险性由文案与确认动作表达（删除确认统一走模态） */
.novel-btn.danger { color: var(--novel-err); border-color: var(--novel-err-line); }
.novel-btn.danger:hover { background: var(--novel-err-weak); }
`
