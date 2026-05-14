// R-Searcher - Content Script v2.0

const MAX_EXPLAIN_CHARS = 2000;
const MAX_ANALYZE_CHARS = 12000;
const RESULT_CACHE_PREFIX = 'cachedAnalyze:';

// Extension context guard
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}
function safeSendMessage(msg) {
  if (!isContextValid()) return;
  try { chrome.runtime.sendMessage(msg); } catch { /* context gone */ }
}

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

function isSupportedHttpsPage(url = location.href) {
  return /^https:\/\//i.test(url || '');
}

let selectedText       = '';
let lastResult         = '';
let panel              = null;
let tooltip            = null;
let minimalMode        = false;
let showTooltipEnabled = true;
let tooltipTimer       = null; // for debounce
let lastExplainResult  = null; // updated after every explain response including follow-ups
let currentExplainText = null; // original selected text, set on first explain
let currentExplainMeta = null; // META from first explain -- reused for all follow-ups

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

async function cacheAnalyzeResult(result, savedMin, articleWordCount, url = location.href) {
  if (!url || !getAnalyzeSections(result)) return;
  const key = resultCacheKey(url);
  await chrome.storage.local.set({ [key]: { result, savedMin, articleWordCount } });
}


// Load settings

if (isContextValid()) {
  chrome.storage.local.get(['minimalMode', 'showTooltip'], (data) => {
    minimalMode = !!data.minimalMode;
    showTooltipEnabled = data.showTooltip !== false; // default true
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.minimalMode) minimalMode = !!changes.minimalMode.newValue;
    if ('showTooltip' in changes) showTooltipEnabled = changes.showTooltip.newValue !== false;
  });
}

// Normalize language code

function normalizeLanguageCode(code) {
  if (!code || typeof code !== 'string') return null;
  const trimmed = code.trim().toLowerCase();
  const parts = trimmed.replace('_', '-').split('-');
  return parts[0] || null;
}

function normalizeArticleText(text) {
  if (!text || typeof text !== 'string') return '';

  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim());

  const filtered = [];
  let previousNonEmpty = '';

  const boilerplatePatterns = [
    /^skip to (main )?content$/i,
    /^table of contents$/i,
    /^on this page$/i,
    /^contents$/i,
    /^share$/i,
    /^previous$/i,
    /^next$/i,
    /^edit this page$/i,
    /^last updated$/i,
    /^was this helpful\??$/i,
    /^this page was helpful\.$/i,
    /^except as otherwise noted/i,
    /^all rights reserved$/i,
  ];

  for (const line of lines) {
    if (!line) {
      if (filtered[filtered.length - 1] !== '') filtered.push('');
      continue;
    }

    const isBoilerplate = boilerplatePatterns.some(pattern => pattern.test(line));
    if (isBoilerplate) continue;

    if (line === previousNonEmpty) continue;

    filtered.push(line);
    previousNonEmpty = line;
  }

  const normalized = filtered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return trimTrailingSiteChrome(normalized);
}

function trimTrailingSiteChrome(text) {
  if (!text || typeof text !== 'string') return '';

  const lines = text.split('\n');
  const stopLinePatterns = [
    /^about me$/i,
    /^thoughtworks$/i,
    /^follow$/i,
  ];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (stopLinePatterns.some((pattern) => pattern.test(line))) {
      return lines.slice(0, i).join('\n').trim();
    }

    if (/^topics$/i.test(line)) {
      const lookahead = lines
        .slice(i + 1, i + 15)
        .map((candidate) => candidate.trim())
        .filter(Boolean);

      const looksLikeSiteNav = lookahead.some((candidate) =>
        /^(about me|thoughtworks|follow|books|faq|videos|content index|board games|photography|insights|careers|radar)$/i.test(candidate)
      );

      if (looksLikeSiteNav) {
        return lines.slice(0, i).join('\n').trim();
      }
    }
  }

  return text;
}

function extractCleanTextFromElement(el) {
  if (!el) return '';

  const clone = el.cloneNode(true);
  const selectorsToRemove = [
    'script',
    'style',
    'noscript',
    'nav',
    'aside',
    'form',
    '[role="navigation"]',
    '[aria-label*="breadcrumb" i]',
    '[aria-label*="table of contents" i]',
    '[aria-label*="on this page" i]',
    '.toc',
    '.table-of-contents',
    '.breadcrumbs',
    '.breadcrumb',
    '.sidebar',
    '.social-share',
    '.share',
    '.feedback',
    '.frontMatter',
    '.post-block-footnote',
    '.footnote-list',
    '.acknowledgements',
    '.pagination',
    '.related',
    '.newsletter',
    '.cookie',
    '.cookies',
    '.ads',
    '.promo',
  ];

  clone.querySelectorAll(selectorsToRemove.join(',')).forEach(node => node.remove());
  return normalizeArticleText(clone.innerText || '');
}

function extractArticleText() {
  const selectorCandidates = [
    // Site-specific high-priority selectors (checked first)
    { selector: '#article-body', priority: -1 },      // dev.to and similar
    { selector: '.crayons-article__body', priority: -1 }, // dev.to v2
    { selector: '.article-body', priority: 0 },
    { selector: '.post-content', priority: 0 },
    { selector: '.entry-content', priority: 0 },
    { selector: '#main-content', priority: 0 },
    { selector: 'article', priority: 1 },
    { selector: '[role="main"]', priority: 3 },
    { selector: 'main', priority: 4 },
  ];

  const candidates = [];
  const seen = new Set();

  for (const { selector, priority } of selectorCandidates) {
    document.querySelectorAll(selector).forEach((el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);

      const text = extractCleanTextFromElement(el) || normalizeArticleText(el.innerText || '');
      if (text.length <= 500) return;

      candidates.push({
        el,
        text,
        priority,
        length: text.length,
      });
    });
  }

  if (candidates.length) {
    // If a lower-priority candidate is an ancestor of a higher-priority one,
    // prefer the more specific (higher-priority) descendant.
    // This prevents picking <article> when #article-body is nested inside it.
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Same priority: prefer shorter text (more focused)
      return a.length - b.length;
    });

    // Filter out candidates that contain a better candidate inside them
    const filtered = candidates.filter((candidate, _, arr) => {
      return !arr.some(
        (other) =>
          other !== candidate &&
          other.priority <= candidate.priority &&
          candidate.el.contains(other.el)
      );
    });

    const best = (filtered.length ? filtered : candidates)[0];
    return { text: best.text, el: best.el };
  }

  return {
    text: extractCleanTextFromElement(document.body) || normalizeArticleText(document.body.innerText || ''),
    el: document.body,
  };
}

function countWordHits(text, words) {
  let count = 0;
  for (const word of words) {
    const regex = new RegExp(`\\b${word}\\b`, 'g');
    const matches = text.match(regex);
    if (matches) count += matches.length;
  }
  return count;
}

function detectLanguageFromText(text) {
  if (!text || typeof text !== 'string') return null;

  const sample = text.toLowerCase().slice(0, 4000);
  const cyrillicMatches = sample.match(/[а-яёіїєґ]/g) || [];
  const latinMatches = sample.match(/[a-z]/g) || [];
  const cyrillicCount = cyrillicMatches.length;
  const latinCount = latinMatches.length;

  if (cyrillicCount > latinCount) {
    if (/[іїєґ]/.test(sample)) return 'uk';
    return 'ru';
  }

  const scores = {
    en: countWordHits(sample, ['the', 'and', 'that', 'this', 'with', 'from', 'what', 'should', 'not', 'are']),
    es: countWordHits(sample, ['el', 'la', 'los', 'las', 'que', 'para', 'con', 'una', 'por', 'como']),
    de: countWordHits(sample, ['der', 'die', 'das', 'und', 'mit', 'nicht', 'eine', 'ist', 'fuer', 'den']),
    fr: countWordHits(sample, ['le', 'la', 'les', 'des', 'une', 'que', 'pour', 'avec', 'est', 'dans']),
    pt: countWordHits(sample, ['o', 'a', 'os', 'as', 'que', 'para', 'com', 'uma', 'por', 'como']),
  };

  let bestLang = null;
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestLang = lang;
      bestScore = score;
    }
  }

  if (bestLang && bestScore >= 2) return bestLang;
  if (latinCount > 100) return 'en';
  return null;
}

function detectArticleLanguage() {
  const htmlLang = normalizeLanguageCode(document.documentElement.lang);
  if (htmlLang) return htmlLang;

  const metaSelectors = [
    'meta[http-equiv="content-language"]',
    'meta[name="language"]',
    'meta[property="og:locale"]',
    'meta[name="og:locale"]',
    'meta[property="og:locale:alternate"]',
    'meta[name="twitter:language"]'
  ];
  for (const selector of metaSelectors) {
    const meta = document.querySelector(selector);
    if (meta?.content) {
      const langs = meta.content.split(',').map(normalizeLanguageCode).filter(Boolean);
      if (langs.length) return langs[0];
    }
  }

  const langAttr = normalizeLanguageCode(document.documentElement.getAttribute('xml:lang'));
  if (langAttr) return langAttr;

  const { text } = extractArticleText();
  const textLang = detectLanguageFromText(text);
  if (textLang) return textLang;

  const navigatorLang = normalizeLanguageCode(navigator.language || navigator.userLanguage);
  return navigatorLang;
}
// Open request-access page

// Text selection tooltip (with 350ms debounce)

function isNodeInsideOverlay(node) {
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!el?.closest?.('#rc-panel, #rc-tooltip');
}

document.addEventListener('mouseup', (e) => {
  if (minimalMode) return;
  if (!showTooltipEnabled) return;
  if (e.target?.closest?.('#rc-tooltip')) {
    return;
  }
  if (e.target?.closest?.('#rc-panel')) {
    hideTooltip();
    return;
  }
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => {
    if (e.target?.closest?.('#rc-tooltip')) {
      return;
    }
    if (e.target?.closest?.('#rc-panel')) {
      hideTooltip();
      return;
    }
    const sel  = window.getSelection();
    const text = sel?.toString().trim();
    const selectionInsideOverlay = isNodeInsideOverlay(sel?.anchorNode) || isNodeInsideOverlay(sel?.focusNode);
    if (selectionInsideOverlay) {
      hideTooltip();
      return;
    }
    if (text && text.length > 1) {
      selectedText = text;
      showTooltip(e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
  }, 350);
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#rc-tooltip') && !e.target.closest('#rc-panel')) hideTooltip();
});

function showTooltip(x, y) {
  hideTooltip();
  tooltip = document.createElement('div');
  tooltip.id = 'rc-tooltip';
  tooltip.innerHTML = `
    <button class="rc-btn-explain" id="rc-explain-btn">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
      </svg>
      ${t('explainBtn')}
    </button>`;
  tooltip.style.cssText = `position:absolute;top:${y + window.scrollY - 50}px;left:${x + window.scrollX - 50}px;z-index:2147483647`;
  document.body.appendChild(tooltip);
  document.getElementById('rc-explain-btn').addEventListener('click', () => {
    hideTooltip();
    triggerExplain(selectedText);
  });
}

function hideTooltip() { tooltip?.remove(); tooltip = null; }

// Parse META block from explain response

function parseMeta(raw) {
  const metaIdx = raw.indexOf('<<<META>>>');
  if (metaIdx === -1) return { explanation: raw, meta: null };
  const explanation = raw.slice(0, metaIdx).trim();
  const metaRaw = raw.slice(metaIdx + 10).trim();
  const meta = {};
  for (const line of metaRaw.split('\n')) {
    const [key, val] = line.split(':').map(s => s.trim());
    if (key && val) meta[key] = val;
  }
  return { explanation, meta };
}

// Explain

async function triggerExplain(text) {

  // Enforce input size limit
  if (text.length > MAX_EXPLAIN_CHARS) {
    showPanel({ title: t('panelTitleExplain'), loading: '' });
    showPanelError(`\u26a0\ufe0f ${t('textTooLong')}`);
    return;
  }

  showPanel({ title: t('panelTitleExplain'), loading: t('loadingExplain') });

  currentExplainText = text;
  callAPI({ text, mode: 'explain', url: location.href, language: detectArticleLanguage() })
    .then(async data => {
      const result = data.result;
      const { explanation, meta } = parseMeta(result);
      lastExplainResult = explanation;
      currentExplainMeta = meta;
      lastResult = explanation;
      safeSendMessage({ type: 'STORE_RESULT', result: explanation, url: location.href });
      showPanelResult(explanation, location.href, { timeSaved: null, meta });
    })
    .catch(err => {
      showPanelError(err.message);
    });
}

// Follow-up explain requests

async function triggerFollowUp(mode) {
  const body = document.getElementById('rc-panel-body');
  if (!body || !currentExplainText) return;
  hideTooltip();

  // Show loading state
  body.innerHTML = `<div class="rc-loading"><div class="rc-spinner"></div><span>${t('loadingExplain')}</span></div>`;

  callAPI({
    text: currentExplainText,
    mode,
    url: location.href,
    language: detectArticleLanguage(),
    previousExplanation: lastExplainResult
  })
    .then(async data => {
      const result = data.result;
      lastExplainResult = result;
      safeSendMessage({ type: 'STORE_RESULT', result, url: location.href });
      showPanelResult(result, location.href, { timeSaved: null, meta: currentExplainMeta });
    })
    .catch(err => {
      showPanelError(err.message);
    });
}

// Analyze

async function triggerAnalyze() {
  const { text: bodyText } = extractArticleText();
  if (bodyText.length > MAX_ANALYZE_CHARS) {
    showPanel({ title: t('panelTitleAnalyze'), loading: '' });
    showPanelError(`${t('articleTooLong')}`, false);
    return;
  }
  const wordCount = bodyText.split(/\s+/).length;
  showPanel({ title: t('panelTitleAnalyze'), loading: t('loading') });

  callAPI({ text: bodyText, mode: 'analyze', url: location.href, language: detectArticleLanguage() })
    .then(async data => {
      const result = data.result;
      const sections = getAnalyzeSections(result);
      lastResult = flattenAnalyzeSections(sections);
      const timeSavedValue = calculateAnalyzeSavedMin(wordCount, result);
      await cacheAnalyzeResult(result, timeSavedValue, wordCount, location.href);
      safeSendMessage({ type: 'STORE_RESULT', result, url: location.href });
      const notesWordCount = sections ? sections.notes.split(/\s+/).length : 0;
      const { densityPct, densityKey } = calculateDensity(wordCount, notesWordCount);
      const densityLabel = t(densityKey);
      showPanelResult(result, location.href, { timeSaved: timeSavedValue, articleWordCount: wordCount, densityPct, densityLabel });
    })
    .catch(err => {
      showPanelError(err.message);
    });
}

// Panel

let panelExpanded = false;

function showPanel({ title, loading }) {
  panel?.remove();
  panelExpanded = false;
  panel = document.createElement('div');
  panel.id = 'rc-panel';
  panel.innerHTML = `
    <div class="rc-panel-header">
      <span class="rc-panel-title">${title}</span>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="rc-expand-btn" id="rc-expand-btn" title="Expand">\u2922</button>
        <button class="rc-close" id="rc-close-btn">\u2715</button>
      </div>
    </div>
    <div class="rc-panel-body" id="rc-panel-body">
      ${loading ? `<div class="rc-loading"><div class="rc-spinner"></div><span>${loading}</span></div>` : ''}
    </div>
    <div class="rc-panel-footer" id="rc-panel-footer" style="display:none"></div>`;
  document.body.appendChild(panel);
  document.getElementById('rc-close-btn').addEventListener('click', closePanel);
  document.getElementById('rc-expand-btn').addEventListener('click', toggleExpand);
}

function toggleExpand() {
  panelExpanded = !panelExpanded;
  const p   = document.getElementById('rc-panel');
  const btn = document.getElementById('rc-expand-btn');
  if (!p) return;
  if (panelExpanded) {
    p.style.cssText = 'width:750px;max-height:80vh;bottom:24px;right:24px';
    btn.textContent = '\u2921';
  } else {
    p.style.cssText = '';
    btn.textContent = '\u2922';
  }
}

function showPanelResult(result, url, { timeSaved, meta, articleWordCount, densityPct, densityLabel } = {}) {
  const body   = document.getElementById('rc-panel-body');
  const footer = document.getElementById('rc-panel-footer');
  if (!body) return;
  const hasServerRate = false;
  const remaining = 0;
  const displayLimit = 0;
  const pct = 0;
  const isWarn = false;

  const isExplain = timeSaved === null || timeSaved === undefined;
  const sections = isExplain ? null : getAnalyzeSections(result);
  const activeSectionMap = sections
    ? {
        essence: sections.essence,
        notes: sections.notes,
        'next-steps': sections.nextSteps,
      }
    : null;
  let displayResult = typeof result === 'string' ? result : result?.raw || '';
  let activeTab = 'essence';

  if (activeSectionMap) {
    // Multi-tab layout for analyze
    displayResult = activeSectionMap.essence;
    const heroParts = [];
    if (timeSaved) heroParts.push(t('heroLine', timeSaved));
    if (densityLabel) heroParts.push(t('density', densityLabel, densityPct));
    const heroText = heroParts.join('<br>');
    body.style.overflowY = 'hidden';
    body.innerHTML = `
      <div class="rc-time-line ${heroText ? 'visible' : ''}">${heroText}</div>
      <div class="rc-result-header">
        <span class="rc-result-label">${t('resultLabel')}</span>
      </div>
      <div class="rc-tab-bar">
        <div class="rc-tab active" data-tab="essence">${t('tabEssence')}</div>
        <div class="rc-tab" data-tab="notes">${t('tabNotes')}</div>
        <div class="rc-tab" data-tab="next-steps">${t('tabNextSteps')}</div>
      </div>
      <div class="rc-result-box">
        <div class="rc-result" id="rc-tab-content">${formatText(displayResult)}</div>
      </div>`;

    body.querySelectorAll('.rc-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        body.querySelectorAll('.rc-tab').forEach(t => {
          if (t.dataset.tab === tabName) t.classList.add('active');
          else t.classList.remove('active');
        });
        document.getElementById('rc-tab-content').innerHTML = formatText(activeSectionMap[tabName] || '');
        activeTab = tabName;
      });
    });
  } else {
    body.style.overflowY = 'auto';
    body.innerHTML = `<div class="rc-result">${formatText(displayResult)}</div>`;
  }

  if (footer) {
    footer.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px 14px';

    const statsHtml = isExplain
      ? ''
      : `<div class="rc-stats">
           ${timeSaved ? `<span class="rc-stat">\u23f1 ${t('timeSaved', timeSaved)}</span>` : ''}
           ${densityLabel ? `<span class="rc-stat">${t('density', densityLabel, densityPct)}</span>` : ''}
           ${hasServerRate
             ? `<span class="rc-stat ${isWarn ? 'rc-stat-warn' : ''}">\ud83d\udd22 ${t('remaining', remaining)}</span>`
             : ''}
         </div>`;

    let footerHTML = isExplain ? '' : statsHtml;

    // Add follow-up buttons for explain mode
    const isExplainMode = timeSaved === null || timeSaved === undefined;
    if (isExplainMode && currentExplainText) {
      const metaToUse = currentExplainMeta;
      const followUpBtns = [];

      followUpBtns.push(`<button class="rc-followup-btn" data-mode="explain_rephrase">${t('explainRephrase')}</button>`);

      if (metaToUse?.type === 'technical' || metaToUse?.has_example === 'true') {
        followUpBtns.push(`<button class="rc-followup-btn" data-mode="explain_example">${t('explainExample')}</button>`);
      }
      if (metaToUse?.has_application === 'true') {
        followUpBtns.push(`<button class="rc-followup-btn" data-mode="explain_application">${t('explainApplication')}</button>`);
      }
      if (metaToUse?.type === 'scientific' || metaToUse?.type === 'historical' || metaToUse?.type === 'medical') {
        followUpBtns.push(`<button class="rc-followup-btn" data-mode="explain_importance">${t('explainImportance')}</button>`);
      }

      if (followUpBtns.length > 0) {
        footerHTML += `<div class="rc-followup-btns" style="display:flex;gap:6px;flex-wrap:wrap">${followUpBtns.join('')}</div>`;
      }
    }

    footerHTML += `<div class="rc-copy-row"><button class="rc-copy-btn full" id="rc-copy-btn">${t('copyBtn')}</button></div>`;
    footer.innerHTML = footerHTML;

    // Attach follow-up button listeners
    if (isExplainMode && currentExplainText) {
      footer.querySelectorAll('.rc-followup-btn').forEach(btn => {
        btn.addEventListener('click', () => triggerFollowUp(btn.dataset.mode));
      });
    }

    document.getElementById('rc-copy-btn').addEventListener('click', () => {
      const fallbackContent = activeSectionMap
        ? activeSectionMap[activeTab] || ''
        : displayResult;
      const renderedContent = getRenderedCopyText();
      copyAsMarkdown(renderedContent || fallbackContent, url);
    });
  }
}

function showPanelError(text) {
  const body = document.getElementById('rc-panel-body');
  if (!body) return;

  const errorDiv = document.createElement('div');
  errorDiv.className = 'rc-error';
  errorDiv.textContent = text;
  body.innerHTML = '';
  body.appendChild(errorDiv);
}

function closePanel() { panel?.remove(); panel = null; }

// Copy as Markdown

function copyAsMarkdown(result, url) {
  const normalizedResult = formatCopyText(result);
  const md = `${normalizedResult}\n\n---\n*Source: [${url}](${url})*`;
  navigator.clipboard.writeText(md);
  const btn = document.getElementById('rc-copy-btn');
  if (btn) {
    btn.textContent = t('copied');
    setTimeout(() => { btn.textContent = t('copyBtn'); }, 2000);
  }
}

function getRenderedCopyText() {
  const activeTabContent = document.getElementById('rc-tab-content');
  if (activeTabContent?.innerText?.trim()) {
    return activeTabContent.innerText.trim();
  }

  const renderedResult = document.querySelector('#rc-panel-body .rc-result');
  if (renderedResult?.innerText?.trim()) {
    return renderedResult.innerText.trim();
  }

  return '';
}

function formatCopyText(text) {
  const normalized = (text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return '';

  // Keep existing structure when the content already carries clear formatting.
  if (
    normalized.includes('\n\n') ||
    /^[-*\u2022]\s/m.test(normalized) ||
    /^#{1,6}\s/m.test(normalized) ||
    /^Q:\s/m.test(normalized) ||
    /^A:\s/m.test(normalized)
  ) {
    return normalized;
  }

  // Plain one-block explains are easier to reuse when we split them into
  // a few readable paragraphs without changing the wording itself.
  const sentences = normalized.match(/.+?(?:[.!?\u2026]+(?=\s|$)|$)/g)?.map((part) => part.trim()).filter(Boolean) || [];
  if (sentences.length < 3) return normalized;

  const paragraphs = [];
  let bucket = [];
  let bucketLength = 0;

  for (const sentence of sentences) {
    bucket.push(sentence);
    bucketLength += sentence.length;

    if (bucket.length >= 2 && bucketLength >= 220) {
      paragraphs.push(bucket.join(' '));
      bucket = [];
      bucketLength = 0;
    }
  }

  if (bucket.length) {
    if (paragraphs.length && bucket.length === 1) {
      paragraphs[paragraphs.length - 1] += ` ${bucket[0]}`;
    } else {
      paragraphs.push(bucket.join(' '));
    }
  }

  return paragraphs.join('\n\n');
}

// Hotkey / Popup message handlers

if (isContextValid()) {
  chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
    if (msg.type === 'HOTKEY_EXPLAIN') {
      const sel = window.getSelection()?.toString().trim();
      if (sel && sel.length > 1) { selectedText = sel; triggerExplain(sel); }
      else showToast(t('selectFirst'));
      sendResponse({ ok: true }); return true;
    }
    if (msg.type === 'HOTKEY_ANALYZE') {
      triggerAnalyze(); sendResponse({ ok: true }); return true;
    }
    if (msg.type === 'COPY_LAST') {
      if (lastResult) { copyAsMarkdown(lastResult, location.href); showToast(t('copied')); }
      else showToast(t('noResult'));
      sendResponse({ ok: true }); return true;
    }
    if (msg.type === 'GET_SELECTION') {
      const sel = window.getSelection()?.toString().trim() || '';
      sendResponse({ text: sel });
      return true;
    }
    if (msg.type === 'GET_ARTICLE_TEXT') {
      const { text } = extractArticleText();
      sendResponse({ text });
      return true;
    }
    if (msg.type === 'POPUP_EXPLAIN') {
      const text = msg.text || '';
      if (!text) { sendResponse({ ok: false, error: t('selectFirst') }); return true; }
      if (text.length > MAX_EXPLAIN_CHARS) {
        sendResponse({ ok: false, error: t('textTooLong') }); return true;
      }
      try {
        const data = await callAPI({
          text,
          mode: 'explain',
          url: location.href,
          installId: msg.installId,
        });
        const result = data.result || '';
        lastResult = result;
        safeSendMessage({ type: 'STORE_RESULT', result, url: location.href });
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({
          ok: false,
          error: getDisplayErrorMessage(err?.message) || t('errorSomethingWentWrong'),
          errorCode: err?.errorCode,
          code: err.code
        });
      }
      return true;
    }
    if (msg.type === 'POPUP_ANALYZE') {
      const { text: bodyText } = extractArticleText();
      if (bodyText.length > MAX_ANALYZE_CHARS) {
        sendResponse({ ok: false, error: t('articleTooLong') });
        return true;
      }
      const wordCount = bodyText.split(/\s+/).length;
      try {
        const data = await callAPI({
          text: bodyText,
          mode: 'analyze',
          url: location.href,
          installId: msg.installId,
        });
        const result = data.result || null;
        const sections = getAnalyzeSections(result);
        lastResult = flattenAnalyzeSections(sections);
        const timeSaved = calculateAnalyzeSavedMin(wordCount, result);
        await cacheAnalyzeResult(result, timeSaved, wordCount, location.href);
        safeSendMessage({ type: 'STORE_RESULT', result, url: location.href });
        sendResponse({ ok: true, result, articleWordCount: wordCount, timeSaved });
      } catch (err) {
        sendResponse({
          ok: false,
          error: getDisplayErrorMessage(err?.message) || t('errorSomethingWentWrong'),
          errorCode: err?.errorCode,
          code: err.code
        });
      }
      return true; // keep channel open for async
    }
  });
}

// API call (with 12 s timeout)

async function callAPI({ text, mode, url, language, previousExplanation, installId }) {
  try {
    if (!isSupportedHttpsPage(url)) {
      throw new Error(t('supportedHttpsOnly'));
    }

    const resolvedInstallId = installId || await ensureInstallId();
    const payload = { text, mode, url, language: language || detectArticleLanguage(), installId: resolvedInstallId };
    if (previousExplanation) payload.previousExplanation = previousExplanation;
    const resp = await chrome.runtime.sendMessage({
      type: 'WORKER_FETCH',
      path: '/process',
      payload,
    });

    if (!resp?.ok) {
      if (resp?.networkError === 'timeout') {
        throw new Error(t('errorRequestTimeout'));
      }
      if (resp?.networkError === 'fetch_failed') {
        throw new Error(t('serviceUnavailable'));
      }

      const err = resp?.body || {};
      if (resp?.status === 429) {
        const error = new Error(t('temporaryProtection'));
        error.code = 'burst_limit';
        throw error;
      }
      if (resp?.status === 503) {
        throw new Error(t('serviceUnavailable'));
      }
      const errorCode = err.error;
      if (errorCode === 'config_missing') {
        const error = new Error(t('backendConfigMissing'));
        error.errorCode = errorCode;
        throw error;
      }
      if (errorCode === 'permission_missing') {
        const error = new Error(t('backendPermissionMissing'));
        error.errorCode = errorCode;
        throw error;
      }
      if (errorCode === 'invalid_backend_url') {
        const error = new Error(t('backendInvalidUrl'));
        error.errorCode = errorCode;
        throw error;
      }
      if (errorCode === 'provider_error') {
        throw new Error(t('errorProviderFailure'));
      }
      if (errorCode === 'internal_error') {
        throw new Error(t('errorSomethingWentWrong'));
      }
      throw new Error(t('errorSomethingWentWrong'));
    }
    return resp.body || {};
  } catch (err) {
    const wrapped = new Error(getDisplayErrorMessage(err?.message) || t('errorSomethingWentWrong'));
    wrapped.code = err?.code;
    wrapped.errorCode = err?.errorCode;
    throw wrapped;
  }
}

// Escape HTML for safe rendering

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Shared markdown formatter

function formatText(text) {
  text = text || '';
  // First escape the text to prevent injection
  text = escapeHtml(text);
  // Then apply lightweight formatting to the escaped string
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^Q:\s*(.+)$/gm, '<div class="rc-q">Q: $1</div>')
    .replace(/^A:\s*(.+)$/gm, '<div class="rc-a">$1</div>')
    .replace(/^[-\u2022]\s*(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

function calculateAnalyzeSavedMin(articleWordCount, analyzeResult) {
  const sections = getAnalyzeSections(analyzeResult);
  if (!sections) return null;
  const articleMin = Math.round(articleWordCount / 200);
  const summaryWords = `${sections.essence} ${sections.notes}`.split(/\s+/).filter(Boolean).length;
  const summaryMin = Math.max(1, Math.round(summaryWords / 200));
  const savedMin = Math.max(1, articleMin - summaryMin);
  return savedMin;
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

function flattenAnalyzeSections(sections) {
  if (!sections) return '';
  return [
    `${t('tabEssence')}\n${sections.essence}`,
    `${t('tabNotes')}\n${sections.notes}`,
    `${t('tabNextSteps')}\n${sections.nextSteps}`,
  ].join('\n\n');
}

// Toast

function showToast(message) {
  document.getElementById('rc-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'rc-toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

