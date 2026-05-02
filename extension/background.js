// R-Searcher · Background Service Worker

const API_BASE_URL_KEY = 'apiBaseUrl';
const REQUEST_TIMEOUT_MS = 12000;

function normalizeApiBaseUrl(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') {
    return null;
  }

  if (url.hash || url.search) {
    return null;
  }

  if (url.pathname && url.pathname !== '/') {
    return null;
  }

  return url.origin;
}

function getOriginPattern(apiBaseUrl) {
  return `${new URL(apiBaseUrl).origin}/*`;
}

async function ensureInstallId() {
  const data = await chrome.storage.local.get('installId');
  if (data.installId) return data.installId;
  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ installId });
  return installId;
}

void ensureInstallId();

chrome.runtime.onInstalled.addListener(() => {
  void ensureInstallId();
  console.log('R-Searcher v2.0 installed');
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInstallId();
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'smart-explain') chrome.tabs.sendMessage(tab.id, { type: 'HOTKEY_EXPLAIN' });
  if (command === 'smart-analyze') chrome.tabs.sendMessage(tab.id, { type: 'HOTKEY_ANALYZE' });
  if (command === 'copy-last') chrome.tabs.sendMessage(tab.id, { type: 'COPY_LAST' });
});

async function resolveApiBaseUrl() {
  const data = await chrome.storage.local.get(API_BASE_URL_KEY);
  const rawValue = data[API_BASE_URL_KEY];
  const normalizedValue = normalizeApiBaseUrl(rawValue);

  if (!rawValue || (typeof rawValue === 'string' && !rawValue.trim())) {
    return { ok: false, status: 400, body: { error: 'config_missing' } };
  }

  if (!normalizedValue) {
    return { ok: false, status: 400, body: { error: 'invalid_backend_url' } };
  }

  const originPattern = getOriginPattern(normalizedValue);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    return {
      ok: false,
      status: 403,
      body: { error: 'permission_missing', origin: new URL(normalizedValue).origin },
    };
  }

  return { ok: true, apiBaseUrl: normalizedValue };
}

async function proxyWorkerRequest(path, payload) {
  const resolvedApiBaseUrl = await resolveApiBaseUrl();
  if (!resolvedApiBaseUrl.ok) {
    return resolvedApiBaseUrl;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${resolvedApiBaseUrl.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, networkError: 'timeout' };
    }
    return { ok: false, status: 0, networkError: 'fetch_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WORKER_FETCH' && msg.path === '/process' && msg.payload) {
    void proxyWorkerRequest(msg.path, msg.payload).then(sendResponse);
    return true;
  }
});
