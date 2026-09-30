/** Read-only pre-launch check of a pump.fun coin against the launch requirements (same decoders the API boots with). */
import { Connection, PublicKey } from '@solana/web3.js'
import { decodeBondingCurve, decodeSharingConfig, pumpPda, PUMP_PROGRAM_ID, PUMP_FEES_PROGRAM_ID } from '../src/venue/pumpfun-program'
const MINT = new PublicKey(process.argv[2] ?? '7uwiFu48zz8R9dmGjshNNhHcK9By2xpjH6sm7xjtpump')
const PUMP = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn'
const PRIZE = 'HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1'
const OPS = 'Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF'
const c = new Connection(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
const bc = pumpPda.bondingCurve(MINT)
const sc = pumpPda.sharingConfig(MINT)
const [bi, si] = await c.getMultipleAccountsInfo([bc, sc])
if (!bi) throw new Error('no bonding curve — not a pump.fun coin?')
console.log('curve owner ok:', bi.owner.equals(PUMP_PROGRAM_ID))
const cv = decodeBondingCurve(bi.data)
console.log('quoteMint:', cv.quoteMint.toBase58(), cv.quoteMint.toBase58() === PUMP ? '✓ PUMP' : '✗ NOT PUMP')
console.log('creatorFeeBps:', Number(cv.creatorFeeBps), Number(cv.creatorFeeBps) === 300 ? '✓ 3%' : '✗ not 3%')
console.log(
  'creator == sharing config:',
  cv.creator.equals(sc) ? '✓ shared' : `✗ creator is ${cv.creator.toBase58()} (Share creator rewards not done yet)`,
)
console.log('graduated:', cv.complete, ' realQuoteReserves:', cv.realQuoteReserves.toString())
if (si) {
  const cfg = decodeSharingConfig(si.data)
  console.log('sharing cfg owner ok:', si.owner.equals(PUMP_FEES_PROGRAM_ID))
  for (const h of cfg.shareholders) {
    const a = h.address.toBase58()
    console.log('  shareholder', a, h.shareBps, 'bps', a === PRIZE ? '(PRIZE)' : a === OPS ? '(OPS)' : '(??? unknown)')
  }
  console.log('admin:', cfg.admin.toBase58(), ' adminRevoked:', cfg.adminRevoked)
} else console.log('sharing config: NOT FOUND (Share creator rewards not set up)')
