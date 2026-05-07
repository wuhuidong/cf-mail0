import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
  R2: R2Bucket
}

const message = new Hono<{ Bindings: Bindings }>()

function normalizeMessageIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []

  return [...new Set(value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
}

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

async function deleteMessagesByIds(env: Bindings, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0

  const placeholders = buildPlaceholders(ids.length)
  const existingMessages = await env.DB.prepare(
    `SELECT id, r2_key
     FROM messages
     WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: number; r2_key: string }>()

  const existingIds = (existingMessages.results || []).map((row) => Number(row.id)).filter(Boolean)
  if (existingIds.length === 0) return 0

  const existingPlaceholders = buildPlaceholders(existingIds.length)
  const attachments = await env.DB.prepare(
    `SELECT a.hash,
            a.r2_key,
            COUNT(*) as total_ref_count,
            SUM(CASE WHEN a.message_id IN (${existingPlaceholders}) THEN 1 ELSE 0 END) as deleting_ref_count
     FROM attachments a
     WHERE a.hash IN (
       SELECT DISTINCT hash
       FROM attachments
       WHERE message_id IN (${existingPlaceholders})
     )
     GROUP BY a.hash, a.r2_key`
  )
    .bind(...existingIds, ...existingIds)
    .all<{ hash: string; r2_key: string; total_ref_count: number; deleting_ref_count: number }>()

  await env.DB.prepare(`DELETE FROM messages WHERE id IN (${existingPlaceholders})`).bind(...existingIds).run()

  for (const row of existingMessages.results || []) {
    await env.R2.delete(row.r2_key as string)
  }

  for (const att of attachments.results || []) {
    if (Number(att.total_ref_count) === Number(att.deleting_ref_count)) {
      await env.R2.delete(att.r2_key as string)
    }
  }

  return existingIds.length
}

// GET /api/mailboxes/:mailboxId/messages - 邮件列表
message.get('/mailboxes/:mailboxId/messages', async (c) => {
  const mailboxId = c.req.param('mailboxId')

  // 验证邮箱存在
  const mailboxRow = await c.env.DB.prepare('SELECT id FROM mailboxes WHERE id = ?')
    .bind(mailboxId)
    .first()

  if (!mailboxRow) {
    return c.json({ error: 'Mailbox not found' }, 404)
  }

  const result = await c.env.DB.prepare(
    `SELECT id, sender, subject, preview, verification_code, received_at, is_read
     FROM messages
     WHERE mailbox_id = ?
     ORDER BY received_at DESC`
  )
    .bind(mailboxId)
    .all()

  return c.json({ messages: result.results })
})

// POST /api/messages/batch-read - 批量标记已读
message.post('/messages/batch-read', async (c) => {
  const body = await c.req.json<{ ids?: unknown }>()
  const ids = normalizeMessageIds(body.ids)

  if (ids.length === 0) {
    return c.json({ error: 'No messages selected' }, 400)
  }

  const placeholders = buildPlaceholders(ids.length)
  const result = await c.env.DB.prepare(`UPDATE messages SET is_read = 1 WHERE id IN (${placeholders})`).bind(...ids).run()

  return c.json({ success: true, updated: result.meta.changes })
})

// POST /api/messages/batch-delete - 批量删除
message.post('/messages/batch-delete', async (c) => {
  const body = await c.req.json<{ ids?: unknown }>()
  const ids = normalizeMessageIds(body.ids)

  if (ids.length === 0) {
    return c.json({ error: 'No messages selected' }, 400)
  }

  const deleted = await deleteMessagesByIds(c.env, ids)
  return c.json({ success: true, deleted })
})

// GET /api/attachments/:id - 下载附件
message.get('/attachments/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT filename, content_type, r2_key FROM attachments WHERE id = ?').bind(id).first<{
    filename: string
    content_type: string | null
    r2_key: string
  }>()

  if (!row) {
    return c.json({ error: 'Attachment not found' }, 404)
  }

  const object = await c.env.R2.get(row.r2_key)
  if (!object) {
    return c.json({ error: 'Attachment file not found' }, 404)
  }

  const encodedFilename = encodeURIComponent(row.filename)
  const safeFilename = row.filename.replace(/"/g, '')
  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
    },
  })
})

// GET /api/messages/:id - 邮件详情
message.get('/messages/:id', async (c) => {
  const id = c.req.param('id')

  const row = await c.env.DB.prepare(
    `SELECT m.id, m.mailbox_id, m.sender, m.subject, m.preview, m.verification_code,
            m.text_content, m.html_content, m.r2_key, m.received_at, m.is_read, mb.address as mailbox_address
     FROM messages m
     JOIN mailboxes mb ON m.mailbox_id = mb.id
     WHERE m.id = ?`
  )
    .bind(id)
    .first()

  if (!row) {
    return c.json({ error: 'Message not found' }, 404)
  }

  // 获取附件列表
  const attachments = await c.env.DB.prepare(
    'SELECT id, filename, content_type, size, hash FROM attachments WHERE message_id = ?'
  )
    .bind(id)
    .all()

  let htmlContent = String((row as { html_content?: string | null }).html_content || '')
  let textContent = String((row as { text_content?: string | null }).text_content || '')

  if (!htmlContent && !textContent) {
    const emlObject = await c.env.R2.get(row.r2_key as string)
    if (emlObject) {
      const emlText = await emlObject.text()

      const { parseEmail } = await import('../services/parser')
      const parsed = parseEmail(emlText)

      htmlContent = parsed.html || ''
      textContent = parsed.text || ''

      await c.env.DB.prepare('UPDATE messages SET text_content = ?, html_content = ? WHERE id = ?')
        .bind(textContent, htmlContent, id)
        .run()
    }
  }

  // 标记为已读
  if (!row.is_read) {
    await c.env.DB.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(id).run()
  }

  return c.json({
    message: {
      id: row.id,
      mailbox_id: row.mailbox_id,
      sender: row.sender,
      subject: row.subject,
      preview: row.preview,
      verification_code: row.verification_code,
      r2_key: row.r2_key,
      received_at: row.received_at,
      is_read: row.is_read,
      mailbox_address: row.mailbox_address,
      html: htmlContent,
      text: textContent,
      attachments: attachments.results,
    },
  })
})

// GET /api/messages/:id/raw - 原始 EML
message.get('/messages/:id/raw', async (c) => {
  const id = c.req.param('id')

  const row = await c.env.DB.prepare('SELECT r2_key FROM messages WHERE id = ?').bind(id).first()

  if (!row) {
    return c.json({ error: 'Message not found' }, 404)
  }

  const emlObject = await c.env.R2.get(row.r2_key as string)

  if (!emlObject) {
    return c.json({ error: 'EML file not found' }, 404)
  }

  return new Response(emlObject.body, {
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename="message-${id}.eml"`,
    },
  })
})

// DELETE /api/messages/:id - 删除邮件
message.delete('/messages/:id', async (c) => {
  const id = c.req.param('id')

  const row = await c.env.DB.prepare('SELECT r2_key FROM messages WHERE id = ?').bind(id).first()

  if (!row) {
    return c.json({ error: 'Message not found' }, 404)
  }

  await deleteMessagesByIds(c.env, [Number(id)])

  return c.json({ success: true })
})

export { message }
