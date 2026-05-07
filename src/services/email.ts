/**
 * Email Workers 收件处理
 */

import { parseEmail, Attachment } from './parser'
import { extractVerificationCode } from './verification'

const MAX_EMAIL_SIZE = 25 * 1024 * 1024 // 25MB

interface Env {
  DB: D1Database
  R2: R2Bucket
  TG_BOT_TOKEN?: string
  TG_CHAT_ID?: string
}

// 计算文件哈希（用于附件去重）
async function hashContent(content: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', content)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 生成 R2 存储路径
function generateR2Key(prefix: string, mailbox: string): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const timestamp = now.getTime()
  const uuid = crypto.randomUUID()

  return `${prefix}/${y}/${m}/${d}/${mailbox}/${timestamp}-${uuid}`
}

// 获取文件扩展名
function getExtension(filename: string, contentType: string): string {
  const extMatch = filename.match(/\.([^.]+)$/)
  if (extMatch) return extMatch[1].toLowerCase()

  // 根据 MIME 类型推断
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'text/plain': 'txt',
  }
  return mimeMap[contentType] || 'bin'
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 尝试自动创建邮箱
async function tryAutoCreateMailbox(db: D1Database, address: string): Promise<{ id: number } | null> {
  // 读取配置
  const settings = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'auto_create_%'").all()
  const config: Record<string, string> = {}
  for (const row of settings.results as { key: string; value: string }[]) {
    config[row.key] = row.value
  }
  console.log('Auto-create config:', JSON.stringify(config))

  if (config.auto_create_enabled !== 'true') return null

  const [localPart, domain] = address.split('@')
  if (!localPart || !domain) return null

  const minLen = parseInt(config.auto_create_min_length || '6')
  const maxLen = parseInt(config.auto_create_max_length || '20')
  const startType = config.auto_create_start_type || 'both'

  // 校验长度
  if (localPart.length < minLen || localPart.length > maxLen) return null

  // 校验开头字符
  const firstChar = localPart[0]
  const isLetter = /^[a-z]$/i.test(firstChar)
  const isDigit = /^[0-9]$/.test(firstChar)
  if (startType === 'letter' && !isLetter) return null
  if (startType === 'digit' && !isDigit) return null
  if (startType === 'both' && !isLetter && !isDigit) return null

  // 创建邮箱
  try {
    const result = await db.prepare(
      'INSERT INTO mailboxes (address, local_part, domain, is_auto_created) VALUES (?, ?, ?, 1) RETURNING id'
    ).bind(address, localPart, domain).first<{ id: number }>()
    console.log(`Auto-created mailbox: ${address}`)
    return result
  } catch (e) {
    console.log(`Auto-create failed for ${address}:`, e)
    return null
  }
}

// 生成预览文本
function generatePreview(text: string, html: string): string {
  let content = text || html
  // 移除 HTML 标签
  content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  // 截取前 120 字符
  return content.length > 120 ? content.substring(0, 120) + '...' : content
}

export async function handleEmail(
  message: EmailMessage,
  env: Env
): Promise<void> {
  // 检查邮件大小
  if (message.rawSize > MAX_EMAIL_SIZE) {
    console.log(`Email too large: ${message.rawSize} bytes, rejecting`)
    message.setReject('Message too large')
    return
  }

  const toAddress = message.to.toLowerCase()

  // 检查收件邮箱是否存在
  let mailboxRow = await env.DB.prepare('SELECT id FROM mailboxes WHERE address = ?')
    .bind(toAddress)
    .first<{ id: number }>()

  if (!mailboxRow) {
    // 尝试自动创建邮箱
    mailboxRow = await tryAutoCreateMailbox(env.DB, toAddress)
    if (!mailboxRow) {
      console.log(`Mailbox not found: ${toAddress}, rejecting`)
      message.setReject('Mailbox not found')
      return
    }
  }

  // 读取原始邮件内容
  const rawEmail = await new Response(message.raw).text()

  // 解析邮件
  const parsed = parseEmail(rawEmail)

  // 提取验证码
  const verificationCode = extractVerificationCode(parsed.subject, parsed.text, parsed.html)

  // 生成预览
  const preview = generatePreview(parsed.text, parsed.html)

  // 存储 EML 到 R2
  const emlKey = generateR2Key('eml', toAddress) + '.eml'
  await env.R2.put(emlKey, rawEmail)

  // 插入邮件记录
  const messageResult = await env.DB.prepare(
    `INSERT INTO messages (mailbox_id, sender, subject, preview, verification_code, text_content, html_content, r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  )
    .bind(mailboxRow.id, parsed.from, parsed.subject, preview, verificationCode, parsed.text || '', parsed.html || '', emlKey)
    .first<{ id: number }>()

  if (!messageResult) {
    throw new Error('Failed to insert message')
  }

  const messageId = messageResult.id

  // 处理附件（带去重）
  for (const att of parsed.attachments) {
    await saveAttachment(env, messageId, att)
  }

  console.log(`Email saved: ${parsed.subject} (code: ${verificationCode || 'none'})`)

  // TG 推送通知 - 从数据库读取配置
  const tgConfig = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('tg_bot_token', 'tg_chat_id', 'tg_topic_id')").all()
  const tgSettings: Record<string, string> = {}
  for (const row of tgConfig.results as { key: string; value: string }[]) {
    tgSettings[row.key] = row.value
  }
  if (tgSettings.tg_bot_token && tgSettings.tg_chat_id) {
    await sendTelegramNotification(tgSettings.tg_bot_token, tgSettings.tg_chat_id, tgSettings.tg_topic_id, {
      from: parsed.from,
      to: toAddress,
      subject: parsed.subject,
      preview,
      verificationCode,
    })
  }
}

// TG 推送通知
async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  topicId: string | undefined,
  email: {
    from: string
    to: string
    subject: string
    preview: string
    verificationCode: string | null
  }
): Promise<void> {
  try {
    const codeText = email.verificationCode ? `\n验证码: <code>${escapeHtml(email.verificationCode)}</code>` : ''
    const text = `新邮件

发件人: ${escapeHtml(email.from)}
收件人: ${escapeHtml(email.to)}
主题: ${escapeHtml(email.subject)}${codeText}

${escapeHtml(email.preview)}`

    const body: { chat_id: string; text: string; parse_mode: string; message_thread_id?: number } = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }
    if (topicId) body.message_thread_id = parseInt(topicId)

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      console.error(`TG 推送失败: ${res.status}`)
    }
  } catch (e) {
    console.error('TG 推送异常:', e)
  }
}

// 保存附件（带去重逻辑）
async function saveAttachment(
  env: Env,
  messageId: number,
  attachment: Attachment
): Promise<void> {
  const hash = await hashContent(attachment.content)
  const ext = getExtension(attachment.filename, attachment.contentType)
  const r2Key = `attachments/${hash}.${ext}`

  // 检查是否已存在相同哈希的附件
  const existing = await env.DB.prepare('SELECT id FROM attachments WHERE hash = ?')
    .bind(hash)
    .first()

  // 如果不存在，上传到 R2
  if (!existing) {
    await env.R2.put(r2Key, attachment.content, {
      httpMetadata: { contentType: attachment.contentType },
    })
  }

  // 插入附件记录（即使 R2 文件已存在，也要建立关联）
  await env.DB.prepare(
    `INSERT INTO attachments (message_id, filename, content_type, size, hash, r2_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(messageId, attachment.filename, attachment.contentType, attachment.content.length, hash, r2Key)
    .run()
}
