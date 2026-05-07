# CF-Mail

Just Simple One CF-Mail.

## 特性

- **单用户设计** - 专为个人使用，无需复杂的多用户管理
- **仅收件** - 不支持发件，简单纯粹
- **验证码提取** - 自动识别邮件中的验证码，一键复制
- **批量操作** - 支持批量标记已读、批量删除邮件
- **附件下载** - 邮件附件可直接下载
- **Telegram 推送** - 新邮件实时推送到 TG，验证码直接显示，自动获取ChatID
- **自动创建邮箱** - 在主页设置中打开开关后，无需进入到邮箱页面可收码，自动创建的邮箱可以批量删除
- **首次使用引导** - 第一次进入会提示先创建一个完整邮箱地址，后续域名自动进入下拉框
- **安全增强** - 默认密码强制修改、邮件 HTML 沙箱渲染、设置接口不再回显敏感密钥

## 展示

![alt text](<asset/image copy 12.png>)

![alt text](<asset/image copy 13.png>)

![alt text](<asset/image copy 14.png>)


## 部署

### 方式一：一键部署

点击按钮自动创建仓库并部署到 Cloudflare Workers：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lyon-le/cf-mail)

### 不要修改任何值，直接进行部署即可。

### 方式二：Fork 部署（推荐）

适合想要同步上游更新的用户。

**1. Fork 本仓库**

点击右上角 Fork 按钮，将仓库复制到你的 GitHub 账号下。

**2. 创建 Cloudflare Workers 项目**

1. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单选择 **Workers & Pages**
3. 点击 **Create** → **Pages** → **Continue with GitHub**
4. 选择你 Fork 的 `cf-mail` 仓库


![alt text](<asset/image copy 2.png>)


**3. 配置构建设置（非必须操作）**

- Framework preset: `None`
- Build command: `npm run build`
- Build output directory: `dist`

**4. 修改环境变量**

> ⚠️ **重要：部署后请立即修改默认值！**

部署后会自动配置默认环境变量，请在 **Settings** → **Variables and Secrets** 中修改：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `ADMIN_PASSWORD` | `Changeyourpasswordbeforeusingcfmail` | 初始登录密码，首次登录后会被强制要求修改 |

域名也不需要预先填写：
- Email Routing 的 **Catch-all** 指向这个 Worker 后，邮件就会正常投递
- 首次手动创建邮箱时，请直接输入完整地址（如 `test@example.com`）
- 创建成功后，这个域名会自动出现在后续创建邮箱的下拉框里
- 第一次进入后台时，界面也会给出这套引导

**5. 绑定 D1 数据库和 R2 存储（非必须操作）**

1. 创建 D1 数据库：**Workers & Pages** → **D1** → **Create**
2. 创建 R2 存储桶：**R2** → **Create bucket**
3. 在项目的 **Settings** → **Bindings** 中绑定：
   - D1 Database: 变量名 `DB`
   - R2 Bucket: 变量名 `R2`

**6. 部署**

保存配置后，点击 **Deployments** → **Retry deployment** 重新部署。

## 部署后配置

### 配置 Email Routing

1. 进入 Cloudflare Dashboard → 你的域名 → **Email** → **Email Routing**
2. 启用 Email Routing
3. 添加路由规则：
   - **Catch-all** → **Send to Worker** → 选择 `cf-mail`

![alt text](<asset/image copy 9.png>)

![alt text](<asset/image copy 10.png>)

![alt text](<asset/image copy 11.png>)

> 数据库表会在首次访问时自动创建，无需手动初始化。

### 配置 Telegram 推送（可选）

**1. 创建 Bot**

1. 打开 Telegram，搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示设置名称
3. 获取 `Bot Token`

![alt text](<asset/image copy 5.png>)

![alt text](<asset/image copy 7.png>)

**2. 获取 Chat ID**

1. **与你的 Bot 对话，发送任意消息**
2. 设置页面中填入你的Token
3. 自动获取ChatID，如果没获取到请手动访问：
  `https://api.telegram.org/bot<Token>/getUpdates`

**3. 配置变量**

在主页设置中打开开关：

![alt text](<asset/image copy 15.png>)

配置后，新邮件会自动推送到 Telegram：

![alt text](<asset/image copy 14.png>)

> 为了安全，已保存的 Bot Token 不会在设置页面回显；如需更换，直接输入新 Token 保存即可。

## 当前能力

- 登录 / 登出
- 邮箱创建 / 删除
- 邮件列表 / 详情 / 原始 EML 下载
- 附件下载
- 批量标记已读 / 批量删除
- 自动创建邮箱
- Telegram 通知

## 安全说明

- 首次若仍使用默认管理员密码，系统会强制要求先改密
- 邮件 HTML 内容会经过前端清洗，并在 `sandbox iframe` 中渲染
- 远程图片默认拦截，避免邮件追踪
- 设置接口不返回 `jwt_secret`、`admin_password_hash`、`tg_bot_token` 等敏感值

## 鸣谢

- [cloud-mail](https://github.com/maillab/cloud-mail) - Telegram 转发参考
- [freemail](https://github.com/idinging/freemail) - 验证码提取逻辑参考, 一键部署逻辑参考
- [LinuxDO](https://linux.do/) - 中文技术论坛

## License

MIT
