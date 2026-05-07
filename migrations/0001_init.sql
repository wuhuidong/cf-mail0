-- 邮箱表
CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    local_part TEXT NOT NULL,
    domain TEXT NOT NULL,
    is_auto_created INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 邮件表
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    preview TEXT,
    verification_code TEXT,
    text_content TEXT,
    html_content TEXT,
    r2_key TEXT NOT NULL,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP,
    is_read INTEGER DEFAULT 0,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

-- 附件表
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size INTEGER,
    hash TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- 设置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_id ON messages(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(hash);
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
