import { describe, expect, it } from 'vitest'

import { bufferedAhead } from './index'

function ranges(values: Array<[number, number]>): TimeRanges {
  return {
    length: values.length,
    start: (index) => values[index][0],
    end: (index) => values[index][1],
  }
}

describe('bufferedAhead', () => {
  it('reports the active range and ignores gaps', () => {
    const value = ranges([
      [0, 3],
      [8, 14],
    ])
    expect(bufferedAhead(value, 10)).toBe(4)
    expect(bufferedAhead(value, 5)).toBe(0)
  })
})
