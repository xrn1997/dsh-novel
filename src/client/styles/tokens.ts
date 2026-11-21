/** 视觉 token 层（`NOVEL_CSS` 的第 1 块）：配色契约、named 标度与 `--novel-*` 变量的缺省定义。
 *  暗层的重钉住 shell 块的 `.novel-dark`；样式规则只读这里的局部变量，不另造 token。
 *
 *  ── 配色契约（宿主语义层）────────────────────────────────────────────────
 *  宿主把调色板与语义层挂在 body 上，本插件**只需引用语义 token**，光/暗自动跟随。三种静默失效要防：
 *  ① 引用不存在的宿主 token（CSS 不报错，只落 fallback）；② 写死白色叠层 / 状态色 hex；
 *  ③ 引用本层自己不存在的 token（整条 background 简写静默落 unset）。宿主名词表以
 *  `tests/client/theme-tokens.test.ts` 为家，本层引用由 `tests/client/ui-system.test.tsx` 守。
 *  用到的 token 先收进 `.novel-root, [data-novel-scope]` 一层局部变量：规则只读局部变量。
 *
 *  ── 标度（sp/fs/r/shadow/z/dur）──────────────────────────────────────────
 *  间距、字阶、圆角、阴影、层级、动效各有一套 named 标度，视觉规则里不散写像素。z 序与 `CTRL_Z`
 *  同表（JS 侧主人是 `reader-ctrl-z.test.ts`），相对次序由 `ui-system.test.tsx` 钉死。
 *  本块必须排在拼装次序最前：后面的块都引用这里的变量。 */
export const TOKENS_CSS = `
.novel-root, [data-novel-scope] {
  /* 层级：底(页面) → 层1(容器/工具栏) → 层2(面板/浮层/抽屉) → 层3(输入件)。宿主层板只到 layer-3。 */
  --novel-bg: var(--dsw-alias-bg-base, #1e1e1e);
  --novel-layer-1: var(--dsw-alias-bg-layer-1, #1e1e1e);
  --novel-layer-2: var(--dsw-alias-bg-layer-2, #242426);
  --novel-layer-3: var(--dsw-alias-bg-layer-3, #2b2b2e);
  /* 描边：容器 l2 / 输入件 l4 / 行内发丝 l1（发丝线观感，别用 1px 实心灰） */
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
  /* brand 派生色：视图不要内联 #2f6feb14/1f/44 与 #79a8ff——brand 一换色即全部失联。 */
  --novel-brand-soft: color-mix(in srgb, var(--novel-brand) 8%, transparent);   /* 选中动作条底 */
  --novel-brand-tint: color-mix(in srgb, var(--novel-brand) 12%, transparent);  /* 选中 chip / 编辑态底 */
  --novel-brand-line: color-mix(in srgb, var(--novel-brand) 27%, transparent);  /* 运行卡 / 选中条描边 */
  --novel-brand-strong: var(--dsw-alias-label-primary-bluish, #79a8ff);         /* 亮蓝强调字 */
  --novel-skeleton: var(--dsw-alias-bg-skeleton, #ffffff14);
  /* 浮层底：迷你条读宿主**浮动钮**语义（与宿主自己的浮动按钮同底同源），不是面板层板。 */
  --novel-float: var(--dsw-alias-button-floating-fill, #2b2b2e);
  /* 滚动条三件套（轨 / thumb / hover）：插件自己的滚动面跟宿主滚动条语义，不留浏览器默认灰条 */
  --novel-scrollbar-track: var(--dsw-alias-scrollbar-bg-l1, #ffffff0f);
  --novel-scrollbar: var(--dsw-alias-scrollbar-bg-l2, #ffffff2e);
  --novel-scrollbar-hover: var(--dsw-alias-scrollbar-hover-l2, #ffffff47);
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
  /* 焦点环：走 brand（宿主主色）+ 2px 外偏移——不要借 label-secondary 与正文同色系，
     在密集列表里几乎找不着环；primary 钮上另换 --novel-text（brand 压 brand 等于没有）。 */
  --novel-ring: var(--novel-brand);
  /* 配置页保存条吸附偏移：JS 吸住时按宿主滚动区底留白写成负值；缺省 0 = 普通 sticky */
  --novel-cfg-pin: 0px;
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
  /* 值槽（唯一由行内写入的动态量，规则都住本层）。 */
  --novel-pct: 0;
  --novel-measure: 36em;
  /* 听书浮窗展开态尺寸（ADR-0080）：由 miniBarLayout 行内写入解析后的呈现尺寸，样式层只读变量。 */
  --novel-tts-panel-w: 320px;
  --novel-tts-panel-h: 200px;
  /* 收起态胶囊尺寸：同样由 miniBarLayout 从 CAPSULE_SIZE 行内写入（两形态尺寸来源对称）；
     这里的缺省只为「值槽必须在词表里在册」的自足守卫。 */
  --novel-tts-capsule-w: 208px;
  --novel-tts-capsule-h: 44px;
  /* 设置弹层 max-height 的上界（px）：由 miniBarPopoverRoom 按选中那一侧的余量算出。 */
  --novel-tts-popover-room: 60vh;
  /* --novel-paper / --novel-paper-ink：正文那一层的纸与墨（prefs.paperColor 与 paperInk 的结果）。 */
  --novel-paper: #f7f3e8;
  --novel-paper-ink: #222;
  /* 跟读高亮的字色：ReaderView 由纸色现算（util.ts 的 paperLiveInk）。 */
  --novel-live-ink: #855532;
  /* 插图预留宽高比：ChapterBody 由 wire 的可信 width/height 行内写入，规则读本值；
     值槽在此在册是 token 自足守卫的硬要求——「行内写、样式读」的这一路也必须词表里有名。 */
  --novel-fig-ratio: 4 / 3;
  /* 浮层层级单表（控制器层三级由 CTRL_Z 同名钉住，防两处各写各的数） */
  --novel-z-status: 5; --novel-z-mask: 10; --novel-z-panel: 11; --novel-z-toolbar: 12; --novel-z-modal: 30;
  /* 无封面降级的书名首字色块：低饱和四档（深浅两态都成立的中间调）。 */
  --novel-cover-1: #3c4250;
  --novel-cover-2: #3d4a42;
  --novel-cover-3: #4d3a3a;
  --novel-cover-4: #443a4d;
  color: var(--novel-text);
}
/* 控制器条底：纸往墨压一档（6%），阅读器顶条与听书条共用；直接写在条元素的 background 上。 */
.novel-rdr-bar, .novel-tts-bar {
  background: color-mix(in srgb, var(--novel-paper-ink) 6%, var(--novel-paper));
}
`
