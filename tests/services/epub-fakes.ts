import { expect } from 'vitest'
import { EpubImportError } from '../../src/services/epub/errors.js'

/**
 * EPUB 拒收断言的共用体：类名、家族归属与点名模式。
 *
 * 四个层各抄过一遍（资源层只换了类名），而这三行正是「坏书不许冒充可读」的机器化表述：
 * 换了类名就是换了半径，不该由抄本各自记。
 */

/** 断言异常是 EPUB 导入错，且报错点名了出问题的条目 / 资源 / 书内位置。 */
export function expectEpubError(e: Error, pattern: RegExp, name = 'EpubImportError'): void {
  expect(e.name).toBe(name)
  expect(e).toBeInstanceOf(EpubImportError)
  expect(e.message).toMatch(pattern)
}

/** 资源级失败是本类（半径写在类型上：编排层只接住这一类，其余照原样上抛），
 *  但仍属 EPUB 导入家族——服务层的分类表按基类映射，不因为降级而换类目。 */
export function expectEpubResourceError(e: Error, pattern: RegExp): void {
  expectEpubError(e, pattern, 'EpubResourceError')
}
