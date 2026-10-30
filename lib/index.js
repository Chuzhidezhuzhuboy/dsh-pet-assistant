/**
 * dsh-pet-assistant —— 宿主半侧。
 *
 * 定位：**dsh-pet 的伴生插件**。dsh-pet 本体一行不改（除了可选的两处菜单补丁），本插件提供：
 *   1. 在 dsh-pet 右键菜单里注册「截图问助手」「提问」两项（走它公开的第三方菜单注册表）；
 *   2. 长轮询它的事件口，接住点击；
 *   3. 抓屏（Windows PowerShell / macOS screencapture）、会话清单、提交到会话、取回本轮回答；
 *   4. 渲染端（lib/client.js）来拉数据、贴 UI——UI 长在 DSH 页面里，不在宠物窗口里。
 *
 * 设计约束：
 *   - **零运行时依赖**：只 import node 内置模块，这样本地 link 安装不会踩"被链包不装依赖"的坑；
 *   - dsh-pet 的服务（webServer / sessionQuery / sessionController）一律 `ctx.get(name, false)` 惰性取；
 *   - 菜单补丁（把本插件的项提到一级）是**可选**的、幂等的、带标记注释的定点替换，失败不影响功能。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-pet-assistant';

/** 本包根目录（卡片的 HTML 在 lib/card.html） */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 硬依赖：本插件全靠 HTTP 路由与前端通信，webServer 没就绪就不该 apply。
 * （踩过：不声明 inject 时 apply 可能早于服务就绪 → 路由 404，而异步的菜单注册却成功了，极难排查）
 */
export const inject = ['webServer'];

/** 第三方菜单的 owner（dsh-pet 按它分组、回传点击） */
const OWNER = 'dsh-pet-assistant';
/** 本插件自己的路由前缀 */
const ROUTE = '/pet-assist';
/** dsh-pet 的路由前缀 */
const PET_ROUTE = '/dsh-pet-7340';
/** 菜单项文案（也是回传的 label，必须与注册时完全一致） */
const LABEL = '进入会话';
/** 截图暂存有效期 */
const SHOT_TTL_MS = 10 * 60 * 1000;
/** 回答保留时长（长任务可能跑很久，给足 1 小时） */
const ANSWER_TTL_MS = 60 * 60 * 1000;
/** 抓屏超时 */
const CAPTURE_TIMEOUT_MS = 20_000;

/** Windows 抓屏脚本（纯 ASCII） */
const PS_CAPTURE = [
  'param([string]$Out)',
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DshPetAssistDpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
  '[DshPetAssistDpi]::SetProcessDPIAware() | Out-Null',
  '$v = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).Bounds',
  '$bmp = New-Object System.Drawing.Bitmap($v.Width, $v.Height)',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$g.CopyFromScreen($v.Left, $v.Top, 0, 0, $bmp.Size)',
  '$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$g.Dispose()',
  '$bmp.Dispose()',
  // 顺带回鼠标位置：宿主拿不到 screen API，用它当卡片窗的锚点（点菜单时鼠标就在宠物身上）
  '$p = [System.Windows.Forms.Cursor]::Position',
  'Write-Output ("{0}x{1} {2} {3}" -f $v.Width, $v.Height, $p.X, $p.Y)',
].join('\r\n');

/** 跑一个进程，收输出；超时杀进程 */
function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, message: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      err += String(d);
      if (err.length > 4000) err = err.slice(0, 4000);
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: e instanceof Error ? e.message : String(e) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, out } : { ok: false, message: (err || out || 'exit ' + code).trim() });
    });
  });
}

/** 从 PNG 头读尺寸 */
function pngSize(file) {
  try {
    const buf = readFileSync(file);
    if (buf.length < 24) return null;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** 按文件头识别图片类型 */
function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 找 dsh-pet 的安装目录（菜单补丁要写它的文件） */
function findPetPackage() {
  const candidates = [];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir) candidates.push(join(profileDir, 'node_modules', 'dsh-pet'));
  try {
    const root = join(homedir(), '.dsh', 'profiles');
    for (const name of readdirSync(root)) candidates.push(join(root, name, 'node_modules', 'dsh-pet'));
  } catch {
    /* 没有 profiles 目录 */
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

/**
 * 可选补丁：把本插件的菜单项从「更多」提到一级。
 * 只做两处定点替换，带 `[dsh-pet-assistant]` 标记，幂等；找不到锚点就跳过（功能仍然可用，只是多一层「更多」）。
 */
function patchPetMenu(log) {
  const dir = findPetPackage();
  if (!dir) {
    log('没有找到 dsh-pet 安装目录，跳过菜单补丁（菜单项会出现在「更多」里）');
    return;
  }
  const web = join(dir, 'lib', 'client.js');
  const desk = join(dir, 'runtime', 'electron-helper', 'sprite.js');
  let patched = 0;

  // 网页半侧
  try {
    let src = readFileSync(web, 'utf8');
    if (!src.includes('[dsh-pet-assistant]')) {
      const before = src;
      src = src.replace(
        'const more = buildMoreBranch(menuItemsRef.current);',
        'const __assistItems = menuItemsRef.current.filter((m) => m.owner === "dsh-pet-assistant");\n' +
          '\t\t\t// [dsh-pet-assistant] 本插件的菜单项提到一级\n' +
          '\t\t\tconst more = buildMoreBranch(menuItemsRef.current.filter((m) => m.owner !== "dsh-pet-assistant"));',
      );
      src = src.replace('...more ? [more] : []', '...( __assistItems.map((m) => ({ label: m.label, action: "third-party", owner: m.owner }))), ...more ? [more] : []');
      if (src !== before) {
        writeFileSync(web, src, 'utf8');
        patched += 1;
      }
    }
  } catch (e) {
    log('网页半侧菜单补丁失败：' + (e && e.message ? e.message : e));
  }

  // 桌面半侧
  try {
    let src = readFileSync(desk, 'utf8');
    if (!src.includes('[dsh-pet-assistant]')) {
      const before = src;
      src = src.replace(
        'const more = S.buildMoreBranch(this.menuItems);',
        '// [dsh-pet-assistant] 本插件的菜单项提到一级\n' +
          "    const __assistItems = this.menuItems.filter((m) => m.owner === 'dsh-pet-assistant').map((m) => ({ label: m.label, action: 'third-party', owner: m.owner }));\n" +
          "    const more = S.buildMoreBranch(this.menuItems.filter((m) => m.owner !== 'dsh-pet-assistant'));",
      );
      src = src.replace(
        'const tree = tools.concat(S.buildMenuTree(this.animations), more ? [more] : []);',
        'const tree = tools.concat(S.buildMenuTree(this.animations), __assistItems, more ? [more] : []);',
      );
      if (src !== before) {
        writeFileSync(desk, src, 'utf8');
        patched += 1;
      }
    }
  } catch (e) {
    log('桌面半侧菜单补丁失败：' + (e && e.message ? e.message : e));
  }

  if (patched > 0) log('已给 dsh-pet 打菜单补丁（' + patched + ' 个文件），重载后本插件的项会出现在一级菜单');
}

export function apply(ctx) {
  const log = (msg) => ctx.logger?.info?.(`[dsh-pet-assistant] ${msg}`);

  /** 卡片窗诊断日志（默认关闭；排查问题时改成 true，会写 ~/.dsh/dsh-pet-assistant/card.log） */
  const CARD_LOG_ENABLED = false;
  function cardLog(line) {
    if (!CARD_LOG_ENABLED) return;
    try {
      const dir = join(homedir(), '.dsh', 'dsh-pet-assistant');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'card.log'), new Date().toISOString() + ' [host] ' + line + '\n');
    } catch {
      /* ignore */
    }
  }

  const shotDir = join(tmpdir(), 'pet-assist-shots');
  /** id → { file, width, height, at } */
  const shots = new Map();
  /** 待处理事件：{ kind: 'shot'|'ask', id?, width?, height?, at } */
  let pending = null;
  /** sessionId → { text, at } */
  const answers = new Map();
  /** 我们提交过、还没收尾的会话：sessionId → { at, lastText } */
  const inflight = new Map();
  let pollTimer = null;
  let registerTimer = null;

  const petBase = () => {
    const ws = ctx.get('webServer', false);
    const origin = ws && typeof ws.getOrigin === 'function' ? ws.getOrigin() : null;
    return origin ? origin.replace(/\/$/, '') + PET_ROUTE : null;
  };

  /** 注册菜单项（整体覆盖语义，重复注册是幂等的） */
  async function registerMenu() {
    const base = petBase();
    if (!base) return false;
    try {
      const res = await fetch(base + '/menu/item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: OWNER, labels: [LABEL] }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => null);
      if (body && body.ok === true) return true;
      log('菜单注册被拒：' + JSON.stringify(body));
      return false;
    } catch (e) {
      log('菜单注册失败（dsh-pet 可能还没加载）：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** 长轮询点击事件 */
  async function pollOnce() {
    const base = petBase();
    if (!base) return;
    try {
      const res = await fetch(base + '/menu/events?owner=' + encodeURIComponent(OWNER) + '&wait=8000', {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (!body || body.ok !== true || !body.events) {
        // owner 不存在（dsh-pet 重启过）→ 立刻重注册
        if (body && body.reason === 'unknown-owner') await registerMenu();
        return;
      }
      for (const [label, petId] of Object.entries(body.events)) {
        if (!petId) continue;
        await onMenuClick(label, petId);
      }
    } catch {
      /* 超时/网络抖动都正常，下一轮继续 */
    }
  }

  async function onMenuClick(label, petId) {
    if (label !== LABEL) return;
    log('收到「' + LABEL + '」点击 pet=' + petId);
    const opened = openCardWindow('sessions', { petId });
    if (!opened) pending = { kind: 'compose', petId, at: Date.now() };
  }

  // ---------- 桌面小卡片窗（插件自己拉 Electron 子进程） ----------
  /**
   * 为什么不在宿主进程里开窗：DSH 宿主是 `ELECTRON_RUN_AS_NODE` 模式跑的——有 electron 版本号，
   * 但 `require('electron')` 拿不到窗口 API。所以按 dsh-pet 的老办法：自己拉一个真 Electron 进程。
   */
  function electronExe() {
    const candidates =
      process.platform === 'win32'
        ? [join(homedir(), '.dsh', 'electron', 'electron.exe')]
        : [join(homedir(), '.dsh', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')];
    for (const p of candidates) if (existsSync(p)) return p;
    return null;
  }

  let cardChild = null;
  function closeCardWindow() {
    if (!cardChild) return;
    try {
      cardChild.kill();
    } catch {
      /* ignore */
    }
    cardChild = null;
  }

  /**
   * 把卡片应用复制到 **纯 ASCII 路径**（~/.dsh/dsh-pet-assistant/card-app）。
   * 为什么：Electron 在 Windows 上遇到非 ASCII 的 app 路径会在初始化阶段直接崩（0x80000003），
   * 而本插件在工作区里，路径带「新建文件夹 (2)」这类中文/括号/空格。源文件变了就重新复制。
   */
  function ensureCardApp() {
    const dir = join(homedir(), '.dsh', 'dsh-pet-assistant', 'card-app');
    mkdirSync(dir, { recursive: true });
    // helper 目录下的文件全量平铺同步（以后加文件不用再改这段），外加卡片页
    const pairs = [];
    try {
      const helperDir = join(PKG_ROOT, 'lib', 'helper');
      for (const name of readdirSync(helperDir)) {
        if (name === '.') continue;
        pairs.push([join('lib', 'helper', name), name]);
      }
    } catch (e) {
      cardLog('list helper dir failed: ' + (e && e.message ? e.message : e));
    }
    pairs.push([join('lib', 'card.html'), 'card.html']);
    for (const [src, dst] of pairs) {
      const from = join(PKG_ROOT, src);
      const to = join(dir, dst);
      try {
        const srcStat = statSync(from);
        const need = !existsSync(to) || statSync(to).size !== srcStat.size || statSync(to).mtimeMs < srcStat.mtimeMs;
        if (need) writeFileSync(to, readFileSync(from));
      } catch (e) {
        cardLog('copy ' + src + ' failed: ' + (e && e.message ? e.message : e));
      }
    }
    return join(dir, 'main.js');
  }

  /** 拉起一个卡片窗进程；返回 false 表示没有 Electron 可用（退回网页 UI） */
  function openCardWindow(mode, extra) {
    const exe = electronExe();
    if (!exe) {
      log('没有找到 Electron（~/.dsh/electron），退回网页端 UI');
      cardLog('no electron exe');
      return false;
    }
    const ws = ctx.get('webServer', false);
    const origin = ws && typeof ws.getOrigin === 'function' ? ws.getOrigin() : '';
    if (!origin) return false;

    closeCardWindow();
    const isShot = mode === 'shot';
    const W = isShot ? 640 : 420;
    const H = isShot ? 470 : mode === 'error' ? 150 : 480;

    const entry = ensureCardApp();
    // 参数走环境变量：这台机器上 `electron.exe app.js --xxx` 会在 Chromium 初始化阶段崩（exit -1），
    // 而 `electron.exe app.js` 无参数正常。命令行只给 app 路径。
    const env = Object.assign({}, process.env, {
      PA_MODE: mode,
      PA_BASE: String(origin).replace(/\/$/, '') + ROUTE,
      PA_W: String(W),
      PA_H: String(H),
    });
    if (extra && extra.shotId) env.PA_SHOT = String(extra.shotId);
    if (extra && extra.message) env.PA_MSG = String(extra.message);
    delete env.ELECTRON_RUN_AS_NODE; // 关键：不带它，子进程才是真 Electron

    const argv = [entry];

    try {
      const child = spawn(exe, argv, { env, cwd: join(homedir(), '.dsh', 'dsh-pet-assistant'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      cardChild = child;
      cardLog('spawn pid=' + child.pid + ' entry=' + entry);
      child.stdout?.on('data', (d) => cardLog('out: ' + String(d).slice(0, 300).trim()));
      child.stderr?.on('data', (d) => cardLog('err: ' + String(d).slice(0, 600).trim()));
      child.on('exit', (code, sig) => {
        cardLog('exit code=' + code + ' sig=' + sig);
        if (cardChild === child) cardChild = null;
      });
      child.on('error', (e) => cardLog('spawn error: ' + (e && e.message ? e.message : e)));
      return true;
    } catch (e) {
      cardLog('spawn threw: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /** 抓「光标所在那块屏」→ 落临时目录 */
  async function capture() {
    mkdirSync(shotDir, { recursive: true });
    const id = 'shot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const file = join(shotDir, id + '.png');
    const platform = process.platform;
    /** Windows 抓屏脚本会顺带回鼠标位置（"WxH x y"），用来把卡片窗放到宠物旁边 */
    let captureOut = '';
    if (platform === 'win32') {
      const script = join(shotDir, 'capture.ps1');
      if (!existsSync(script)) writeFileSync(script, PS_CAPTURE, 'utf8');
      const r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', file], CAPTURE_TIMEOUT_MS);
      if (!r.ok) return { ok: false, message: r.message || 'capture failed' };
      captureOut = String(r.out || '').trim();
    } else if (platform === 'darwin') {
      const r = await runProcess('screencapture', ['-x', '-t', 'png', file], CAPTURE_TIMEOUT_MS);
      if (!r.ok) return { ok: false, message: r.message || 'capture failed' };
    } else {
      const attempts = [['grim', [file]], ['gnome-screenshot', ['-f', file]], ['import', ['-window', 'root', file]]];
      let last = 'no screenshot tool';
      let done = false;
      for (const [cmd, args] of attempts) {
        const r = await runProcess(cmd, args, CAPTURE_TIMEOUT_MS);
        if (r.ok) {
          done = true;
          break;
        }
        last = r.message || 'failed';
      }
      if (!done) return { ok: false, message: last };
    }
    if (!existsSync(file)) return { ok: false, message: '截屏没有产出文件' };
    const size = pngSize(file);
    if (!size) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      return { ok: false, message: '截屏产物不是合法 PNG' };
    }
    shots.set(id, { file, width: size.width, height: size.height, at: Date.now() });
    // 从 "2560x1440 1200 300" 里取鼠标位置
    let cursor = null;
    const m = /(\d+)\s+(\d+)\s*$/.exec(captureOut);
    if (m) cursor = { x: Number(m[1]), y: Number(m[2]) };
    return { ok: true, id, width: size.width, height: size.height, cursor };
  }

  /** 会话的 cwd（把回答里的相对路径还原成绝对路径） */
  async function sessionCwd(sessionId) {
    if (!sessionId) return null;
    const query = ctx.get('sessionQuery', false);
    if (!query || typeof query.listSessions !== 'function') return null;
    try {
      const recs = await query.listSessions();
      const hit = Array.isArray(recs) ? recs.find((r) => r && r.header && r.header.id === sessionId) : null;
      return hit && hit.header.cwd ? String(hit.header.cwd) : null;
    } catch {
      return null;
    }
  }

  /**
   * 从回答文本里认出「真实存在的文件」：markdown 链接 / 反引号路径 / 裸的绝对路径。
   * 相对路径按会话 cwd 解析；不是文件、太大、重复的都丢掉，最多 10 个。
   */
  async function extractFiles(text, sessionId) {
    if (!text) return [];
    const cwd = await sessionCwd(sessionId);
    const seen = new Set();
    const out = [];
    const push = (raw) => {
      let p = String(raw || '').trim();
      p = p.replace(/^[<'"`]+/, '').replace(/[>'"`),.]+$/, '');
      if (!p || p.length > 400) return;
      if (/^https?:\/\//i.test(p)) return;
      const isAbs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
      if (!isAbs && !cwd) return;
      const abs = isAbs ? p : join(cwd, p);
      let st = null;
      try {
        st = statSync(abs);
      } catch {
        return;
      }
      if (!st.isFile()) return;
      if (st.size > 512 * 1024 * 1024) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push({ path: abs, name: abs.split(/[\\/]/).pop() || abs, size: st.size });
    };
    for (const m of text.matchAll(/\]\(<?([^)>]+)>?\)/g)) push(m[1]);
    for (const m of text.matchAll(/`([^`\n]+)`/g)) push(m[1]);
    for (const m of text.matchAll(/[A-Za-z]:\\[^\s<>"'`|]+/g)) push(m[0]);
    return out.slice(0, 10);
  }

  /** 清理过期截图 */
  function sweep() {
    const now = Date.now();
    for (const [id, rec] of shots) {
      if (now - rec.at <= SHOT_TTL_MS) continue;
      shots.delete(id);
      try {
        rmSync(rec.file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** 把内容块里的纯文本拼出来 */
  function blocksText(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  /**
   * 判断一条用户消息是不是 DSH 注入的运行时上下文（不是用户亲手打的）。
   * 这类消息会以独立的 user/message 写进日志，历史里显示出来会让人莫名其妙。
   */
  function isInjectedContext(text) {
    // 用"特征词出现即命中"而不是"开头匹配"：DSH 每次发消息前都会写一条上下文，
    // 不同版本的开头不一样（Current runtime context / Time sampled / Elapsed since …）。
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return false;
    const markers = [
      'current runtime context',
      'current working directory:',
      'current dsh file policy:',
      'approval policy:',
      'browser time zone for this request',
      'time sampled while preparing turn',
      'elapsed since the preceding',
      'snapshot supersedes earlier',
    ];
    return markers.some((m) => t.includes(m));
  }

  /**
   * 读一条会话的历史（卡片"进入会话"用）。
   * 用 sessionController.follow 的第一帧快照（它本来就是给"打开会话"设计的），
   * 拿到就把流 Abort 掉，不留常驻订阅。
   */
  async function readHistory(sessionId, max) {
    const sc = ctx.get('sessionController', false);
    if (!sc || typeof sc.follow !== 'function') throw new Error('当前宿主不支持读取会话历史');
    const ac = new AbortController();
    let snapshot = null;
    try {
      const stream = sc.follow({ address: { kind: 'session', sessionId }, maxMessages: max }, ac.signal);
      for await (const frame of stream) {
        if (frame && frame.type === 'snapshot') {
          snapshot = frame;
          break;
        }
      }
    } finally {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    if (!snapshot) throw new Error('没有拿到会话快照');
    const out = [];
    for (const rec of snapshot.records || []) {
      if (!rec || rec.type !== 'event') continue;
      const ev = rec.event || {};
      const data = ev.data || {};
      if (ev.type === 'user/message') {
        const blocks = data.content;
        const text = blocksText(blocks).slice(0, 4000);
        // 图片只回 id，不在这里解码——卡片点了才去 /attachment 取（懒加载）
        const images = Array.isArray(blocks)
          ? blocks
              .filter((b) => b && b.type === 'image' && b.attachment && b.attachment.attachmentId)
              .map((b) => ({ id: String(b.attachment.attachmentId), mediaType: b.attachment.mediaType || 'image/png' }))
          : [];
        // DSH 会把运行时上下文（"Current runtime context…"那段英文）当成一条独立的用户消息写进日志，
        // 历史里不该显示它 —— 用户没说过这段话。
        if (text && !images.length && isInjectedContext(text)) continue;
        if (text || images.length) out.push({ role: 'user', text, images });
      } else if (ev.type === 'assistant/message') {
        const text = blocksText(data.message && data.message.content).slice(0, 4000);
        if (text) out.push({ role: 'assistant', text });
      }
    }
    return out;
  }

  /**
   * 当前被归档（侧边栏藏起来）的会话 id 集合。
   * workspaceController.follow 的第一帧 baseline 里带 archivedSessionIds，读到就 abort。
   */
  async function archivedSessionIds() {
    const wc = ctx.get('workspaceController', false);
    if (!wc || typeof wc.follow !== 'function') return new Set();
    const ac = new AbortController();
    try {
      const stream = wc.follow(ac.signal);
      for await (const frame of stream) {
        if (frame && frame.type === 'baseline' && frame.value) {
          return new Set((frame.value.archivedSessionIds || []).map(String));
        }
      }
    } catch {
      /* 拿不到就当没有归档 */
    } finally {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    return new Set();
  }

  /** 会话清单 */
  async function listSessions(includeArchived) {
    const out = [];
    const query = ctx.get('sessionQuery', false);
    if (query && typeof query.listSessions === 'function') {
      let records = [];
      try {
        records = await query.listSessions();
      } catch {
        records = [];
      }
      const roots = records.filter((r) => r && r.header && !r.header.parentSession && r.header.origin !== 'subagent').slice(0, 30);
      const archived = await archivedSessionIds();
      let titles = new Map();
      if (roots.length && typeof query.readTitleSnapshots === 'function') {
        try {
          const list = await query.readTitleSnapshots(roots.map((r) => r.header.id));
          titles = new Map(list.filter((x) => x && x.status === 'fulfilled' && x.value && x.value.title).map((x) => [x.sessionId, x.value.title.title]));
        } catch {
          titles = new Map();
        }
      }
      for (const r of roots) {
        const title = titles.get(r.header.id) ?? '';
        const isArchived = archived.has(String(r.header.id));
        // 空白会话（建过但一条消息都没有）在侧边栏里也不显示，这里同样跳过；
        // 正在跑的先留着，标签可能是刚生成、还没落盘
        if (!title && r.live !== true) continue;
        // 归档的默认藏起来，除非调用方要"显示已归档"
        if (isArchived && !includeArchived) continue;
        out.push({ id: r.header.id, title, cwd: r.header.cwd ?? '', live: r.live === true, archived: isArchived });
      }
    }
    out.sort((a, b) => Number(b.live) - Number(a.live) || Number(a.archived) - Number(b.archived));
    return out;
  }

  /** 提交：图（可无）+ 文字 → 目标会话 */
  async function submit(body) {
    const sc = ctx.get('sessionController', false);
    if (!sc || typeof sc.prompt !== 'function') {
      return { ok: false, reason: 'service-missing', message: '当前宿主没有会话服务，无法提交' };
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) return { ok: false, reason: 'bad-request', message: 'sessionId 必填' };

    let bytes = null;
    if (typeof body.image === 'string' && body.image.startsWith('data:image/')) {
      const comma = body.image.indexOf(',');
      if (comma < 0) return { ok: false, reason: 'bad-request', message: 'image 不是合法 data URL' };
      bytes = Buffer.from(body.image.slice(comma + 1), 'base64');
    } else if (typeof body.shotId === 'string' && body.shotId) {
      const rec = shots.get(body.shotId);
      if (!rec || Date.now() - rec.at > SHOT_TTL_MS) return { ok: false, reason: 'shot-expired', message: '截图不存在或已过期' };
      bytes = readFileSync(rec.file);
    }

    let mediaType = null;
    if (bytes) {
      mediaType = detectImageType(bytes);
      if (!mediaType) return { ok: false, reason: 'bad-request', message: '图片格式不认识' };
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!bytes && !text) return { ok: false, reason: 'bad-request', message: '文字和图至少给一个' };

    const content = [];
    if (text) content.push({ type: 'text', text });
    if (bytes) content.push({ type: 'image', mediaType, data: bytes.toString('base64') });

    const requestId = 'pet-assist-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try {
      await sc.prompt(
        {
          requestId,
          sessionId,
          mode: body.mode === 'steer' ? 'steer' : 'queue',
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        AbortSignal.timeout(15_000),
      );
    } catch (e) {
      return { ok: false, reason: 'prompt-failed', message: e instanceof Error ? e.message : String(e) };
    }
    inflight.set(sessionId, { at: Date.now(), lastText: '' });
    return { ok: true, sessionId, bytes: bytes ? bytes.length : 0 };
  }

  /** 读 body */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 32 * 1024 * 1024) reject(new Error('body too large'));
      });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // 卡片窗是 file:// 页面，跨源取数据必须放开
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(obj));
  }

  /** 路由 */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rest = decodeURIComponent(url.pathname.slice(ROUTE.length + 1));
    const json = (status, obj) => sendJson(res, status, obj);

    if (rest === 'pending') {
      return json(200, {
        ok: true,
        pending: pending
          ? { kind: pending.kind, id: pending.id, width: pending.width, height: pending.height, petId: pending.petId, message: pending.message }
          : null,
      });
    }
    if (rest === 'ack') {
      pending = null;
      return json(200, { ok: true });
    }
    if (rest === 'sessions') {
      const includeArchived = url.searchParams.get('archived') === '1';
      return json(200, { ok: true, items: await listSessions(includeArchived) });
    }
    // 归档 / 取消归档一条会话
    if (rest === 'archive' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw || '{}') || {};
      } catch {
        body = {};
      }
      const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const want = body.archived !== false;
      if (!sid) return json(200, { ok: false, message: 'sessionId 必填' });
      const reg = ctx.get('workspaceRegistry', false);
      if (!reg || typeof reg.archiveSession !== 'function') {
        return json(200, { ok: false, message: '当前宿主不支持归档' });
      }
      try {
        if (want) {
          // stopActivity: 会话正在跑也能归档（会顺手停掉它的活动）
          await reg.archiveSession(sid, { stopActivity: true });
        } else {
          await reg.unarchiveSession(sid);
        }
        log((want ? '已归档 ' : '已取消归档 ') + sid);
        return json(200, { ok: true, archived: want });
      } catch (e) {
        return json(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
    // 读一条会话的历史（卡片"进入会话"用）：从 follow 的第一帧快照里取最近的用户/助手消息
    if (rest === 'history') {
      const sid = url.searchParams.get('sessionId') ?? '';
      const max = Math.max(4, Math.min(120, Number(url.searchParams.get('max') ?? 60) || 60));
      if (!sid) return json(200, { ok: false, message: 'sessionId 必填' });
      try {
        return json(200, { ok: true, items: await readHistory(sid, max) });
      } catch (e) {
        return json(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
    // 按需取一张历史图片（懒加载：卡片点了"查看图片"才来）
    if (rest === 'attachment') {
      const sid = url.searchParams.get('sessionId') ?? '';
      const aid = url.searchParams.get('id') ?? '';
      if (!sid || !aid) return json(200, { ok: false, message: 'sessionId / id 都要给' });
      const sc = ctx.get('sessionController', false);
      if (!sc || typeof sc.attachment !== 'function') {
        return json(200, { ok: false, message: '当前宿主不支持读取图片' });
      }
      try {
        const v = await sc.attachment({ sessionId: sid, attachmentId: aid });
        const ref = (v && v.attachment) || {};
        const mediaType = ref.mediaType || 'image/png';
        return json(200, {
          ok: true,
          dataUrl: 'data:' + mediaType + ';base64,' + String(v.data || ''),
          width: ref.width || 0,
          height: ref.height || 0,
        });
      } catch (e) {
        return json(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
    // 新建工作区 + 会话：
    //   光给会话设 cwd 只是"这条会话在哪个目录跑"，侧边栏会把它归到「未分组」；
    //   必须先 workspaceRegistry.create(path) 把目录**注册成工作区**，才会按目录分组。
    //   create 本身是幂等的：同一个目录重复调用返回已有工作区（不改标题）。
    if (rest === 'new-session' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw || '{}') || {};
      } catch {
        body = {};
      }
      const sc = ctx.get('sessionController', false);
      if (!sc || typeof sc.create !== 'function') {
        return json(200, { ok: false, message: '当前宿主不支持新建会话' });
      }
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined;
      const folderName = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : '';

      // 1) 先把目录注册成工作区
      let workspaceId = '';
      let title = folderName;
      if (cwd) {
        const reg = ctx.get('workspaceRegistry', false);
        if (reg && typeof reg.create === 'function') {
          try {
            const ws = await reg.create(cwd);
            workspaceId = String(ws.id);
            title = String(ws.title || folderName);
          } catch (e) {
            log('注册工作区失败（改为只设 cwd）：' + (e && e.message ? e.message : e));
          }
        } else {
          log('没有 workspaceRegistry，工作区不会出现在侧边栏分组里');
        }
      }

      // 2) 在工作区里建会话
      try {
        const created = await sc.create(workspaceId ? { workspaceId } : cwd ? { cwd } : {});
        const sessionId = String(created.sessionId ?? '');
        log('新建会话 ' + sessionId + (cwd ? ' @ ' + cwd : '') + (workspaceId ? ' ws=' + workspaceId : ''));
        return json(200, { ok: true, sessionId, cwd: cwd ?? '', name: title, workspaceId });
      } catch (e) {
        return json(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
    // 从回答文本里认出「真实存在的文件」，供卡片显示并另存
    if (rest === 'files' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = null;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(200, { ok: false, message: 'body 不是 JSON' });
      }
      return json(200, { ok: true, items: await extractFiles(String(body?.text ?? ''), String(body?.sessionId ?? '')) });
    }
    // 卡片里的「截图」按钮：抓一张屏，回 shotId，卡片自己取图并框选
    if (rest === 'capture' && req.method === 'POST') {
      const shot = await capture();
      if (!shot.ok) return json(200, { ok: false, message: shot.message });
      return json(200, { ok: true, shotId: shot.id, width: shot.width, height: shot.height });
    }
    if (rest === 'submit' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = null;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(200, { ok: false, reason: 'bad-request', message: 'body 不是 JSON' });
      }
      try {
        return json(200, await submit(body || {}));
      } catch (e) {
        return json(500, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (rest === 'answer') {
      const sid = url.searchParams.get('sessionId') ?? '';
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const hit = sid ? answers.get(sid) : undefined;
      if (hit && hit.at >= since && Date.now() - hit.at <= ANSWER_TTL_MS) {
        return json(200, { ok: true, text: hit.text, at: hit.at });
      }
      // 还没出结果：把「已等待多久 + 最近的进度文本」告诉卡片，别让它看起来像卡死
      const rec = sid ? inflight.get(sid) : undefined;
      if (rec && Date.now() - rec.at <= ANSWER_TTL_MS) {
        return json(200, {
          ok: true,
          text: '',
          progress: String(rec.lastText || '').replace(/\s+/g, ' ').slice(0, 120),
          elapsed: Date.now() - rec.at,
        });
      }
      return json(200, { ok: true, text: '' });
    }
    if (rest.startsWith('image/')) {
      sweep();
      const name = rest.slice('image/'.length);
      const id = name.endsWith('.png') ? name.slice(0, -4) : name;
      const rec = shots.get(id);
      if (!rec || !existsSync(rec.file)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const buf = readFileSync(rec.file);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(buf);
      return;
    }
    return json(404, { ok: false, reason: 'unknown-route', message: rest });
  }

  // ---- 装配 ----
  patchPetMenu(log);

  /** 路由是否已注册（幂等；万一 apply 时服务还没就绪，定时器会补上） */
  let routesReady = false;
  const routeHandler = (req, res) => {
    handle(req, res).catch((e) => {
      try {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      } catch {
        /* 连接已断 */
      }
    });
  };
  function ensureRoutes() {
    if (routesReady) return true;
    const ws = ctx.get('webServer', false);
    if (!ws || typeof ws.register !== 'function') return false;
    try {
      ws.register({ kind: 'prefix', path: ROUTE, handler: routeHandler });
      log('路由已注册：' + ROUTE);
    } catch (e) {
      // 重复注册说明本次 apply 之前已经注册过（热重载场景），当成就绪
      log('路由注册抛出（可能已存在）：' + (e && e.message ? e.message : e));
    }
    routesReady = true;
    return true;
  }

  ctx.effect(() => {
    ensureRoutes();
    // 兜底：apply 那一刻服务若还没就绪，每 3 秒重试，直到注册上
    const retry = setInterval(() => {
      if (ensureRoutes()) clearInterval(retry);
    }, 3000);
    return () => clearInterval(retry);
  }, 'pet-assistant: routes');

  ctx.effect(() => {
    let stopped = false;
    void registerMenu();
    registerTimer = setInterval(() => {
      if (stopped) return;
      // 自愈：dsh-pet 被重装/升级后菜单补丁会丢，这里补回来（幂等，已打过就只是两次文件读取）
      patchPetMenu(log);
      void registerMenu();
    }, 30_000);
    const loop = async () => {
      while (!stopped) {
        await pollOnce();
        if (stopped) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    void loop();
    return () => {
      stopped = true;
      if (registerTimer) clearInterval(registerTimer);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, 'pet-assistant: menu polling');

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      const type = event?.type;
      if (type !== 'assistant/message' && type !== 'turn/end') return;
      const sessionId = String(session?.header?.id ?? session?.id ?? '');
      const rec = sessionId ? inflight.get(sessionId) : undefined;
      if (!rec) return;
      if (Date.now() - rec.at > ANSWER_TTL_MS) {
        inflight.delete(sessionId);
        return;
      }
      if (type === 'assistant/message') {
        const content = event?.data?.message?.content;
        if (Array.isArray(content)) {
          const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
          if (text) rec.lastText = text;
        }
        return;
      }
      const kind = event?.data?.reason?.kind;
      inflight.delete(sessionId);
      if (kind === 'completed' && rec.lastText) answers.set(sessionId, { text: rec.lastText, at: Date.now() });
    });
    return () => dispose?.();
  }, 'pet-assistant: answers');

  log('已加载（菜单项：' + LABEL + '）');
}
