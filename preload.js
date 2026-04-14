/**
 * Preload 脚本
 * 安全地暴露 IPC API 给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('api', {
    // 配置
    getConfig: () => ipcRenderer.invoke('get-config'),
    setOutputDir: (dir) => ipcRenderer.invoke('set-output-dir', dir),
    chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
    openFolder: () => ipcRenderer.invoke('open-folder'),

    // 下载
    startDownload: (url) => ipcRenderer.invoke('start-download', url),
    selectFormatAndDownload: (taskId, formatId) => ipcRenderer.invoke('select-format-and-download', taskId, formatId),
    cancelTask: (taskId) => ipcRenderer.invoke('cancel-task', taskId),
    retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),

    // Behance 多视频
    updateBehanceSelection: (taskId, entryId, selected) => ipcRenderer.invoke('update-behance-selection', taskId, entryId, selected),
    updateBehanceFormat: (taskId, entryId, formatId) => ipcRenderer.invoke('update-behance-format', taskId, entryId, formatId),
    downloadBehanceVideos: (taskId) => ipcRenderer.invoke('download-behance-videos', taskId),

    // 任务
    getTasks: () => ipcRenderer.invoke('get-tasks'),
    getCompletedTasks: () => ipcRenderer.invoke('get-completed-tasks'),
    clearCompletedTasks: (deleteFiles = false) => ipcRenderer.invoke('clear-completed-tasks', deleteFiles),
    deleteCompletedTask: (taskId, deleteFiles = false) => ipcRenderer.invoke('delete-completed-task', taskId, deleteFiles),

    // 剪贴板
    pasteFromClipboard: () => ipcRenderer.invoke('paste-from-clipboard'),

    // Cookie 同步
    getCookieSyncStatus: () => ipcRenderer.invoke('get-cookie-sync-status'),
    openExtensionFolder: () => ipcRenderer.invoke('open-extension-folder'),
    resetCookieSyncToken: () => ipcRenderer.invoke('reset-cookie-sync-token'),
    activatePluginCookieSource: () => ipcRenderer.invoke('activate-plugin-cookie-source'),

    // 系统
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    getLogs: () => ipcRenderer.invoke('get-logs'),
    checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
    getYtdlpVersion: () => ipcRenderer.invoke('get-ytdlp-version'),
    updateCore: () => ipcRenderer.invoke('update-core'),
    downloadImage: (url) => ipcRenderer.invoke('download-image', url),

    // 事件监听
    onTaskUpdate: (callback) => {
        ipcRenderer.on('task-update', (event, task) => callback(task));
    },
    onLogUpdate: (callback) => {
        ipcRenderer.on('log-update', (event, log) => callback(log));
    },
    onCookieSyncUpdate: (callback) => {
        ipcRenderer.on('cookie-sync-update', (event, status) => callback(status));
    }
});

console.log('[Preload] API 已暴露到 window.api');
