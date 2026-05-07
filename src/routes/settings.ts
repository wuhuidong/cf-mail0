import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const settings = new Hono<{ Bindings: Bindings }>()
const EDITABLE_KEYS = new Set([
  'auto_create_enabled',
  'auto_create_min_length',
  'auto_create_max_length',
  'auto_create_start_type',
  'tg_chat_id',
  'tg_topic_id',
])

// GET /api/settings - 获取所有配置
settings.get('/settings', async (c) => {
  const result = await c.env.DB
    .prepare(
      `SELECT key, value
       FROM settings
       WHERE key IN (
         'auto_create_enabled',
         'auto_create_min_length',
         'auto_create_max_length',
         'auto_create_start_type',
         'tg_bot_token',
         'tg_chat_id',
         'tg_topic_id'
       )`
    )
    .all()

  const rawConfig: Record<string, string> = {}
  for (const row of result.results as { key: string; value: string }[]) {
    rawConfig[row.key] = row.value
  }

  return c.json({
    settings: {
      auto_create_enabled: rawConfig.auto_create_enabled || 'false',
      auto_create_min_length: rawConfig.auto_create_min_length || '6',
      auto_create_max_length: rawConfig.auto_create_max_length || '20',
      auto_create_start_type: rawConfig.auto_create_start_type || 'both',
      tg_bot_token: '',
      tg_bot_token_configured: !!rawConfig.tg_bot_token,
      tg_chat_id: rawConfig.tg_chat_id || '',
      tg_topic_id: rawConfig.tg_topic_id || '',
    },
  })
})

// PUT /api/settings - 更新配置
settings.put('/settings', async (c) => {
  const body = await c.req.json<Record<string, string | boolean>>()

  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_KEYS.has(key) || typeof value !== 'string') continue
    await c.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run()
  }

  if (typeof body.tg_bot_token === 'string' && body.tg_bot_token.trim()) {
    await c.env.DB
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('tg_bot_token', body.tg_bot_token.trim())
      .run()
  }

  if (body.clear_tg_bot_token === true) {
    await c.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('tg_bot_token', '').run()
  }

  return c.json({ success: true })
})

export { settings }
