# dsh-pet-assistant · 桌宠助手

给 [dsh-pet](https://www.npmjs.com/package/dsh-pet) 加一个**桌面小卡片**：右键宠物 →「进入会话」，
就能看历史、继续聊、框选截图提问、新建工作区、归档会话、收下我发你的文件。

不需要打开 DeepSeek Harness 主窗口——卡片本身就是个轻量会话端。

> ⚠️ **依赖**：必须先安装 `dsh-pet`（菜单入口由它提供）。
>
> ⚠️ **会改动 dsh-pet**：本插件会把 **2 行**补丁写进 dsh-pet 的菜单组装处
> （`lib/client.js` 与 `runtime/electron-helper/sprite.js`），目的是让菜单项出现在**一级菜单**
> 而不是「更多」子菜单里。补丁带 `[dsh-pet-assistant]` 标记、**幂等**、**可还原**，
> 不改 dsh-pet 的其他任何逻辑；dsh-pet 升级后补丁会每 30 秒自动补回。
> 介意这一点的话请不要安装。

## 它长什么样

```
右键桌面宠物
   ↓
   ┌ 桌宠助手 ──────────────── ×
   │ 选择会话
   │ ● 优化桌宠为快捷会话入口讨论   dsh-pet
   │ ○ 问候                     宠物
   │ [＋ 新建工作区]  [显示已归档]
   └
   ↓ 点一条
   ┌ 桌宠助手 ‹ 优化桌宠为… ─── ×
   │ 你：xxx
   │ 助手：……
   │ ── 以上是历史 · 继续聊吧 ──
   │ [缩略图]
   │ [想说什么…（Enter 发送）]
   │ [截图]          [关闭] [发送]
   └
```

## 功能

| 功能 | 说明 |
|---|---|
| 进入会话 | 列出会话（和侧边栏一致：不显示空白/子会话/已归档），带运行中绿点 |
| 看历史 | 最近 60 条用户/助手消息；图片**点了才加载**，点开可滚轮缩放看大图 |
| 继续聊 | Enter 发送、Shift+Enter 换行；回答回流到同一张卡，带已等待时长和进度片段 |
| 框选截图 | 点「截图」→ 卡片消失 → 全屏冻结 → 拖框 → 右键/回车确认；卡片只显示小缩略图 |
| 新建工作区 | 选一个目录 → 注册成工作区（侧边栏会出现同名分组）+ 建一条会话 |
| 归档 | 会话行悬停出现「归档」；「显示已归档」里可以取消归档 |
| 文件 | 回答里提到的真实文件列出来，可「保存到…」（系统另存为框）或「文件夹」定位 |
| 调大小 | 右下角小把手拖拽；手动调过之后不再自动改尺寸 |

## 依赖

- **dsh-pet** 必须已安装（菜单项是通过它的第三方菜单注册表挂上去的）
- Electron 可执行文件：`~/.dsh/electron/electron.exe`（dsh-pet 也会下载这一份）

插件本身**零运行时依赖**，只 import Node 内置模块。

## 安装

```powershell
# 方式一：本地目录
pnpm dsh plugin install <本目录路径>

# 方式二：打包后的 tgz
pnpm pack
pnpm dsh plugin install ./dsh-pet-assistant-0.1.0.tgz
```

装完**重启一次 DeepSeek Harness**，然后右键宠物，菜单里会多出「进入会话」。

## 它动过 dsh-pet 的哪里

只有两处，都是为了让菜单项出现在**一级菜单**而不是「更多」子菜单里：

| 文件 | 改动 |
|---|---|
| `lib/client.js`（网页端菜单） | 把 `owner === 'dsh-pet-assistant'` 的项摊平到一级 |
| `runtime/electron-helper/sprite.js`（桌面端菜单） | 同上 |

- 改动带 `[dsh-pet-assistant]` 标记，**幂等**：已打过就跳过
- 插件每 30 秒自检一次，dsh-pet 升级/重装后补丁会自动补回来
- 找不到锚点就只打日志，功能仍然可用（菜单项退回到「更多」里）

## 接口（本地 HTTP，挂在 `webServer` 的 `/pet-assist` 前缀下）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/sessions?archived=1` | 会话列表（可选包含已归档） |
| GET | `/history?sessionId=&max=` | 最近若干条历史消息 |
| GET | `/attachment?sessionId=&id=` | 按需取一张历史图片 |
| POST | `/submit` | 提交（文字 + 可选 dataURL 图片）到会话 |
| GET | `/answer?sessionId=&since=` | 取这一轮的回答 / 等待进度 |
| POST | `/new-session` | 注册工作区 + 建会话 |
| POST | `/archive` | 归档 / 取消归档 |
| POST | `/files` | 从回答文本里认出真实存在的文件 |
| POST | `/capture` | （旧路径）抓一张整屏，卡片里框选，已被桌面选区取代 |

## 排查

- 菜单没出现：看 dsh-pet 是否在跑；插件每 30 秒重注册一次菜单
- 点「进入会话」没反应：看 `~/.dsh/dsh-pet-assistant/card.log`（把 `lib/index.js` 里
  `CARD_LOG_ENABLED` 和 `lib/helper/main.js` 里 `LOG_ENABLED` 改成 `true` 才会写）
- 卡片位置怪：卡片按"点菜单时的鼠标位置"定位，鼠标离屏幕边缘太近会被夹进工作区
- Electron 相关：这台机器上 `electron.exe app.js --任意参数` 会让 Chromium 初始化崩溃，
  所以所有参数都走环境变量传，命令行只给 app 路径

## 卸载

```powershell
pnpm dsh plugin remove dsh-pet-assistant
```

菜单补丁是 dsh-pet 里的几行，卸载后不影响 dsh-pet 运行（只是它会把这几行当成普通代码）。
要彻底还原 dsh-pet，重装一次 dsh-pet 即可（补丁不会自动重打，除非插件还在）。

## 许可

MIT
