import { describe, expect, it } from 'vitest'
import SessionResumeService from '../src/index.ts'

describe('host Remote signatures', () => {
  it('keeps discover compatible with the Gateway SRC signature parser', () => {
    const source = Function.prototype.toString.call(SessionResumeService.prototype.discover)

    expect(source).toMatch(/discover\(input\)/u)
    expect(source).not.toContain('= {}')
  })
})
