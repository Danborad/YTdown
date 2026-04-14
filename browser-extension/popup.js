function formatTime(value) {
    if (!value) return '未同步';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '未同步';
    return date.toLocaleString();
}

async function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
}

function renderState(state) {
    document.getElementById('status').textContent = state.statusText || '未连接下载器';
    document.getElementById('browser-name').textContent = state.browserName || '-';
    document.getElementById('last-sync').textContent = formatTime(state.lastSyncAt);
    document.getElementById('last-count').textContent = String(state.lastCount || 0);
    document.getElementById('paired-state').textContent = state.paired ? '已配对' : '未配对';
    document.getElementById('token').value = state.token || '';
    document.getElementById('error').textContent = state.lastError || '';
}

async function refreshState() {
    const response = await sendMessage({ type: 'get-state' });
    if (response?.success) {
        renderState(response.state);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await refreshState();

    document.getElementById('token').addEventListener('input', async (event) => {
        await sendMessage({
            type: 'save-token',
            token: event.target.value
        });
    });

    document.getElementById('connect-btn').addEventListener('click', async () => {
        const token = document.getElementById('token').value;
        const response = await sendMessage({ type: 'connect', token });
        if (!response?.success) {
            document.getElementById('error').textContent = response?.message || '连接失败';
        }
        if (response?.state) {
            renderState(response.state);
        } else {
            await refreshState();
        }
    });

    document.getElementById('sync-btn').addEventListener('click', async () => {
        const response = await sendMessage({ type: 'sync-now' });
        if (!response?.success) {
            document.getElementById('error').textContent = response?.message || '同步失败';
        }
        if (response?.state) {
            renderState(response.state);
        } else {
            await refreshState();
        }
    });
});
