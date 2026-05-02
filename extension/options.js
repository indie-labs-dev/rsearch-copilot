// R-Searcher · Options

const API_BASE_URL_KEY = 'apiBaseUrl';

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

function applyI18n() {
  const { version } = chrome.runtime.getManifest();
  document.getElementById('opt-version').textContent = `Settings · v${version}`;
  document.getElementById('opt-section-interface').textContent = t('settingsSectionInterface');
  document.getElementById('opt-label-minimal').textContent = t('settingsMinimalMode');
  document.getElementById('opt-desc-minimal').textContent = t('settingsMinimalDesc');
  document.getElementById('opt-label-tooltip').textContent = t('settingsShowTooltip');
  document.getElementById('opt-desc-tooltip').textContent = t('settingsTooltipDesc');
  document.getElementById('opt-section-backend').textContent = t('settingsSectionBackend');
  document.getElementById('opt-backend-label').textContent = t('settingsBackendLabel');
  document.getElementById('opt-backend-desc').textContent = t('settingsBackendDesc');
  document.getElementById('api-base-url').placeholder = t('settingsBackendPlaceholder');
  document.getElementById('opt-backend-note').textContent = t('settingsBackendNote');
  document.getElementById('opt-section-hotkeys').textContent = t('hotkeysTitle');
  document.getElementById('hk-row-1').textContent = t('settingsHotkeyExplain');
  document.getElementById('hk-row-2').textContent = t('settingsHotkeyAnalyze');
  document.getElementById('hk-row-3').textContent = t('settingsHotkeyCopy');
  document.getElementById('hk-hint').textContent = t('settingsHotkeyHint');
  document.getElementById('save-btn').textContent = t('settingsSave');
}

function syncTooltipToggleState() {
  const minimal = document.getElementById('minimalMode').checked;
  const tooltip = document.getElementById('showTooltip');
  if (minimal) {
    tooltip.checked = false;
    tooltip.disabled = true;
  } else {
    tooltip.disabled = false;
  }
}

function setSavedMessage(text = '') {
  document.getElementById('saved-msg').textContent = text;
}

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();

  const data = await chrome.storage.local.get(['minimalMode', 'showTooltip', API_BASE_URL_KEY]);
  document.getElementById('minimalMode').checked = !!data.minimalMode;
  document.getElementById('showTooltip').checked = data.showTooltip !== false;
  document.getElementById('api-base-url').value = data[API_BASE_URL_KEY] || '';

  syncTooltipToggleState();

  document.getElementById('minimalMode').addEventListener('change', () => {
    syncTooltipToggleState();
  });

  const apiInput = document.getElementById('api-base-url');
  apiInput.addEventListener('paste', (event) => {
    const pastedText = event.clipboardData?.getData('text') || '';
    const normalizedApiBaseUrl = normalizeApiBaseUrl(pastedText);

    if (!normalizedApiBaseUrl) {
      event.preventDefault();
      setSavedMessage(t('settingsBackendInvalidUrl'));
      return;
    }

    event.preventDefault();
    apiInput.value = normalizedApiBaseUrl;
    setSavedMessage('');
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const normalizedApiBaseUrl = normalizeApiBaseUrl(apiInput.value);
    if (apiInput.value.trim() && !normalizedApiBaseUrl) {
      setSavedMessage(t('settingsBackendInvalidUrl'));
      return;
    }

    if (normalizedApiBaseUrl) {
      const granted = await chrome.permissions.request({ origins: [getOriginPattern(normalizedApiBaseUrl)] });
      if (!granted) {
        setSavedMessage(t('settingsBackendPermissionDenied'));
        return;
      }
    }

    await chrome.storage.local.set({
      minimalMode: document.getElementById('minimalMode').checked,
      showTooltip: document.getElementById('showTooltip').checked,
      [API_BASE_URL_KEY]: normalizedApiBaseUrl || '',
    });

    apiInput.value = normalizedApiBaseUrl || '';
    setSavedMessage(normalizedApiBaseUrl ? t('settingsBackendSaved') : t('settingsSaved'));
    setTimeout(() => { setSavedMessage(''); }, 2000);
  });
});
