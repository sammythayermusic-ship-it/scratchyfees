import { describe, expect, it } from 'vitest'
import { classifyFailure, failingProgram } from '../src/payouts/classify'

const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const HOOK = 'HooKzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const SYS = '11111111111111111111111111111111'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

describe('classifyFailure (innermost failing program decides custom codes)', () => {
  it('token program 0x1 → low_pool; 0x11 → permanent', () => {
    expect(
      classifyFailure('instruction 4: custom program error: 0x1', false, [
        `Program ${T22} invoke [1]`,
        `Program ${T22} failed: custom program error: 0x1`,
      ]),
    ).toBe('low_pool')
    expect(classifyFailure('x', false, [`Program ${T22} failed: custom program error: 0x11`])).toBe(
      'permanent',
    )
  })
  it('a transfer hook failing with 0x1 is NOT low_pool (would pause every payout)', () => {
    const logs = [
      `Program ${T22} invoke [1]`,
      `Program ${HOOK} invoke [2]`,
      'Program log: Error: insufficient funds',
      `Program ${HOOK} failed: custom program error: 0x1`,
      `Program ${T22} failed: custom program error: 0x1`,
    ]
    expect(failingProgram('instruction 4: custom program error: 0x1', logs)?.program).toBe(HOOK)
    expect(classifyFailure('instruction 4: custom program error: 0x1', false, logs)).toBe('transient')
    expect(classifyFailure('instruction 4: custom program error: 0x1', true, logs)).toBe('permanent')
  })
  it('system program 0x1 during ATA creation → low_gas', () => {
    const logs = [
      `Program ${ATA} invoke [1]`,
      `Program ${SYS} invoke [2]`,
      'Transfer: insufficient lamports 100, need 2039280',
      `Program ${SYS} failed: custom program error: 0x1`,
    ]
    expect(classifyFailure('instruction 3: custom program error: 0x1', false, logs)).toBe('low_gas')
  })
  it('ATA program InvalidOwner → permanent', () => {
    expect(classifyFailure('x', false, [`Program ${ATA} failed: custom program error: 0x0`])).toBe(
      'permanent',
    )
  })
  it('logs embedded in a rendered error string are used when no logs are passed', () => {
    expect(
      classifyFailure(
        `instruction 4: custom program error: 0x1 | logs: Program ${HOOK} failed: custom program error: 0x1`,
      ),
    ).toBe('transient')
    expect(
      classifyFailure(
        `instruction 4: custom program error: 0x1 | logs: Program ${T22} failed: custom program error: 0x1`,
      ),
    ).toBe('low_pool')
  })
  it('an unattributed custom code (on-chain status, no logs) is retried, never guessed', () => {
    expect(
      classifyFailure('instruction 4: custom program error: 0x1 {"InstructionError":[4,{"Custom":1}]}'),
    ).toBe('transient')
  })
  it('named runtime errors keep their meaning', () => {
    expect(classifyFailure('Attempt to debit an account but found no record of a prior credit')).toBe(
      'low_gas',
    )
    expect(classifyFailure('InsufficientFundsForRent')).toBe('low_gas')
    expect(classifyFailure('Program Token: insufficient funds')).toBe('low_pool')
    expect(classifyFailure('AccountFrozen')).toBe('permanent')
    expect(classifyFailure('Blockhash not found')).toBe('transient')
  })
})
