import { buildApp } from './app'
import { loadConfig } from './env'
import { buildServices } from './services'

const config = loadConfig()
const services = await buildServices(config)
const app = await buildApp(services)
await app.listen({ host: config.env.HOST, port: config.env.PORT })
services.start()
app.log.info(
  {
    cluster: config.env.CHAIN_MODE === 'memory' ? 'memory' : config.env.SOLANA_CLUSTER,
    prize: services.prizeAddress,
  },
  'scratchy api up',
)

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    if (stopping) return
    stopping = true
    app.log.info({ sig }, 'shutting down')
    void (async () => {
      await app.close()
      await services.stop()
      process.exit(0)
    })()
  })
}
