import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
  R2: R2Bucket
}

const mailbox = new Hono<{ Bindings: Bindings }>()

// 生成随机地址
function generateRandomAddress(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// GET /api/config - 获取配置信息
mailbox.get('/config', async (c) => {
  const result = await c.env.DB.prepare('SELECT DISTINCT domain FROM mailboxes ORDER BY domain ASC').all<{ domain: string }>()
  const domains = (result.results || []).map((row) => row.domain).filter(Boolean)
  return c.json({ domains })
})

// GET /api/mailboxes - 列表
mailbox.get('/mailboxes', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT m.id, m.address, m.local_part, m.domain, m.is_auto_created, m.created_at,
            MAX(msg.received_at) as last_message_at,
            COUNT(msg.id) as message_count,
            SUM(CASE WHEN msg.is_read = 0 THEN 1 ELSE 0 END) as unread_count
     FROM mailboxes m
     LEFT JOIN messages msg ON msg.mailbox_id = m.id
     GROUP BY m.id
     ORDER BY last_message_at DESC NULLS LAST, m.created_at DESC`
  ).all()

  return c.json({ mailboxes: result.results })
})

// POST /api/mailboxes - 创建
mailbox.post('/mailboxes', async (c) => {
  const body = await c.req.json<{ address?: string; domain?: string }>()

  let localPart: string
  let domain: string

  if (body.address) {
    const normalized = body.address.toLowerCase().trim()

    if (normalized.includes('@')) {
      const parts = normalized.split('@')
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return c.json({ error: 'Invalid address format' }, 400)
      }
      localPart = parts[0]
      domain = parts[1]
    } else {
      localPart = normalized
      domain = body.domain?.toLowerCase().trim() || ''
      if (!domain) {
        return c.json({ error: 'Domain is required' }, 400)
      }
    }

    if (!/^[a-z0-9._-]+$/.test(localPart) || !/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.')) {
      return c.json({ error: 'Invalid address format' }, 400)
    }
  } else {
    domain = body.domain?.toLowerCase().trim() || ''
    if (!domain || !/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.')) {
      return c.json({ error: 'Domain is required' }, 400)
    }
    localPart = generateRandomAddress()
  }

  const fullAddress = `${localPart}@${domain}`

  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO mailboxes (address, local_part, domain) VALUES (?, ?, ?) RETURNING id, address, local_part, domain, created_at'
    )
      .bind(fullAddress, localPart, domain)
      .first()

    return c.json({ mailbox: result }, 201)
  } catch (e: any) {
    if (e.message?.includes('UNIQUE constraint')) {
      return c.json({ error: 'Address already exists' }, 409)
    }
    throw e
  }
})

// DELETE /api/mailboxes/:id - 删除
mailbox.delete('/mailboxes/:id', async (c) => {
  const id = c.req.param('id')

  // 先查询邮箱是否存在
  const mailboxRow = await c.env.DB.prepare('SELECT id FROM mailboxes WHERE id = ?').bind(id).first()

  if (!mailboxRow) {
    return c.json({ error: 'Mailbox not found' }, 404)
  }

  // 获取所有邮件的 R2 keys
  const messages = await c.env.DB.prepare('SELECT r2_key FROM messages WHERE mailbox_id = ?').bind(id).all()

  // 获取附件（检查引用计数）
  const attachments = await c.env.DB.prepare(
    `SELECT a.hash, a.r2_key, (SELECT COUNT(*) FROM attachments WHERE hash = a.hash) as ref_count
     FROM attachments a
     WHERE a.message_id IN (SELECT id FROM messages WHERE mailbox_id = ?)
     GROUP BY a.hash`
  ).bind(id).all()

  // 删除邮箱（关联的 messages 和 attachments 会级联删除）
  await c.env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(id).run()

  // 清理 R2 中的 EML 文件
  for (const msg of messages.results || []) {
    await c.env.R2.delete(msg.r2_key as string)
  }

  // 清理不再被引用的附件
  for (const att of attachments.results || []) {
    if ((att.ref_count as number) === 1) {
      await c.env.R2.delete(att.r2_key as string)
    }
  }

  return c.json({ success: true })
})

// DELETE /api/mailboxes/auto-created - 批量删除自动创建的邮箱
mailbox.delete('/mailboxes-auto-created', async (c) => {
  // 获取所有自动创建邮箱的 ID
  const mailboxIds = await c.env.DB.prepare('SELECT id FROM mailboxes WHERE is_auto_created = 1').all()
  const ids = (mailboxIds.results || []).map((r) => r.id as number)

  if (ids.length === 0) {
    return c.json({ success: true, deleted: 0 })
  }

  const idList = ids.join(',')

  // 获取所有邮件的 R2 keys
  const messages = await c.env.DB.prepare(`SELECT r2_key FROM messages WHERE mailbox_id IN (${idList})`).all()

  // 获取附件（检查引用计数）
  const attachments = await c.env.DB.prepare(
    `SELECT a.hash, a.r2_key, (SELECT COUNT(*) FROM attachments WHERE hash = a.hash) as ref_count
     FROM attachments a
     WHERE a.message_id IN (SELECT id FROM messages WHERE mailbox_id IN (${idList}))
     GROUP BY a.hash`
  ).all()

  // 删除数据库记录
  const result = await c.env.DB.prepare('DELETE FROM mailboxes WHERE is_auto_created = 1').run()

  // 清理 R2
  for (const msg of messages.results || []) {
    await c.env.R2.delete(msg.r2_key as string)
  }
  for (const att of attachments.results || []) {
    if ((att.ref_count as number) <= ids.length) {
      await c.env.R2.delete(att.r2_key as string)
    }
  }

  return c.json({ success: true, deleted: result.meta.changes })
})

export { mailbox }
