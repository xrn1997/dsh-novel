/**
 * 在册已知桥缺口：脚本在调、本仓没挂的 `java.*` 方法名，以及它在覆盖矩阵里的归属行。
 *
 * 默认门 `bridge-surface.test.ts` 核两件事：名字真的不在沙箱挂载面、行 id 真的在矩阵里；
 * 源侧「新名字冒出来」仍由解析面普查（`DSH_PARSE_CENSUS`）判红。名册按名字点，不数第几条。
 */
export interface BridgeGap {
  /** 脚本侧方法名（不带 `java.` 前缀） */
  name: string
  /** 覆盖矩阵行 id：这个名字的去处 */
  row: string
  /** 为什么没挂 / 去哪儿 */
  why: string
}

export const KNOWN_BRIDGE_GAPS: readonly BridgeGap[] = [
  { name: 't2s', row: 'h-java-t2s', why: '繁简词典不在本仓，且转换链上还压着一份补丁词典——换轮子（opencc 一类）得到的文本不逐字相等，要拍板' },
  { name: 's2t', row: 'h-java-t2s', why: '与 t2s 同席（同一词典议题，需求方已进本库 2 源）' },
  { name: 'cacheFile', row: 'h-java-cache-file', why: '裁决已有（真实文件 API = 数据外泄面），这一条的作用是确认该裁决真有需求方' },
  { name: 'toURL', row: 'h-java-tourl', why: '返回的是 URL 对象（不是串）；先看清那 1 源真调了哪些成员再造壳' },
  { name: 'getVerificationCode', row: 'h-tts-and-search-bridges', why: '需宿主交互面（验证码对话框），headless 无面——登录/评论链调用（4 源）' },
  { name: 'ajaxTestAll', row: 'h-java-ajax-test-all', why: '静态命中全在特性探测注释块（两条 loginCheckJs），无真实调用；网络自测函数无面' },
  { name: 'queryBase64TTF', row: 'h-font-anti-scrape', why: '字体反混淆（TTF 解析 + 码位映射，大件）——需求方已出现（1 源），用户裁「排队」' },
  { name: 'refreshExplore', row: 'h-source-refresh-explore', why: '宿主重算发现面列表；本仓无对应出口' },
  { name: 'refreshBookUrl', row: 'h-source-refresh-explore', why: '书源刷新扩展；本仓无对应出口' },
  { name: 'searchBook', row: 'h-tts-and-search-bridges', why: 'App 内搜索/朗读面，headless 无面' },
  { name: 'upLoginData', row: 'h-tts-and-search-bridges', why: '登录面未知扩展，调用现场如实抛错' },
  { name: 'openWeb', row: 'h-tts-and-search-bridges', why: '登录面脚本里的开页动作，headless 无面；本仓既不挂也不桩，调用现场如实抛错' },
  { name: 'startBrowserDp', row: 'h-tts-and-search-bridges', why: 'App 浏览器动作，headless 无面' },
  { name: 'showBrowser', row: 'h-tts-and-search-bridges', why: 'App 浏览器动作，headless 无面' },
  { name: 'openVideoPlayer', row: 'h-tts-and-search-bridges', why: 'App 播放器面，headless 无面' },
  { name: 'webview', row: 'h-host-ext-methods', why: 'WebView 渲染扩展，本仓只读文本、不猜形状' },
  { name: 'getStrResponse', row: 'h-host-ext-methods', why: '形状未知的宿主扩展调用，不猜返回结构' },
  { name: 'deviceID', row: 'h-host-ext-methods', why: '设备标识扩展，无对应面' },
  { name: 'qread', row: 'h-host-ext-methods', why: '阅读器扩展，无对应面' },
  { name: 'sleep', row: 'h-host-ext-methods', why: '脚本侧休眠扩展，本仓未挂' },
  { name: 'initUrl', row: 'h-host-ext-methods', why: '形状未知的宿主扩展调用，不猜返回结构' },
  { name: 'tripleDESEncodeBase64Str', row: 'h-encrypt-side', why: '3DES 加密方向，本仓只做正文解密' },
  { name: 'removeCookie', row: 'h-packages-app-host-apis', why: '宿主 cookie 删除扩展；cookie.removeCookie 已接，java.removeCookie 未挂' },
]

export const BRIDGE_GAP_NAMES: ReadonlySet<string> = new Set(KNOWN_BRIDGE_GAPS.map((gap) => gap.name))
