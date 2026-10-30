// 选区窗口的桥：只回传"确认/取消"和选区矩形。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('selectorApi', {
  /** 选区矩形（CSS 像素，相对这块屏幕） */
  confirm: (rect) => ipcRenderer.send('selector:confirm', rect),
  cancel: () => ipcRenderer.send('selector:cancel'),
});
