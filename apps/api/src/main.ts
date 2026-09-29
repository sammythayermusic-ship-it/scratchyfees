import { buildApp } from './app'
import { loadConfig } from './env'

const config = loadConfig()
const app = await buildApp(config)
await app.listen({ host: config.env.HOST, port: config.env.PORT })

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    app.log.info({ sig }, 'shutting down')
    void app.close().then(() => process.exit(0))
  })
}
