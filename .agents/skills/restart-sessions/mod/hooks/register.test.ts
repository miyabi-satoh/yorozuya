import { expect, test } from 'claude-code/testing'

import { splitLines } from './register'

test('切れ端を次に回し、行ごとに分ける', () => {
  const first = splitLines('', 'OVER\t52\tw1:p2\nUPD')
  expect(first.lines).toEqual(['OVER\t52\tw1:p2'])
  expect(first.rest).toBe('UPD')

  const second = splitLines(first.rest, 'ATE\tx\n\n')
  expect(second.lines).toEqual(['UPDATE\tx'])
  expect(second.rest).toBe('')
})
