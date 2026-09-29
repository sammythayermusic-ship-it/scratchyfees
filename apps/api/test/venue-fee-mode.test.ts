import { describe, expect, it } from 'vitest'
import { feeCollection } from '../src/venue/damm-v2'

describe('DAMM v2 fee collection (launch config: fees only in PUMP)', () => {
  it('OnlyB collects in token B — PUMP only when SCRATCHY is token A', () => {
    expect(feeCollection(1, 'base-is-a')).toBe('quote-only')
    expect(feeCollection(1, 'base-is-b')).toBe('base-only') // pool created the other way round → SCRATCHY fees
    expect(feeCollection(0, 'base-is-a')).toBe('both')
    expect(feeCollection(0, 'base-is-b')).toBe('both')
  })
})
