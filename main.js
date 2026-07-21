/**
 * Electron 主进程
 * 负责窗口管理、IPC 通信、调用 yt-dlp
 */

const { app, BrowserWindow, ipcMain, dialog, shell, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const nodeNet = require('net');
const crypto = require('crypto');
const { spawn, execFile, spawnSync } = require('child_process');
const packageJson = require('./package.json');
const {
    USER_AGENT: ART_LIST_USER_AGENT,
    isArtlistUrl,
    parseArtlistPage,
    guessArtlistExtension,
    isSafeArtlistAudioUrl
} = require('./lib/artlist');

// 应用目录
const APP_DIR = app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : __dirname;

const RESOURCES_DIR = app.isPackaged
    ? path.join(process.resourcesPath)
    : APP_DIR;

const DATA_DIR = app.getPath('userData');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 配置文件路径
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const BUNDLED_YTDLP_EXE = path.join(RESOURCES_DIR, 'yt-dlp.exe');
const DATA_YTDLP_EXE = path.join(DATA_DIR, 'yt-dlp.exe');
const BUNDLED_NODE_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'node-runtime')
    : path.join(APP_DIR, 'node-runtime');
const BUNDLED_NODE_EXE = path.join(BUNDLED_NODE_DIR, 'node.exe');
const PLUGIN_COOKIE_FILE = path.join(DATA_DIR, 'browser_extension_cookies.txt');
const COOKIE_SYNC_FALLBACK_DIR = path.join(require('os').homedir(), 'Downloads', 'YT下载器 Cookie Sync');
const COOKIE_SYNC_FALLBACK_FILE = path.join(COOKIE_SYNC_FALLBACK_DIR, 'browser_extension_cookies.txt');
const COOKIE_SYNC_PORT = 38491;
const COOKIE_SYNC_PORT_CANDIDATES = [38491, 38492, 38493, 38494, 38495];
const YTDLP_OUTPUT_MARKER = '__YTDLP_FILE__:';
const MAX_PROXY_IMAGE_BYTES = 10 * 1024 * 1024;
const PROXY_IMAGE_TIMEOUT_MS = 15000;
const GITHUB_REPO = 'Danborad/YTdown';
const APP_ICON = process.platform === 'win32'
    ? path.join(APP_DIR, 'icon.ico')
    : path.join(APP_DIR, 'icon.png');
const BUNDLED_EXTENSION_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(APP_DIR, 'browser-extension');
const DATA_EXTENSION_DIR = path.join(DATA_DIR, 'browser-extension');
const EXTENSION_DIR = DATA_EXTENSION_DIR;
const COOKIE_SYNC_SITES = [
    { name: 'YouTube', domains: ['youtube.com', 'google.com', 'accounts.google.com'] },
    { name: 'Bilibili', domains: ['bilibili.com'] },
    { name: 'Vimeo', domains: ['vimeo.com'] },
    { name: 'TikTok', domains: ['tiktok.com'] },
    { name: 'X', domains: ['twitter.com', 'x.com'] },
    { name: 'Instagram', domains: ['instagram.com'] },
    { name: 'Behance', domains: ['behance.net', 'adobe.com'] }
];

function generatePairToken() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function migrateLegacyFile(oldPath, newPath) {
    try {
        if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
            fs.copyFileSync(oldPath, newPath);
        }
    } catch (error) {
        console.error(`迁移文件失败 ${oldPath} -> ${newPath}:`, error.message);
    }
}

migrateLegacyFile(path.join(APP_DIR, 'config.json'), CONFIG_FILE);
migrateLegacyFile(path.join(APP_DIR, 'tasks.json'), TASKS_FILE);

function ensureYtdlpExecutable() {
    try {
        if (!fs.existsSync(DATA_YTDLP_EXE) && fs.existsSync(BUNDLED_YTDLP_EXE)) {
            fs.copyFileSync(BUNDLED_YTDLP_EXE, DATA_YTDLP_EXE);
        }
    } catch (error) {
        console.error('初始化 yt-dlp 失败:', error.message);
    }
}

function ensureExtensionFiles() {
    try {
        if (fs.existsSync(BUNDLED_EXTENSION_DIR)) {
            fs.cpSync(BUNDLED_EXTENSION_DIR, DATA_EXTENSION_DIR, { recursive: true, force: true });
        }
    } catch (error) {
        console.error('初始化浏览器插件失败:', error.message);
    }
}

function getYtdlpExePath() {
    return fs.existsSync(DATA_YTDLP_EXE) ? DATA_YTDLP_EXE : BUNDLED_YTDLP_EXE;
}

function getChildProcessEnv() {
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    const currentPath = env[pathKey] || '';
    const extraDirs = [];

    if (fs.existsSync(BUNDLED_NODE_EXE)) {
        extraDirs.push(BUNDLED_NODE_DIR);
    }

    if (extraDirs.length > 0) {
        env[pathKey] = `${extraDirs.join(path.delimiter)}${currentPath ? path.delimiter : ''}${currentPath}`;
    }

    return env;
}

// 启动时检查 yt-dlp
console.log('=== 启动信息 ===');
console.log('APP_DIR:', APP_DIR);
console.log('DATA_DIR:', DATA_DIR);
console.log('RESOURCES_DIR:', RESOURCES_DIR);
ensureYtdlpExecutable();
ensureExtensionFiles();
console.log('YTDLP_EXE:', getYtdlpExePath());
console.log('yt-dlp.exe 存在:', fs.existsSync(getYtdlpExePath()));

// 全局状态
let mainWindow = null;
let config = loadConfig();
let activeTasks = {};
let completedTasks = loadTasks();
let systemLogs = [];
let ytdlpVersion = '检测中...';
let cookieSyncServer = null;
let cookieSyncServerPort = 0;
let preferredJsRuntime = '';
let jsRuntimeChecked = false;

saveConfig(config);

function getCookieSyncStatus() {
    return {
        running: Boolean(cookieSyncServer),
        port: cookieSyncServerPort || config.cookie_sync_port || COOKIE_SYNC_PORT,
        portCandidates: COOKIE_SYNC_PORT_CANDIDATES,
        token: config.cookie_sync_token,
        browser: config.cookie_sync_browser || '',
        paired: Boolean(config.cookie_sync_paired_at),
        pairedAt: config.cookie_sync_paired_at || '',
        lastSyncAt: config.cookie_sync_last_sync || '',
        lastCookieCount: config.cookie_sync_last_count || 0,
        extensionDir: EXTENSION_DIR,
        sourceActive: config.cookie_source === 'plugin-sync',
        cookiesFile: PLUGIN_COOKIE_FILE,
        fallbackCookiesFile: COOKIE_SYNC_FALLBACK_FILE,
        lastMode: config.cookie_sync_last_mode || '',
        sites: COOKIE_SYNC_SITES
    };
}

function getPreferredJsRuntime() {
    if (jsRuntimeChecked) {
        return preferredJsRuntime;
    }

    const candidates = [
        { name: 'node', command: 'node', args: ['-v'] },
        { name: 'bun', command: 'bun', args: ['-v'] },
        { name: 'deno', command: 'deno', args: ['--version'] }
    ];

    for (const candidate of candidates) {
        try {
            const result = spawnSync(candidate.command, candidate.args, {
                encoding: 'utf8',
                windowsHide: true,
                env: getChildProcessEnv()
            });
            if (result.status === 0) {
                preferredJsRuntime = candidate.name;
                jsRuntimeChecked = true;
                return preferredJsRuntime;
            }
        } catch (error) {
            // ignore and try next runtime
        }
    }

    jsRuntimeChecked = true;
    preferredJsRuntime = '';
    return preferredJsRuntime;
}

function appendPreferredJsRuntime(args) {
    const runtime = getPreferredJsRuntime();
    if (runtime) {
        const insertIndex = Math.max(args.length - 1, 0);
        args.splice(insertIndex, 0, '--js-runtimes', runtime);
    }
    return runtime;
}

function sendCookieSyncUpdate() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cookie-sync-update', getCookieSyncStatus());
    }
}

function shouldAutoUsePluginSync() {
    return !config.cookies_file
        || config.cookie_source === 'plugin-sync'
        || config.cookies_file === PLUGIN_COOKIE_FILE
        || config.cookies_file === COOKIE_SYNC_FALLBACK_FILE;
}

function activatePluginCookieSource() {
    const pluginCookiePath = getBestCookieFilePath();
    if (!pluginCookiePath) {
        return { success: false, message: '还没有收到插件同步的 Cookie，请先在浏览器插件中完成连接并同步' };
    }

    config.cookies_file = pluginCookiePath;
    config.cookie_source = 'plugin-sync';
    config.cookie_browser = '';
    saveConfig(config);
    sendCookieSyncUpdate();
    return { success: true, path: pluginCookiePath };
}

function ensureFallbackCookieDir() {
    fs.mkdirSync(COOKIE_SYNC_FALLBACK_DIR, { recursive: true });
}

function getBestCookieFilePath() {
    if (fs.existsSync(PLUGIN_COOKIE_FILE)) return PLUGIN_COOKIE_FILE;
    if (fs.existsSync(COOKIE_SYNC_FALLBACK_FILE)) return COOKIE_SYNC_FALLBACK_FILE;
    return '';
}

function applyPluginCookieSource(cookiePath, syncMode) {
    config.cookie_sync_last_mode = syncMode || 'local-api';
    if (shouldAutoUsePluginSync()) {
        config.cookies_file = cookiePath;
        config.cookie_source = 'plugin-sync';
        config.cookie_browser = '';
    }
}

function saveSyncedCookies(cookies, syncMode = 'local-api') {
    const normalizedCookies = normalizeSyncedCookies(cookies);
    const outputPath = syncMode === 'folder-fallback' ? COOKIE_SYNC_FALLBACK_FILE : PLUGIN_COOKIE_FILE;

    if (syncMode === 'folder-fallback') {
        ensureFallbackCookieDir();
    }

    fs.writeFileSync(outputPath, buildNetscapeCookieFile(normalizedCookies), 'utf-8');
    applyPluginCookieSource(outputPath, syncMode);
    config.cookie_sync_last_sync = new Date().toISOString();
    config.cookie_sync_last_count = normalizedCookies.length;
    saveConfig(config);

    log('INFO', `[Cookie Sync] 已同步 ${normalizedCookies.length} 个 Cookie (${config.cookie_sync_browser || '浏览器插件'}${syncMode === 'folder-fallback' ? ' / 目录兜底' : ''})`);
    sendCookieSyncUpdate();

    return {
        cookieCount: normalizedCookies.length,
        outputPath,
        sourceActive: config.cookie_source === 'plugin-sync',
        mode: syncMode
    };
}

function resolveActiveCookieFile() {
    const preferredPaths = [config.cookies_file, PLUGIN_COOKIE_FILE, COOKIE_SYNC_FALLBACK_FILE]
        .filter(Boolean);

    for (const filePath of preferredPaths) {
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }

    return '';
}

function syncCookieFilePreference() {
    const activeCookieFile = resolveActiveCookieFile();
    if (!activeCookieFile) return;

    if (config.cookie_source === 'plugin-sync' || !config.cookies_file || !fs.existsSync(config.cookies_file)) {
        config.cookies_file = activeCookieFile;
        if (activeCookieFile === PLUGIN_COOKIE_FILE || activeCookieFile === COOKIE_SYNC_FALLBACK_FILE) {
            config.cookie_source = 'plugin-sync';
            config.cookie_browser = '';
            config.cookie_sync_last_mode = activeCookieFile === COOKIE_SYNC_FALLBACK_FILE ? 'folder-fallback' : (config.cookie_sync_last_mode || 'local-api');
        }
        saveConfig(config);
    }
}

function normalizeVersion(version) {
    return String(version || '').trim().replace(/^v/i, '');
}

function compareVersions(left, right) {
    const leftParts = normalizeVersion(left).split('.').map(part => parseInt(part, 10) || 0);
    const rightParts = normalizeVersion(right).split('.').map(part => parseInt(part, 10) || 0);
    const maxLength = Math.max(leftParts.length, rightParts.length);

    for (let i = 0; i < maxLength; i += 1) {
        const leftValue = leftParts[i] || 0;
        const rightValue = rightParts[i] || 0;
        if (leftValue > rightValue) return 1;
        if (leftValue < rightValue) return -1;
    }

    return 0;
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                'User-Agent': 'YTDownloader-App',
                'Accept': 'application/vnd.github+json'
            }
        }, (response) => {
            let body = '';
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`GitHub API 请求失败: ${response.statusCode}`));
                    return;
                }

                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });

        request.on('error', reject);
        request.end();
    });
}

function buildNetscapeCookieFile(cookies) {
    const lines = ['# Netscape HTTP Cookie File', '# Generated by YT下载器 Browser Extension', ''];

    cookies.forEach((cookie) => {
        if (!cookie || !cookie.domain || !cookie.name) return;

        let domain = String(cookie.domain).trim();
        const hostOnly = Boolean(cookie.hostOnly);
        if (hostOnly) {
            domain = domain.replace(/^\./, '');
        } else if (!domain.startsWith('.')) {
            domain = `.${domain}`;
        }

        const includeSubdomains = hostOnly ? 'FALSE' : 'TRUE';
        const cookiePath = cookie.path || '/';
        const secure = cookie.secure ? 'TRUE' : 'FALSE';
        const expires = cookie.session || !cookie.expirationDate ? 0 : Math.floor(cookie.expirationDate);
        const name = String(cookie.name);
        const value = String(cookie.value || '');

        lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expires}\t${name}\t${value}`);
    });

    return lines.join('\n');
}

function normalizeSyncedCookies(cookies) {
    const seen = new Set();
    const normalized = [];

    (Array.isArray(cookies) ? cookies : []).forEach((cookie) => {
        if (!cookie || !cookie.domain || !cookie.name) return;

        const normalizedCookie = {
            domain: String(cookie.domain),
            hostOnly: Boolean(cookie.hostOnly),
            path: cookie.path || '/',
            secure: Boolean(cookie.secure),
            session: Boolean(cookie.session),
            expirationDate: cookie.expirationDate || 0,
            name: String(cookie.name),
            value: String(cookie.value || '')
        };

        const key = [normalizedCookie.domain, normalizedCookie.path, normalizedCookie.name].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push(normalizedCookie);
    });

    return normalized;
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 5 * 1024 * 1024) {
                reject(new Error('请求体过大'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function isAllowedCookieSyncOrigin(origin) {
    return !origin || /^chrome-extension:\/\/[a-p]{32}$/i.test(origin);
}

function cookieSyncTokensMatch(providedToken, expectedToken) {
    const provided = Buffer.from(String(providedToken || '').trim().toUpperCase());
    const expected = Buffer.from(String(expectedToken || '').trim().toUpperCase());
    return provided.length === expected.length
        && provided.length > 0
        && crypto.timingSafeEqual(provided, expected);
}

function getPublicCookieSyncStatus() {
    return {
        running: Boolean(cookieSyncServer),
        port: cookieSyncServerPort || config.cookie_sync_port || COOKIE_SYNC_PORT,
        paired: Boolean(config.cookie_sync_paired_at)
    };
}

function writeJson(req, res, statusCode, payload) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };
    const origin = req.headers.origin || '';
    if (origin && isAllowedCookieSyncOrigin(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
    }
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify(payload));
}

function createCookieSyncServer() {
    return http.createServer(async (req, res) => {
        if (!req.url) {
            writeJson(req, res, 400, { success: false, message: '无效请求' });
            return;
        }

        if (!isAllowedCookieSyncOrigin(req.headers.origin || '')) {
            writeJson(req, res, 403, { success: false, message: '不允许的请求来源' });
            return;
        }

        if (req.method === 'OPTIONS') {
            writeJson(req, res, 204, {});
            return;
        }

        const urlObj = new URL(req.url, `http://127.0.0.1:${config.cookie_sync_port || COOKIE_SYNC_PORT}`);

        if (req.method === 'GET' && urlObj.pathname === '/api/cookie-sync/status') {
            writeJson(req, res, 200, { success: true, ...getPublicCookieSyncStatus() });
            return;
        }

        if (req.method !== 'POST') {
            writeJson(req, res, 405, { success: false, message: '方法不支持' });
            return;
        }

        try {
            const payload = await readRequestBody(req);
            const expectedToken = config.cookie_sync_token;

            if (!cookieSyncTokensMatch(payload.token, expectedToken)) {
                writeJson(req, res, 401, { success: false, message: '配对码错误' });
                return;
            }

            if (urlObj.pathname === '/api/cookie-sync/pair') {
                config.cookie_sync_browser = payload.browserName || '';
                config.cookie_sync_paired_at = new Date().toISOString();
                config.cookie_sync_last_mode = 'local-api';
                saveConfig(config);
                log('INFO', `[Cookie Sync] 浏览器插件已配对: ${config.cookie_sync_browser || '未知浏览器'}`);
                sendCookieSyncUpdate();
                writeJson(req, res, 200, {
                    success: true,
                    message: '配对成功',
                    sites: COOKIE_SYNC_SITES,
                    filePath: PLUGIN_COOKIE_FILE,
                    port: cookieSyncServerPort,
                    sourceActive: config.cookie_source === 'plugin-sync'
                });
                return;
            }

            if (urlObj.pathname === '/api/cookie-sync/sync') {
                config.cookie_sync_browser = payload.browserName || config.cookie_sync_browser || '';
                const result = saveSyncedCookies(payload.cookies, 'local-api');
                writeJson(req, res, 200, {
                    success: true,
                    message: '同步成功',
                    cookieCount: result.cookieCount,
                    outputPath: result.outputPath,
                    port: cookieSyncServerPort,
                    mode: result.mode,
                    sourceActive: result.sourceActive
                });
                return;
            }

            writeJson(req, res, 404, { success: false, message: '接口不存在' });
        } catch (error) {
            log('ERROR', `[Cookie Sync] 请求处理失败: ${error.message}`);
            writeJson(req, res, 500, { success: false, message: error.message });
        }
    });
}

function startCookieSyncServer() {
    if (cookieSyncServer) return;

    const tryListen = (index = 0) => {
        const port = COOKIE_SYNC_PORT_CANDIDATES[index];
        if (!port) {
            log('ERROR', `[Cookie Sync] 所有候选端口均不可用: ${COOKIE_SYNC_PORT_CANDIDATES.join(', ')}`);
            return;
        }

        const server = createCookieSyncServer();

        server.once('error', (error) => {
            if (error && error.code === 'EADDRINUSE') {
                log('WARN', `[Cookie Sync] 端口 ${port} 已被占用，尝试下一个端口`);
                tryListen(index + 1);
                return;
            }

            log('ERROR', `[Cookie Sync] 本地同步服务异常: ${error.message}`);
        });

        server.listen(port, '127.0.0.1', () => {
            cookieSyncServer = server;
            cookieSyncServerPort = port;
            config.cookie_sync_port = port;
            saveConfig(config);
            log('INFO', `[Cookie Sync] 本地同步服务已启动: http://127.0.0.1:${port}`);
            if (port !== COOKIE_SYNC_PORT) {
                log('INFO', `[Cookie Sync] 当前使用备用端口 ${port}`);
            }
            sendCookieSyncUpdate();
        });

        server.on('error', (error) => {
            log('ERROR', `[Cookie Sync] 本地同步服务异常: ${error.message}`);
        });
    };

    tryListen(0);
}

// ==================== 日志系统 ====================
function log(type, message) {
    const time = new Date().toLocaleTimeString();
    const logEntry = `[${time}] [${type}] ${message}`;
    console.log(logEntry);
    systemLogs.unshift({ time, type, message });
    if (systemLogs.length > 200) systemLogs.pop(); // 保留最近200条

    // 实时推送到前端
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log-update', { time, type, message });
    }
}

// ==================== 配置管理 ====================
function loadConfig() {
    const defaults = {
        output_dir: path.join(require('os').homedir(), 'Downloads'),
        cookies_file: '',
        cookie_source: 'file',
        cookie_browser: '',
        cookie_sync_token: generatePairToken(),
        cookie_sync_port: COOKIE_SYNC_PORT,
        cookie_sync_browser: '',
        cookie_sync_last_sync: '',
        cookie_sync_last_count: 0,
        cookie_sync_paired_at: '',
        cookie_sync_last_mode: ''
    };

    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const mergedConfig = {
                ...defaults,
                ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
            };

            if (['browser', 'login-browser', 'youtube-login'].includes(mergedConfig.cookie_source)) {
                mergedConfig.cookie_source = 'file';
                mergedConfig.cookie_browser = '';
            }

            return mergedConfig;
        }
    } catch (e) {
        log('ERROR', '加载配置失败: ' + e.message);
    }
    return defaults;
}

function saveConfig(cfg) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (e) {
        log('ERROR', '保存配置失败: ' + e.message);
    }
}

function loadTasks() {
    try {
        if (fs.existsSync(TASKS_FILE)) {
            return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
        }
    } catch (e) {
        log('ERROR', '加载任务失败: ' + e.message);
    }
    return [];
}

function saveTasks(tasks) {
    try {
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (e) {
        log('ERROR', '保存任务失败: ' + e.message);
    }
}

function isPathInside(rootPath, candidatePath) {
    const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
    return relativePath !== ''
        && !relativePath.startsWith(`..${path.sep}`)
        && relativePath !== '..'
        && !path.isAbsolute(relativePath);
}

function getTrackedOutputRecords(task) {
    const records = [];
    const appendRecords = (item, fallbackOutputDir = '') => {
        if (!item) return;
        const outputDir = item.output_dir || fallbackOutputDir;
        const outputFiles = Array.isArray(item.output_files) ? item.output_files : [];
        outputFiles.forEach((filePath) => {
            if (outputDir && filePath) {
                records.push({ outputDir, filePath });
            }
        });
    };

    appendRecords(task);
    (Array.isArray(task?.entries) ? task.entries : []).forEach((entry) => {
        appendRecords(entry, task.output_dir || '');
    });
    return records;
}

function deleteTrackedOutputFiles(task) {
    const result = { deletedFiles: 0, missingFiles: 0, skippedFiles: 0 };
    const records = getTrackedOutputRecords(task);
    const seen = new Set();

    records.forEach(({ outputDir, filePath }) => {
        const resolvedOutputDir = path.resolve(outputDir);
        const resolvedFilePath = path.resolve(filePath);
        const pathKey = resolvedFilePath.toLowerCase();

        if (seen.has(pathKey)) return;
        seen.add(pathKey);

        if (!isPathInside(resolvedOutputDir, resolvedFilePath)) {
            result.skippedFiles += 1;
            log('WARN', `[Delete] 跳过下载目录外的文件: ${resolvedFilePath}`);
            return;
        }

        if (!fs.existsSync(resolvedFilePath)) {
            result.missingFiles += 1;
            return;
        }

        try {
            const stat = fs.lstatSync(resolvedFilePath);
            if (!stat.isFile() && !stat.isSymbolicLink()) {
                result.skippedFiles += 1;
                log('WARN', `[Delete] 跳过非文件路径: ${resolvedFilePath}`);
                return;
            }

            fs.unlinkSync(resolvedFilePath);
            result.deletedFiles += 1;
            log('INFO', `[Delete] 已删除文件: ${resolvedFilePath}`);
        } catch (error) {
            result.skippedFiles += 1;
            log('WARN', `[Delete] 删除文件失败: ${resolvedFilePath} - ${error.message}`);
        }
    });

    if (records.length === 0) {
        result.skippedFiles += 1;
        log('WARN', `[Delete] 任务 ${task?.task_id || 'unknown'} 没有精确文件路径，仅删除记录`);
    }

    return result;
}

// ==================== 窗口创建 ====================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'YT下载器',
        backgroundColor: '#F5F7FA',
        autoHideMenuBar: true, // 隐藏菜单栏
        icon: APP_ICON,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    // 开发模式下打开 DevTools
    if (!app.isPackaged) {
        // mainWindow.webContents.openDevTools(); // 用户请求关闭调试窗口
    }
}

// 统一的启动逻辑
app.whenReady().then(() => {
    log('INFO', '应用启动');
    log('INFO', `APP_DIR: ${APP_DIR}`);
    log('INFO', `DATA_DIR: ${DATA_DIR}`);
    log('INFO', `YTDLP_EXE: ${getYtdlpExePath()}`);
    syncCookieFilePreference();

    // 检查版本
    checkYtdlpVersion();
    checkFFmpeg();
    checkNode();
    startCookieSyncServer();

    // 创建窗口
    createWindow();

    // 修复 B站缩略图 referer 问题 - 拦截所有请求
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const url = details.url.toLowerCase();
        // 检查是否是 B站相关域名
        if (url.includes('hdslb.com') || url.includes('bilibili.com') || url.includes('bilivideo.com') || url.includes('biliimg.com')) {
            details.requestHeaders['Referer'] = 'https://www.bilibili.com/';
            details.requestHeaders['Origin'] = 'https://www.bilibili.com';
        }
        callback({ requestHeaders: details.requestHeaders });
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (cookieSyncServer) {
        cookieSyncServer.close();
        cookieSyncServer = null;
        cookieSyncServerPort = 0;
    }
});

function checkYtdlpVersion() {
    return new Promise((resolve) => {
        execFile(getYtdlpExePath(), ['--version'], { env: getChildProcessEnv() }, (error, stdout) => {
            if (error) {
                ytdlpVersion = '未检测到';
                log('ERROR', `yt-dlp 版本检测失败: ${error.message}`);
            } else {
                ytdlpVersion = stdout.trim();
                log('INFO', `检测到 yt-dlp 版本: ${ytdlpVersion}`);
            }
            resolve(ytdlpVersion);
        });
    });
}

function checkFFmpeg() {
    // 首先检查 RESOURCES_DIR 下的 ffmpeg.exe
    const ffmpegExe = path.join(RESOURCES_DIR, 'ffmpeg.exe');
    if (fs.existsSync(ffmpegExe)) {
        require('child_process').execFile(ffmpegExe, ['-version'], (error, stdout) => {
            if (error) {
                log('ERROR', `内置 FFmpeg 执行失败: ${error.message}`);
            } else {
                const match = stdout.match(/ffmpeg version (\S+)/);
                log('INFO', `FFmpeg 检测正常: ${match ? match[1] : '未知版本'}`);
            }
        });
        return;
    }

    // 回退到系统 PATH
    require('child_process').exec('ffmpeg -version', (error, stdout) => {
        if (error) {
            log('ERROR', '未检测到 FFmpeg! 高画质视频(4K/8K)可能无法解析或下载。请确保 ffmpeg 在环境变量中。');
            log('ERROR', `System PATH: ${process.env.PATH}`);
        } else {
            const match = stdout.match(/ffmpeg version (\S+)/);
            log('INFO', `FFmpeg 检测正常: ${match ? match[1] : '未知版本'}`);
        }
    });
}

function checkNode() {
    const runtime = getPreferredJsRuntime();
    if (runtime) {
        const runtimeHint = runtime === 'node' && fs.existsSync(BUNDLED_NODE_EXE)
            ? ` (内置: ${BUNDLED_NODE_EXE})`
            : '';
        log('INFO', `JavaScript Runtime 检测正常: ${runtime}${runtimeHint}`);
    } else {
        log('INFO', '未检测到可用的 JavaScript Runtime（YouTube 解析可能受限）');
    }
}

// ==================== IPC 处理 ====================

// 获取日志
ipcMain.handle('get-logs', () => systemLogs);

// 获取 yt-dlp 版本
ipcMain.handle('get-ytdlp-version', () => ytdlpVersion);

ipcMain.handle('check-app-update', async () => {
    try {
        const release = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
        const latestVersion = normalizeVersion(release.tag_name || release.name || '');
        const currentVersion = normalizeVersion(packageJson.version);
        const installerAsset = Array.isArray(release.assets)
            ? release.assets.find(asset => /setup .*\.exe$/i.test(asset.name || ''))
            : null;

        if (!latestVersion) {
            return { success: false, message: '无法识别远程版本号' };
        }

        return {
            success: true,
            currentVersion,
            latestVersion,
            hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
            releaseUrl: release.html_url,
            downloadUrl: installerAsset ? installerAsset.browser_download_url : release.html_url,
            publishedAt: release.published_at || '',
            notes: release.body || ''
        };
    } catch (error) {
        log('ERROR', `[Update] 检查应用更新失败: ${error.message}`);
        return { success: false, message: error.message };
    }
});

// 更新 yt-dlp
ipcMain.handle('update-core', async () => {
    return new Promise((resolve) => {
        log('INFO', '正在手动更新 yt-dlp components...');
        require('child_process').execFile(getYtdlpExePath(), ['-U'], { env: getChildProcessEnv() }, (error, stdout, stderr) => {
            if (error) {
                log('ERROR', `更新失败: ${error.message}`);
                resolve({ success: false, message: error.message });
            } else {
                log('INFO', `更新输出: ${stdout}`);
                // 检测是否已是最新版本
                const isUpToDate = stdout.toLowerCase().includes('is up to date') ||
                    stdout.includes('已是最新') ||
                    stdout.includes('up-to-date');

                checkYtdlpVersion().then((version) => {
                    resolve({
                        success: true,
                        output: stdout,
                        isUpToDate: isUpToDate,
                        version
                    });
                });
            }
        });
    });
});

// 获取配置
ipcMain.handle('get-config', () => config);

// 设置下载目录
ipcMain.handle('set-output-dir', (event, dir) => {
    if (fs.existsSync(dir)) {
        config.output_dir = dir;
        saveConfig(config);
        return { success: true };
    }
    return { success: false, error: '无效的目录' };
});

// 选择目录
ipcMain.handle('choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        defaultPath: config.output_dir
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const dir = result.filePaths[0];
        config.output_dir = dir;
        saveConfig(config);
        return { success: true, path: dir };
    }
    return { success: false, cancelled: true };
});

// 打开文件夹
ipcMain.handle('open-folder', () => {
    shell.openPath(config.output_dir);
    return { success: true };
});

ipcMain.handle('get-cookie-sync-status', () => getCookieSyncStatus());

ipcMain.handle('open-extension-folder', async () => {
    ensureExtensionFiles();
    const targetPath = fs.existsSync(EXTENSION_DIR) ? EXTENSION_DIR : APP_DIR;
    const result = await shell.openPath(targetPath);
    if (result) {
        return { success: false, message: result };
    }
    return { success: true, path: targetPath };
});

ipcMain.handle('reset-cookie-sync-token', () => {
    config.cookie_sync_token = generatePairToken();
    config.cookie_sync_paired_at = '';
    config.cookie_sync_browser = '';
    config.cookie_sync_last_sync = '';
    config.cookie_sync_last_count = 0;
    config.cookie_sync_last_mode = '';
    saveConfig(config);
    log('INFO', '[Cookie Sync] 已重新生成配对码');
    sendCookieSyncUpdate();
    return getCookieSyncStatus();
});

ipcMain.handle('activate-plugin-cookie-source', () => {
    const result = activatePluginCookieSource();
    log('INFO', '[Cookie Sync] 已切换为浏览器插件同步来源');
    return result;
});

// 获取任务列表
// 获取任务列表
ipcMain.handle('get-tasks', () => Object.values(activeTasks).map(createTaskSnapshot));
ipcMain.handle('get-completed-tasks', () => completedTasks);

// 清空已完成任务（支持同时删除文件）
ipcMain.handle('clear-completed-tasks', (event, deleteFiles = false) => {
    const deleteResult = { deletedFiles: 0, missingFiles: 0, skippedFiles: 0 };

    if (deleteFiles) {
        completedTasks.forEach((task) => {
            const taskResult = deleteTrackedOutputFiles(task);
            deleteResult.deletedFiles += taskResult.deletedFiles;
            deleteResult.missingFiles += taskResult.missingFiles;
            deleteResult.skippedFiles += taskResult.skippedFiles;
        });
    }

    completedTasks = [];
    saveTasks([]);
    return { success: true, ...deleteResult };
});

// 删除单个已完成任务（支持同时删除文件）
ipcMain.handle('delete-completed-task', (event, taskId, deleteFiles = false) => {
    const task = completedTasks.find(t => t.task_id === taskId);
    let deleteResult = { deletedFiles: 0, missingFiles: 0, skippedFiles: 0 };

    if (deleteFiles && task) {
        deleteResult = deleteTrackedOutputFiles(task);
    }

    completedTasks = completedTasks.filter(t => t.task_id !== taskId);
    saveTasks(completedTasks);
    return { success: true, ...deleteResult };
});

// 打开外部链接
ipcMain.handle('open-external', async (event, url) => {
    try {
        const parsedUrl = new URL(String(url || ''));
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return { success: false, message: '仅允许打开 HTTP/HTTPS 链接' };
        }
        await shell.openExternal(parsedUrl.toString());
        return { success: true };
    } catch (error) {
        return { success: false, message: '无效的外部链接' };
    }
});

// 从剪贴板粘贴
ipcMain.handle('paste-from-clipboard', () => {
    const { clipboard } = require('electron');
    return { success: true, text: clipboard.readText() };
});

// 选择 Cookie 文件
ipcMain.handle('choose-cookie-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Cookie 文件', extensions: ['txt'] }
        ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const file = result.filePaths[0];
        config.cookies_file = file;
        config.cookie_source = 'file'; // Set source to file
        config.cookie_browser = '';
        saveConfig(config);
        console.log('[Cookie] 已设置 Cookie 文件:', file);
        return { success: true, message: 'Cookie 文件已设置', path: file };
    }
    return { success: false, cancelled: true };
});

// 设置 Cookie 浏览器 (废弃，保留兼容)
ipcMain.handle('set-cookie-browser', () => {
    return { success: false, message: '已移除本机浏览器直读，请改用浏览器插件同步' };
});

// 切换回本地文件（不重新上传）
ipcMain.handle('set-cookie-source-file', () => {
    config.cookie_source = 'file';
    config.cookie_browser = '';
    saveConfig(config);
    log('INFO', '[Cookie] 已切换回本地文件');
    return { success: true };
});

// 开始下载 (解析)
ipcMain.handle('start-download', async (event, url) => {
    if (!url || !url.trim()) {
        return { success: false, error: '请输入有效的 URL' };
    }

    // 规范化 URL（去除尾部斜杠、统一小写域名）
    let trimmedUrl = url.trim();
    try {
        const urlObj = new URL(trimmedUrl);
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return { success: false, error: '仅支持 HTTP/HTTPS 视频链接' };
        }
        urlObj.hostname = urlObj.hostname.toLowerCase();
        // 移除常见的追踪参数
        ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'tracking_source'].forEach(p => urlObj.searchParams.delete(p));
        trimmedUrl = urlObj.toString().replace(/\/$/, ''); // 移除尾部斜杠
    } catch (e) {
        return { success: false, error: '请输入有效的视频链接' };
    }

    log('INFO', `[start-download] 检查 URL: ${trimmedUrl}`);
    log('INFO', `[start-download] 当前活跃任务数: ${Object.keys(activeTasks).length}`);

    // 防重复：检查是否有相同 URL 的任务正在进行中
    const existingTask = Object.values(activeTasks).find(t => {
        // 同样规范化已有任务的 URL
        let existingUrl = t.url;
        try {
            const urlObj = new URL(existingUrl);
            urlObj.hostname = urlObj.hostname.toLowerCase();
            ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'tracking_source'].forEach(p => urlObj.searchParams.delete(p));
            existingUrl = urlObj.toString().replace(/\/$/, '');
        } catch (e) { }

        return existingUrl === trimmedUrl && ['parsing', 'waiting', 'downloading', 'processing'].includes(t.status);
    });

    if (existingTask) {
        log('WARN', `[start-download] URL 已存在进行中的任务: ${existingTask.task_id} (状态: ${existingTask.status})`);
        return { success: false, error: '该视频已在任务列表中' };
    }

    const taskId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const task = {
        task_id: taskId,
        url: trimmedUrl,
        title: '正在解析...',
        thumbnail: '',
        status: 'parsing',
        progress: 0,
        speed: '',
        eta: '',
        formats: [],
        error_message: '',
        cookie_source: config.cookie_source,
        cookie_browser: config.cookie_browser || '',
        _parseRequestId: 0,
        _parseStartedAt: 0
    };

    activeTasks[taskId] = task;
    sendTaskUpdate(task);

    // 异步解析
    parseFormats(task);

    return { success: true, task_id: taskId };
});

// 选择格式并下载
ipcMain.handle('select-format-and-download', (event, taskId, formatId) => {
    const task = activeTasks[taskId];
    if (!task) {
        return { success: false, error: '任务不存在' };
    }

    task.format_id = formatId;
    task.status = 'downloading';
    sendTaskUpdate(task);

    downloadVideo(task);

    return { success: true };
});

// 取消任务
ipcMain.handle('cancel-task', async (event, taskId) => {
    const task = activeTasks[taskId];
    if (task) {
        if (!task._process && ['waiting', 'failed'].includes(task.status)) {
            delete activeTasks[taskId];
            log('INFO', `[Cancel] 已移除任务 ${taskId}`);
            return { success: true, removed: true };
        }

        task._cancelRequested = true;
        task.status = 'cancelled';
        const pid = task._process?.pid;
        task._cancelledProcessPid = pid || 0;
        task._parseRequestId = (task._parseRequestId || 0) + 1;
        log('INFO', `[Cancel] 请求取消任务 ${taskId}, pid=${pid || 'unknown'}`);
        let terminationResult = { success: true, message: '' };
        if (task._process) {
            terminationResult = terminateProcessTree(task._process, 'Cancel');
        }
        if (task._request) {
            task._request.abort();
        }
        if (task._downloadStream) {
            task._downloadStream.destroy();
        }

        sendTaskUpdate(task);

        await delay(1200);
        if (!terminationResult.success || isPidRunning(pid)) {
            task.status = 'failed';
            task.error_message = `取消失败：${terminationResult.message || '后台进程仍在运行'}`;
            task._cancelRequested = false;
            log('ERROR', `[Cancel] 任务 ${taskId} 取消失败: ${task.error_message}`);
            sendTaskUpdate(task);
            return { success: false, error: task.error_message };
        }

        if (!task.formats || task.formats.length === 0) {
            delete activeTasks[taskId];
            log('INFO', `[Cancel] 解析任务 ${taskId} 已移除`);
            return { success: true, removed: true };
        }

        cleanupCancelledArtifacts(task);
        task._cancelRequested = false;
        task._process = null;
        task._request = null;
        task._downloadStream = null;
        task.progress = 0;
        task.speed = '';
        task.eta = '';
        task.error_message = '';
        task.status = 'waiting';
        (Array.isArray(task.entries) ? task.entries : []).forEach((entry) => {
            if (entry.status === 'downloading') {
                entry.status = 'waiting';
                entry.progress = 0;
                entry.speed = '';
                entry.eta = '';
            }
        });
        log('INFO', `[Cancel] 任务 ${taskId} 已成功取消`);
        sendTaskUpdate(task);
        return { success: true, status: 'waiting' };
    }
    return { success: false, error: '任务不存在' };
});

// 重新解析任务
ipcMain.handle('retry-task', (event, taskId) => {
    const task = activeTasks[taskId];
    if (task && (task.status === 'failed' || task.status === 'parsing')) {
        task.status = 'parsing';
        task.error_message = '';
        sendTaskUpdate(task);
        parseFormats(task);
        return { success: true };
    }
    return { success: false, error: '任务不存在或状态不正确' };
});

// Behance: 更新视频选择状态
ipcMain.handle('update-behance-selection', (event, taskId, entryId, selected) => {
    const task = activeTasks[taskId];
    if (task && task.entries) {
        const entry = task.entries.find(e => e.id === entryId);
        if (entry) {
            entry.selected = selected;
            sendTaskUpdate(task);
            return { success: true };
        }
    }
    return { success: false, error: '未找到视频' };
});

// Behance: 更新视频格式
ipcMain.handle('update-behance-format', (event, taskId, entryId, formatId) => {
    const task = activeTasks[taskId];
    if (task && task.entries) {
        const entry = task.entries.find(e => e.id === entryId);
        if (entry) {
            entry.format_id = formatId;
            sendTaskUpdate(task);
            return { success: true };
        }
    }
    return { success: false, error: '未找到视频' };
});

// Behance: 开始下载选中视频
ipcMain.handle('download-behance-videos', (event, taskId) => {
    const task = activeTasks[taskId];
    if (!task || !task.entries) {
        return { success: false, error: '任务不存在' };
    }

    const selectedEntries = task.entries.filter(e => e.selected);
    if (selectedEntries.length === 0) {
        return { success: false, error: '请至少选择一个视频' };
    }

    task.status = 'downloading';
    task.currentEntryIndex = 0;
    task.totalEntries = selectedEntries.length;
    sendTaskUpdate(task);

    downloadBehanceVideos(task);
    return { success: true };
});

// 图片代理下载 (绕过防盗链)
ipcMain.handle('download-image', async (event, url) => {
    if (!url) {
        log('WARN', '图片代理: URL 为空');
        return null;
    }

    return new Promise((resolve) => {
        let settled = false;
        let timeout = null;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve(value);
        };

        try {
            let processedUrl = url;
            if (processedUrl.startsWith('//')) {
                processedUrl = 'https:' + processedUrl;
            } else if (processedUrl.startsWith('http://')) {
                processedUrl = processedUrl.replace('http://', 'https://');
            }

            const parsedUrl = new URL(processedUrl);
            if (!isSafeProxyImageUrl(parsedUrl)) {
                log('WARN', `图片代理: 拒绝不安全地址 ${parsedUrl.hostname}`);
                finish(null);
                return;
            }

            const request = net.request(processedUrl);
            request.setHeader('Referer', getImageReferer(processedUrl));
            request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            timeout = setTimeout(() => {
                log('WARN', `图片代理: 请求超时 ${parsedUrl.hostname}`);
                request.abort();
                finish(null);
            }, PROXY_IMAGE_TIMEOUT_MS);

            request.on('response', (response) => {
                const contentTypeHeader = response.headers['content-type'];
                const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : (contentTypeHeader || '');
                const contentLengthHeader = response.headers['content-length'];
                const contentLength = Number(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader);

                if (response.statusCode !== 200 || !String(contentType).toLowerCase().startsWith('image/')) {
                    log('WARN', `图片代理: 响应无效 ${response.statusCode} ${parsedUrl.hostname}`);
                    request.abort();
                    finish(null);
                    return;
                }
                if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_IMAGE_BYTES) {
                    log('WARN', `图片代理: 图片超过大小限制 ${contentLength} 字节`);
                    request.abort();
                    finish(null);
                    return;
                }

                const chunks = [];
                let totalBytes = 0;
                response.on('data', (chunk) => {
                    if (settled) return;
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_PROXY_IMAGE_BYTES) {
                        log('WARN', `图片代理: 图片超过大小限制 ${totalBytes} 字节`);
                        request.abort();
                        finish(null);
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    if (settled) return;
                    const buffer = Buffer.concat(chunks);
                    log('INFO', `图片代理: 成功下载 ${buffer.length} 字节`);
                    finish(`data:${contentType};base64,${buffer.toString('base64')}`);
                });
            });

            request.on('error', (error) => {
                log('ERROR', `图片代理: 网络错误 - ${error.message}`);
                finish(null);
            });

            request.end();
        } catch (e) {
            log('ERROR', `图片代理: 异常 - ${e.message}`);
            finish(null);
        }
    });
});

function isSafeProxyImageUrl(parsedUrl) {
    if (!parsedUrl || parsedUrl.protocol !== 'https:') return false;

    const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;

    const ipVersion = nodeNet.isIP(hostname);
    if (ipVersion === 4) {
        const octets = hostname.split('.').map(Number);
        return !(octets[0] === 10
            || octets[0] === 127
            || octets[0] === 0
            || (octets[0] === 169 && octets[1] === 254)
            || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] === 192 && octets[1] === 168));
    }
    if (ipVersion === 6) {
        return hostname !== '::1'
            && !hostname.startsWith('fc')
            && !hostname.startsWith('fd')
            && !hostname.startsWith('fe80:');
    }

    return true;
}

function getImageReferer(imageUrl) {
    try {
        const hostname = new URL(imageUrl).hostname.toLowerCase();
        if (hostname.includes('vimeo.com') || hostname.includes('vimeocdn.com')) {
            return 'https://vimeo.com/';
        }
        if (hostname.includes('bilibili.com') || hostname.includes('hdslb.com')) {
            return 'https://www.bilibili.com/';
        }
        if (hostname.includes('ytimg.com') || hostname.includes('youtube.com') || hostname.includes('googlevideo.com')) {
            return 'https://www.youtube.com/';
        }
        return `https://${hostname}/`;
    } catch (error) {
        return 'https://www.bilibili.com/';
    }
}

// ==================== yt-dlp 封装 ====================

function sendTaskUpdate(task) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task-update', createTaskSnapshot(task));
    }
}

function createTaskSnapshot(task) {
    const snapshot = { ...task };
    delete snapshot._process;
    delete snapshot._request;
    delete snapshot._downloadStream;
    delete snapshot._artlistAudioUrl;
    delete snapshot._tempFile;
    return snapshot;
}

function normalizeYtdlpErrorMessage(message, task) {
    const rawMessage = message || '';

    if (task?.status === 'cancelled') {
        return '已取消';
    }

    if (rawMessage.includes('Could not copy Chrome cookie database')) {
        const browserLabel = task?.cookie_browser === 'edge' || config.cookie_browser === 'edge' ? 'Edge' : 'Chrome';
        return `无法读取 ${browserLabel} 登录态，请先完全关闭 ${browserLabel} 后重试；如果仍失败，请改用 cookies.txt`;
    }

    if (rawMessage.includes('Could not copy Edge cookie database')) {
        return '无法读取 Edge 登录态，请先完全关闭 Edge 后重试；如果仍失败，请改用 cookies.txt';
    }

    if (rawMessage.includes('n challenge solving failed')) {
        if (getPreferredJsRuntime()) {
            return 'YouTube 解析失败：已检测到登录态，但 JS 挑战未完成，请先更新 yt-dlp 核心后重试';
        }
        return 'YouTube 解析失败：未检测到可用的 JavaScript Runtime，请安装 Node.js 后重试';
    }

    return rawMessage;
}

function requestArtlistPage(task) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const chunks = [];
        let totalBytes = 0;
        const request = net.request({ method: 'GET', url: task.url });
        task._request = request;

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (task._request === request) task._request = null;
            if (error) reject(error);
            else resolve(value);
        };

        request.setHeader('User-Agent', ART_LIST_USER_AGENT);
        request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
        request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
        request.on('redirect', (statusCode, method, redirectUrl) => {
            if (!isArtlistUrl(redirectUrl)) {
                request.abort();
                finish(new Error('Artlist 页面重定向到了不受支持的地址'));
                return;
            }
            request.followRedirect();
        });
        request.on('response', (response) => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                request.abort();
                finish(new Error(`Artlist 页面请求失败（HTTP ${response.statusCode}）`));
                return;
            }
            response.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > 20 * 1024 * 1024) {
                    request.abort();
                    finish(new Error('Artlist 页面超过大小限制'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
            response.on('error', (error) => finish(error));
        });
        request.on('error', (error) => finish(error));
        timer = setTimeout(() => {
            request.abort();
            finish(new Error('Artlist 页面请求超时'));
        }, 45000);
        request.end();
    });
}

async function parseArtlistTask(task) {
    task._parseRequestId = (task._parseRequestId || 0) + 1;
    const requestId = task._parseRequestId;
    task._parseStartedAt = Date.now();
    task.error_message = '';
    log('INFO', `[parseArtlistTask] 开始解析: ${task.url}`);

    try {
        const parsed = isSafeArtlistAudioUrl(task.url)
            ? { title: 'artlist_audio', artist: '', songId: '', audioUrl: task.url }
            : parseArtlistPage(await requestArtlistPage(task), task.url);
        if (!activeTasks[task.task_id] || task._cancelRequested || task._parseRequestId !== requestId) return;

        task.isArtlist = true;
        task.title = parsed.artist ? `${parsed.title} - ${parsed.artist}` : parsed.title;
        task.artist = parsed.artist;
        task.song_id = parsed.songId;
        task._artlistAudioUrl = parsed.audioUrl;
        task.formats = [{
            format_id: 'artlist-preview',
            resolution: 'Artlist 试听音频',
            ext: guessArtlistExtension(parsed.audioUrl),
            filesize: '自动',
            hasAudio: true,
            mp4Compatible: false
        }];
        task.status = 'waiting';
        sendTaskUpdate(task);
        log('INFO', `[parseArtlistTask] 解析成功: ${task.title} - ${task.artist}`);
    } catch (error) {
        if (!activeTasks[task.task_id] || task._cancelRequested) return;
        task.status = 'failed';
        task.error_message = error.message || 'Artlist 解析失败';
        log('ERROR', `[parseArtlistTask] ${task.error_message}`);
        sendTaskUpdate(task);
    } finally {
        if (task._request && task._parseRequestId === requestId) task._request = null;
    }
}

function parseFormats(task, attempt = 1) {
    if (!task || task._cancelRequested) return;

    if (isArtlistUrl(task.url)) {
        parseArtlistTask(task);
        return;
    }

    task._parseRequestId = (task._parseRequestId || 0) + 1;
    task._parseStartedAt = Date.now();
    const currentParseRequestId = task._parseRequestId;
    log('INFO', `[parseFormats] 开始解析: ${task.url}`);

    // 检测是否为 Behance URL（Behance 页面可能包含多个视频）
    const isBehance = task.url.includes('behance.net');

    // 对 Behance 不使用 --no-playlist，以获取所有视频
    const args = isBehance
        ? ['-J', '--no-cache-dir', '--no-update', task.url]
        : ['-J', '--no-playlist', '--no-cache-dir', '--no-update', task.url];
    appendPreferredJsRuntime(args);

    // Cookie logic (same as downloadVideo)
    const activeCookieFile = resolveActiveCookieFile();
    if (config.cookie_source === 'browser' && config.cookie_browser) {
        args.push('--cookies-from-browser', config.cookie_browser);
    } else if (activeCookieFile) {
        args.push('--cookies', activeCookieFile);
    }

    log('INFO', `[parseFormats] 执行命令: yt-dlp ${args.join(' ')}`);

    const child = execFile(getYtdlpExePath(), args, { maxBuffer: 50 * 1024 * 1024, env: getChildProcessEnv() }, async (error, stdout, stderr) => {
        if (!activeTasks[task.task_id] || task._cancelRequested || task._parseRequestId !== currentParseRequestId) {
            log('INFO', `[parseFormats] 忽略过期解析结果: ${task.task_id}`);
            return;
        }

        log('INFO', '[parseFormats] 执行完成');
        if (error) {
            log('ERROR', `[parseFormats] 错误: ${error.message}`);
            if (stderr) log('ERROR', `[parseFormats] stderr: ${stderr}`);
            log('ERROR', `[parseFormats] System PATH: ${process.env.PATH}`);

            const rawMessage = `${stderr || ''}\n${error.message || ''}`;
            const isRetriableVimeo503 = attempt === 1
                && task.url.includes('vimeo.com')
                && /503|service unavailable/i.test(rawMessage);
            if (isRetriableVimeo503) {
                log('WARN', '[parseFormats] Vimeo 解析遇到 503，1200ms 后自动重试一次');
                await delay(1200);
                if (activeTasks[task.task_id] && !task._cancelRequested && task._parseRequestId === currentParseRequestId) {
                    parseFormats(task, attempt + 1);
                }
                return;
            }

            task.status = 'failed';
            task.error_message = normalizeYtdlpErrorMessage(stderr || error.message, task);
            sendTaskUpdate(task);
            return;
        }

        try {
            const info = JSON.parse(stdout);

            // 检测是否为多视频（Behance playlist）
            const isBehance = task.url.includes('behance.net');
            const hasEntries = info.entries && Array.isArray(info.entries) && info.entries.length > 0;

            if (isBehance && hasEntries) {
                // Behance 多视频处理
                log('INFO', `[parseFormats] Behance 多视频检测: ${info.entries.length} 个视频`);

                task.isBehance = true;
                task.title = info.title || info.entries[0]?.title || task.url;
                task.thumbnail = pickBestThumbnail(info) || pickBestThumbnail(info.entries[0]) || '';

                // 解析每个视频
                task.entries = info.entries.map((entry, index) => {
                    const entryFormats = parseVideoFormats(entry.formats || []);
                    return {
                        id: index,
                        title: entry.title || `视频 ${index + 1}`,
                        thumbnail: pickBestThumbnail(entry) || '',
                        url: entry.webpage_url || entry.url || task.url,
                        formats: entryFormats,
                        selected: true,  // 默认全选
                        format_id: 'bestvideo+bestaudio/best'  // 默认最高画质
                    };
                });

                // 第一个视频的格式作为主格式（向后兼容）
                task.formats = task.entries[0]?.formats || [];
                task.status = 'waiting';
                sendTaskUpdate(task);
            } else {
                // 单视频处理（原有逻辑）
                task.title = info.title || task.url;
                task.thumbnail = pickBestThumbnail(info) || '';
                task.formats = parseVideoFormats(info.formats || []);
                task.status = 'waiting';
                sendTaskUpdate(task);
            }
        } catch (e) {
            task.status = 'failed';
            task.error_message = '解析失败: ' + e.message;
            sendTaskUpdate(task);
        }
    });

    task._process = child;
    const parseTimeout = setTimeout(() => {
        if (!activeTasks[task.task_id] || task._cancelRequested || task._parseRequestId !== currentParseRequestId) {
            return;
        }

        log('WARN', `[parseFormats] 解析超时: ${task.task_id}`);
        terminateProcessTree(child, 'Parse Timeout');

        if (activeTasks[task.task_id] && !task._cancelRequested && task._parseRequestId === currentParseRequestId) {
            task.status = 'failed';
            task.error_message = '解析超时，请重试';
            sendTaskUpdate(task);
        }
    }, 45000);

    child.on('close', () => {
        clearTimeout(parseTimeout);
        if (task._process === child) {
            task._process = null;
        }
    });

    child.on('error', () => {
        clearTimeout(parseTimeout);
        if (task._process === child) {
            task._process = null;
        }
    });
}

function pickBestThumbnail(info) {
    if (!info || typeof info !== 'object') return '';

    const directThumbnail = String(info.thumbnail || '').trim();
    if (directThumbnail) return directThumbnail;

    const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];
    if (thumbnails.length === 0) return '';

    const sorted = [...thumbnails]
        .filter((item) => item && item.url)
        .sort((left, right) => {
            const leftScore = (left.preference || 0) * 1000000 + (left.width || 0) * (left.height || 0);
            const rightScore = (right.preference || 0) * 1000000 + (right.width || 0) * (right.height || 0);
            return rightScore - leftScore;
        });

    return sorted[0]?.url || '';
}

// 辅助函数：解析视频格式列表
function parseVideoFormats(allFormats) {
    const formats = [
        { format_id: 'bestvideo+bestaudio/best', resolution: '🔥 最高画质', ext: 'auto', filesize: '自动', hasAudio: true }
    ];

    const seenHeights = new Set();
    const hasMp4CompatibleAudio = allFormats.some((f) => {
        if (!f || f.acodec === 'none') return false;
        const ext = String(f.ext || '').toLowerCase();
        const acodec = String(f.acodec || '').toLowerCase();
        return ['m4a', 'mp4', 'aac'].includes(ext) || acodec.includes('mp4a') || acodec.includes('aac');
    });
    log('INFO', `[parseVideoFormats] 收到 ${allFormats.length} 个原始格式`);

    const rawFormats = allFormats
        .filter(f => f.height && f.vcodec !== 'none')
        .sort((a, b) => {
            const hDiff = (b.height || 0) - (a.height || 0);
            if (hDiff !== 0) return hDiff;
            const aHasAudio = a.acodec && a.acodec !== 'none' ? 1 : 0;
            const bHasAudio = b.acodec && b.acodec !== 'none' ? 1 : 0;
            if (bHasAudio !== aHasAudio) return bHasAudio - aHasAudio;
            const aIsMp4 = a.ext === 'mp4' ? 1 : 0;
            const bIsMp4 = b.ext === 'mp4' ? 1 : 0;
            if (bIsMp4 !== aIsMp4) return bIsMp4 - aIsMp4;
            return (b.tbr || 0) - (a.tbr || 0);
        });

    // 回退逻辑：针对可能没有 height 属性的站点
    if (rawFormats.length === 0 && allFormats.length > 0) {
        const fallbackFormats = allFormats
            .filter(f => f.vcodec !== 'none' || f.format_id?.includes('hls'))
            .sort((a, b) => (b.tbr || 0) - (a.tbr || 0));

        fallbackFormats.forEach(f => {
            if (!rawFormats.includes(f)) rawFormats.push(f);
        });
    }

    for (const f of rawFormats) {
        const key = f.height || f.format_id;
        if (seenHeights.has(key)) continue;
        seenHeights.add(key);

        let resolution = f.height ? `${f.height}p` : (f.resolution || f.format_note || '默认画质');
        if (f.height >= 2160) resolution += ' (4K)';
        else if (f.height >= 1440) resolution += ' (2K)';

        let extra = f.ext || 'mp4';
        if (f.vcodec && (f.vcodec.includes('av01') || f.vcodec.includes('vp9'))) {
            extra += ' (高效)';
        }
        if (f.fps > 30) extra += ` ${f.fps}fps`;

        const hasAudio = Boolean(f.acodec && f.acodec !== 'none');
        const extLower = String(f.ext || '').toLowerCase();
        const acodecLower = String(f.acodec || '').toLowerCase();
        const mp4Compatible = hasAudio
            ? (extLower === 'mp4' || acodecLower.includes('mp4a') || acodecLower.includes('aac'))
            : hasMp4CompatibleAudio;

        formats.push({
            format_id: f.format_id,
            resolution,
            ext: extra,
            filesize: f.filesize ? formatBytes(f.filesize) : '未知',
            hasAudio,
            mp4Compatible
        });
    }

    return formats;
}

function extractFormatHeight(value) {
    const text = String(value || '');
    const pMatch = text.match(/(\d+)p/i);
    if (pMatch) {
        return parseInt(pMatch[1], 10);
    }

    const dimensionMatch = text.match(/(\d{3,4})\s*[xX]\s*(\d{3,4})/);
    if (dimensionMatch) {
        return parseInt(dimensionMatch[2], 10);
    }

    return 0;
}

function normalizeFormatExt(ext) {
    const text = String(ext || '').trim();
    if (!text) return '';
    return text.split(/\s+/)[0].toLowerCase();
}

function getFormatSummary(task) {
    const selectedFormat = (task.formats || []).find(f => f.format_id === task.format_id);
    if (selectedFormat) {
        if (task.format_id === 'bestvideo+bestaudio/best') {
            const numericHeights = (task.formats || [])
                .map(f => extractFormatHeight(f.resolution))
                .filter(Boolean);
            const bestHeight = numericHeights.length > 0 ? `${Math.max(...numericHeights)}p` : '最高画质';
            return `${bestHeight} · ${getPreferredContainer(task)}`;
        }

        const resolutionText = selectedFormat.resolution || task.format_id;
        const extText = normalizeFormatExt(selectedFormat.ext) || getPreferredContainer(task);
        return `${resolutionText} · ${extText}`;
    }

    if (task.format_id === 'bestvideo+bestaudio/best') {
        return `最高画质 · ${getPreferredContainer(task)}`;
    }

    return task.format_id || '';
}

function getPreferredContainer(task) {
    const selectedFormat = (task.formats || []).find(f => f.format_id === task.format_id);
    if (!selectedFormat) return 'mkv';

    const height = extractFormatHeight(selectedFormat.resolution);
    if (height > 0 && height <= 1080 && selectedFormat.mp4Compatible !== false) {
        return 'mp4';
    }

    return 'mkv';
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidRunning(pid) {
    if (!pid) return false;
    if (process.platform !== 'win32') {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return false;
        }
    }

    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], {
        windowsHide: true,
        encoding: 'utf8'
    });
    return (result.stdout || '').includes(String(pid));
}

function getWindowsDescendantPids(rootPid) {
    if (process.platform !== 'win32' || !rootPid) return [];

    const script = [
        `$rootProcessId = ${Number(rootPid)}`,
        '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
        '$queue = [System.Collections.Generic.Queue[int]]::new()',
        '$queue.Enqueue($rootProcessId)',
        '$result = [System.Collections.Generic.List[int]]::new()',
        'while ($queue.Count -gt 0) {',
        '  $current = $queue.Dequeue()',
        '  foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $current }) {',
        '    $childId = [int]$child.ProcessId',
        '    $result.Add($childId)',
        '    $queue.Enqueue($childId)',
        '  }',
        '}',
        '$result | ForEach-Object { Write-Output $_ }'
    ].join('\n');

    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000
    });
    if (result.error) {
        log('WARN', `[Process] 无法枚举子进程: ${result.error.message}`);
        return [];
    }

    return (result.stdout || '')
        .split(/\r?\n/)
        .map(line => parseInt(line.trim(), 10))
        .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== rootPid);
}

function terminateProcessTree(child, contextLabel = 'Process') {
    const pid = child?.pid;
    let descendantPids = [];
    if (!pid) {
        return { success: true, pid: 0, message: '进程已退出' };
    }

    try {
        if (process.platform === 'win32') {
            descendantPids = getWindowsDescendantPids(pid);
            // 必须先按 PID 杀进程树，不能先终止父进程，否则 ffmpeg 可能变成孤儿进程。
            const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 10000
            });
            const stdout = (result.stdout || '').trim();
            const stderr = (result.stderr || '').trim();
            if (stdout) log('INFO', `[${contextLabel}] taskkill: ${stdout}`);
            if (stderr && isPidRunning(pid)) log('WARN', `[${contextLabel}] taskkill: ${stderr}`);

            // 某些启动方式会让后代进程在父进程退出后脱离进程树，因此再按取消前记录的 PID 清理。
            [...descendantPids].reverse().forEach((descendantPid) => {
                if (!isPidRunning(descendantPid)) return;
                spawnSync('taskkill', ['/PID', String(descendantPid), '/T', '/F'], {
                    windowsHide: true,
                    encoding: 'utf8',
                    timeout: 10000
                });
            });

            const remainingPids = [pid, ...descendantPids].filter(isPidRunning);
            if (remainingPids.length === 0) {
                return { success: true, pid };
            }
            log('WARN', `[${contextLabel}] 仍有进程未退出: ${remainingPids.join(', ')}`);
        } else {
            child.kill('SIGTERM');
            if (!isPidRunning(pid)) {
                return { success: true, pid };
            }
            child.kill('SIGKILL');
        }
    } catch (error) {
        log('WARN', `[${contextLabel}] 终止进程树失败: ${error.message}`);
    }

    try {
        if (isPidRunning(pid)) {
            child.kill('SIGKILL');
        }
        if (process.platform === 'win32') {
            [...descendantPids].reverse().forEach((descendantPid) => {
                if (isPidRunning(descendantPid)) {
                    spawnSync('taskkill', ['/PID', String(descendantPid), '/T', '/F'], {
                        windowsHide: true,
                        encoding: 'utf8',
                        timeout: 10000
                    });
                }
            });
        }
    } catch (error) {
        log('WARN', `[${contextLabel}] 最终终止失败: ${error.message}`);
    }

    const remainingPids = [pid, ...descendantPids].filter(isPidRunning);
    return {
        success: remainingPids.length === 0,
        pid,
        message: remainingPids.length > 0 ? `后台进程仍在运行: ${remainingPids.join(', ')}` : ''
    };
}

function createYtdlpOutputParser(target, onLine) {
    let buffer = '';

    const processLine = (line) => {
        const markerIndex = line.indexOf(YTDLP_OUTPUT_MARKER);
        if (markerIndex >= 0) {
            const outputPath = line.slice(markerIndex + YTDLP_OUTPUT_MARKER.length).trim();
            recordTaskOutputFile(target, outputPath);
            return;
        }
        onLine(line);
    };

    return {
        push(text) {
            buffer += text;
            const lines = buffer.split(/[\r\n]+/);
            buffer = lines.pop() || '';
            lines.forEach(processLine);
        },
        flush() {
            if (buffer) {
                processLine(buffer);
                buffer = '';
            }
        }
    };
}

function recordTaskOutputFile(target, filePath) {
    if (!target || !filePath) return;

    const outputDir = path.resolve(target.output_dir || config.output_dir);
    const resolvedFilePath = path.resolve(filePath);
    if (!isPathInside(outputDir, resolvedFilePath)) {
        log('WARN', `[Download] 忽略下载目录外的输出路径: ${resolvedFilePath}`);
        return;
    }

    if (!Array.isArray(target.output_files)) {
        target.output_files = [];
    }
    if (!target.output_files.includes(resolvedFilePath)) {
        target.output_files.push(resolvedFilePath);
        log('INFO', `[Download] 已记录输出文件: ${resolvedFilePath}`);
    }
}

function cleanupCancelledArtifacts(task) {
    try {
        const safeBaseName = sanitizeFileBase(task.title);
        const outputDir = config.output_dir;
        if (!fs.existsSync(outputDir)) return;

        const entries = fs.readdirSync(outputDir);
        entries.forEach((name) => {
            const lowerName = name.toLowerCase();
            const matchesBase = name.startsWith(safeBaseName);
            const isTemp = lowerName.endsWith('.part') || lowerName.endsWith('.ytdl') || lowerName.endsWith('.temp');
            if (matchesBase && isTemp) {
                const fullPath = path.join(outputDir, name);
                fs.rmSync(fullPath, { force: true });
                log('INFO', `[Cancel] 已清理临时文件: ${fullPath}`);
            }
        });
    } catch (error) {
        log('WARN', `[Cancel] 清理临时文件失败: ${error.message}`);
    }
}

function sanitizeFileBase(name) {
    return String(name || 'video')
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/[\u0000-\u001f]/g, '')
        .replace(/\s+/g, ' ')
        .trim() || 'video';
}

function createUniqueOutputTemplate(title, preferredExt) {
    const safeBaseName = sanitizeFileBase(title);
    let candidateBase = safeBaseName;
    let suffix = 1;

    while (fs.existsSync(path.join(config.output_dir, `${candidateBase}.${preferredExt}`))) {
        candidateBase = `${safeBaseName}_${suffix}`;
        suffix += 1;
    }

    return path.join(config.output_dir, `${candidateBase}.%(ext)s`);
}

function isCompletedFileNameBusy(baseName, preferredExt) {
    return fs.existsSync(path.join(config.output_dir, `${baseName}.${preferredExt}`));
}

function buildDownloadFormatSelector(task, preferredContainer) {
    const selectedFormatId = task.format_id || 'bestvideo+bestaudio/best';
    const selectedFormat = (task.formats || []).find(f => f.format_id === selectedFormatId);
    if (selectedFormatId === 'bestvideo+bestaudio/best') {
        if (preferredContainer === 'mp4') {
            return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best';
        }
        return 'bestvideo+bestaudio/best';
    }

    if (selectedFormat?.hasAudio) {
        return selectedFormatId;
    }

    if (preferredContainer === 'mp4') {
        return `${selectedFormatId}+bestaudio[ext=m4a]/${selectedFormatId}+bestaudio/best[ext=mp4]/best`;
    }

    return `${selectedFormatId}+bestaudio/best`;
}

function createUniqueArtlistOutputPath(task, extension) {
    const artist = task.artist && !task.title.toLowerCase().includes(task.artist.toLowerCase())
        ? ` - ${task.artist}`
        : '';
    const baseName = sanitizeFileBase(`${task.title}${artist}`).slice(0, 180);
    let candidate = path.join(task.output_dir, `${baseName}.${extension}`);
    let suffix = 1;
    while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.part`)) {
        candidate = path.join(task.output_dir, `${baseName} (${suffix}).${extension}`);
        suffix += 1;
    }
    return candidate;
}

function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const rounded = Math.ceil(seconds);
    const minutes = Math.floor(rounded / 60);
    const remaining = rounded % 60;
    return `${minutes.toString().padStart(2, '0')}:${remaining.toString().padStart(2, '0')}`;
}

function downloadArtlistAudio(task) {
    if (!isSafeArtlistAudioUrl(task._artlistAudioUrl)) {
        task.status = 'failed';
        task.error_message = 'Artlist 音频地址无效或不受支持';
        sendTaskUpdate(task);
        return;
    }

    fs.mkdirSync(path.resolve(config.output_dir), { recursive: true });
    task.output_dir = path.resolve(config.output_dir);
    task.output_files = [];
    task.startTime = Date.now();
    task.progress = 0;
    task.totalSize = '';

    const request = net.request({ method: 'GET', url: task._artlistAudioUrl });
    task._request = request;
    let settled = false;
    let timer = null;
    let outputPath = '';
    let tempPath = '';
    let stream = null;
    let receivedBytes = 0;
    const startedAt = Date.now();

    const cleanupTemp = () => {
        if (!tempPath) return;
        try {
            if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
        } catch (error) {
            log('WARN', `[Artlist] 清理临时文件失败: ${error.message}`);
        }
    };

    const finishError = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (stream) stream.destroy();
        cleanupTemp();
        if (task._request === request) task._request = null;
        if (task._downloadStream === stream) task._downloadStream = null;
        if (task._tempFile === tempPath) task._tempFile = null;
        if (!task._cancelRequested) {
            task.status = 'failed';
            task.error_message = error.message || 'Artlist 音频下载失败';
            sendTaskUpdate(task);
        }
    };

    request.setHeader('User-Agent', ART_LIST_USER_AGENT);
    request.setHeader('Referer', 'https://artlist.io/');
    request.setHeader('Origin', 'https://artlist.io');
    request.setHeader('Accept', '*/*');
    request.on('redirect', (statusCode, method, redirectUrl) => {
        if (!isSafeArtlistAudioUrl(redirectUrl)) {
            request.abort();
            finishError(new Error('Artlist 音频重定向到了不受支持的地址'));
            return;
        }
        request.followRedirect();
    });
    request.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
            request.abort();
            finishError(new Error(`Artlist 音频请求失败（HTTP ${response.statusCode}）`));
            return;
        }

        const contentTypeHeader = response.headers['content-type'];
        const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : (contentTypeHeader || '');
        const contentLengthHeader = response.headers['content-length'];
        const contentLength = Number(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader);
        const extension = guessArtlistExtension(task._artlistAudioUrl, contentType);
        outputPath = createUniqueArtlistOutputPath(task, extension);
        tempPath = `${outputPath}.part`;
        task._tempFile = tempPath;
        task.totalSize = Number.isFinite(contentLength) && contentLength > 0 ? formatBytes(contentLength) : '';

        try {
            stream = fs.createWriteStream(tempPath);
            task._downloadStream = stream;
        } catch (error) {
            finishError(error);
            return;
        }

        response.on('data', (chunk) => {
            if (settled || task._cancelRequested) return;
            receivedBytes += chunk.length;
            if (!stream.write(chunk)) response.pause();

            if (contentLength > 0) task.progress = Math.min(99.9, receivedBytes / contentLength * 100);
            const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
            task.speed = `${formatBytes(receivedBytes / elapsedSeconds)}/s`;
            if (contentLength > 0) task.eta = formatEta((contentLength - receivedBytes) / (receivedBytes / elapsedSeconds));
            task.status = 'downloading';
            sendTaskUpdate(task);
        });
        stream.on('drain', () => response.resume());
        response.on('end', () => {
            if (settled || task._cancelRequested) {
                cleanupTemp();
                return;
            }
            stream.end(() => {
                try {
                    fs.renameSync(tempPath, outputPath);
                    recordTaskOutputFile(task, outputPath);
                    settled = true;
                    if (timer) clearTimeout(timer);
                    if (task._request === request) task._request = null;
                    if (task._downloadStream === stream) task._downloadStream = null;
                    if (task._tempFile === tempPath) task._tempFile = null;
                    task.progress = 100;
                    task.status = 'completed';
                    task.finishTime = Date.now();
                    const durationMs = Date.now() - task.startTime;
                    task.duration = `${Math.floor(durationMs / 60000).toString().padStart(2, '0')}:${Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0')}`;
                    task.format_summary = `Artlist 试听音频 · ${extension.toUpperCase()}`;
                    completedTasks.unshift({
                        task_id: task.task_id,
                        title: task.title,
                        artist: task.artist,
                        url: task.url,
                        thumbnail: task.thumbnail,
                        status: 'completed',
                        isArtlist: true,
                        format_id: task.format_id,
                        format_summary: task.format_summary,
                        totalSize: task.totalSize,
                        duration: task.duration,
                        finishTime: task.finishTime,
                        output_dir: task.output_dir,
                        output_files: task.output_files
                    });
                    saveTasks(completedTasks);
                    delete activeTasks[task.task_id];
                    sendTaskUpdate(task);
                } catch (error) {
                    finishError(error);
                }
            });
        });
        response.on('error', finishError);
        stream.on('error', finishError);
    });
    request.on('error', finishError);
    timer = setTimeout(() => {
        request.abort();
        finishError(new Error('Artlist 音频下载超时'));
    }, 10 * 60 * 1000);
    request.end();
}

function downloadVideo(task) {
    if (task.isArtlist) {
        downloadArtlistAudio(task);
        return;
    }

    const preferredContainer = getPreferredContainer(task);
    const formatStr = buildDownloadFormatSelector(task, preferredContainer);
    const outputTemplate = createUniqueOutputTemplate(task.title, preferredContainer);
    const args = [
        '--format', formatStr,
        '--output', outputTemplate,
        '--no-playlist',
        '--no-cache-dir',
        '--no-update',
        '--no-simulate',
        '--progress',
        '--newline',
        '--print', `after_move:${YTDLP_OUTPUT_MARKER}%(filepath)s`,
        task.url
    ];
    if (preferredContainer === 'mp4') {
        args.splice(args.length - 1, 0, '--recode-video', 'mp4');
    } else {
        args.splice(args.length - 1, 0, '--merge-output-format', preferredContainer);
    }
    appendPreferredJsRuntime(args);

    task.startTime = Date.now();
    task.output_dir = path.resolve(config.output_dir);
    task.output_files = [];

    // Cookie logic
    const activeCookieFile = resolveActiveCookieFile();
    if (config.cookie_source === 'browser' && config.cookie_browser) {
        args.push('--cookies-from-browser', config.cookie_browser);
    } else if (activeCookieFile) {
        args.push('--cookies', activeCookieFile);
    }

    const proc = spawn(getYtdlpExePath(), args, { env: getChildProcessEnv(), windowsHide: true });
    task._process = proc;
    task._cancelRequested = false;
    task._cancelledProcessPid = 0;
    let stderrOutput = '';

    const outputParser = createYtdlpOutputParser(task, (line) => {
        // 解析进度, 速度, ETA
        // [download]  23.5% of 10.00MiB at 2.50MiB/s ETA 00:05
        const match = line.match(/\[download\]\s+([\d.]+)%/);
        if (match) {
            if (task._cancelRequested) return;
            task.progress = parseFloat(match[1]);
            task.status = 'downloading';

            // Extract Total Size
            const sizeMatch = line.match(/of\s+~?([\d\.]+[KMG]iB)/);
            if (sizeMatch) task.totalSize = sizeMatch[1];

            const speedMatch = line.match(/at\s+([^\s]+)/);
            if (speedMatch) task.speed = speedMatch[1];

            const etaMatch = line.match(/ETA\s+([^\s]+)/);
            if (etaMatch) task.eta = etaMatch[1];

            sendTaskUpdate(task);
        }
    });
    proc.stdout.on('data', (data) => {
        outputParser.push(data.toString());
    });

    proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderrOutput += text;
        console.error('yt-dlp stderr:', text);
    });

    proc.on('close', (code) => {
        outputParser.flush();
        if (task._process === proc) {
            task._process = null;
        }

        if (task._cancelRequested || task.status === 'cancelled' || task._cancelledProcessPid === proc.pid) {
            return;
        }

        if (code === 0) {
            task.status = 'completed';
            task.progress = 100;

            // Calculate Duration
            const durationMs = Date.now() - (task.startTime || Date.now());
            const minutes = Math.floor(durationMs / 60000);
            const seconds = Math.floor((durationMs % 60000) / 1000);
            task.duration = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            task.finishTime = Date.now();
            task.format_summary = getFormatSummary(task);

            // 添加到已完成列表
            completedTasks.unshift({
                task_id: task.task_id,
                title: task.title,
                url: task.url,
                thumbnail: task.thumbnail,
                status: 'completed',
                format_id: task.format_id,
                format_summary: task.format_summary,
                totalSize: task.totalSize,
                duration: task.duration,
                finishTime: task.finishTime,
                output_dir: task.output_dir,
                output_files: task.output_files
            });
            saveTasks(completedTasks);
        } else if (task.status !== 'cancelled') {
            task.status = 'failed';
            task.error_message = normalizeYtdlpErrorMessage(stderrOutput || '下载失败', task);
        } else {
            return;
        }

        delete activeTasks[task.task_id];
        sendTaskUpdate(task);
    });
}

// Behance 多视频下载
function downloadBehanceVideos(task) {
    const selectedEntries = task.entries.filter(e => e.selected);
    task.output_dir = path.resolve(config.output_dir);
    if (selectedEntries.length === 0) {
        task.status = 'completed';
        task.finishTime = new Date().toISOString();
        sendTaskUpdate(task);
        return;
    }

    // 初始化选中的 entry 状态
    selectedEntries.forEach(e => {
        e.status = 'waiting';
        e.progress = 0;
    });

    let currentIndex = 0;

    function downloadNextEntry() {
        if (currentIndex >= selectedEntries.length) {
            // 全部下载完成
            task.status = 'completed';
            task.finishTime = new Date().toISOString();
            task.progress = 100;
            sendTaskUpdate(task);

            // 添加到已完成列表（保存完整 entries 数据）
            completedTasks.unshift({
                task_id: task.task_id,
                title: task.title,
                url: task.url,
                thumbnail: task.thumbnail,
                status: 'completed',
                format_summary: '多视频下载',
                totalSize: task.totalSize,
                finishTime: task.finishTime,
                isBehance: true,
                videoCount: selectedEntries.length,
                output_dir: task.output_dir,
                entries: selectedEntries.map(e => ({
                    id: e.id,
                    title: e.title,
                    thumbnail: e.thumbnail,
                    status: e.status,
                    totalSize: e.totalSize,
                    duration: e.duration,
                    finishTime: e.finishTime,
                    output_dir: e.output_dir,
                    output_files: e.output_files
                }))
            });
            saveTasks(completedTasks);
            delete activeTasks[task.task_id];
            return;
        }

        const entry = selectedEntries[currentIndex];
        entry.status = 'downloading';
        entry.progress = 0;
        entry.startTime = Date.now(); // 记录开始时间

        task.currentEntryIndex = currentIndex;
        task.currentEntryTitle = entry.title;
        // 使用 entry 进度的加权平均
        const totalProgress = selectedEntries.reduce((acc, e) => acc + (e.progress || 0), 0);
        task.progress = Math.round(totalProgress / selectedEntries.length);
        sendTaskUpdate(task);

        log('INFO', `[Behance] 下载视频 ${currentIndex + 1}/${selectedEntries.length}: ${entry.title}`);

        // 构建下载参数 (与之前相同)
        let formatStr = entry.format_id || 'bestvideo+bestaudio/best';
        if (/^\d+$/.test(formatStr)) {
            formatStr = `${formatStr}+bestaudio/best`;
        }

        const outputTemplate = createUniqueOutputTemplate(`${entry.title}_${currentIndex + 1}`, 'mp4');
        entry.output_dir = path.resolve(config.output_dir);
        entry.output_files = [];
        const args = [
            '-f', formatStr,
            '-o', outputTemplate,
            '--no-playlist',
            '--embed-thumbnail',
            '--no-cache-dir',
            '--no-update',
            '--no-simulate',
            '--progress',
            '--newline',
            '--print', `after_move:${YTDLP_OUTPUT_MARKER}%(filepath)s`,
            entry.url
        ];
        args.splice(args.length - 1, 0, '--recode-video', 'mp4');
        appendPreferredJsRuntime(args);

        const activeCookieFile = resolveActiveCookieFile();
        if (activeCookieFile) {
            args.push('--cookies', activeCookieFile);
        }

        const proc = spawn(getYtdlpExePath(), args, { env: getChildProcessEnv(), windowsHide: true });
        task._process = proc;
        task._cancelRequested = false;
        task._cancelledProcessPid = 0;
        let stderrOutput = '';

        const outputParser = createYtdlpOutputParser(entry, (line) => {
            // 解析进度、速度、ETA
            // [download]  23.5% of 10.00MiB at 2.50MiB/s ETA 00:05
            const progressMatch = line.match(/(\d+\.?\d*)%/);
            if (progressMatch) {
                if (task._cancelRequested) return;
                const entryProgress = parseFloat(progressMatch[1]);
                entry.progress = entryProgress;

                // 解析文件大小
                const sizeMatch = line.match(/of\s+~?([\d\.]+[KMG]iB)/);
                if (sizeMatch) entry.totalSize = sizeMatch[1];

                // 解析速度
                const speedMatch = line.match(/at\s+([^\s]+)/);
                if (speedMatch) entry.speed = speedMatch[1];

                // 解析剩余时间
                const etaMatch = line.match(/ETA\s+([^\s]+)/);
                if (etaMatch) entry.eta = etaMatch[1];

                // 更新总进度
                const totalProgress = selectedEntries.reduce((acc, e) => acc + (e.progress || 0), 0);
                task.progress = Math.round(totalProgress / selectedEntries.length);

                sendTaskUpdate(task);
            }
        });
        proc.stdout.on('data', (data) => {
            outputParser.push(data.toString());
        });

        proc.stderr.on('data', (data) => {
            const line = data.toString();
            stderrOutput += line;
            if (line.includes('ERROR')) {
                log('ERROR', `[Behance] ${entry.title}: ${line}`);
            }
        });

        proc.on('close', (code) => {
            outputParser.flush();
            if (task._process === proc) {
                task._process = null;
            }

            if (task._cancelRequested || task.status === 'cancelled' || task._cancelledProcessPid === proc.pid) {
                return;
            }

            if (code === 0) {
                log('INFO', `[Behance] 完成下载: ${entry.title}`);
                entry.status = 'completed';
                entry.progress = 100;
                // 计算耗时
                const durationMs = Date.now() - (entry.startTime || Date.now());
                const minutes = Math.floor(durationMs / 60000);
                const seconds = Math.floor((durationMs % 60000) / 1000);
                entry.duration = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                entry.finishTime = new Date().toISOString();
                currentIndex++;
                downloadNextEntry();
            } else if (task.status !== 'cancelled') {
                log('ERROR', `[Behance] 下载失败: ${entry.title}`);
                entry.status = 'failed';
                entry.error_message = normalizeYtdlpErrorMessage(stderrOutput || '下载失败', task);
                currentIndex++;
                downloadNextEntry();
            }
        });
    }

    downloadNextEntry();
}

function formatBytes(bytes) {
    if (!bytes) return '未知';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(1)} ${units[i]}`;
}
