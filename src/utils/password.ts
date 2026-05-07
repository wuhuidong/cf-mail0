const encoder = new TextEncoder()

export const DEFAULT_ADMIN_PASSWORD = 'Changeyourpasswordbeforeusingcfmail'
const PASSWORD_HASH_KEY = 'admin_password_hash'
const PBKDF2_ITERATIONS = 100000

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false

  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i]
  }
  return result === 0
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    key,
    256
  )

  return new Uint8Array(bits)
}

export function validateNewPassword(password: string): string | null {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters'
  }
  if (password.length > 128) {
    return 'Password must be at most 128 characters'
  }
  return null
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterationsValue, saltB64, hashB64] = storedHash.split('$')
  if (algorithm !== 'pbkdf2' || !iterationsValue || !saltB64 || !hashB64) {
    return false
  }

  const iterations = parseInt(iterationsValue, 10)
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false
  }

  const salt = base64ToBytes(saltB64)
  const expectedHash = base64ToBytes(hashB64)
  const actualHash = await derivePasswordHash(password, salt, iterations)
  return constantTimeEqual(actualHash, expectedHash)
}

export async function getStoredPasswordHash(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(PASSWORD_HASH_KEY).first<{ value: string }>()
  return row?.value || null
}

export async function verifyAdminPassword(
  db: D1Database,
  envPassword: string,
  password: string
): Promise<boolean> {
  const storedHash = await getStoredPasswordHash(db)
  if (storedHash) {
    return verifyPassword(password, storedHash)
  }

  return password === envPassword
}

export async function isUsingDefaultAdminPassword(db: D1Database, envPassword: string): Promise<boolean> {
  const storedHash = await getStoredPasswordHash(db)
  return !storedHash && envPassword === DEFAULT_ADMIN_PASSWORD
}

export async function setAdminPassword(db: D1Database, password: string): Promise<void> {
  const hashed = await hashPassword(password)
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(PASSWORD_HASH_KEY, hashed).run()
}
