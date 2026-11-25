import { describe, expect, it } from 'vitest'
import {
  MOYU_ACTION_MARKS, MOYU_PIN_RELEASE_PX, actionMarkFor, chapterFileName, isMainLine,
  isPinnedToTail, nextPhase, projectLines,
} from '../../src/client/moyu-stream.js'

describe('节奏行分派（正常行 / 小字行动作标记）', () => {
  it('isMainLine：每 4 行第 1 行是正常行，其余是小字行', () => {
    expect([0, 4, 8, 12].map(isMainLine)).toEqual([true, true, true, true])
    expect([1, 2, 3, 5, 6, 7, 9].map(isMainLine)).toEqual([false, false, false, false, false, false, false])
  })
  it('actionMarkFor：小字行在动作池（运行命令 / 思考 / 读取 / 编辑）里确定性轮换', () => {
    // 第一个周期的小字行 i=1..3 → 池下标 0..2
    expect([1, 2, 3].map(actionMarkFor)).toEqual(['▸', '»', '⇣'])
    // 第二个周期继续往前滚（i=5..7 → 池下标 3,4%4,5%4），不每周期从头来
    expect([5, 6, 7].map(actionMarkFor)).toEqual(['✎', '▸', '»'])
    // 第三个周期接着滚：i=9..11 → 池下标 6%4,7%4,8%4
    expect([9, 10, 11].map(actionMarkFor)).toEqual(['⇣', '✎', '▸'])
    // 误传正常行序号（0）→ 负下标落空，回退池首，不闪变
    expect(actionMarkFor(0)).toBe('▸')
  })
  it('动作池只有四款装饰字形，长度固定', () => {
    expect([...MOYU_ACTION_MARKS]).toEqual(['▸', '»', '⇣', '✎'])
  })
})

describe('chapterFileName', () => {
  it('四位零垫序号 + 章名 + .ts 后缀', () => {
    expect(chapterFileName(0, '第一章')).toBe('0001_第一章.ts')
    expect(chapterFileName(4, '第5章 夜战2')).toBe('0005_第5章 夜战2.ts')
    expect(chapterFileName(999, '末章')).toBe('1000_末章.ts')
  })
  it('Windows 非法文件名字符（含换行/制表）折成下划线；首尾下划线与空白剪掉', () => {
    expect(chapterFileName(0, 'a/b\\c:d*e?f"g<h>i|j')).toBe('0001_a_b_c_d_e_f_g_h_i_j.ts')
    expect(chapterFileName(0, '第\n二\t章')).toBe('0001_第_二_章.ts')
    expect(chapterFileName(0, '_x_')).toBe('0001_x.ts')
    expect(chapterFileName(0, '  第一章  ')).toBe('0001_第一章.ts')
  })
  it('消毒后为空回退 chapter；超长按 code point 截到 32', () => {
    expect(chapterFileName(0, '')).toBe('0001_chapter.ts')
    expect(chapterFileName(0, '???')).toBe('0001_chapter.ts')
    expect(chapterFileName(0, 'x'.repeat(40))).toBe(`0001_${'x'.repeat(32)}.ts`)
  })
})

describe('isPinnedToTail', () => {
  it('距尾不超过释放阈值即贴尾，越过即脱离', () => {
    const box = (top: number) => ({ scrollTop: top, scrollHeight: 1000, clientHeight: 200 })
    expect(isPinnedToTail(box(800))).toBe(true)
    expect(isPinnedToTail(box(800 - MOYU_PIN_RELEASE_PX))).toBe(true)
    expect(isPinnedToTail(box(800 - MOYU_PIN_RELEASE_PX - 1))).toBe(false)
  })
})

describe('nextPhase', () => {
  it('揭示未满为 streaming；满而非末章为 chapter-done；末章满即 end', () => {
    expect(nextPhase(0, 10, false)).toBe('streaming')
    expect(nextPhase(9, 10, false)).toBe('streaming')
    expect(nextPhase(10, 10, false)).toBe('chapter-done')
    expect(nextPhase(10, 10, true)).toBe('end')
  })
  it('空章（total 0）恒为 streaming——不许当成章完成去连环跳章', () => {
    expect(nextPhase(0, 0, false)).toBe('streaming')
  })
})

describe('projectLines', () => {
  it('按已揭示字符数截断：全量段 done、截断段 streaming、未到段不出现', () => {
    expect(projectLines(['abc', 'def'], 4)).toEqual([
      { text: 'abc', done: true },
      { text: 'd', done: false },
    ])
  })
  it('revealed 为 0 时投影为空；全量后整段 done', () => {
    expect(projectLines(['ab', 'cd'], 0)).toEqual([])
    expect(projectLines(['ab', 'cd'], 4)).toEqual([
      { text: 'ab', done: true },
      { text: 'cd', done: true },
    ])
  })
  it('空行不渲染也不计数', () => {
    expect(projectLines(['a', '', 'b'], 1)).toEqual([{ text: 'a', done: true }])
    expect(projectLines(['', 'a'], 1)).toEqual([{ text: 'a', done: true }])
  })
  it('按 code point 截断，代理对不切半', () => {
    expect(projectLines(['👍👍'], 1)).toEqual([{ text: '👍', done: false }])
  })
})
