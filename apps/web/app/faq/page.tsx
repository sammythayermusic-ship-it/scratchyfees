import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { ECON } from '@/components/faq/econ'
import { FAQ_LINK, FaqItem, FaqSection } from '@/components/faq/FaqItem'
import { FeeFlow } from '@/components/faq/FeeFlow'
import { OddsTable } from '@/components/faq/OddsTable'
import { TicketLadder } from '@/components/faq/TicketLadder'
import { X_HANDLE } from '@/lib/config'

export const metadata: Metadata = {
  title: 'FAQ — $SCRATCHY',
  description:
    'How $SCRATCHY scratch tickets work: why there’s no wallet connect, tickets and multipliers, the full odds table, the progressive jackpot, where the $PUMP prizes come from, and how to verify every ticket.',
  alternates: { canonical: '/faq' },
}

const SECTIONS = [
  { id: 'basics', label: 'The basics' },
  { id: 'tickets-odds', label: 'Tickets & odds' },
  { id: 'prize-money', label: 'Prize money' },
  { id: 'fairness', label: 'Fairness' },
  { id: 'payouts', label: 'Payouts' },
]

export default function FaqPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 pt-6">
      <header className="panel relative flex items-center gap-4 overflow-hidden px-4 py-5 sm:gap-6 sm:px-7 sm:py-7">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[repeating-conic-gradient(from_0deg_at_88%_50%,rgba(249,25,215,0.10)_0deg_9deg,transparent_9deg_18deg)]"
        />
        <div className="relative min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.25em] text-magenta sm:text-xs">straight answers</p>
          <h1 className="foil-text font-display text-5xl leading-none sm:text-7xl">FAQ</h1>
          <p className="mt-2 text-sm text-muted sm:text-base">
            Hold <span className="text-gold">{ECON.minHold}+</span> of $SCRATCHY, paste your wallet, scratch
            every {ECON.roundMinutes} minutes, win <span className="text-magenta">$PUMP</span>. Here&apos;s
            everything behind that — the odds, the money, and how to check our work.
          </p>
        </div>
        <Image
          src="/brand/mascot-sticker.png"
          alt="Scratchy, the $SCRATCHY mascot"
          width={768}
          height={768}
          priority
          sizes="(min-width: 640px) 144px, 88px"
          className="relative h-22 w-22 shrink-0 animate-float drop-shadow-[0_10px_30px_rgba(252,4,168,0.55)] sm:h-36 sm:w-36"
        />
      </header>

      <nav aria-label="FAQ sections" className="-mt-4 flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-muted/40 bg-stage/55 px-4 py-2 text-sm text-ink transition hover:border-gold/60 hover:text-gold"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <FaqSection id="basics" kicker="start here" title="The basics">
        <FaqItem id="how-it-works" q="How does $SCRATCHY work?" defaultOpen>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 marker:font-display marker:text-gold">
            <li>
              Hold at least <strong>{ECON.minHold}</strong> of $SCRATCHY in a Solana wallet.
            </li>
            <li>
              Paste that wallet address on the{' '}
              <Link href="/" className={FAQ_LINK}>
                home page
              </Link>{' '}
              (adding an X handle is optional).
            </li>
            <li>
              Every <strong>{ECON.roundMinutes} minutes</strong> a fresh drop of scratch tickets lands.
              Scratch them with your finger or mouse.
            </li>
            <li>
              Hit a winner and <strong>$PUMP is sent to that wallet automatically</strong> — usually within
              seconds, with a Solscan receipt.
            </li>
          </ol>
          <p>
            Nobody buys tickets. All prize money comes from the trading fees on the $SCRATCHY pool —{' '}
            <a href="#fees" className={FAQ_LINK}>
              here&apos;s exactly how
            </a>
            .
          </p>
        </FaqItem>

        <FaqItem id="no-connect" q="Why is there no “connect wallet” button?">
          <p>
            Because we don&apos;t need one. You paste an address — you never connect, sign or send anything.{' '}
            <strong>Prizes only ever go to the wallet that was pasted</strong>, the one holding the $SCRATCHY.
          </p>
          <p>
            Paste someone else&apos;s wallet and you&apos;re just scratching <em>their</em> tickets — they get
            paid, not you. There&apos;s nothing to sign and nothing to steal.
          </p>
          <p className="rounded-xl border border-pink/40 bg-pink/10 px-3 py-2.5 text-ink">
            $SCRATCHY will never ask you to connect a wallet, sign a message or send tokens. If something
            claiming to be us does, it isn&apos;t us.
          </p>
        </FaqItem>

        <FaqItem id="entering" q="How do I get into a drop?">
          <p>
            Paste your wallet and you&apos;re in for the <strong>next</strong> drop — tickets land when the
            next {ECON.roundMinutes}-minute round starts. First time? There&apos;s a free practice ticket to
            warm up on while you wait (it can&apos;t win anything).
          </p>
          <p>
            <strong>Keep the site open in a visible tab</strong> to stay in for every drop after that. Your
            $SCRATCHY balance is snapshotted at each drop — you need {ECON.minHold}+ at that moment — and the
            snapshot sets your tickets for the round.
          </p>
        </FaqItem>

        <FaqItem id="expiry" q="Do tickets expire?">
          <p>
            Yes — <strong>at the next drop</strong>. Unscratched tickets are void once the next round&apos;s
            tickets land, and any prize under them quietly goes back into the pool for future rounds. Watch
            the countdown.
          </p>
          <p>
            Holding a big stack? <strong>SCRATCH ALL</strong> reveals every ticket in one go.
          </p>
        </FaqItem>

        <FaqItem id="one-session" q="Can I play the same wallet on two devices?">
          <p>
            One wallet gets <strong>one entry per round</strong>, however many tabs or phones paste it. The
            first session to scratch holds the tickets; anywhere else you&apos;ll see “this wallet&apos;s
            tickets are being scratched” until that session goes quiet. Every ticket is counted exactly once.
          </p>
        </FaqItem>

        <FaqItem id="x-handle" q="What’s the X handle for?">
          <p>
            Bragging rights. It&apos;s optional and shows next to your wins on the{' '}
            <Link href="/winners" className={FAQ_LINK}>
              Winners
            </Link>{' '}
            page, marked <strong>unverified</strong> — anyone can type any handle, so the wallet is what
            counts.
          </p>
        </FaqItem>
      </FaqSection>

      <FaqSection id="tickets-odds" kicker="the numbers" title="Tickets & odds">
        <FaqItem id="tickets" q="How many tickets do I get?">
          <p>
            <strong>
              {ECON.ticketsPerBlock} tickets for every {ECON.block}
            </strong>{' '}
            of $SCRATCHY you hold (whole {ECON.block} steps), up to <strong>{ECON.ticketCap} tickets</strong>{' '}
            per drop at {ECON.ticketCapUsd}.
          </p>
          <p>
            Past {ECON.ticketCapUsd} your ticket count stays at {ECON.ticketCap}, and a{' '}
            <strong>whale multiplier</strong> takes over: your holdings ÷ {ECON.multDivisor}, up to{' '}
            <strong>{ECON.multCap}</strong> at {ECON.multCapUsd}. It multiplies every prize on your tickets.
          </p>
          <TicketLadder />
          <p>
            <strong>Weight</strong> = tickets × multiplier: your slice of each round&apos;s prize money. It
            grows in a straight line with dollars held from {ECON.minHold} to {ECON.multCapUsd}, so splitting
            a bag across wallets doesn&apos;t get you more ticket prizes. Above {ECON.multCapUsd} it stops
            growing.
          </p>
        </FaqItem>

        <FaqItem id="odds" q="What are the odds?">
          <p>Every ticket rolls against the same published table:</p>
          <OddsTable />
          <p>
            About <strong>{ECON.anyWin}</strong> of tickets win something. Your prize ={' '}
            <strong>the multiple × e × your whale multiplier</strong>.
          </p>
          <p>
            <strong>e</strong> is the round&apos;s ticket prize money divided by everyone&apos;s total weight
            — in plain words, what one ticket is worth on average this round. A bigger pool or fewer tickets
            in play means a bigger e. The table averages out to exactly <strong>{ECON.evPerTicket}e</strong>{' '}
            per ticket, so a round pays out its ticket budget on average, no more.
          </p>
        </FaqItem>

        <FaqItem id="jackpot" q="How does the jackpot work?">
          <p>
            Every round, <strong>{ECON.jackpotShare}</strong> of the round budget goes into a progressive
            jackpot pot that climbs until someone hits it — you can watch it on the{' '}
            <Link href="/" className={FAQ_LINK}>
              home page
            </Link>
            .
          </p>
          <p>
            Every scratched ticket gets its own <strong>1-in-{ECON.jackpotOdds}</strong> roll to win{' '}
            <strong>the entire pot</strong>. It isn&apos;t multiplied — same glory for a {ECON.minHold} holder
            and a whale — and it&apos;s paid from its own pot, not from the round&apos;s ticket prizes.
          </p>
          <p>
            After a hit the pot starts over and refills from the next rounds (at launch it&apos;s seeded with{' '}
            {ECON.jackpotSeed} of the starting pool). If two tickets hit in the same round, the first one
            revealed takes the pot.
          </p>
        </FaqItem>
      </FaqSection>

      <FaqSection id="prize-money" kicker="follow the money" title="Where prizes come from">
        <FaqItem id="fees" q="Where does the prize money come from?">
          <p>Trading fees — and nothing else. Here&apos;s the path:</p>
          <FeeFlow />
          <p>
            More trading → more fees → a bigger pool → bigger prizes. Quiet volume means smaller prizes.
            Everything is held and paid in PUMP, so PUMP&apos;s dollar price moving around never breaks the
            math.
          </p>
        </FaqItem>

        <FaqItem id="budget" q="How much gets paid out each round?">
          <p>
            At each drop the round budget is <strong>{ECON.payoutRate} of the prize pool</strong>. That&apos;s
            the default; it can be tuned between {ECON.payoutRateMin} and {ECON.payoutRateMax}, and every
            round&apos;s actual settings are published on the{' '}
            <Link href="/fair" className={FAQ_LINK}>
              Fair
            </Link>{' '}
            page. {ECON.ticketShare} of it is for ticket prizes and {ECON.jackpotShare} feeds the jackpot.
          </p>
          <p>
            Because each round only takes a small slice of what&apos;s there, the pool shrinks gently when
            fees are quiet instead of emptying out, and trading fees keep topping it back up.
          </p>
        </FaqItem>

        <FaqItem id="safety" q="What stops one lucky ticket from draining the pool?">
          <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-pink">
            <li>
              <strong>Prize cap.</strong> No single ticket prize can be more than {ECON.singlePrizeCap} of the
              pool at the start of the round. (The jackpot is paid from its own pot.)
            </li>
            <li>
              <strong>Round breaker.</strong> If a round&apos;s ticket payouts would ever add up to more than{' '}
              {ECON.breakerX} that round&apos;s budget, the rest of that round&apos;s payouts are held. When
              the round ends, every revealed prize is re-checked against the revealed seed: all good →
              released automatically; anything off → payouts stay stopped until a human looks.
            </li>
          </ul>
          <p>
            The breaker can also trip on a genuinely lucky streak when only a few tickets are in play.
            That&apos;s why a held win shows <strong>“safety check”</strong> and pays out right after the
            round ends.
          </p>
        </FaqItem>

        <FaqItem id="paused" q="What happens when the pool is low or payouts are paused?">
          <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-pink">
            <li>
              Payouts <strong>pause automatically</strong> if the prize pool drops below its reserve (about{' '}
              {ECON.minPoolReserve} worth of PUMP) or the prize wallet runs low on SOL for transaction fees
              (under {ECON.minGasSol} SOL). They resume on their own once it&apos;s topped back up.
            </li>
            <li>
              A round that would start below the reserve is skipped — no tickets drop until fees refill the
              pool.
            </li>
            <li>
              If a pause hits mid-round you can keep scratching.{' '}
              <strong>Wins queue up and pay out when payouts resume</strong> — nothing gets dropped.
            </li>
            <li>
              If price feeds go down, eligibility freezes at the last known price. Payouts keep going, because
              prizes are counted in PUMP, not dollars.
            </li>
          </ul>
          <p>The home page shows when payouts are paused and why.</p>
        </FaqItem>
      </FaqSection>

      <FaqSection id="fairness" kicker="check our work" title="Fairness">
        <FaqItem id="provably-fair" q="How do I know it’s fair?">
          <p>
            Every ticket is <strong>provably fair</strong> — commit, roll, reveal:
          </p>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 marker:font-display marker:text-gold">
            <li>
              Before a round, the server picks a secret random seed and publishes its fingerprint (a SHA-256
              hash). The seed can&apos;t be swapped afterwards without the fingerprint giving it away.
            </li>
            <li>
              Each ticket&apos;s result is computed from that seed plus your wallet, the round number and the
              ticket number, then mapped through the odds table above.
            </li>
            <li>
              When the round ends the seed is published. Anyone can hash it, compare it to the fingerprint and
              recompute every ticket.
            </li>
          </ol>
          <p>Losing tickets show symbols drawn from the same seed, too — no engineered near-misses.</p>
          <p>
            <Link href="/fair" className="btn-pink inline-block text-sm">
              Verify a round on the Fair page →
            </Link>
          </p>
        </FaqItem>

        <FaqItem id="theater" q="Does how I scratch change anything?">
          <p>
            Nope — <strong>the scratch is theater</strong>. Outcomes are pre-rolled the moment tickets drop;
            scratching only reveals what&apos;s already there, exactly like a paper scratch-off that was
            printed before it reached you. Fast, slow, one at a time or SCRATCH ALL — same result. (It&apos;s
            still extremely satisfying.)
          </p>
        </FaqItem>

        <FaqItem id="void" q="Can my tickets get voided?">
          <p>Two ways, both on purpose:</p>
          <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-pink">
            <li>
              <strong>Selling below your snapshot tier.</strong> Your tickets come from your $SCRATCHY at the
              drop. When you scratch, your balance is checked again — if you&apos;ve sold down into a lower{' '}
              {ECON.block} bracket since the drop, your remaining unscratched tickets for that round are void.
              That shuts down buy → scratch → sell farming.
            </li>
            <li>
              <strong>Expiry.</strong> Tickets you don&apos;t scratch before the next drop are void.
            </li>
          </ul>
          <p>
            <strong>Price dips never void anything</strong>: both balances are valued at the snapshot price,
            so only selling tokens counts. Wins you already revealed are yours.
          </p>
        </FaqItem>
      </FaqSection>

      <FaqSection id="payouts" kicker="getting paid" title="Payouts">
        <FaqItem id="paid" q="How and when do I get paid?">
          <p>
            <strong>Automatically.</strong> When a ticket wins, the PUMP is sent from the prize wallet to the
            wallet you pasted — no claim button, no human in the loop — usually within seconds. The win screen
            links the Solscan transaction, and every win lands on the{' '}
            <Link href="/winners" className={FAQ_LINK}>
              Winners
            </Link>{' '}
            page with its receipt.
          </p>
          <p>
            <strong>The PUMP amount is exact.</strong> The “~$” next to it is an estimate at PUMP&apos;s price
            when you revealed the ticket, and it drifts as PUMP&apos;s price moves. The PUMP you received
            doesn&apos;t change.
          </p>
        </FaqItem>

        <FaqItem id="straight-talk" q="Is winning guaranteed?">
          <p>
            No. It&apos;s a game funded by trading fees:{' '}
            <strong>{ECON.loseChance} of tickets are blanks</strong>, prize sizes rise and fall with trading
            volume, and PUMP&apos;s price moves on its own. Holding $SCRATCHY gets you tickets — it
            doesn&apos;t promise you anything. Scratch for fun.
          </p>
        </FaqItem>
      </FaqSection>

      <section className="panel flex flex-col items-center gap-4 px-5 py-6 text-center sm:flex-row sm:text-left">
        <Image
          src="/brand/mascot-head.png"
          alt=""
          width={512}
          height={512}
          sizes="72px"
          className="h-18 w-18 shrink-0 rounded-full ring-2 ring-gold/70"
        />
        <div className="flex-1">
          <p className="font-display text-2xl">Still curious?</p>
          <p className="text-sm text-muted">
            Ask us on X —{' '}
            <a
              href={`https://x.com/${X_HANDLE}`}
              target="_blank"
              rel="noreferrer noopener"
              className={FAQ_LINK}
            >
              @{X_HANDLE}
            </a>
            .
          </p>
        </div>
        <Link href="/" className="btn-gold">
          Go scratch
        </Link>
      </section>
    </div>
  )
}
