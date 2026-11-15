import type { VolatileConfigFieldName } from '../config.js'
import type { CopyKey } from './copy/index.js'

/**
 * 配置页的分区表：纯数据、零运行时依赖（两个 import 都是 type-only，运行时擦除）。
 * 它从视图文件里分出来的全部理由是让 Node 侧的 `tests/client/config-fields.test.ts` 能拿它与
 * 字段表、文案字典对读——页面分区漏一项，字段就在界面上隐身。
 *
 * 分区按「你什么时候会来动它」切，不按实现模块切：全部字段等权排一条纵列时，
 * 第 12 项在首屏之外，而最常调的两个（超时、并发）和最不敢调的两个（字节数）占一样的地方。
 * 听书组排最后：它只在开了听书之后才会来调，平时不进首屏视线。
 */
export const GROUPS: {
  titleKey: CopyKey
  names: readonly VolatileConfigFieldName[]
  /** 整行宽 + 组尾挂对象数据管理区（听书组）；视图不按文案键反查分区身份。 */
  wide?: boolean
}[] = [
  { titleKey: 'config.group.search', names: ['searchTimeoutMs', 'searchParallel'] },
  { titleKey: 'config.group.reading', names: ['jsTimeoutMs', 'exportDelayMs'] },
  { titleKey: 'config.group.storage', names: ['cacheMaxBytes', 'localImportMaxBytes'] },
  { titleKey: 'config.group.network', names: ['proxyUrl'] },
  {
    titleKey: 'config.group.tts',
    names: ['ttsDefaultEngine', 'ttsDefaultRate', 'ttsDefaultVolume', 'ttsCacheMaxBytes', 'ttsPrefetchParagraphs'],
    wide: true,
  },
]
