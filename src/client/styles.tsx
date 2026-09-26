import type { ReactNode } from 'react'

/** 基础样式层：视图环各视图 + 宿主设置区块共用的 design token、标度与组件类
 *  （口径详见 `docs/design/client.md`）。
 *
 *  ── 配色契约（宿主 `@deepseek-ai/dsh-client-ui-theme` 的 alias 语义层）─────────────
 *  宿主把调色板与语义层都挂在 `body` / `body[data-ds-dark-theme]` 上（两套同名 token，
 *  暗态靠选择器特异性覆盖），所以本插件**只需引用语义 token**，光/暗自动跟随，不必自己
 *  判深浅、不该写死任何主题色。踩过的坑（本次修复的病根）：
 *    ① `--dsw-alias-border-l` 在宿主里**根本不存在**（宿主是 l1/l2/l3/l4 四级）——
 *       引用它 = 永远落到硬编码 fallback，边框在光/暗两态都不跟随宿主（暗态还偏浅）。
 *    ② `rgba(255,255,255,.0x)` 这类写死的白色叠层只在暗底成立，光态下 hover/表头/进度槽
 *       全部与底色无对比（实测对比度 ≈ 1.00，肉眼不可见）。
 *    ③ 状态色（可用/不可用）写死 `#3fb950/#f85149` = 钉死一套主题的观感。
 *    ④ 同罪但换了主语：**引用本层自己不存在的 token**。`.novel-searchbox` 曾写
 *       `var(--novel-layer)`（层板只有 `-1/-2/-3`），CSS 不报错，而是让整条 `background`
 *       简写落到 `unset` → 实测计算值 `rgba(0,0,0,0)`，搜索框从此没有底。
 *       守卫在 `tests/client/ui-system.test.tsx`：本层每个 `var(--novel-*)` 引用都必须有定义。
 *  本文件因此把用到的 token 先收进 `.novel-root, [data-novel-scope]` 一层局部变量：
 *  视觉规则只读局部变量（读起来是自解释的语义名），token→宿主、fallback→暗底老观感。
 *  自定义属性覆盖 `.novel-root` 与 `[data-novel-scope]` 两个根：病史是宿主设置区块曾渲染在
 *  **独立 React 树**（`SettingsSection` 在宿主设置页，拿不到 `NovelView` 的根节点，坑见
 *  ab2391d）；2026 IA 后设置区块搬进小说视图（已同树），双根覆盖与组件自带 `data-novel-scope`
 *  的自足性**保留**——组件在哪棵树渲染都成立，可测性不受挂载点影响。
 *
 *  ── 标度（sp/fs/r/shadow/z/dur）───────────────────────────────────────────────
 *  间距、字阶、圆角、阴影、层级、动效时长各有一套 named 标度，视觉规则里不再散写像素：
 *  散值的代价不是「不美观」，是**同一层里 2/3/5/7/11/13/18/22px 混用**时读者无法判断
 *  哪一档才是意图，改一处无从对齐其余三十处。中文最小可读字阶取 11px（10px 的「本地」角标
 *  笔画会糊）。z 序见「浮层层级」一节，与本层 `--novel-z-*` 同表——`CTRL_Z` 是控制器层的
 *  JS 侧主人（`reader-ctrl-z.test.ts` 钉），两者的相对次序由 `ui-system.test.tsx` 钉死。
 *
 *  以 <style data-novel-style> 注入（renderToString 友好；HMR 重载随 bundle 整体替换）。 */
export const NOVEL_CSS = `
.novel-root, [data-novel-scope] {
  /* 层级：底(页面) → 层1(容器/工具栏) → 层2(面板/浮层/抽屉) → 层3(输入件)。宿主层板只到 layer-3。 */
  --novel-bg: var(--dsw-alias-bg-base, #1e1e1e);
  --novel-layer-1: var(--dsw-alias-bg-layer-1, #1e1e1e);
  --novel-layer-2: var(--dsw-alias-bg-layer-2, #242426);
  --novel-layer-3: var(--dsw-alias-bg-layer-3, #2b2b2e);
  /* 描边：容器 l2 / 输入件 l4 / 行内发丝 l1（宿主自己的描边也是 .5px 起步，别用 1px 实心灰） */
  --novel-border: var(--dsw-alias-border-l2, #ffffff1f);
  --novel-border-strong: var(--dsw-alias-border-l4, #fff3);
  --novel-border-faint: var(--dsw-alias-border-l1, #ffffff0f);
  /* 交互与文字 */
  --novel-hover: var(--dsw-alias-interactive-bg-hover, #ffffff14);
  --novel-active: var(--dsw-alias-interactive-bg-active, #ffffff24);
  --novel-text: var(--dsw-alias-label-primary, #f9fafb);
  --novel-text-2: var(--dsw-alias-label-secondary, #cfd3d6);
  --novel-text-3: var(--dsw-alias-label-tertiary, #adb2b8);
  --novel-fg: var(--dsw-alias-label-primary-foreground, #0f1115);
  --novel-brand: var(--dsw-alias-brand-primary, #2f6feb);
  --novel-primary-fill: var(--dsw-alias-button-primary-fill, #2f6feb);
  --novel-primary-hover: var(--dsw-alias-button-primary-hover, #3b7bf0);
  /* brand 派生色：视图此前内联 #2f6feb14/1f/44 与 #79a8ff——brand 一换色即全部失联。
     alpha 值按 --novel-brand 用 color-mix 派生（宿主换 brand / 主按钮换色自动跟随）；
     strong 走宿主「亮蓝语义文字」alias（无派生对应），fallback 即原内联色。 */
  --novel-brand-soft: color-mix(in srgb, var(--novel-brand) 8%, transparent);   /* 选中动作条底 */
  --novel-brand-tint: color-mix(in srgb, var(--novel-brand) 12%, transparent);  /* 选中 chip / 编辑态底 */
  --novel-brand-line: color-mix(in srgb, var(--novel-brand) 27%, transparent);  /* 运行卡 / 选中条描边 */
  --novel-brand-strong: var(--dsw-alias-label-primary-bluish, #79a8ff);         /* 亮蓝强调字 */
  --novel-skeleton: var(--dsw-alias-bg-skeleton, #ffffff14);
  /* 模态遮罩：宿主语义层真名 bg-mask-1（词表在 theme-tokens 守卫内）——视觉规则只读本局部变量 */
  --novel-mask: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .45));
  /* 状态：成功/错误/警告 + 其弱底（错误底用宿主 interactive-*-danger 而非自调 alpha） */
  --novel-ok: var(--dsw-alias-state-success-primary, #3fb950);
  --novel-err: var(--dsw-alias-state-error-primary, #f85149);
  --novel-warn: var(--dsw-alias-state-warn-primary, #d29922);
  --novel-err-weak: var(--dsw-alias-interactive-bg-hover-danger, rgba(248,81,73,.08));
  --novel-err-line: color-mix(in srgb, var(--novel-err) 35%, transparent);      /* 危险钮描边 */
  /* 源状态三色（徽标内联用）：可用/不可用/未验证——未验证=次要文字色，不是自造灰 */
  --novel-status-verified: var(--dsw-alias-state-success-primary, #3fb950);
  --novel-status-broken: var(--dsw-alias-state-error-primary, #f85149);
  --novel-status-unverified: var(--dsw-alias-label-tertiary, #8b949e);
  /* 字面量（无宿主对应）：纯白字压在主按钮/错误徽标上 */
  --novel-on-solid: #fff;
  /* 焦点环：走 brand（宿主主色）+ 2px 外偏移——原先借 label-secondary 与正文同色系，
     在密集列表里几乎找不着环；primary 钮上另换 --novel-text（brand 压 brand 等于没有）。 */
  --novel-ring: var(--novel-brand);
  /* ── 标度：间距 / 字阶 / 圆角 / 阴影 / 层级 / 动效 ── */
  --novel-sp-0: 2px; --novel-sp-1: 4px; --novel-sp-2: 6px; --novel-sp-3: 8px;
  --novel-sp-4: 12px; --novel-sp-5: 16px; --novel-sp-6: 24px; --novel-sp-7: 32px;
  --novel-fs-xs: 11px; --novel-fs-sm: 12px; --novel-fs-md: 13px;
  --novel-fs-base: 14px; --novel-fs-lg: 16px; --novel-fs-xl: 19px;
  --novel-r-xs: 4px; --novel-r-sm: 6px; --novel-r-md: 8px; --novel-r-lg: 12px;
  --novel-shadow-1: 0 1px 4px rgba(0, 0, 0, .18);      /* 封面贴页 */
  --novel-shadow-2: 0 6px 16px rgba(0, 0, 0, .16);     /* 卡片浮起 / 状态条浮层 */
  --novel-shadow-pop: 0 18px 48px rgba(0, 0, 0, .35);  /* 模态 */
  --novel-dur: .15s; --novel-ease: cubic-bezier(.2, 0, 0, 1);
  /* 值槽（唯一由行内写入的动态量，规则都住本层）：
     --novel-pct 进度推进（bits.ProgressBar / 章进度细线），--novel-measure 正文栏宽（prefs.measure，
     随字号缩放的 em）。在此定义为缺省值——它们不是主题色，但必须在词表里在册，否则 token 自足
     守卫会把「行内写、样式读」的这一路判成未定义引用。 */
  --novel-pct: 0;
  --novel-measure: 36em;
  /* 插图预留宽高比（ChapterBody 由 wire 的可信 width/height 行内写入，规则读本值）：
     值槽在此在册是 token 自足守卫的硬要求——「行内写、样式读」的这一路也必须词表里有名。 */
  --novel-fig-ratio: 4 / 3;
  /* 浮层层级单表（控制器层三级由 CTRL_Z 同名钉住，防两处各写各的数） */
  --novel-z-status: 5; --novel-z-mask: 10; --novel-z-panel: 11; --novel-z-toolbar: 12; --novel-z-modal: 30;
  /* 无封面降级的书名首字色块：低饱和四档（深浅两态都成立的中间调），
     视图按 coverTintClass(title) 选类——hex 只住 token 层（theme-tokens 守卫口径） */
  --novel-cover-1: #3c4250;
  --novel-cover-2: #3d4a42;
  --novel-cover-3: #4d3a3a;
  --novel-cover-4: #443a4d;
  color: var(--novel-text);
}
/* ── 布局与宿主壳收口（与配色无关，别在改主题时弄丢：commit e25ff8e / ab2391d）──────
   五分支共用同一条 overflow 链：.novel-root 定高 overflow:hidden、.novel-main
   flex:1 + overflow-y:auto 自己滚（阅读器一视同仁），谁在滚由 src/client/scrollport.ts
   向上探测判定（现即 .novel-main）。注意本文件是模板字符串：注释里不写反引号。
   病史——**别把放开规则加回来**：阅读器曾放过这两层 overflow、把正文交给宿主 resident
   scrollport（[data-conversation-scroll]）承载，那是 conversation.view 时代的前提；
   a9f35f7 迁全局面板后祖先链是 centerCol/frame 双 overflow:hidden，链上再无 scrollport，
   放开 = 整条链没人滚：滚轮无效、正文裁在首屏、scroll 事件永不发生（进度落盘/预取/回跳
   一并死）。三链差分实测与病史细节见 docs/design/client.md「控制器层与正文层」。 */
.novel-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.novel-main { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
/* 「小说」视图在场时收掉宿主常驻 composer（AI 输入框）：它是会话壳的固定座位
   （scrollBody > [data-composer-seat]，data-phase=active 下 sticky bottom），view 环切换不卸载它，
   所以切到小说 tab 后它仍贴在底部、还压在正文上。宿主没有「本视图不需要输入框」的钩子
   （轨迹视图用的是 data-conversation-composer-overlay 浮层），故由本样式层用 :has 判在场性：
   只有 data-novel-root 进了 DOM（= 小说 tab 被选中渲染）才命中，切回「对话」样式随之卸载、输入框即时恢复。
   只藏「默认 composer」那一层（chain 的 overlay fallback 包裹层）而不是整个 [data-composer-seat]——
   未选中接管时宿主给该层写的是 inline display:contents，故必须 !important；而 ui-approval /
   ui-user-questions / ui-subagent 的接管组件是它的**兄弟节点**，照样渲染：小说 tab 里 agent 提问与
   审批提示不会因为本规则被吞掉（整座 display:none 会吞掉，用户在等待中看不到提问 → 卡死）。
   宿主 DOM 钩子 [data-conversation-scroll]/[data-composer-seat]/[data-chain-overlay-fallback]
   与 src/client/scrollport.ts 的 [data-conversation-scroll] 同源。 */
[data-conversation-scroll]:has([data-novel-root]) [data-chain-overlay-fallback="conversation.composer"] { display: none !important; }
/* 配套控件：会话列宽拖拽把手。宿主在 .wSkVaW_body 里 [data-conversation-scroll] 之后渲染左右两条
   div[data-width-handle]（宿主自己的覆盖场景也是 hide 它：:has([data-conversation-composer-overlay]) → display:none）。
   它是 40px 透明 col-resize 条，hover 出竖光条，拖动写 --dsh-chat-user-width → --dsh-composer-card-max-width
   = 「调 AI 输入框宽度」；输入框收掉后它没对象可调，留着只剩一条会在正文上冒光标的假控件。
   用兄弟选择器而非后代：对话视图（chat）里的同名把手不受影响。 */
[data-conversation-scroll]:has([data-novel-root]) ~ [data-width-handle] { display: none; }
/* 「控制器层跟随深色」：勾上即把本层局部 token 钉成暗底值（正文纸张色不受影响）。
   宿主没有「强制暗层」的现成 token，故这一处允许字面量——它表达的是用户显式选择，不是主题推导。
   层-1（工具栏底）也在此重钉：工具栏挂的是 --novel-layer-1，不重钉就会「暗面板 + 亮工具栏」
   novel-dark 现挂在工具栏根，整个控制器层同底。 */
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
  /* 控制器层强制暗：阅读器工具栏底读 --novel-bg——不重钉就是「暗面板 + 亮工具栏」 */
  --novel-bg: #1b1b1d;
  color: var(--novel-text);
}
[data-novel] { font-size: var(--novel-fs-base); }
/* ── border-box 守卫（作用域：插件自己的两棵树，不碰宿主）──
   病史（探针实测）：本样式层此前没有 box-sizing 声明 → 默认 content-box，
   .novel-wrap（width:100% / max-width:1600px + padding:0 24px）的外廓恒比容器宽 48px——
   vp=1670 时 main cw=1670 ≥ wrap 外廓 1648 侥幸无恙；vp=970 时实测 main cw=970 sw=1002、
   overflowing=novel-wrap；.novel-main 的 overflow-y:auto 按 CSS 规范把另一轴也算成
   auto → 底部横向滚动条 + 网格右侧被截断（用户真机反馈「书架宽度怎么回事」的根因）。
   同病还波及一切「显式 width/max-width + padding」件（modal/drawer/prefs 定宽都肥一圈）。
   reset 只圈 .novel-root 与 [data-novel-scope] 两棵树——宿主其余区域不受影响。
   （本文件注释里别写反引号：NOVEL_CSS 是模板字符串，反引号会当场截断它。） */
.novel-root, .novel-root *, .novel-root *::before, .novel-root *::after,
[data-novel-scope], [data-novel-scope] *, [data-novel-scope] *::before, [data-novel-scope] *::after {
  box-sizing: border-box;
}
.novel-view { padding: var(--novel-sp-4) var(--novel-sp-5); display: flex; flex-direction: column; gap: var(--novel-sp-4); }
/* ── 顶部 tab 导航（书架 | 书城 | 书源管理）：IA 上三者并列（2026 变更，用户拍板）——
   选择即切换下方内容。曾经的「书城预留位占位 chip」退役：占位不如真导航（书城未上线时
   点开是诚实的占位空态 CityView，内容上线后填充该分支，导航结构不用再改）；书源管理 =
   原宿主设置「小说」区块整体搬入（settings.section 注册撤除，单一归属）。
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
/* ── 全局状态条＝浮层（真机逐帧实测）─────────────────────────
   病根：状态条原本是区块里的**普通流内**元素。一次启停就推一条泳道 → 挂上即把下面所有内容
   顶下去、settle 再弹回（实测区块头 y 116→151、源列表首行 y 361→396，整块 **+35px**，每次
   启停 2 条 layout-shift）。单源启停往返本机只有 13~20ms（≈1 帧），于是肉眼看到的是「一帧的
   下沉回弹」＝闪烁；服务端事件循环被占（LLM 流式/导入验证）时往返变长，就变成整块下移几百
   毫秒再弹回（节流 400ms 实测：泳道连续绘制 26 帧 ≈ 416ms）。
   修法：宿主容器 position:relative + 状态条 position:absolute —— 泳道来去不再参与布局，
   慢操作与错误条也不再顶动内容。代价：条目在场时它浮在区块头上方一小条（自带底/描边/投影
   以便与正文分离），条目仍可点（任务条=跳转、错误条=定位/忽略）。
   2026-09 住址变更：锚点从「小说视图内的 .novel-status-host」换成「宿主 shell.overlay 里的
   .novel-shell-status」——conversation.view 一次只渲染一个 tab，状态条住在视图环内就等于切走
   tab 即失去读数。那一层默认 click-through（官方声明：entries opt back into pointer events），
   故条目自己收回 pointer-events。
   但**条身不能沿用原来那套顶部通栏偏移**：原锚点在小说视图内部的区块头，宽满 = 视图宽；换到
   overlay 后容器铺满整个 frame（宿主 .pI_x6G_overlayLayer 是 inset: 0，含会话顶栏），
   「top + left + right」的真机读数就是「y=6、左右各 8、全宽 1264、高 26」的一条——正好盖在
   宿主会话标题行上，而它是 pointer-events:auto，于是任务在跑期间那一条带子里宿主自己的钮都点不到。
   改锚右下并限宽：角落无宿主 chrome，观感是「一颗浮在内容之上的状态胶囊」。 */
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
/* 危险动作：红字红边，但底不刷红——危险性由文案与确认动作表达（危险区专区已退役，删除确认统一模态） */
.novel-btn.danger { color: var(--novel-err); border-color: var(--novel-err-line); }
.novel-btn.danger:hover { background: var(--novel-err-weak); }
/* ── 焦点环：一套覆盖所有交互件（brand 环 + 2px 偏移，压在深浅两种底上都找得着）──
   .novel-btn.primary 另有环色换色规则（brand 压 brand 等于没有）；手风琴退役后
   .novel-section-* 系列规则已随之删除（死代码不留）。 */
.novel-btn:focus-visible,
.novel-input:focus-visible, .novel-textarea:focus-visible, .novel-chip:focus-visible,
.novel-seg button:focus-visible, .novel-tabs button:focus-visible, .novel-menu button:focus-visible,
.novel-card:focus-visible, .novel-row-main:focus-visible,
.novel-drawer-item:focus-visible, .novel-switch:focus-visible, .novel-searchbox:focus-within,
.novel-ref:focus-visible {
  outline: 2px solid var(--novel-ring); outline-offset: 2px;
}
.novel-btn.primary:focus-visible { outline-color: var(--novel-text); }
.novel-input, .novel-textarea {
  font: inherit; font-size: var(--novel-fs-md); padding: var(--novel-sp-2) var(--novel-sp-4);
  border-radius: var(--novel-r-sm); border: 1px solid var(--novel-border-strong);
  color: inherit; background: var(--novel-layer-3);
  outline-offset: 2px;
}
.novel-input::placeholder, .novel-textarea::placeholder { color: var(--novel-text-3); }
.novel-textarea { width: 100%; font-family: ui-monospace, Consolas, monospace; }
.novel-panel { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); padding: var(--novel-sp-4); background: var(--novel-layer-2); }
/* 错误横幅（会话/导出失败）：弱底 + 徽标 + 重试钮，全靠标度；旧实现在视图里行内写死 */
.novel-error-banner { background: var(--novel-err-weak); margin: var(--novel-sp-3) 0; }
.novel-retry { margin-left: var(--novel-sp-4); }
/* 运行卡（导入 / 批量验证共用外壳）：brand 派生色浮层底，标题行窄时可折。
   复合选择器不是冗余：.novel-group（本文件更后处）也写 gap，靠顺序决胜太脆。 */
.novel-group.novel-run-card {
  border: 1px solid var(--novel-brand-line); border-radius: var(--novel-r-md);
  background: var(--novel-brand-soft); padding: var(--novel-sp-5); gap: var(--novel-sp-3);
}
.novel-run-card-head { flex-wrap: wrap; gap: var(--novel-sp-2) var(--novel-sp-4); }
.novel-muted { color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
/* 场景内提示行（书架导入/加载错误等）：字号走标度，不再行内 fontSize */
.novel-note-sm { font-size: var(--novel-fs-sm); }
.novel-note-md { font-size: var(--novel-fs-md); line-height: 1.6; }
/* 隐藏的原生 file input（由拖放区/自绘钮触发）：display:none 不进无障碍树，
   触发方是可见按钮，不构成「藏起来却还能操作」 */
.novel-file-hidden { display: none; }
.novel-ok { color: var(--novel-ok); } .novel-err { color: var(--novel-err); } .novel-warn { color: var(--novel-warn); }
.novel-badge { font-size: var(--novel-fs-sm); white-space: nowrap; }
.novel-badge[data-status="verified"] { color: var(--novel-status-verified); }
.novel-badge[data-status="broken"] { color: var(--novel-status-broken); }
.novel-badge[data-status="unverified"] { color: var(--novel-status-unverified); }
.novel-badge-pill {
  display: inline-block; padding: 0 var(--novel-sp-2); border-radius: var(--novel-r-xs);
  margin-right: var(--novel-sp-3);
  font-size: var(--novel-fs-sm); background: var(--novel-err); color: var(--novel-on-solid);
}
/* 分组徽丸（图标态）：分组列只显示图标（hover 出全名，无图标组回退全名，
   表头「?」有图例）；flex-wrap 兜底——极多组/病态长名折行不撑破列 */
.novel-grouppill {
  display: inline-block; padding: 0 var(--novel-sp-2); border-radius: var(--novel-r-xs);
  font-size: var(--novel-fs-xs); line-height: 1.7;
  background: var(--novel-skeleton); color: var(--novel-text-2); white-space: nowrap;
}
.novel-group-legend { cursor: help; margin-left: var(--novel-sp-0); }
/* 表头「?」图例（cursor:help 是「这里有解释」的唯一提示） */
/* 圆角**不能**靠 overflow: hidden 收：行内「⋯」菜单（.novel-menu 绝对定位）的包含块
   .novel-actions 就在表内，一裁就把菜单锁进表格盒、超出表底的部分点不到——实测（真
   NOVEL_CSS + 真 Edge）末行菜单 89px 只可见 **21px**，越出表底 68px；库里源一少、菜单
   每次都在末行时必现（2026-09-26 用户实机）。改为首/末行各自带圆角裁自己的背景，
   浮层语义归浮层、圆角归圆角。 */
.novel-table { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  /* 容器查询锚：源列表按**表格自身宽度**（不是视口宽度）收列——宿主会话列可拖窄，
     视口断点在分栏布局下量不准。inline-size containment 同时把表格的布局影响范围关住。 */
  container-type: inline-size;
}
/* 圆角落在行上（表头背景 / hover 底色由行自己裁）。:only-child 写在最后——它与 :first-child
   同特异度，靠次序覆盖「一行成表」（.novel-tr.one 空态行）的四个角。 */
.novel-table > .novel-tr:first-child { border-top-left-radius: var(--novel-r-md); border-top-right-radius: var(--novel-r-md); }
.novel-table > .novel-tr:last-child { border-bottom-left-radius: var(--novel-r-md); border-bottom-right-radius: var(--novel-r-md); }
.novel-table > .novel-tr:only-child { border-radius: var(--novel-r-md); }
.novel-tr {
  display: grid; gap: var(--novel-sp-3); align-items: center;
  padding: var(--novel-sp-2) var(--novel-sp-4); font-size: var(--novel-fs-md);
  border-top: 1px solid var(--novel-border-faint);
}
.novel-tr:first-child { border-top: none; }
.novel-tr:hover { background: var(--novel-hover); }
.novel-tr.head { background: var(--novel-skeleton); font-size: var(--novel-fs-sm); color: var(--novel-text-2); }
/* 源列表六列：列宽唯一住址（表头与每一行共用，此前是两处逐字重复的字面量）。
   操作列（第5轨）**定宽 + 右对齐**（2026 调度台改版）：内容随状态增减（异常态多一个
   验证/重验钮），auto 轨让各行内容宽不一 → 右缘按钮组漂移（用户实机反馈「没对齐」）；
   定宽后「试跑/⋯」右缘全表锚定，状态动作钮向左生长。启停唯一入口 = 最右开关，
   行内不再渲染重复的「启用」文字钮。 */
.novel-tr.src { grid-template-columns: minmax(120px, 1.3fr) 68px minmax(0, 1fr) minmax(0, 1.6fr) 148px auto; }
.novel-tr.one { grid-template-columns: 1fr; }
/* 窄表收列：地址是「认得出这源」的次要线索，名称/状态/分组/操作才是要害——
   隐藏列与列轨数必须同时改（少一格配六轨 = 整行错位） */
@container (max-width: 620px) {
  .novel-tr.src { grid-template-columns: minmax(120px, 1.4fr) 68px minmax(0, 1fr) 120px auto; }
  .novel-tr.src > .col-url { display: none; }
}
/* 行级失败锚点（全局状态条的行内装饰层，transient.ts）：文案归条，行内只留红左边标记——
   错误条目的定位按钮 scrollIntoView 跳到这里，标记随错误 dismiss 消失 */
.novel-tr.row-err { box-shadow: inset 3px 0 0 var(--novel-err); }
/* 停用行：内容变灰、名称去粗体（**启停开关不参与变灰**——把开关一起压暗会读成「控件禁用」，
   而停用态恰恰是最需要能被点回来的东西）。旧实现把 opacity 行内写在四个格子上。 */
.novel-tr.off .novel-td, .novel-tr.off .novel-badge, .novel-tr.off .novel-grouppill { opacity: .6; }
.novel-tr.off strong { font-weight: 400; }
.novel-td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-td.name { display: flex; align-items: center; gap: var(--novel-sp-3); min-width: 0; }
.novel-actions { display: flex; gap: var(--novel-sp-2); justify-content: flex-end; position: relative; }
/* ── 启停开关（设置区）：状态由 aria-checked 表达，位移用 transform 而非 left
   （left 改的是布局位置，每切一次都要重排一行；transform 只走合成层）。
   旧实现把 30/17/13/15px 全写在行内 style 上，642 行每行每次渲染新建两个 style 对象。 */
.novel-switch {
  position: relative; flex: none; width: 30px; height: 17px; padding: 0;
  border-radius: 999px; cursor: pointer;
  background: var(--novel-skeleton); border: 1px solid var(--novel-border-strong);
  transition: background var(--novel-dur) var(--novel-ease), border-color var(--novel-dur) var(--novel-ease);
}
.novel-switch[aria-checked="true"] { background: var(--novel-ok); border-color: var(--novel-ok); }
.novel-switch > i {
  position: absolute; top: 1px; left: 1px; width: 13px; height: 13px; border-radius: 50%;
  background: var(--novel-text-3);
  transition: transform var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-switch[aria-checked="true"] > i { transform: translateX(13px); background: var(--novel-on-solid); }
.novel-switch[data-busy="true"] { opacity: .55; cursor: wait; }
/* ── 书源待办收件箱（2026 调度台 IA，用户拍板：反常置顶、任务卡横排）──
   宽屏口径：auto-fit 卡片网格——横跨整列的长条在 1600px 内容列下中间空、动作钮孤悬列尾
   （悬浮碎片病，实测用户反馈）；窄屏/会话列拖窄自动堆叠。
   读数职责从状态 chips 移交此处：坏源/未验证的数量与处置动作同框，chips/.novel-chip-dot 退役。 */
.novel-inbox { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); background: var(--novel-layer-2); }
.novel-inbox-head { display: flex; align-items: center; gap: var(--novel-sp-3);
  padding: var(--novel-sp-3) var(--novel-sp-4); border-bottom: 1px solid var(--novel-border-faint); }
.novel-inbox-head strong { font-size: var(--novel-fs-base); }
.novel-inbox-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 340px));
  gap: var(--novel-sp-3); padding: var(--novel-sp-3) var(--novel-sp-4) var(--novel-sp-4); }
.novel-todo-card { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); background: var(--novel-layer-3);
  padding: var(--novel-sp-3) var(--novel-sp-4); display: flex; flex-direction: column; gap: var(--novel-sp-2); align-items: flex-start; }
.novel-todo-card.err { box-shadow: inset 3px 0 0 var(--novel-err); }
.novel-todo-card.warn { box-shadow: inset 3px 0 0 var(--novel-warn); }
/* 卡内首行：状态名 + 忽略钮（右锚）。卡标题不印计数——读数唯一住址是列表头状态带 */
.novel-todo-head { display: flex; align-items: center; gap: var(--novel-sp-3); width: 100%; }
.novel-todo-label { font-weight: 600; font-size: var(--novel-fs-md); white-space: nowrap; }
.novel-todo-label.err { color: var(--novel-err); }
.novel-todo-label.warn { color: var(--novel-warn); }
.novel-todo-names { color: var(--novel-text-3); font-size: var(--novel-fs-sm); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
/* 源列表头（标题 + 状态带 + 过滤工具 + 编辑切换 + 导入入口）与列表体。
   container-type: inline-size 让下面的状态带退化按**这条头行自身宽度**判定（宿主会话列可拖窄，
   视口断点量不准——与 .novel-table 收地址列同一套理由）。 */
.novel-list-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-3) var(--novel-sp-4);
  padding: var(--novel-sp-3) var(--novel-sp-4); border-bottom: 1px solid var(--novel-border-faint);
  container-type: inline-size; }
.novel-list-head strong { font-size: var(--novel-fs-base); }
/* 状态带（2026-09）：全库读数的唯一住址（待办卡可忽略，读数不能跟着提示一起消失）。
   点号是分隔符不是内容，故走 ::before——加一条数就多一个点，视图里不抄分隔符。
   非 0 的 未验证/坏源 才吃 warn/err 色（0 是"没事"，不该红）；.slim 是窄列可牺牲的部分 */
.novel-src-stats { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: var(--novel-sp-2);
  color: var(--novel-text-2); font-size: var(--novel-fs-sm); }
.novel-src-stats > span { white-space: nowrap; }
.novel-src-stats > span:not(:first-child)::before { content: '·'; margin-right: var(--novel-sp-2); color: var(--novel-text-3); }
.novel-src-stats .warn { color: var(--novel-warn); }
.novel-src-stats .err { color: var(--novel-err); }
/* 窄列退化：留「共 N 个源 · 已启用 M」，掉 已停用/未验证/坏源（丢了能从下拉再筛回来，宽列也在同一屏）。
   1000px = 渲染台实测（2026-09-19，out/settings.light.html，浏览器改 .novel-root 宽后量
   .novel-list-head 的 content-box，量的是**出厂 CSS**、非注入覆盖）：状态带五项自然宽 326px、
   退化后 140px；整行还含标题 + 文本框 + 三个下拉 + 两个钮——内容宽 1004 时五项同线，
   五项常驻则在 984 就把钮挤下第二行；退化后单线能撑到 814，再窄由 flex-wrap 自然折行（不裁字）。
   即退化买回 ~170px 单线余量。宿主内容列文档实测 ~1600（此处内容宽 1544）→ 正常态全五项同线。 */
@container (max-width: 1000px) {
  .novel-src-stats .slim { display: none; }
}
.novel-list-body { display: flex; flex-direction: column; gap: var(--novel-sp-3); padding: var(--novel-sp-3) var(--novel-sp-4) var(--novel-sp-4); }
/* 行内「⋯」溢出菜单：低频动作收纳（登录态/试跑/删除）——行内只留当下要用的；
   锚点是 .novel-actions（position:relative），菜单浮在该格下方 */
.novel-menu { position: absolute; right: 0; top: calc(100% - 6px); z-index: var(--novel-z-panel); min-width: 168px;
  background: var(--novel-layer-3); border: 1px solid var(--novel-border-strong); border-radius: var(--novel-r-md);
  box-shadow: var(--novel-shadow-2); overflow: hidden; }
.novel-menu button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--novel-text-2);
  font: inherit; font-size: var(--novel-fs-md); padding: var(--novel-sp-2) var(--novel-sp-4); cursor: pointer; }
.novel-menu button:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-menu button.danger { color: var(--novel-err); }
.novel-selbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-3);
  background: var(--novel-brand-soft); border: 1px solid var(--novel-brand-line);
  border-radius: var(--novel-r-md); padding: var(--novel-sp-3) var(--novel-sp-4);
}
.novel-selbar > strong { color: var(--novel-brand-strong); }
.novel-group-filter { max-width: 200px; }
.novel-source-query { max-width: 200px; }
.novel-cell-end { display: flex; justify-content: flex-end; }
.novel-cell-right { text-align: right; }
.novel-cell-groups {
  display: flex; flex-wrap: wrap; gap: var(--novel-sp-2); align-items: center; min-width: 0; overflow: hidden;
}
.novel-grow { flex: 1 1 auto; min-width: 0; }
/* details 折叠块（导入区粘贴小道等）：自带底与描边（.novel-panel），内边距归子件（summary 要顶到边） */
.novel-panel.novel-collapsed { padding: 0; }
.novel-summary { cursor: pointer; padding: var(--novel-sp-2) var(--novel-sp-4); font-size: var(--novel-fs-md); user-select: none; }
.novel-auth-pane { display: flex; flex-wrap: wrap; gap: var(--novel-sp-3); align-items: center; }
.novel-auth-pane .novel-input { flex: 1 1 200px; max-width: 360px; }
/* ── 搜索（IA 不变：分批进度 + 逐源分组 + 失败折叠；仅呈现收敛为简约版）── */
.novel-search-bar {
  display: flex; flex-wrap: wrap; gap: var(--novel-sp-3) var(--novel-sp-4); align-items: center;
  padding: var(--novel-sp-6) 0 var(--novel-sp-5);
}
.novel-search-form { flex: 1 1 240px; display: flex; gap: var(--novel-sp-3); min-width: 0; }
.novel-search-form .novel-searchbox { flex: 1 1 180px; }
.novel-search-prog { display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-search-prog .novel-progress { height: 4px; border-radius: 2px; }
.novel-prog-text { font-size: var(--novel-fs-sm); color: var(--novel-text-3); display: flex; flex-wrap: wrap; gap: var(--novel-sp-3) var(--novel-sp-4); align-items: baseline; }
.novel-prog-text b { color: var(--novel-text-2); font-weight: 600; }
.novel-groups { display: flex; flex-direction: column; gap: var(--novel-sp-6); }
.novel-group-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--novel-sp-3) var(--novel-sp-4);
  margin-bottom: var(--novel-sp-0); padding-bottom: var(--novel-sp-2);
  border-bottom: 1px solid var(--novel-border-faint);
}
.novel-group-head strong { font-size: var(--novel-fs-base); font-weight: 600; }
/* 命中行：发丝分隔线列表（真实搜索动辄十几条命中，靠分隔线扫读）。
   结构口径（本轮改）：行 = 容器 + **主按钮**（标题/副行）+ 兄弟动作钮。
   旧结构是 div[role=button] 里套 button——只绑 onClick，键盘 Enter/Space 什么都不发生，
   且读屏念成「按钮 内含 按钮」。守卫见 ui-system.test.tsx。
   布局：主钮 flex:1 挤压、动作钮天然同行尾；丢掉 flex 会让钮掉到标题下方堆叠。 */
.novel-row {
  display: flex; align-items: center; gap: var(--novel-sp-4);
  border-bottom: 1px solid var(--novel-border-faint); padding: 0;
  transition: background var(--novel-dur) var(--novel-ease);
}
.novel-row:last-child { border-bottom: none; }
.novel-row:hover { background: var(--novel-hover); }
.novel-row-main {
  flex: 1 1 auto; min-width: 0; text-align: left; cursor: pointer;
  background: none; border: none; color: inherit; font: inherit;
  padding: var(--novel-sp-4) var(--novel-sp-3); border-radius: var(--novel-r-sm);
}
.novel-row-main:hover .novel-hit-title, .novel-row-main:focus-visible .novel-hit-title { color: var(--novel-brand-strong); }
/* 无 url 的命中：既不能读也不能加架——竖排两行、不给可点态（hover 不改字色） */
.novel-row-dead { flex-direction: column; align-items: flex-start; gap: 0; padding: var(--novel-sp-4) var(--novel-sp-3); cursor: default; }
.novel-row-dead:hover { background: none; }
.novel-row-dead:hover .novel-hit-title { color: inherit; }
.novel-fail-list { margin-top: var(--novel-sp-2); line-height: 1.6; }
.novel-group .novel-list { gap: 0; }
.novel-hit-title { display: block; font-size: var(--novel-fs-base); }
.novel-row:hover .novel-hit-title { color: var(--novel-brand-strong); }
.novel-hit-sub { display: block; font-size: var(--novel-fs-sm); color: var(--novel-text-3); margin-top: var(--novel-sp-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-row .novel-btn:hover { border-color: var(--novel-brand); color: var(--novel-brand-strong); background: transparent; }
.novel-fail { border-top: 1px solid var(--novel-border-faint); padding: var(--novel-sp-4) 0 var(--novel-sp-1); font-size: var(--novel-fs-sm); color: var(--novel-text-3); }
.novel-fail summary { cursor: pointer; }
.novel-fail summary:hover { color: var(--novel-text-2); }
/* 进度段：推进走 transform: scaleX 而非 width —— width 每次改都触发布局（书架几十张卡
   + 搜索条 + 运行卡同时在途时逐帧重排），scaleX 只走合成。transform-origin 必须在左，
   否则从中心缩放。行内只写 --novel-pct（唯一动态量）。 */
.novel-progress {
  display: block; height: 6px; border-radius: 3px; background: var(--novel-skeleton); overflow: hidden;
}
.novel-progress > i {
  display: block; height: 100%; transform-origin: left; transform: scaleX(var(--novel-pct, 0));
  background: var(--novel-brand); transition: transform var(--novel-dur) var(--novel-ease);
}
.novel-empty { text-align: center; padding: var(--novel-sp-7) var(--novel-sp-5); color: var(--novel-text-2); font-size: var(--novel-fs-base); }
.novel-empty-title { font-size: var(--novel-fs-lg); margin-bottom: var(--novel-sp-2); }
.novel-empty-hint { display: block; margin-top: var(--novel-sp-2); color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
.novel-empty .novel-btn { margin-top: var(--novel-sp-3); }
.novel-list { display: flex; flex-direction: column; gap: var(--novel-sp-2); }
.novel-chips { display: flex; flex-wrap: wrap; gap: var(--novel-sp-2); }
.novel-group { display: flex; flex-direction: column; gap: var(--novel-sp-1); }
/* ── 简约版：通用内容列（书架/搜索用；设置区块不挂此类，布局不受影响）──
   上限按**场景**给，不是一个 900px 通吃：900px 是「文档阅读宽度」的度量，套在缩略图
   画廊上就成了两边各空两百多 px（实测 1400px 屏空 226px、1800px 空 426px，而网格明明
   还能长出更多列）。画廊 fill、文字列表留可读行长上限。 */
.novel-wrap { max-width: var(--novel-wrap-max, 900px); margin: 0 auto; padding: 0 var(--novel-sp-6); width: 100%; }
[data-novel-view="shelf"] .novel-wrap { --novel-wrap-max: 1600px; }
[data-novel-view="search"] .novel-wrap { --novel-wrap-max: 1100px; }
/* 级别 chip（阅读偏好面板用；设置区 chips 继续走 .novel-btn sm，互不影响） */
.novel-chip {
  background: transparent; border: 1px solid var(--novel-border-strong); color: var(--novel-text-2);
  border-radius: var(--novel-r-sm); font-size: var(--novel-fs-sm); padding: var(--novel-sp-1) var(--novel-sp-4);
  cursor: pointer; font-family: inherit;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease),
    border-color var(--novel-dur) var(--novel-ease);
}
.novel-chip:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-chip.on { color: var(--novel-brand-strong); border-color: var(--novel-brand); background: var(--novel-brand-tint); }
.novel-paper-swatch { width: 24px; height: 18px; padding: 0; border-radius: var(--novel-r-xs); }
.novel-paper-swatch.on { outline: 2px solid var(--novel-brand); outline-offset: 1px; }
/* ── 阅读器：工具栏/正文列/目录抽屉/Aa 面板（z 序仍归 CTRL_Z 常量，布局归样式类）── */
/* 纸面 full-bleed：**纸张色涂满整个阅读区**（行内 style={{background}} 挂在 .novel-rdr-main），
   正文列只决定「文字排到哪儿为止」。旧做法把纸色涂在 .novel-rdr-body 上，宽屏下就是一张
   680px 的窄带飘在宿主底色里（实测 1500px 视口左右各漏底 410px）——那不是留白，是纸没铺开。
   min-height 一屏：正文短于一屏时纸面也要铺满，不许下面漏底色。 */
.novel-rdr { position: relative; display: flex; flex-direction: column; min-height: 100vh; }
.novel-rdr-bar {
  display: flex; gap: var(--novel-sp-3); align-items: center;
  padding: var(--novel-sp-2) var(--novel-sp-4);
  border-bottom: 1px solid var(--novel-border); background: var(--novel-bg);
}
.novel-rdr-title {
  flex: 1; text-align: center; font-size: var(--novel-fs-md); color: var(--novel-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-rdr-book { color: var(--novel-text); font-weight: 500; }
/* 章进度细线：挂在 sticky 工具栏下沿（跨章才变——低频量，见 client.md「跨章可见性」）。
   width: 100% 不是冗余——绝对定位 + 无内容的元素 shrink-to-fit 成 0 宽，scaleX 再大也画不出线。 */
.novel-rdr-trail {
  position: absolute; left: 0; bottom: -1px; width: 100%; height: 2px; background: var(--novel-brand);
  transform-origin: left; transform: scaleX(var(--novel-pct, 0));
  transition: transform var(--novel-dur) var(--novel-ease);
}
.novel-rdr-acts { display: flex; gap: var(--novel-sp-1); align-items: center; }
.novel-rdr-main { position: relative; flex: 1 1 auto; min-height: 0; display: flex; align-items: flex-start; }
/* 正文列宽随字号走：--novel-measure（缺省 36em，行内由 prefs.measure 覆写；em 跟着
   prefs.fontSize 变，中文一行约 36 字）。
   旧实现 padding 写死 calc(50% - 320px) = 恒 640px 列 → 12px 字号约 53 字/行、
   28px 字号约 23 字/行，两端都出了舒适区。 */
.novel-rdr-body {
  flex: 1 1 auto; min-width: 0; max-width: var(--novel-measure); margin-inline: auto;
  overflow-y: auto; padding: var(--novel-sp-7) var(--novel-sp-5) calc(var(--novel-sp-7) * 3);
}
.novel-rdr-body h2 { font-size: 1.3em; font-weight: 600; letter-spacing: .08em; text-align: center; margin: 0 0 var(--novel-sp-1); }
.novel-rdr-body p { margin: .5em 0; text-indent: 2em; }
.novel-rdr-body [data-chapter] { margin-bottom: 1.2em; }
.novel-rdr-loading { padding: var(--novel-sp-7) 0; text-align: center; color: var(--novel-text-3); font-size: var(--novel-fs-md); }
.novel-sentinel { opacity: .5; font-size: var(--novel-fs-sm); padding: var(--novel-sp-6) 0; text-align: center; }
/* 目录抽屉：锚视口靠**外层 .novel-drawer-slot 的 sticky**，抽屉本体 absolute 浮在正文右缘。
   为什么外层宽度给 0：抽屉若按老办法当「有宽度的 flex 兄弟」，它会从正文列里切走 293px
   （实测视口 766px 下正文 38 字/行 → 22 字/行）。0 宽槽 + 绝对定位子件 = sticky 的跟随性
   保留、正文列不缩水、窄屏时抽屉压在正文上（选章是瞬时态，压字可接受，挤列不可接受）。
   三版死法各不同，记全：
     ① flex 兄弟 + sticky，高度无上限：912 条比正文高，行高 = max(正文, 目录) → 整页撑到两万多 px。
     ② absolute 锚 .novel-rdr-main：不撑页了，但锚的是**内容盒起点**（正文开头），读到第 500 章
        点目录，抽屉画在你头顶上方两万 px 处；且 max-height 的 100% 也是正文高度
        （复刻实测：父高 2400px、视口 766px 时约束算出 2380px，形同虚设）。
     ③ 现方案的上一版（兄弟 + 视口上限）：锚对了，但**flex 列里的条目会在滚动发生前先被
        flex-shrink 压扁**——实测每条 12px 高（60 条 850px 内容塞进 678px 容器），文字互相咬住。
        ③ 的两处修正：条目 flex: none（守卫钉住）+ 槽宽 0。
   sticky 在本环境已被工具栏证明可用（同一祖先链、同一 .novel-main 滚动口径）。
   槽几何是**共用的一条**（选择器组）：目录抽屉与右上角那两块面板（注释 / 导入说明）同住阅读区，
   各抄一份 sticky 就会漂移——漂移的代价实测过两次（面板锚在内容盒上 ⇒ 一滚就飘出视口，
   且对位时把主滚动拉回内容顶部）。守卫：ui-system 的「共用同一份槽几何」那条。 */
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
/* 当前章：底色 + 左侧 brand 标记。选择器用 aria-current（语义与样式同一个源——
   抽屉条目被 memo 住，高亮靠视图把一个属性挪到那一条上，不重建整份列表） */
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
/* pre 的空白是内容不是排版：换行与缩进原样保留。折行靠 pre-wrap + word-break（超长的词断开，
   不是一条横滚到底的窄带）；overflow-x: auto 只兜确实撑出去的内容。 */
.novel-body pre {
  margin: .8em 0; padding: var(--novel-sp-4); border-radius: var(--novel-r-xs);
  background: var(--novel-skeleton); overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  text-indent: 0; font-family: ui-monospace, Consolas, monospace; font-size: .95em;
}
.novel-body code { font-family: ui-monospace, Consolas, monospace; font-size: .95em; }
.novel-body sup, .novel-body sub { font-size: .75em; line-height: 0; }
.novel-body hr { margin: 1.4em 0; border: none; border-top: 1px solid var(--novel-border); }
/* 宽表在栏内滚：滚动归容器（表格本体不缩），否则整页被一张表撑出横滚条 */
.novel-table-wrap { margin: .8em 0; max-width: 100%; overflow-x: auto; text-indent: 0; }
.novel-body table { border-collapse: collapse; max-width: 100%; }
.novel-body th, .novel-body td {
  border: 1px solid var(--novel-border); padding: var(--novel-sp-1) var(--novel-sp-3); vertical-align: top;
}
.novel-body caption { color: var(--novel-text-3); font-size: var(--novel-fs-sm); text-align: left; }
/* 插图：按可信宽高比先占位，加载完成/失败都不收缩框（失败仍是同一块框，只换内容）。
   宽高比走值槽；容器 max-width: 100% 受阅读栏限制，图片不撑破栏宽。
   text-indent: 0 不是冗余：图常被包在 p 里，段首缩进会继承到这块块级框上、把居中图挪偏。 */
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
/* 正文内链：不是 <a>（raw href = 把书内 URL 变成可点击导航），是按钮——字色继承、能聚焦。
   hover 不改色：正文层可能是纸张色，宿主强调色压在上面不一定有对比度。 */
.novel-ref {
  font: inherit; color: inherit; padding: 0; border: none; background: none; cursor: pointer;
  text-align: left; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: .18em;
}
/* 含块级内容的链接（插图/表格/段落等，XHTML5 的透明内容模型允许）本身是块级容器，且**宽度要显式写满**：
   按钮的 width: auto 是「内在宽度」（收缩包裹），不像 div 那样填满包含块——只写 display: block 时
   里面插图的百分比宽度仍解析成 auto，图未解码就没有内在尺寸，占位框塌成 0（实测真浏览器里 0×0，
   图一到手跳到 600×900、后文位移近一屏）。width: 100% 让按钮的宽度基准由包含块（正文栏）给出。 */
.novel-ref-block { display: block; width: 100%; }
/* 链接内容里的块级子节点：XHTML 的 a 允许它们做子节点（源书合法），HTML 的 button 只收短语级元素，
   所以渲染层把块级标签降级成 span，块状观感在这里用 CSS 拿回（内容模型管元素类型，不管 display）。
   novel-ref-rule 是链接里的 hr——那条线还是要画出来。 */
.novel-ref-part { display: block; }
.novel-ref-rule { border-top: 1px solid var(--novel-border-strong); margin: .8em 0; }
/* 目录树：深度靠嵌套列表（结构即层级，不写行内缩进值）；组头不可点，故不是按钮样。 */
.novel-nav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-nav .novel-nav { padding-left: var(--novel-sp-4); }
.novel-nav-group {
  padding: var(--novel-sp-2) var(--novel-sp-4) 0;
  color: var(--novel-text-3); font-size: var(--novel-fs-sm); font-weight: 600;
}
/* 注释面板（与导入说明面板同几何）：尺寸与锚定**都**走目录抽屉那一条——外层 .novel-notes-slot
   的 sticky 锚视口（槽几何与抽屉共用同一条规则，见上），本体 absolute 浮在右上。
   曾经的缺陷正是同族浮层并存两套锚定：面板 absolute 挂在 .novel-rdr-main（**内容盒**）上，
   内容盒一滚面板就跟着走，读到章末时飘在视口上方，对位还顺手把主滚动拉回内容顶部。
   落位只滚面板自己的 body，理由与口径见 src/client/util.ts 的 centerInScroller。
   z 走浮层单表——面板挂阅读区任意一层都不必依赖外层槽的 z。
   body 自己滚：脚注可能很长，面板整体不外扩。 */
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
/* 导入说明清单（导入回执与阅读器的导入说明面板共用一份规则）：一条 = 码 + 资源 + 人读的交代。
   列表去掉默认项目符号与缩进——这里的层级是「一条说明」，不是嵌套列表。 */
.novel-warn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-warn-list li { text-indent: 0; }
.novel-warn-code { font-size: var(--novel-fs-xs); color: var(--novel-warn); font-family: ui-monospace, Consolas, monospace; }
/* 导入回执（书架顶栏下方那块）：只在有持久告警时出现。左缘竖条说「这是说明不是错误」
   （错的用 .novel-err 那条红字），封面位是 44px 的小缩略图——与卡片同一套封面类，不发明第二套。 */
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
/* ── 书架 ── */
.novel-shelf-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--novel-sp-3) var(--novel-sp-5);
  padding: var(--novel-sp-6) 0 var(--novel-sp-4);
}
.novel-shelf-title { font-size: var(--novel-fs-xl); font-weight: 600; margin: 0; letter-spacing: .02em; white-space: nowrap; }
.novel-shelf-count { color: var(--novel-text-3); font-size: var(--novel-fs-md); margin-left: var(--novel-sp-3); font-weight: 400; }
/* 书架 tab 顶栏（三行）：行1 内容标题「书架 · N 本」；行2 搜索框独占一行且整簇居中；
   行3 书架筛选簇（pills + 簇尾排序灰字）。
   为什么不做「工具组与标题同行」：实测 Chrome 把同行 flex item（旧 .novel-shelf-tools）
   的假设主尺寸算成 min-content 量级——四件东西需要 706px 被算成 651px、只剩两件时被挤到
   215px（探针实测），搜索框与导入钮在标题旁折行堆叠。显式三行后不存在这条折行路径。
   margin-left:auto 在书架顶栏已无用武之地：书城预留位 chip 随 tab 化退役（书架/书城/
   书源管理并列后，占位不如真导航）；筛选簇与排序灰字禁止贴右——灰字曾被钉到 1600px 列
   最右端（实测 x1472 vs pills x75）＝悬浮碎片。
   （本文件注释里别写反引号：NOVEL_CSS 是模板字符串，反引号会当场截断它。） */
/* 行2：搜索框单独一行（聚合搜索 = 找新书入口，与书架筛选不是同一语义组）。
   form = 搜索框 + 「搜索」提交钮（与搜索页同款 type=submit + novel-btn primary；Enter 仍是
   快捷径——可见按钮才是显式入口，用户提议）。基准 460px（380 框 + 钮 + 间距）、可收缩、
   不写死宽（守卫钉 flex 0 1 Npx + 无固定 width）。整簇居中（用户实机反馈拍板）。 */
.novel-shelf-search { flex: 1 1 100%; display: flex; align-items: center; justify-content: center; gap: var(--novel-sp-3); }
.novel-shelf-search form { display: flex; align-items: center; gap: var(--novel-sp-2); flex: 0 1 460px; min-width: 0; }
.novel-shelf-search .novel-searchbox { flex: 1 1 auto; min-width: 0; }
.novel-shelf-search form .novel-btn { flex: none; }
.novel-shelf-search-note { color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
/* 搜索框：放大镜图标 + 无边框输入装进层底圆角容器，focus 描边走强调色；
   宽度弹性（1 1 180px）而非死 260px——宿主会话列可拖窄，实测死宽会把标题压成一个字一行。
   底色必须读 --novel-layer-2：本轮病根就是这里引用了不存在的 --novel-layer，
   background 整条落 unset → 实测 rgba(0,0,0,0)（空心框）。 */
.novel-searchbox {
  display: flex; align-items: center; gap: var(--novel-sp-3); background: var(--novel-layer-2);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  padding: var(--novel-sp-2) var(--novel-sp-4); flex: 1 1 180px; min-width: 0;
  transition: border-color var(--novel-dur) var(--novel-ease);
}
.novel-searchbox:focus-within { border-color: var(--novel-brand); }
.novel-searchbox > svg { flex: none; color: var(--novel-text-3); }
.novel-searchbox input {
  flex: 1; min-width: 0; width: 100%; background: none; border: none; outline: none;
  color: inherit; font: inherit; font-size: var(--novel-fs-base); padding: 0;
}
.novel-searchbox input::placeholder { color: var(--novel-text-3); }
.novel-seg {
  display: flex; gap: var(--novel-sp-0); background: var(--novel-layer-2);
  border: 1px solid var(--novel-border-faint); border-radius: var(--novel-r-md); padding: var(--novel-sp-0);
}
.novel-seg button {
  background: none; border: none; color: var(--novel-text-2); font-size: var(--novel-fs-md);
  padding: var(--novel-sp-1) var(--novel-sp-4); border-radius: var(--novel-r-sm);
  cursor: pointer; font-family: inherit; white-space: nowrap;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
.novel-seg button:hover { color: var(--novel-text); }
.novel-seg button.on {
  color: var(--novel-text); background: var(--novel-active); font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .12);
}
/* 行3：书架筛选簇——pills 是书架自己的筛选项（全部/在读/未读/本地），不与搜索同簇；
   排序灰字跟在簇尾（margin-left:auto 已删，见上方病史）。hairline 在簇行下沿：
   控制区与网格的分隔语义不变。有书才渲染（空架/加载中没有可筛的东西）。 */
.novel-shelf-filter {
  flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center;
  gap: var(--novel-sp-3) var(--novel-sp-5);
  padding: var(--novel-sp-4) 0 var(--novel-sp-5);
  border-bottom: 1px solid var(--novel-border-faint);
}
.novel-shelf-sort { color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
.novel-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
  gap: var(--novel-sp-6) var(--novel-sp-5); padding-top: var(--novel-sp-5);
}
/* 空书架兜底：EmptyState 分支不渲染整网格，导入引导卡以单卡网格居中补位——
   工具栏导入钮已移除，导入入口不能随之消失（真零本时它恰恰是最刚需的操作）。 */
.novel-grid.solo { max-width: 200px; margin: 0 auto; }
/* 卡片 = 一格（.novel-cell）里的「打开钮 + 删除钮」两个兄弟按钮：
   打开钮是原生 <button>（Enter/Space 免费可用、焦点环自然），删除钮浮在封面右上；
   旧结构是 div[role=button] 套 button——键盘按不动、读屏念「按钮含按钮」。 */
.novel-cell { position: relative; display: flex; flex-direction: column; }
.novel-card {
  display: flex; flex-direction: column; cursor: pointer; text-align: left;
  font: inherit; color: inherit; border: 1px solid transparent; border-radius: var(--novel-r-sm);
  background: none; padding: var(--novel-sp-2) var(--novel-sp-2) var(--novel-sp-3);
  transition: background var(--novel-dur) var(--novel-ease), transform var(--novel-dur) var(--novel-ease),
    box-shadow var(--novel-dur) var(--novel-ease);
}
.novel-card:hover { background: var(--novel-hover); transform: translateY(-2px); box-shadow: var(--novel-shadow-2); }
.novel-card:focus-visible { transform: translateY(-2px); box-shadow: var(--novel-shadow-2); }
/* 网格末位常驻引导卡 =「导入本地书籍」：搜索入口已由行2搜索框显式承担（「搜一本书」
   引导卡退役），导入职责单一归这张卡；点击触发隐藏 file input。空架兜底见 .novel-grid.solo。 */
.novel-card-ghost .novel-ghost-cover {
  aspect-ratio: 2 / 3; display: grid; place-items: center; margin-bottom: var(--novel-sp-3);
  border: 1px dashed var(--novel-border-strong); border-radius: var(--novel-r-xs);
  color: var(--novel-text-3); font-size: var(--novel-fs-lg);
  transition: border-color var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease),
    background var(--novel-dur) var(--novel-ease);
}
.novel-card-ghost:hover .novel-ghost-cover, .novel-card-ghost:focus-visible .novel-ghost-cover {
  border-color: var(--novel-brand); color: var(--novel-brand-strong); background: var(--novel-brand-soft);
}
/* 加载骨架：按网格占位，避免「文字→整屏网格」的一跳布局位移（shimmer 可关，见本文件末） */
.novel-sk { background: var(--novel-skeleton); border-radius: var(--novel-r-xs); position: relative; overflow: hidden; }
.novel-sk::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .06), transparent);
  transform: translateX(-100%); animation: novel-shimmer 1.4s var(--novel-ease) infinite;
}
.novel-sk-cover { aspect-ratio: 2 / 3; width: 100%; margin-bottom: var(--novel-sp-3); }
.novel-sk-line { height: 10px; }
.novel-sk-line.sm { height: 8px; width: 60%; margin-top: var(--novel-sp-2); }
@keyframes novel-shimmer { to { transform: translateX(100%); } }
.novel-cover {
  aspect-ratio: 2 / 3; width: 100%; object-fit: cover; display: block; margin-bottom: var(--novel-sp-3);
  border-radius: var(--novel-r-xs); border: 1px solid var(--novel-border); background: var(--novel-skeleton);
  box-shadow: var(--novel-shadow-1);
}
/* 首字色块＝真实封面的降级，不是灰色占位符：token 底色 + 顶部渐变高光 + 底部压暗 +
   衬线大字。浅色宿主下白底页面里一块「有质感的深色封面」正是书架的视觉锚点。 */
.novel-cover-fallback {
  position: relative; overflow: hidden;
  aspect-ratio: 2 / 3; display: grid; place-items: center; margin-bottom: var(--novel-sp-3);
  border-radius: var(--novel-r-xs); border: 1px solid var(--novel-border); background: var(--novel-layer-3);
  font-family: "Noto Serif SC", "STSong", "SimSun", serif; font-size: 30px; font-weight: 600;
  letter-spacing: .06em; text-shadow: 0 1px 3px rgba(0, 0, 0, .35);
  box-shadow: var(--novel-shadow-1);
}
.novel-cover-fallback::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(120% 55% at 30% 0%, rgba(255, 255, 255, .16), transparent 60%),
    linear-gradient(180deg, transparent 62%, rgba(0, 0, 0, .22));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .10);
}
.novel-cover-fallback.sm {
  font-size: var(--novel-fs-base); letter-spacing: .2em; font-family: inherit; font-weight: 500;
  color: var(--novel-text-2); background: var(--novel-layer-3); text-shadow: none;
}
.novel-cover-fallback.sm::after { background: none; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06); }
/* 四档色块底：token 底色 + 顶部提亮 155° 渐变（纯色块在浅色主题下像补丁，渐变才是封面感） */
.novel-cover-t1 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-1) 74%, var(--novel-on-solid) 13%), var(--novel-cover-1)); color: var(--novel-on-solid); }
.novel-cover-t2 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-2) 74%, var(--novel-on-solid) 13%), var(--novel-cover-2)); color: var(--novel-on-solid); }
.novel-cover-t3 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-3) 74%, var(--novel-on-solid) 13%), var(--novel-cover-3)); color: var(--novel-on-solid); }
.novel-cover-t4 { background: linear-gradient(155deg, color-mix(in srgb, var(--novel-cover-4) 74%, var(--novel-on-solid) 13%), var(--novel-cover-4)); color: var(--novel-on-solid); }
.novel-card-title {
  display: block; font-size: var(--novel-fs-md); font-weight: 600; line-height: 1.35; padding: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-card:hover .novel-card-title, .novel-card:focus-visible .novel-card-title { color: var(--novel-brand-strong); }
.novel-card-meta {
  display: block; font-size: var(--novel-fs-xs); color: var(--novel-text-3);
  margin: var(--novel-sp-0) 0 var(--novel-sp-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-card .novel-progress { height: 2px; border-radius: 1px; margin-top: var(--novel-sp-0); }
/* 删除钮：hover/焦点显形（鼠标端不吃布局），触屏端无 hover 能力 → 常驻可见
   （旧实现只有 :hover/:focus 两条路，触屏设备上这个操作根本不存在）。 */
.novel-card-x {
  position: absolute; top: var(--novel-sp-2); right: var(--novel-sp-2); z-index: 1;
  width: 24px; height: 24px; padding: 0; line-height: 1; border-radius: var(--novel-r-xs);
  opacity: 0; border: none;
  background: color-mix(in srgb, var(--novel-bg) 60%, transparent); color: var(--novel-text);
  transition: opacity var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-cell:hover .novel-card-x, .novel-card-x:focus { opacity: 1; }
.novel-card-x:hover { background: var(--novel-err); color: var(--novel-on-solid); }
.novel-local-tag {
  position: absolute; top: var(--novel-sp-2); left: var(--novel-sp-2); z-index: 1;
  font-size: var(--novel-fs-xs); color: var(--novel-text-2);
  background: color-mix(in srgb, var(--novel-bg) 60%, transparent);
  border-radius: var(--novel-r-xs); padding: var(--novel-sp-0) var(--novel-sp-2);
}
/* ── 来源 chip + 多选态（2026 书架两条新需求）────────────────────────────
   来源 chip 钉在封面**左下**：右上归删除 ✕、左上归本地角标，四个角各司其职。
   色点按 sourceId 派生四档——复用无封面降级那四档 token（hex 仍不出本层），
   于是「同源同色、异源异色」在整架书上一眼可辨。源名超长省略（全名走 title 提示）。 */
.novel-cover-box { position: relative; display: block; margin-bottom: var(--novel-sp-3); }
.novel-cover-box > .novel-cover, .novel-cover-box > .novel-cover-fallback { margin-bottom: 0; }
.novel-src-tag {
  position: absolute; left: var(--novel-sp-2); bottom: var(--novel-sp-2); z-index: 1;
  display: inline-flex; align-items: center; gap: var(--novel-sp-2);
  max-width: calc(100% - var(--novel-sp-4));
  font-size: var(--novel-fs-xs); color: var(--novel-text);
  background: color-mix(in srgb, var(--novel-bg) 68%, transparent);
  border-radius: var(--novel-r-xs); padding: var(--novel-sp-0) var(--novel-sp-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-src-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.novel-src-t1 .novel-src-dot { background: var(--novel-cover-1); }
.novel-src-t2 .novel-src-dot { background: var(--novel-cover-2); }
.novel-src-t3 .novel-src-dot { background: var(--novel-cover-3); }
.novel-src-t4 .novel-src-dot { background: var(--novel-cover-4); }
/* 源已被删（服务端 join 不到）：灰字 + 灰点，不冒充一个还活着的来源 */
.novel-src-tag.gone { color: var(--novel-text-3); }
.novel-src-tag.gone .novel-src-dot { background: var(--novel-text-3); opacity: .55; }
/* 多选态：勾选标记占左上（本地角标让位），选中卡片描边走强调色 */
.novel-check {
  position: absolute; top: var(--novel-sp-2); left: var(--novel-sp-2); z-index: 1;
  width: 18px; height: 18px; border-radius: var(--novel-r-xs);
  display: grid; place-items: center; line-height: 1; font-size: var(--novel-fs-xs);
  background: color-mix(in srgb, var(--novel-bg) 62%, transparent);
  border: 1px solid var(--novel-border-strong); color: var(--novel-on-solid);
}
.novel-cell.on .novel-check { background: var(--novel-brand); border-color: var(--novel-brand); }
.novel-cell.on .novel-card { border-color: var(--novel-brand); }
/* ── 模态确认（删除书籍等危险操作）：遮罩 + 居中对话框 + 危险色确认钮；
   Esc / 点遮罩取消，失败留在框内可重试（错误不再散落在页面流里）。── */
.novel-modal-mask {
  position: fixed; inset: 0; z-index: var(--novel-z-modal); display: grid; place-items: center;
  background: var(--novel-mask); padding: var(--novel-sp-5);
  animation: novel-fade var(--novel-dur) var(--novel-ease);
}
.novel-modal {
  width: min(400px, calc(100vw - 48px)); background: var(--novel-layer-2);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-lg);
  padding: var(--novel-sp-5) var(--novel-sp-6);
  box-shadow: var(--novel-shadow-pop);
  display: flex; flex-direction: column; gap: var(--novel-sp-4);
  animation: novel-rise var(--novel-dur) var(--novel-ease);
}
.novel-modal-title { font-size: var(--novel-fs-base); font-weight: 600; line-height: 1.5; }
/* 导入弹层等信息量更大的模态用宽档（删除确认保持 400px 紧凑档） */
.novel-modal.wide { width: min(680px, calc(100vw - 48px)); }
.novel-modal-body { font-size: var(--novel-fs-md); color: var(--novel-text-2); line-height: 1.6; }
.novel-modal-warn { font-size: var(--novel-fs-sm); color: var(--novel-warn); line-height: 1.6; }
.novel-modal-actions { display: flex; justify-content: flex-end; gap: var(--novel-sp-3); margin-top: var(--novel-sp-1); }
.novel-btn.danger.solid { background: var(--novel-err); border-color: var(--novel-err); color: var(--novel-on-solid); }
.novel-btn.danger.solid:hover { filter: brightness(1.08); background: var(--novel-err); }
@keyframes novel-fade { from { opacity: 0; } }
@keyframes novel-rise { from { opacity: 0; transform: translateY(6px) scale(.98); } }
/* ── 状态条泳道：栏位形状由类给出（此前是 statusLane() 工厂每次渲染造五个 style 对象）── */
.novel-lane {
  display: grid; gap: var(--novel-sp-3); align-items: center; width: 100%; text-align: left;
  border: none; padding: var(--novel-sp-1) var(--novel-sp-4);
  font: inherit; font-size: var(--novel-fs-sm); cursor: pointer; background: transparent; color: inherit;
}
.novel-lane.cols-1 { grid-template-columns: 1fr; cursor: default; }
.novel-lane.cols-err { grid-template-columns: auto 1fr auto auto; background: var(--novel-err-weak); }
.novel-lane.cols-job { grid-template-columns: auto auto 1fr auto; }
.novel-lane-link { color: var(--novel-brand); white-space: nowrap; }
/* ── 导入区：拖放主入口（dragging/busy 两态由类给，视图只切类名）+ 粘贴小道 + 完成汇总 ── */
.novel-dropzone {
  display: flex; flex-direction: column; gap: var(--novel-sp-1);
  border: 1.5px dashed var(--novel-border-strong); border-radius: var(--novel-r-md);
  padding: var(--novel-sp-6) var(--novel-sp-5); text-align: center; cursor: pointer;
  background: var(--novel-layer-2);
  transition: border-color var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-dropzone:hover { border-color: var(--novel-brand); }
.novel-dropzone.dragging { border-color: var(--novel-brand); background: color-mix(in srgb, var(--novel-brand) 6%, transparent); }
.novel-dropzone.busy { cursor: default; opacity: .45; }
.novel-dropzone:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: 2px; }
.novel-dropzone-icon { font-size: 22px; line-height: 1; }
.novel-dropzone-lead { font-size: var(--novel-fs-base); margin-top: var(--novel-sp-2); }
.novel-paste { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); background: var(--novel-layer-2); }
.novel-paste > summary { color: var(--novel-text-2); }
.novel-paste-body { padding: var(--novel-sp-0) var(--novel-sp-4) var(--novel-sp-4); gap: var(--novel-sp-3); }
/* 导入汇总条：左侧 3px 竖条说成败（整块刷色会把「读一段文字」变成「盯一面红墙」） */
.novel-result { border-left: 3px solid var(--novel-ok); }
.novel-result.err { border-left-color: var(--novel-err); }
.novel-issues { margin-top: var(--novel-sp-2); }
/* ── 指针与动效偏好：hover-only 的 affordance 必须有非 hover 的路 ── */
@media (hover: none) {
  .novel-card-x { opacity: 1; }
  .novel-card:hover, .novel-card:focus-visible { transform: none; box-shadow: none; }
}
@media (prefers-reduced-motion: reduce) {
  .novel-card, .novel-btn, .novel-chip, .novel-seg button, .novel-searchbox, .novel-row,
  .novel-switch, .novel-switch > i, .novel-progress > i, .novel-rdr-trail, .novel-card-ghost .novel-ghost-cover {
    transition: none;
  }
  .novel-sk::after { animation: none; }
  .novel-modal-mask, .novel-modal { animation: none; }
  .novel-card:hover, .novel-card:focus-visible { transform: none; }
}
`

/** 样式注入组件。`NovelView` 在根上注入一次；`SettingsSection` 单飞渲染时自带（`withStyles`
 *  缺省 true），被 NovelView 挂载时让位——同一棵树里注两遍等于 45KB CSS 进 DOM 两次。 */
export function NovelStyles(): ReactNode {
  return <style data-novel-style>{NOVEL_CSS}</style>
}
