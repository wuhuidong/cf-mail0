import { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { jwt } from '../utils/jwt'
import { getJwtSecret } from '../db/init'
import { isUsingDefaultAdminPassword } from '../utils/password'

const PUBLIC_PATHS = ['/api/login', '/api/health', '/api/config', '/api/session']
const ALLOWED_WHEN_PASSWORD_CHANGE = new Set([...PUBLIC_PATHS, '/api/logout', '/api/change-password'])

export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname

  if (PUBLIC_PATHS.includes(path)) {
    return next()
  }

  if (!path.startsWith('/api/')) {
    return next()
  }

  const token = getCookie(c, 'token')
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const secret = await getJwtSecret(c.env.DB)
  const payload = await jwt.verify(token, secret)
  if (!payload) {
    return c.json({ error: 'Invalid token' }, 401)
  }

  const mustChangePassword = await isUsingDefaultAdminPassword(c.env.DB, c.env.ADMIN_PASSWORD)
  if (mustChangePassword && !ALLOWED_WHEN_PASSWORD_CHANGE.has(path)) {
    return c.json({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' }, 403)
  }

  return next()
}
