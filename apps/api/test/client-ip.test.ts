import { describe, expect, it } from 'vitest'

describe('client identity', () => {
  it('buckets IPv6 by /64 and keeps IPv4 as-is', async () => {
    const { ipBucket } = await import('../src/routes/http')
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'))
    expect(ipBucket('2001:db8:1:2::5')).not.toBe(ipBucket('2001:db8:1:3::5'))
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9')
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9')
  })
})
