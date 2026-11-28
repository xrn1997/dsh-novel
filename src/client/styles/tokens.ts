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
  /* elevation 发丝描边的间接色（宿主 body 默认 l4；菜单面重绑 l1、输入卡重绑 l2） */
  --novel-elevation-stroke-color: var(--dsw-alias-border-l4, #fff3);
  /* 交互与文字 */
  --novel-hover: var(--dsw-alias-interactive-bg-hover, #ffffff14);
  --novel-active: var(--dsw-alias-interactive-bg-active, #ffffff24);
  --novel-text: var(--dsw-alias-label-primary, #f9fafb);
  --novel-text-2: var(--dsw-alias-label-secondary, #cfd3d6);
  --novel-text-3: var(--dsw-alias-label-tertiary, #adb2b8);
  /* 宿主会话面：摸鱼舞台按宿主的「对话流」真名取色。比通用层多出的这族只服务对话外观
     （气泡 / 输入卡 / 选底 / 业务蓝 / 代码块 / 次要说明 / 发丝边），不往别处扩散。 */
  --novel-caption: var(--dsw-alias-label-caption, #81858c);
  --novel-bubble: var(--dsw-specific-bubble, #2c2c2e);
  --novel-input-fill: var(--dsw-specific-input-major, #2c2c2e);
  --novel-selector-fill: var(--dsw-specific-selector, #353638);
  --novel-business: var(--dsw-alias-state-business-primary, #7aaaff);
  --novel-info-fill: var(--dsw-alias-button-info-fill, #7aaaff);
  --novel-info-hover: var(--dsw-alias-button-info-hover, #4176e6);
  --novel-code-bg: var(--dsw-alias-markdown-code-block, #1b1b1c);
  --novel-inline-code: var(--dsw-alias-markdown-inline-code, #292929);
  --novel-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, #353638);
  --novel-border-mid: var(--dsw-alias-border-l3, #ffffff29);
  /* 宿主里另有 label-deep-diving / label-shimmer 两族：本仓词表未收（theme-tokens 守卫的冻结
     快照），派生色只准住本层，所以按宿主公式在 token 层混出来。 */
  --novel-deep-diving: color-mix(in srgb, var(--novel-business) 55%, var(--novel-text-3));
  --novel-shimmer: color-mix(in srgb, var(--novel-text) 45%, transparent);
  --novel-fg: var(--dsw-alias-label-primary-foreground, #0f1115);
  /* 压在实心按钮上的字色：宿主真名 label-on-color（两态同名）。 */
  --novel-on-solid: var(--dsw-alias-label-on-color, #fff);
  /* 内链色：宿主真名 alias-link（两态自动跟随）。 */
  --novel-link: var(--dsw-alias-link, #3b76e8);
  --novel-brand: var(--dsw-alias-brand-primary, #2f6feb);
  --novel-primary-fill: var(--dsw-alias-button-primary-fill, #2f6feb);
  --novel-primary-hover: var(--dsw-alias-button-primary-hover, #3b7bf0);
  /* brand 派生色：视图不要内联 #2f6feb14/1f/44 与 #79a8ff——brand 一换色即全部失联。 */
  --novel-brand-soft: color-mix(in srgb, var(--novel-brand) 8%, transparent);   /* 选中动作条底 */
  --novel-brand-tint: color-mix(in srgb, var(--novel-brand) 12%, transparent);  /* 选中 chip / 编辑态底 */
  --novel-brand-line: color-mix(in srgb, var(--novel-brand) 27%, transparent);  /* 运行卡 / 选中条描边 */
  --novel-brand-strong: var(--dsw-alias-label-primary-bluish, #79a8ff);         /* 亮蓝强调字 */
  /* 阅读器子菜单彩色强调色：在深浅宿主下始终保持 DeepSeek 品牌蓝，避免宿主黑白反色主色在深色模式下与白字/白圆点撞色。 */
  --novel-accent: var(--dsw-static-deepseek-500, #3b76e8);
  --novel-accent-hover: var(--dsw-static-deepseek-600, #2f65d4);
  --novel-accent-soft: color-mix(in srgb, var(--novel-accent) 14%, transparent);
  --novel-accent-line: color-mix(in srgb, var(--novel-accent) 38%, transparent);
  --novel-skeleton: var(--dsw-alias-bg-skeleton, #ffffff14);
  /* 浮层底：迷你条读宿主**浮动钮**语义（与宿主自己的浮动按钮同底同源），不是面板层板。 */
  --novel-float: var(--dsw-alias-button-floating-fill, #2b2b2e);
  /* 滚动条三件套（宿主滚动条口径）：轨透明、thumb 按表面高度取档——基面 l1 对，
     抬升面（菜单面 / 输入卡）重绑 l2 对；hover 用同档 hover 值。 */
  --novel-scrollbar-track: transparent;
  --novel-scrollbar: var(--dsw-alias-scrollbar-bg-l1, #ffffff0f);
  --novel-scrollbar-hover: var(--dsw-alias-scrollbar-hover-l1, #ffffff2e);
  --novel-scrollbar-elevated: var(--dsw-alias-scrollbar-bg-l2, #ffffff2e);
  --novel-scrollbar-elevated-hover: var(--dsw-alias-scrollbar-hover-l2, #ffffff47);
  /* 模态遮罩：宿主语义层真名 bg-mask-1（词表在 theme-tokens 守卫内）——视觉规则只读本局部变量 */
  --novel-mask: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .45));
  /* 菜单面材质 / tab 激活底 / chip 悬停底 / Toast 底 / Tooltip 三色（宿主真名，见 theme-tokens 词表）。 */
  --novel-menu-fill: var(--dsw-menu-surface-fill, var(--novel-layer-2));
  --novel-menu-blur: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  --novel-tab-active: var(--dsw-alias-markdown-tag, var(--novel-active));
  --novel-chip-hover: var(--dsw-alias-state-business-tertiary, color-mix(in srgb, var(--novel-business) 18%, transparent));
  --novel-toast-bg: var(--dsw-alias-toast-bg, var(--novel-layer-2));
  /* 文件牌琥珀（FileTypeIcon folder 色相，宿主静态 amber-400）。 */
  --novel-file-folder: var(--dsw-static-amber-400, #f7ad31);
  /* 轨迹轮次头的满幅浅底（宿主 TrajectoryTurnHeader 的 ghost-active-fill）与事件类型标签三对
     （宿主 TrajectoryCell tagSystem/tagUser/tagMessage/tagTool 的取色；消息对是 brand-new×
     error-secondary 的混色，按宿主公式在本层混出）。 */
  --novel-ghost-fill: var(--dsw-alias-button-ghost-active-fill, #ffffff14);
  --novel-tag-user-fg: var(--dsw-alias-state-success-primary, #3fb950);
  --novel-tag-user-bg: var(--dsw-alias-state-success-tertiary, #2ea04326);
  --novel-tag-tool-fg: var(--dsw-alias-state-warn-label, #d29922);
  --novel-tag-tool-bg: var(--dsw-alias-state-warn-tertiary, #d2992226);
  --novel-tag-msg-fg: color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%, var(--novel-err));
  --novel-tag-msg-bg: color-mix(in srgb, color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 55%, var(--novel-err)) 15%, var(--novel-layer-1));
  --novel-tooltip-bg: var(--dsw-alias-tooltip-bg, var(--novel-layer-3));
  --novel-tooltip-label: var(--dsw-alias-tooltip-label, var(--novel-text));
  --novel-tooltip-key-bg: var(--dsw-alias-tooltip-key-bg, color-mix(in srgb, var(--novel-tooltip-bg), white 18%));
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
  /* 焦点环：宿主焦点环的真口径——business 蓝（brand-primary 在宿主词表里是黑白反色主色，
     不是环色）+ 标准 2px 宽；宽度/颜色如宿主可被 --dsw-focus-ring-* 覆写。 */
  --novel-ring: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #7aaaff));
  /* 配置页保存条吸附偏移：JS 吸住时按宿主滚动区底留白写成负值；缺省 0 = 普通 sticky */
  --novel-cfg-pin: 0px;
  /* ── 标度：间距 / 字阶 / 圆角 / 阴影 / 层级 / 动效 ── */
  --novel-sp-0: 2px; --novel-sp-1: 4px; --novel-sp-2: 6px; --novel-sp-3: 8px;
  --novel-sp-4: 12px; --novel-sp-5: 16px; --novel-sp-6: 24px; --novel-sp-7: 32px;
  --novel-fs-xs: 11px; --novel-fs-sm: 12px; --novel-fs-md: 13px;
  --novel-fs-base: 14px; --novel-fs-lg: 16px; --novel-fs-xl: 19px;
  /* 圆角标度逐档贴宿主 radius 标度（xs 4 / sm 8 / md 12 / lg 16 / xl 20 / panel 28），
     名字同序对齐——宿主换档时只动这里的 fallback。 */
  --novel-r-xs: var(--dsw-radius-xs, 4px); --novel-r-sm: var(--dsw-radius-sm, 8px);
  --novel-r-md: var(--dsw-radius-md, 12px); --novel-r-lg: var(--dsw-radius-lg, 16px);
  --novel-r-xl: var(--dsw-radius-xl, 20px); --novel-r-panel: var(--dsw-radius-panel, 28px);
  /* 阴影走宿主阴影词表：lv1 贴页 / lv2 卡片浮起 / 模态走
     elevation-prominent（0.5px 发丝描边 + 2–5% 柔光）。 */
  --novel-shadow-1: var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0, 0, 0, .05));
  --novel-shadow-2: var(--dsw-shadow-lv2, 0 4px 12px 0 rgba(0, 0, 0, .02), 0 2px 8px 0 rgba(0, 0, 0, .04));
  --novel-shadow-pop: var(--dsw-elevation-prominent, 0 0 0 0.5px var(--novel-border-strong), 0 3px 8px 0 rgba(0, 0, 0, .04), 0 0 20px 0 rgba(0, 0, 0, .05));
  --novel-dur: .15s; --novel-ease: cubic-bezier(.2, 0, 0, 1);
  --novel-ease-out: cubic-bezier(.22, 1, .36, 1);
  --novel-ease-spring: cubic-bezier(.34, 1.35, .64, 1);
  --novel-dur-fast: 140ms; --novel-dur-mid: 220ms;
  --novel-font-serif: "Noto Serif SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, serif;
  /* 宿主代码字族（宿主平台缺省栈，故意不带裸 monospace 尾——Windows 中文会掉宋体）：
     文件路径、时长读数与代码标记共用；用户字体表在宿主 body 上重绑 --ds-font-family-code。 */
  --novel-font-mono: var(--ds-font-family-code, 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei');
  /* 宿主正文字族：--dsw-font-family 在宿主 body 上被用户字体表前置，跟随「字体」设置。 */
  --novel-font-text: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif);
  /* 值槽（唯一由行内写入的动态量，规则都住本层）。 */
  --novel-pct: 0;
  --novel-measure: 680px;
  --novel-book-page-h: 520px;
  --novel-range-fill: 50%;
  --novel-picker-h: 44;
  --novel-picker-s: 52%;
  --novel-picker-l: 94%;
  --novel-picker-color: #f7f3e8;
  --novel-picker-ink: #222;
  --novel-picker-live: #855532;
  --novel-seg-count: 2;
  --novel-seg-index: 0;
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
/* Elevation 三件套（宿主 elevation 的同款口径）：0.5px 发丝描边画在
   box-shadow 里（组件配 border: 0 不占布局）+ 两层极淡柔光。**逐元素声明**而非继承：
   继承传下来的是在声明处已替换完 var() 的值，组件重绑 --novel-elevation-stroke-color
   进不了已替换的派生值；逐元素声明让每个元素按自己看到的描边色重新替换。 */
.novel-root, .novel-root *, [data-novel-scope], [data-novel-scope] * {
  --novel-elevation-stroke: 0 0 0 0.5px var(--novel-elevation-stroke-color);
  --novel-elevation-panel: var(--novel-elevation-stroke), 0 3px 8px 0 rgba(0, 0, 0, .03), 0 0 16px 0 rgba(0, 0, 0, .02);
  --novel-elevation-prominent: var(--novel-elevation-stroke), 0 3px 8px 0 rgba(0, 0, 0, .04), 0 0 20px 0 rgba(0, 0, 0, .05);
  --novel-elevation-soft: var(--novel-elevation-stroke), 0 4px 16px 0 rgba(0, 0, 0, .03), 0 0 24px 0 rgba(0, 0, 0, .03);
}
/* 控制器条底：纸往墨压一档（6%），阅读器顶条与听书条共用；直接写在条元素的 background 上。 */
.novel-rdr-bar, .novel-tts-bar {
  background: color-mix(in srgb, var(--novel-paper-ink) 6%, var(--novel-paper));
}
`
