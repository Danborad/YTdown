const SUPPORTED_DOMAINS = [
    'youtube.com',
    'google.com',
    'accounts.google.com',
    'bilibili.com',
    'vimeo.com',
    'tiktok.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'behance.net',
    'adobe.com'
];

const DEFAULT_STATE = {
    serverBase: 'http://127.0.0.1:38491/api/cookie-sync',
    token: '',
    paired: false,
    browserName: '',
    lastSyncAt: '',
    lastError: '',
    lastCount: 0,
    statusText: '未连接下载器'
};

function getBrowserName() {
    return navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
}

async function getState() {
    const stored = await chrome.storage.local.get(DEFAULT_STATE);
    return {
        ...DEFAULT_STATE,
        ...stored,
        browserName: stored.browserName || getBrowserName()
    };
}

async function setState(patch) {
    await chrome.storage.local.set(patch);
    return getState();
}

function matchesSupportedDomain(domain) {
    const normalized = String(domain || '').replace(/^\./, '');
    return SUPPORTED_DOMAINS.some((item) => normalized === item || normalized.endsWith(`.${item}`));
}

async function collectCookies() {
    const cookieMap = new Map();

    for (const domain of SUPPORTED_DOMAINS) {
        const cookies = await chrome.cookies.getAll({ domain });
        cookies.forEach((cookie) => {
            const key = [cookie.domain, cookie.path, cookie.name, cookie.storeId || '0'].join('|');
            if (!cookieMap.has(key)) {
                cookieMap.set(key, {
                    domain: cookie.domain,
                    hostOnly: cookie.hostOnly,
                    path: cookie.path,
                    secure: cookie.secure,
                    session: cookie.session,
                    expirationDate: cookie.expirationDate || 0,
                    name: cookie.name,
                    value: cookie.value
                });
            }
        });
    }

    return Array.from(cookieMap.values()).sort((a, b) => {
        const left = `${a.domain}|${a.name}|${a.path}`;
        const right = `${b.domain}|${b.name}|${b.path}`;
        return left.localeCompare(right);
    });
}

async function postJson(path, payload) {
    const state = await getState();
    const response = await fetch(`${state.serverBase}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({ success: false, message: '本地服务返回异常' }));
    if (!response.ok || !result.success) {
        throw new Error(result.message || `请求失败 (${response.status})`);
    }

    return result;
}

async function pairWithDownloader(token) {
    const formattedToken = String(token || '').trim().toUpperCase();
    if (!formattedToken) {
        throw new Error('请输入配对码');
    }

    const browserName = getBrowserName();
    const result = await postJson('/pair', {
        token: formattedToken,
        browserName,
        extensionVersion: chrome.runtime.getManifest().version
    });

    await setState({
        token: formattedToken,
        paired: true,
        browserName,
        lastError: '',
        statusText: '已连接下载器'
    });

    return result;
}

async function syncCookies(reason = 'manual') {
    const state = await getState();
    const formattedToken = String(state.token || '').trim().toUpperCase();
    if (!formattedToken) {
        throw new Error('请先输入配对码');
    }

    const cookies = await collectCookies();
    const browserName = getBrowserName();
    const result = await postJson('/sync', {
        token: formattedToken,
        browserName,
        reason,
        cookies,
        extensionVersion: chrome.runtime.getManifest().version
    });

    await setState({
        paired: true,
        browserName,
        lastSyncAt: new Date().toISOString(),
        lastCount: result.cookieCount || cookies.length,
        lastError: '',
        statusText: `已同步 ${result.cookieCount || cookies.length} 个 Cookie`
    });

    return result;
}

async function connectAndSync(token) {
    await pairWithDownloader(token);
    return syncCookies('pair');
}

function queueSync(delayMs = 3000) {
    chrome.alarms.create('downloader-pro-cookie-sync', { when: Date.now() + delayMs });
}

chrome.runtime.onInstalled.addListener(async () => {
    await setState({ browserName: getBrowserName() });
    chrome.alarms.create('downloader-pro-cookie-sync-heartbeat', { periodInMinutes: 15 });
});

chrome.runtime.onStartup.addListener(async () => {
    await setState({ browserName: getBrowserName() });
    const state = await getState();
    if (state.paired && state.token) {
        queueSync(5000);
    }
});

chrome.cookies.onChanged.addListener(async (changeInfo) => {
    const state = await getState();
    if (!state.paired || !state.token) return;
    if (!matchesSupportedDomain(changeInfo.cookie?.domain)) return;
    queueSync(2500);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!['downloader-pro-cookie-sync', 'downloader-pro-cookie-sync-heartbeat'].includes(alarm.name)) {
        return;
    }

    const state = await getState();
    if (!state.paired || !state.token) return;

    try {
        await syncCookies(alarm.name === 'downloader-pro-cookie-sync' ? 'change' : 'heartbeat');
    } catch (error) {
        await setState({
            lastError: error.message,
            statusText: '同步失败'
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        if (message?.type === 'get-state') {
            sendResponse({ success: true, state: await getState() });
            return;
        }

        if (message?.type === 'connect') {
            const result = await connectAndSync(message.token);
            sendResponse({ success: true, result, state: await getState() });
            return;
        }

        if (message?.type === 'sync-now') {
            const result = await syncCookies('manual');
            sendResponse({ success: true, result, state: await getState() });
            return;
        }

        if (message?.type === 'save-token') {
            await setState({ token: String(message.token || '').trim().toUpperCase() });
            sendResponse({ success: true, state: await getState() });
            return;
        }

        sendResponse({ success: false, message: '未知指令' });
    })().catch(async (error) => {
        await setState({
            lastError: error.message,
            statusText: '同步失败'
        });
        sendResponse({ success: false, message: error.message, state: await getState() });
    });

    return true;
});
