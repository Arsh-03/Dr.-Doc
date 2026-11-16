const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('drdocDesktop', {
  outputDir: () => ipcRenderer.invoke('output-dir'),
  save: (name, data) => ipcRenderer.invoke('save', name, data),
  open: (p) => ipcRenderer.invoke('open', p),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  rename: (p, newName) => ipcRenderer.invoke('rename', p, newName),
  remove: (p) => ipcRenderer.invoke('remove', p),
  saveAs: (name, data) => ipcRenderer.invoke('save-as', name, data),
  htmlToPdf: (html, pageSize) => ipcRenderer.invoke('html-to-pdf', html, pageSize),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
});
