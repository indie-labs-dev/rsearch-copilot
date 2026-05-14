// R-Searcher · Popup v1.8

const RESULT_CACHE_PREFIX = 'cachedAnalyze:';
const MAX_ANALYZE_CHARS = 50000;

let analyzeResult = null;
let analyzeResultSections = null;
let pageUrl = '';
let activeTab = null;
let expanded = false;
let activeTabName = 'essence';

function isRefreshRequiredErrorMessage(message) {
  if (!message || typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  return lower.includes('extension context invalidated')
    || lower.includes('could not establish connection')
    || lower.includes('receiving end does not exist')
    || lower.includes('message port closed')
    || lower.includes('the tab was closed')
    || lower.includes('frame was removed');
}

function getDisplayErrorMessage(message) {
  return isRefreshRequiredErrorMessage(message) ? t('refreshAndRetry') : message;
}

function isSupportedHttpsPage(url = pageUrl) {
  return /^https:\/\//i.test(url || '');
}

async function ensureInstallId() {
  const data = await chrome.storage.local.get('installId');
  if (data.installId) return data.installId;
  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ installId });
  return installId;
}

function resultCacheKey(url) {
  return `${RESULT_CACHE_PREFIX}${btoa(encodeURIComponent(url))}`;
}

async function cacheAnalyzeResult(result, savedMin, articleWordCount) {
  if (!pageUrl || !getAnalyzeSections(result)) return;
  const key = resultCacheKey(pageUrl);
  await chrome.storage.local.set({ [key]: { result, savedMin, articleWordCount } });
}

async function loadCachedAnalyzeResult() {
  if (!pageUrl) return;
  const key = resultCacheKey(pageUrl);
  const data = await chrome.storage.local.get([key]);
  const cached = data[key];
  if (typeof cached?.result === 'string') {
    await chrome.storage.local.remove(key);
    return;
  }

  const sections = getAnalyzeSections(cached?.result);
  if (!sections) return;
  if (typeof cached?.articleWordCount !== 'number') {
    await chrome.storage.local.remove(key);
    return;
  }

  document.body.classList.add('result-open');
  analyzeResult = cached.result;
  analyzeResultSections = sections;
  document.getElementById('result-section-analyze').classList.add('visible');

  const articleWordCount = cached.articleWordCount;
  const notesWordCount = sections.notes.split(/\s+/).length;
  const { densityPct, densityKey } = calculateDensity(articleWordCount, notesWordCount);
  const densityLabel = t(densityKey);
  showResultContent(cached.result, cached.savedMin, densityLabel, densityPct);
}

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  await getCurrentTab();
  await loadCachedAnalyzeResult();
  checkArticleLength();
  setupTabButtons();
  setupAnalyzeButton();
  setupCopyButton();
  setupExpandButton();
  document.getElementById('settings-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

async function checkArticleLength() {
  if (!activeTab?.id) return;
  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_ARTICLE_TEXT' });
    if (!response?.text) return;
    if (response.text.length > MAX_ANALYZE_CHARS) {
      showArticleTooLongWarning();
    }
  } catch {
    // Content script not loaded or other error.
  }
}

function showArticleTooLongWarning() {
  let banner = document.getElementById('article-too-long-banner');
  if (banner) return;

  banner = document.createElement('div');
  banner.id = 'article-too-long-banner';
  banner.style.cssText = 'background:#f5a623;color:#0f0f0f;padding:10px 12px;margin:0 16px 12px;border-radius:6px;font-size:12px;line-height:1.5;font-weight:500';
  banner.textContent = t('articleTooLong');

  const main = document.querySelector('.main');
  if (main) main.insertBefore(banner, main.firstChild);
}

function applyI18n() {
  document.getElementById('subtitle').textContent = t('subtitle');
  document.getElementById('analyze-btn').textContent = t('analyzeBtn');
  document.getElementById('hotkeys-title-a').textContent = t('hotkeysTitle');
  document.getElementById('hk-explain').textContent = t('hkExplain');
  document.getElementById('hk-analyze').textContent = t('hkAnalyze');
  document.getElementById('hk-copy').textContent = t('hkCopy');
  document.getElementById('result-label-analyze').textContent = t('resultLabel');
  document.getElementById('copy-btn-analyze').textContent = t('copyBtn');
  document.getElementById('settings-link').textContent = t('settings');
  document.getElementById('tab-essence').textContent = t('tabEssence');
  document.getElementById('tab-notes').textContent = t('tabNotes');
  document.getElementById('tab-next-steps').textContent = t('tabNextSteps');
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  pageUrl = tab?.url || '';
}

function setupTabButtons() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      setActiveTab(tab.dataset.tab);
    });
  });
}

function setupAnalyzeButton() {
  document.getElementById('analyze-btn').addEventListener('click', async () => {
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border:2px solid rgba(0,0,0,0.2);border-top-color:#0f0f0f;border-radius:50%;animation:spin .8s linear infinite"></div> ${t('analyzingBtn')}`;

    document.getElementById('result-section-analyze').classList.add('visible');
    document.getElementById('time-hero').classList.remove('visible');
    document.getElementById('tab-bar').style.display = 'none';
    document.getElementById('content-essence').innerHTML = `<div class="loading-state"><div class="spinner"></div><span>${t('loading')}</span></div>`;
    document.getElementById('content-notes').innerHTML = '';
    document.getElementById('content-next-steps').innerHTML = '';
    setActiveTab('essence');

    try {
      const tab = activeTab;
      if (!tab?.id || /^(chrome|about|chrome-extension):/.test(tab.url || '')) {
        showResultError(t('cannotRunOnPage'));
        return;
      }
      if (!isSupportedHttpsPage(tab.url)) {
        showResultError(t('supportedHttpsOnly'));
        return;
      }

      let response;
      try {
        const installId = await ensureInstallId();
        response = await chrome.tabs.sendMessage(tab.id, { type: 'POPUP_ANALYZE', installId });
      } catch {
        showResultError(isSupportedHttpsPage(tab.url) ? t('refreshAndRetry') : t('supportedHttpsOnly'));
        return;
      }

      if (response?.ok) {
        analyzeResult = response.result;
        analyzeResultSections = getAnalyzeSections(response.result);

        const articleWords = response.articleWordCount || 0;
        const savedMin = typeof response.timeSaved === 'number' ? response.timeSaved : null;
        const notesWordCount = analyzeResultSections ? analyzeResultSections.notes.split(/\s+/).length : 0;
        const { densityPct, densityKey } = calculateDensity(articleWords, notesWordCount);
        const densityLabel = t(densityKey);

        await cacheAnalyzeResult(response.result, savedMin, articleWords);
        showResultContent(response.result, savedMin, densityLabel, densityPct);
        return;
      }

      if (response?.code === 'burst_limit') {
        showResultError(t('temporaryProtection'));
        return;
      }

      if (response?.errorCode) {
        showResultError(mapBackendConfigMessage(response.errorCode));
        return;
      }

      if (response?.error) {
        showResultError(getDisplayErrorMessage(response.error));
        return;
      }

      showResultError(t('errorSomethingWentWrong'));
    } catch (err) {
      showResultError(getDisplayErrorMessage(err?.message) || t('errorSomethingWentWrong'));
    } finally {
      btn.disabled = false;
      btn.textContent = t('analyzeBtn');
    }
  });
}

function showResultContent(result, savedMin, densityLabel, densityPct) {
  document.body.classList.add('result-open');
  document.body.style.height = 'auto';

  const sections = getAnalyzeSections(result) || analyzeResultSections;
  const tabBar = document.getElementById('tab-bar');
  const essenceContent = document.getElementById('content-essence');
  const notesContent = document.getElementById('content-notes');
  const nextStepsContent = document.getElementById('content-next-steps');

  if (sections) {
    analyzeResultSections = sections;
    tabBar.style.display = 'flex';
    essenceContent.innerHTML = formatResult(sections.essence);
    notesContent.innerHTML = formatResult(sections.notes);
    nextStepsContent.innerHTML = formatResult(sections.nextSteps);
    activeTabName = 'essence';
    setActiveTab('essence');
  } else {
    tabBar.style.display = 'none';
    essenceContent.innerHTML = formatResult(result?.raw || '');
    notesContent.innerHTML = '';
    nextStepsContent.innerHTML = '';
    setActiveTab('essence');
  }

  const hero = document.getElementById('time-hero');
  if (typeof savedMin === 'number' || densityLabel) {
    let heroText = '';
    if (typeof savedMin === 'number') {
      heroText = t('heroLine', savedMin);
    }
    if (densityLabel) {
      const densityStr = t('density', densityLabel, densityPct);
      heroText = heroText ? `${heroText}<br>${densityStr}` : densityStr;
    }
    hero.innerHTML = heroText;
    hero.classList.add('visible');
  } else {
    hero.classList.remove('visible');
  }
}

function showResultError(message) {
  document.body.classList.add('result-open');
  document.body.style.height = 'auto';
  document.getElementById('time-hero').classList.remove('visible');
  document.getElementById('tab-bar').style.display = 'none';
  document.getElementById('content-notes').innerHTML = '';
  document.getElementById('content-next-steps').innerHTML = '';

  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-msg';
  errorDiv.textContent = `⚠️ ${message}`;

  const errorContainer = document.getElementById('content-essence');
  errorContainer.innerHTML = '';
  errorContainer.appendChild(errorDiv);
  setActiveTab('essence');
}

function setActiveTab(tabName) {
  activeTabName = tabName;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach((content) => {
    content.classList.toggle('active', content.id === `content-${tabName}`);
  });
}

function setupExpandButton() {
  document.getElementById('expand-btn').addEventListener('click', () => {
    expanded = !expanded;
    const btn = document.getElementById('expand-btn');
    const shell = document.querySelector('.popup-shell');
    const html = document.documentElement;
    const body = document.body;
    if (expanded) {
      html.classList.add('expanded');
      body.classList.add('expanded');
      if (shell) shell.classList.add('expanded');
      html.style.width = '670px';
      body.style.width = '670px';
      document.getElementById('result-content-analyze').style.maxHeight = '620px';
      btn.textContent = '⤡';
      btn.title = 'Collapse';
      if (typeof window.resizeTo === 'function') {
        window.resizeTo(680, Math.min(window.screen.availHeight - 40, 760));
      }
    } else {
      html.classList.remove('expanded');
      body.classList.remove('expanded');
      if (shell) shell.classList.remove('expanded');
      html.style.width = '320px';
      body.style.width = '320px';
      document.getElementById('result-content-analyze').style.maxHeight = '420px';
      btn.textContent = '⤢';
      btn.title = 'Expand';
      if (typeof window.resizeTo === 'function') {
        window.resizeTo(330, Math.min(window.screen.availHeight - 40, 620));
      }
    }
  });
}

function setupCopyButton() {
  document.getElementById('copy-btn-analyze').addEventListener('click', () => {
    if (!analyzeResult) return;
    const contentToCopy = getAnalyzeSectionText(analyzeResultSections, activeTabName) || analyzeResult.raw || '';
    navigator.clipboard.writeText(`${contentToCopy}\n\n---\n*Source: [${pageUrl}](${pageUrl})*`).then(() => {
      const btn = document.getElementById('copy-btn-analyze');
      btn.textContent = t('copied');
      setTimeout(() => { btn.textContent = t('copyBtn'); }, 2000);
    });
  });
}

function mapBackendConfigMessage(errorCode) {
  if (errorCode === 'config_missing') return t('backendConfigMissing');
  if (errorCode === 'permission_missing') return t('backendPermissionMissing');
  if (errorCode === 'invalid_backend_url') return t('backendInvalidUrl');
  return t('errorSomethingWentWrong');
}

function getAnalyzeSections(result) {
  if (!result || typeof result !== 'object' || typeof result.sections !== 'object') {
    return null;
  }

  const essence = typeof result.sections.essence === 'string' ? result.sections.essence.trim() : '';
  const notes = typeof result.sections.notes === 'string' ? result.sections.notes.trim() : '';
  const nextSteps = typeof result.sections.nextSteps === 'string' ? result.sections.nextSteps.trim() : '';

  if (!essence || !notes || !nextSteps) {
    return null;
  }

  return { essence, notes, nextSteps };
}

function calculateDensity(articleWordCount, notesWordCount) {
  const densityRatio = notesWordCount / Math.max(articleWordCount, 1);
  const densityPct = Math.round(densityRatio * 100);
  let densityKey = 'densityLow';
  if (densityRatio >= 0.08 && densityRatio < 0.16) {
    densityKey = 'densityMedium';
  } else if (densityRatio >= 0.16) {
    densityKey = 'densityHigh';
  }
  return { densityPct, densityKey };
}

function getAnalyzeSectionText(sections, tabName) {
  if (!sections) return '';
  if (tabName === 'essence') return sections.essence;
  if (tabName === 'notes') return sections.notes;
  if (tabName === 'next-steps') return sections.nextSteps;
  return '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatResult(text) {
  text = text || '';
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^Q:\s*(.+)$/gm, '<div style="color:#f5e642;font-weight:600;margin-top:8px;font-size:12px">Q: $1</div>')
    .replace(/^A:\s*(.+)$/gm, '<div style="color:#c4c4c4;padding-left:8px;border-left:2px solid #2a2a2a;margin-bottom:4px;font-size:12px">$1</div>')
    .replace(/^[-•]\s*(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*?<\/li>)/gs, '<ul style="padding-left:14px;margin:4px 0">$1</ul>')
    .replace(/\n\n/g, '<br>')
    .replace(/\n/g, '<br>');
}
