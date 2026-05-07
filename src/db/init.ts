/**
 * 数据库初始化
 * 首次访问时自动创建表结构
 */

let initialized = false
let jwtSecret: string | null = null

function generateJwtSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function ensureDefaultSettings(db: D1Database): Promise<void> {
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_create_enabled', 'false');")
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_create_min_length', '6');")
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_create_max_length', '20');")
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_create_start_type', 'both');")
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('tg_bot_token', '');")
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('tg_chat_id', '');")
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('tg_topic_id', '');")
  await getJwtSecret(db)
}

async function addColumnIfMissing(db: D1Database, table: string, columnDefinition: string): Promise<void> {
  const columnName = columnDefinition.trim().split(/\s+/)[0]
  const columns = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()
  const hasColumn = (columns.results || []).some((column) => column.name === columnName)
  if (hasColumn) {
    return
  }

  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`).run()
  } catch (error: any) {
    const message = String(error?.message || error || '')
    if (
      message.includes('duplicate column name') ||
      message.includes('already exists') ||
      message.includes('Duplicate column name')
    ) {
      return
    }
    throw error
  }
}

async function ensureSchemaUpgrades(db: D1Database): Promise<void> {
  await addColumnIfMissing(db, 'mailboxes', 'is_auto_created INTEGER DEFAULT 0')
  await addColumnIfMissing(db, 'messages', 'text_content TEXT')
  await addColumnIfMissing(db, 'messages', 'html_content TEXT')
}

export async function getJwtSecret(db: D1Database): Promise<string> {
  if (jwtSecret) return jwtSecret

  const existing = await db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").first<{ value: string }>()
  if (existing?.value) {
    jwtSecret = existing.value
    return existing.value
  }

  const generated = generateJwtSecret()
  await db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind('jwt_secret', generated).run()

  const persisted = await db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").first<{ value: string }>()
  if (!persisted?.value) {
    throw new Error('Failed to initialize jwt_secret')
  }

  jwtSecret = persisted.value
  return persisted.value
}

export async function initDatabase(db: D1Database): Promise<void> {
  if (initialized) return

  try {
    try {
      await db.prepare('SELECT 1 FROM mailboxes LIMIT 1').all()
      await db.prepare('SELECT 1 FROM messages LIMIT 1').all()
      await db.prepare('SELECT 1 FROM attachments LIMIT 1').all()
      await db.prepare('SELECT 1 FROM settings LIMIT 1').all()
      await ensureSchemaUpgrades(db)
      await ensureDefaultSettings(db)
      initialized = true
      return
    } catch {
      console.log('Initializing database...')
    }

    await db.exec("CREATE TABLE IF NOT EXISTS mailboxes (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, local_part TEXT NOT NULL, domain TEXT NOT NULL, is_auto_created INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);")
    await db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, mailbox_id INTEGER NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL, preview TEXT, verification_code TEXT, text_content TEXT, html_content TEXT, r2_key TEXT NOT NULL, received_at TEXT DEFAULT CURRENT_TIMESTAMP, is_read INTEGER DEFAULT 0, FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE);")
    await db.exec("CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, filename TEXT NOT NULL, content_type TEXT, size INTEGER, hash TEXT NOT NULL, r2_key TEXT NOT NULL, FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE);")
    await db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")

    await db.exec("CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address);")
    await db.exec("CREATE INDEX IF NOT EXISTS idx_messages_mailbox_id ON messages(mailbox_id);")
    await db.exec("CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at DESC);")
    await db.exec("CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(hash);")
    await db.exec("CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);")

    await ensureSchemaUpgrades(db)
    await ensureDefaultSettings(db)

    console.log('Database initialized')
    initialized = true
  } catch (error) {
    console.error('Database init error:', error)
    throw error
  }
}
