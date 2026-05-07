import { Hono } from 'hono'
import { authMiddleware } from './middleware/auth'
import { auth } from './routes/auth'
import { mailbox } from './routes/mailbox'
import { message } from './routes/message'
import { settings } from './routes/settings'
import { handleEmail } from './services/email'
import { initDatabase } from './db/init'

type Bindings = {
  DB: D1Database
  R2: R2Bucket
  ADMIN_PASSWORD: string
  TG_BOT_TOKEN?: string
  TG_CHAT_ID?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (c, next) => {
  await initDatabase(c.env.DB)
  return next()
})

app.use('*', authMiddleware)

app.get('/api/health', (c) => c.json({ status: 'ok' }))
app.route('/api', auth)
app.route('/api', mailbox)
app.route('/api', message)
app.route('/api', settings)

export default {
  fetch: app.fetch,

  async email(message: EmailMessage, env: Bindings, ctx: ExecutionContext) {
    console.log(`Received email from: ${message.from} to: ${message.to}`)

    try {
      await initDatabase(env.DB)
      await handleEmail(message, env)
    } catch (error) {
      console.error('Failed to handle email:', error)
      message.setReject('Internal error')
    }
  },
}
