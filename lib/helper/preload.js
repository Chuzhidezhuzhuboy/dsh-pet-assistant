// 卡片页 ↔ 窗口 的唯一桥：只暴露几个动作，够用就行。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cardApi', {
  /** 把窗口调整成给定尺寸（页面量完内容高度后调用） */
  resize: (w, h) => ipcRenderer.send('card:resize', w, h),
  /** 关闭窗口 */
  close: () => ipcRenderer.send('card:close'),
  /** 临时隐藏/显示（抓屏时避免把卡片自己拍进去） */
  hide: () => ipcRenderer.send('card:hide'),
  show: () => ipcRenderer.send('card:show'),
  /** 另存文件：弹系统保存对话框，返回 { ok, path } 或 { ok:false, canceled } */
  saveFile: (srcPath) => ipcRenderer.invoke('card:save-file', srcPath),
  /** 在资源管理器里定位文件 */
  reveal: (p) => ipcRenderer.send('card:reveal', p),
  /** 选一个目录（新建工作区用），返回 { ok, path } 或 { ok:false, canceled } */
  pickFolder: () => ipcRenderer.invoke('card:pick-folder'),
  /** 全屏选区截图 → { ok, dataUrl, width, height } 或 { ok:false, canceled } */
  captureRegion: () => ipcRenderer.invoke('card:capture-region'),
});
