// 卡片小窗的 Electron 主进程（由宿主插件按需拉起，一块卡片一个进程，关窗即退出）。
//
// 为什么需要它：DSH 宿主是 `ELECTRON_RUN_AS_NODE` 模式跑的（有 electron 版本号但拿不到窗口 API），
// 插件在宿主进程里开不了窗，只能自己拉一个真正的 Electron 进程——和 dsh-pet 的 helper 是同一招。
//
// 参数（都是 `--k v` 成对）：
//   mode    shot | ask | error
//   base    接口基址（http://127.0.0.1:PORT/pet-assist）
//   shot    shotId（截图模式）
//   pet     petId
//   msg     错误文案
//   w/h     窗口宽高
//   ax/ay   锚点屏幕坐标（通常是点菜单时的鼠标位置）；缺省用当前鼠标位置

// 最先写一行启动日志：在 require('electron') **之前**，用于区分"进程没起来"和"起来了但加载失败"
try {
  const fs0 = require('node:fs');
  const os0 = require('node:os');
  const path0 = require('node:path');
  const dir0 = path0.join(os0.homedir(), '.dsh', 'dsh-pet-assistant');
  fs0.mkdirSync(dir0, { recursive: true });
  fs0.appendFileSync(path0.join(dir0, 'card.log'), new Date().toISOString() + ' [helper] boot pid=' + process.pid + '\n');
} catch {
  /* 写不了日志也要继续 */
}

const { app, BrowserWindow, screen, ipcMain, dialog, shell, desktopCapturer } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

/** 诊断日志（默认关闭；排查时改成 true 会写 ~/.dsh/dsh-pet-assistant/card.log） */
const LOG_ENABLED = false;
function logLine(line) {
  if (!LOG_ENABLED) return;
  try {
    const dir = path.join(os.homedir(), '.dsh', 'dsh-pet-assistant');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'card.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch {
    /* ignore */
  }
}

// **必须先定自己的 userData**：Electron 按可执行文件名兜底成 "%APPDATA%\Electron"，
// 而 dsh-pet 的 helper 正占着那个目录 —— Chromium 的 SingletonLock 会让后启动的实例静默退出。
app.setPath('userData', path.join(os.homedir(), '.dsh', 'dsh-pet-assistant', 'electron-userdata'));

// 参数**走环境变量**：实测这台机器上 `electron.exe app.js --任意参数` 会在 Chromium 初始化阶段
// 直接崩（exit -1），而 `electron.exe app.js` 无参数则正常。命令行只给 app 路径，其余全用 env。
// 仍保留 argv 解析作为兜底（某些环境可能没这个毛病）。
const envArgs = {};
const envMap = { mode: 'PA_MODE', base: 'PA_BASE', shot: 'PA_SHOT', pet: 'PA_PET', msg: 'PA_MSG', w: 'PA_W', h: 'PA_H', ax: 'PA_AX', ay: 'PA_AY' };
for (const [k, name] of Object.entries(envMap)) {
  if (process.env[name] !== undefined && process.env[name] !== '') envArgs[k] = process.env[name];
}
const argvArgs = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) {
  const key = String(process.argv[i]).replace(/^--/, '');
  argvArgs[key] = process.argv[i + 1];
}
const args = Object.assign({}, argvArgs, envArgs);

logLine('start mode=' + (args.mode || '') + ' w=' + args.w + ' h=' + args.h + ' pid=' + process.pid);

// 各形态的**初始**尺寸（页面随后会按内容自适应，见 card.html 的 fit()）
const MODE_SIZE = {
  sessions: { w: 420, h: 480 },
  compose: { w: 420, h: 240 },
  ask: { w: 380, h: 190 },
  error: { w: 380, h: 150 },
  shot: { w: 640, h: 470 },
};
const preset = MODE_SIZE[args.mode] || MODE_SIZE.sessions;
const W = Math.max(260, Number(args.w) || preset.w);
const H = Math.max(120, Number(args.h) || preset.h);

app.whenReady().then(() => {
  const cursor = screen.getCursorScreenPoint();
  const ax = Number.isFinite(Number(args.ax)) && args.ax !== undefined ? Number(args.ax) : cursor.x;
  const ay = Number.isFinite(Number(args.ay)) && args.ay !== undefined ? Number(args.ay) : cursor.y;

  const display = screen.getDisplayNearestPoint({ x: ax, y: ay });
  const wa = display.workArea;
  // 回填：卡片页要用这个锚点画「指向桌宠」的箭头
  args.ax = String(Math.round(ax));
  args.ay = String(Math.round(ay));

  // 优先放锚点右侧，右侧不够翻左侧，都放不下再上下；最后夹进工作区
  let x = Math.round(ax + 24);
  let y = Math.round(ay - H / 2);
  if (x + W > wa.x + wa.width) x = Math.round(ax - 24 - W);
  if (x < wa.x) {
    x = Math.round(ax - W / 2);
    y = Math.round(ay - H - 40);
    if (y < wa.y) y = Math.round(ay + 40);
  }
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - W));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - H));

  const win = new BrowserWindow({
    x,
    y,
    width: W,
    height: H,
    minWidth: 320,
    minHeight: 140,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 允许手动拖边调整；页面会检测到"用户自己调过"后停止自动适配
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('context-menu', (e) => e.preventDefault());
  win.on('closed', () => app.quit());

  // 页面量完内容高度后调 resize，把窗口缩到刚好（并保持锚点不变，只动高宽）
  ipcMain.on('card:resize', (event, w, h) => {
    if (event.sender !== win.webContents) return;
    if (win.isDestroyed()) return;
    const nw = Math.max(320, Math.min(1600, Math.round(Number(w) || W)));
    const nh = Math.max(140, Math.min(1000, Math.round(Number(h) || H)));
    const b = win.getBounds();
    if (b.width === nw && b.height === nh) return;
    win.setBounds({ x: b.x, y: b.y, width: nw, height: nh });
  });
  ipcMain.on('card:close', (event) => {
    if (event.sender !== win.webContents) return;
    if (!win.isDestroyed()) win.close();
  });
  // 抓屏前藏起来：不然截出来的图里会有卡片自己
  ipcMain.on('card:hide', (event) => {
    if (event.sender !== win.webContents) return;
    if (!win.isDestroyed()) win.hide();
  });
  ipcMain.on('card:show', (event) => {
    if (event.sender !== win.webContents) return;
    if (!win.isDestroyed()) win.show();
  });
  // 另存文件：弹系统"保存到"对话框，选完就复制过去
  ipcMain.handle('card:save-file', async (event, srcPath) => {
    if (event.sender !== win.webContents) return { ok: false, message: '非本卡片' };
    try {
      const src = String(srcPath || '');
      if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) return { ok: false, message: '文件不存在' };
      let defaultPath = path.basename(src);
      try {
        defaultPath = path.join(app.getPath('downloads'), path.basename(src));
      } catch {
        /* 拿不到下载目录就用文件名 */
      }
      const res = await dialog.showSaveDialog(win, { title: '保存文件', defaultPath, buttonLabel: '保存' });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.copyFileSync(src, res.filePath);
      logLine('saved ' + src + ' -> ' + res.filePath);
      return { ok: true, path: res.filePath };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : String(e) };
    }
  });
  // 在资源管理器里定位文件
  ipcMain.on('card:reveal', (event, p) => {
    if (event.sender !== win.webContents) return;
    try {
      const target = String(p || '');
      if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    } catch {
      /* ignore */
    }
  });
  // 选一个目录（可以用系统对话框在里面新建文件夹）→ 用来建新工作区
  ipcMain.handle('card:pick-folder', async (event) => {
    if (event.sender !== win.webContents) return { ok: false, message: '非本卡片' };
    try {
      const res = await dialog.showOpenDialog(win, {
        title: '选一个新的工作区目录',
        buttonLabel: '用这个目录',
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : String(e) };
    }
  });

  /**
   * 全屏选区截图：卡片先藏起来 → 冻结当前屏 → 打开全屏选区窗 → 右键/回车确认 → 裁出选区。
   * 返回 { ok, dataUrl, width, height }（dataUrl 直接给卡片当缩略图 + 提交用）。
   */
  ipcMain.handle('card:capture-region', async (event) => {
    if (event.sender !== win.webContents) return { ok: false, message: '非本卡片' };
    let selectorWin = null;
    const finish = (result) => {
      ipcMain.removeAllListeners('selector:confirm');
      ipcMain.removeAllListeners('selector:cancel');
      try {
        if (selectorWin && !selectorWin.isDestroyed()) selectorWin.close();
      } catch {
        /* ignore */
      }
      selectorWin = null;
      try {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      } catch {
        /* ignore */
      }
      return result;
    };
    try {
      win.hide();
      await new Promise((r) => setTimeout(r, 240));
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const b = display.bounds;
      const scale = display.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(b.width * scale), height: Math.round(b.height * scale) },
      });
      const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      if (!source) return finish({ ok: false, message: '没有可用的屏幕源' });
      const thumb = source.thumbnail;
      const dir = path.join(os.homedir(), '.dsh', 'dsh-pet-assistant', 'regions');
      fs.mkdirSync(dir, { recursive: true });
      const framePath = path.join(dir, 'frame-' + Date.now() + '.png');
      fs.writeFileSync(framePath, thumb.toPNG());

      selectorWin = new BrowserWindow({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        minWidth: 200,
        minHeight: 200,
        frame: false,
        backgroundColor: '#000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        fullscreenable: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload-selector.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      selectorWin.setAlwaysOnTop(true, 'screen-saver');
      selectorWin.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
      selectorWin.on('closed', () => {
        selectorWin = null;
      });

      const picked = new Promise((resolve) => {
        ipcMain.once('selector:confirm', (_e, rect) => {
          try {
            const size = thumb.getSize();
            const sx = size.width / b.width;
            const sy = size.height / b.height;
            const crop = {
              x: Math.max(0, Math.round(Number(rect.x) * sx)),
              y: Math.max(0, Math.round(Number(rect.y) * sy)),
              width: Math.round(Number(rect.w) * sx),
              height: Math.round(Number(rect.h) * sy),
            };
            crop.width = Math.max(1, Math.min(crop.width, size.width - crop.x));
            crop.height = Math.max(1, Math.min(crop.height, size.height - crop.y));
            const img = thumb.crop(crop);
            logLine('region ' + crop.width + 'x' + crop.height);
            resolve({ ok: true, dataUrl: img.toDataURL(), width: crop.width, height: crop.height });
          } catch (e) {
            resolve({ ok: false, message: e && e.message ? e.message : String(e) });
          }
        });
        ipcMain.once('selector:cancel', () => resolve({ ok: false, canceled: true }));
      });

      const imgArg = framePath.replace(/\\/g, '/');
      await selectorWin.loadFile(path.join(__dirname, 'selector.html'), { query: { img: imgArg, w: String(b.width), h: String(b.height) } });
      selectorWin.show();
      selectorWin.focus();
      const result = await Promise.race([
        picked,
        new Promise((r) => setTimeout(() => r({ ok: false, message: '选区超时' }), 180000)),
      ]);
      return finish(result);
    } catch (e) {
      return finish({ ok: false, message: e && e.message ? e.message : String(e) });
    }
  });

  const query = { mode: args.mode || 'ask', base: args.base || '' };
  if (args.shot) query.shotId = args.shot;
  if (args.pet) query.pet = args.pet;
  if (args.msg) query.message = args.msg;
  // 桌宠的屏幕坐标（点菜单时的鼠标位置）→ 卡片用它画指向箭头
  if (args.ax) query.px = args.ax;
  if (args.ay) query.py = args.ay;

  win.webContents.once('did-finish-load', () => {
    logLine('loaded, showing');
    win.show();
    win.focus();
  });
  // card.html 可能和 main.js 同级（运行时复制到 ASCII 目录），也可能在上一级（源码树里）
  const cardPath = fs.existsSync(path.join(__dirname, 'card.html'))
    ? path.join(__dirname, 'card.html')
    : path.join(__dirname, '..', 'card.html');
  win.loadFile(cardPath, { query }).catch((e) => {
    logLine('load failed: ' + (e && e.message ? e.message : e));
    console.error('[pet-assist card] load failed:', e && e.message ? e.message : e);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  logLine('quit');
  app.quit();
});
