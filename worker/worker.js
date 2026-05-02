// ─── R-Searcher · Cloudflare Worker v1.2 ───────────────────────────────

const LIMITS = {
  free: { explain: 70, analyze: 5 },
};

// ─── Observability ─────────────────────────────────────────────────────────────

function getShortInstallIdForLogs(installId) {
  if (!installId || typeof installId !== 'string') {
    return 'unknown';
  }
  // Use last 8 chars of installId as a derived short identifier for logs
  return installId.slice(-8);
}

function logEvent(event, fields) {
  const timestamp = new Date().toISOString();
  // Mask full installId in logs if present
  const maskedFields = { ...fields };
  if (maskedFields.installId) {
    maskedFields.installId = getShortInstallIdForLogs(maskedFields.installId);
  }
  const logEntry = JSON.stringify({
    timestamp,
    event,
    ...maskedFields,
  });
  console.log(logEntry);
}

// Intentional early-stage spending ceiling. Not exact billing math, intentionally conservative.
const GLOBAL_DAILY_TOKEN_BUDGET = 10000000;
const MAX_EXPLAIN_CHARS = 2000;
const MAX_ANALYZE_CHARS = 12000;

// ─── Emergency controls (env-driven) ───────────────────────────────────────────

function checkEmergencyControls(env) {
  const maintenanceMode = env.MAINTENANCE_MODE === 'true';
  const aiDisabled = env.AI_DISABLED === 'true';
  const maxBudgetOverride = parseInt(env.MAX_GLOBAL_BUDGET_OVERRIDE || '0', 10);

  return {
    maintenanceMode,
    aiDisabled,
    maxBudgetOverride: maxBudgetOverride > 0 ? maxBudgetOverride : null,
  };
}
const BURST_LIMITS = {
  explain: { windowSec: 300, max: 12 },
  analyze: { windowSec: 600, max: 4 },
};
const VALID_MODES = [
  'explain',
  'analyze',
  'explain_rephrase',
  'explain_example',
  'explain_application',
  'explain_importance',
];
const INSTALL_ID_PATTERN = /^[a-f0-9-]{30,40}$/i;
const ANALYZE_DELIMITERS = {
  section1: '<<<SECTION_1>>>',
  section2: '<<<SECTION_2>>>',
  section3: '<<<SECTION_3>>>',
};
const ANALYZE_FALLBACK_COPY = {
  en: {
    headings: ['Search queries:', 'Experts & sources:', 'Related topics:'],
    nextSteps: [
      'Search queries:',
      '- Explore this topic further',
      '',
      'Experts & sources:',
      '- Original author / publication',
      '',
      'Related topics:',
      '- Adjacent topic worth reading next',
    ].join('\n'),
    essenceUnavailable: 'Key idea unavailable in the original response.',
  },
  ru: {
    headings: ['Поисковые запросы:', 'Эксперты и источники:', 'Связанные темы:'],
    nextSteps: [
      'Поисковые запросы:',
      '- Изучить тему глубже',
      '',
      'Эксперты и источники:',
      '- Исходный автор / публикация',
      '',
      'Связанные темы:',
      '- Смежная тема для следующего чтения',
    ].join('\n'),
    essenceUnavailable: 'Не удалось выделить ключевую мысль из исходного ответа.',
  },
  uk: {
    headings: ['Пошукові запити:', 'Експерти та джерела:', "Пов'язані теми:"],
    nextSteps: [
      'Пошукові запити:',
      '- Дослідити цю тему глибше',
      '',
      'Експерти та джерела:',
      '- Початковий автор / публікація',
      '',
      "Пов'язані теми:",
      '- Суміжна тема для наступного читання',
    ].join('\n'),
    essenceUnavailable: 'Не вдалося виділити ключову думку з початкової відповіді.',
  },
  es: {
    headings: ['Consultas de busqueda:', 'Expertos y fuentes:', 'Temas relacionados:'],
    nextSteps: [
      'Consultas de busqueda:',
      '- Explorar este tema con mas profundidad',
      '',
      'Expertos y fuentes:',
      '- Autor o publicacion original',
      '',
      'Temas relacionados:',
      '- Un tema cercano para seguir leyendo',
    ].join('\n'),
    essenceUnavailable: 'No fue posible extraer la idea clave de la respuesta original.',
  },
  de: {
    headings: ['Suchanfragen:', 'Experten und Quellen:', 'Verwandte Themen:'],
    nextSteps: [
      'Suchanfragen:',
      '- Dieses Thema weiter vertiefen',
      '',
      'Experten und Quellen:',
      '- Urspruenglicher Autor / Publikation',
      '',
      'Verwandte Themen:',
      '- Angrenzendes Thema zum Weiterlesen',
    ].join('\n'),
    essenceUnavailable: 'Die Kernaussage konnte aus der urspruenglichen Antwort nicht extrahiert werden.',
  },
  fr: {
    headings: ['Recherches suggerees:', 'Experts et sources:', 'Sujets connexes:'],
    nextSteps: [
      'Recherches suggerees:',
      '- Approfondir ce sujet',
      '',
      'Experts et sources:',
      '- Auteur ou publication d origine',
      '',
      'Sujets connexes:',
      '- Sujet voisin a lire ensuite',
    ].join('\n'),
    essenceUnavailable: "Impossible d extraire l idee cle de la reponse d origine.",
  },
  pt: {
    headings: ['Pesquisas sugeridas:', 'Especialistas e fontes:', 'Topicos relacionados:'],
    nextSteps: [
      'Pesquisas sugeridas:',
      '- Explorar este tema com mais profundidade',
      '',
      'Especialistas e fontes:',
      '- Autor ou publicacao original',
      '',
      'Topicos relacionados:',
      '- Tema adjacente para ler em seguida',
    ].join('\n'),
    essenceUnavailable: 'Nao foi possivel extrair a ideia principal da resposta original.',
  },
};

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SMART_ANALYZE_PROMPT = (text, language) => `The article language is: ${language}. Write your ENTIRE response in this language. No exceptions.

You are R-Searcher — a reading assistant that helps users extract maximum value from articles.

Structure your response using EXACTLY these delimiters, nothing before <<<SECTION_1>>>:

<<<SECTION_1>>>
ESSENCE: 3-5 sentences. What is this article about, what is the main claim or finding, and why does it matter? Be direct — no intro phrases like "This article...". Start with the subject.

<<<SECTION_2>>>
NOTES: Structured digest — not a retelling, not a summary. Capture only insights, decisions, and facts the user would want to reference later. Use ## for main topics, bullet points for key points, **bold** for key terms. Be thorough but ruthlessly cut anything obvious, repetitive or decorative.

<<<SECTION_3>>>
NEXT STEPS:
Keep EVERYTHING inside SECTION_3 in the article language too, including headings, labels, and bullet text.
Do not switch to English for headings or helper labels unless the article itself is in English.
Use exactly three compact groups in this order:
1. Search queries: 3-5 specific queries to explore the topic further
2. Experts & sources: 2-3 names, authors, publications, or organizations relevant to the topic
3. Related topics: 1-2 adjacent areas worth exploring next
Keep proper names in their original language when appropriate, but keep the surrounding labels and explanations in the article language.

Article:
"""
${text}
"""`;

const SMART_EXPLAIN_PROMPT = (text, language) => `The text language is: ${language}. Write your ENTIRE response in this language. No exceptions.

You are R-Searcher. Explain the following text to a smart person with no background in this field.

- No jargon without explanation
- Max 4-5 sentences
- Be direct, start explaining immediately

Then add EXACTLY this block at the end, in English, no exceptions:

<<<META>>>
type: technical|scientific|historical|legal|medical|general
has_example: true|false
has_application: true|false

Text:
"""
${text}
"""`;

const SMART_EXPLAIN_REPHRASE_PROMPT = (text, language, previousExplanation) => `The text language is: ${language}. Write your ENTIRE response in this language. No exceptions.

You are R-Searcher. The previous explanation was:
"""
${previousExplanation}
"""

Now explain the SAME text differently. Use a completely different angle, metaphor, or structure. Focus on what wasn't covered before.

- No jargon without explanation
- Max 4-5 sentences
- Be direct

Text:
"""
${text}
"""`;

const SMART_EXPLAIN_EXAMPLE_PROMPT = (text, language, previousExplanation) => `The text language is: ${language}. Write your ENTIRE response in this language. No exceptions.

You are R-Searcher. Here's the text that was explained:
"""
${previousExplanation}
"""

Provide a concrete, real-world example that illustrates the concept.

- Use a relatable scenario
- Max 3-4 sentences
- Be specific and practical

Text:
"""
${text}
"""`;

const SMART_EXPLAIN_APPLICATION_PROMPT = (text, language, previousExplanation) => `The text language is: ${language}. Write your ENTIRE response in this language. No exceptions.

You are R-Searcher. Here's what was explained:
"""
${previousExplanation}
"""

Where and how is this used in the real world? What industries, professions, or situations apply this concept?

- Be practical
- Max 3-4 sentences
- Name specific contexts if possible

Text:
"""
${text}
"""`;

const SMART_EXPLAIN_IMPORTANCE_PROMPT = (text, language, previousExplanation) => `The text language is: ${language}. Write your ENTIRE response in this language. No exceptions.

You are R-Searcher. Here's what was explained:
"""
${previousExplanation}
"""

Why does this matter? What makes this concept important, significant, or worth understanding?

- Explain the impact or relevance
- Max 3-4 sentences
- Be direct and meaningful

Text:
"""
${text}
"""`;

// ─── Rate limiting ─────────────────────────────────────────────────────────────

function getModeBucket(mode) {
  return mode.startsWith('explain') ? 'explain' : 'analyze';
}

function getBurstBucket(mode) {
  return mode.startsWith('explain') ? 'explain' : 'analyze';
}

function getModeLimit(mode, effectivePlan) {
  return LIMITS[effectivePlan][getModeBucket(mode)];
}

function getMaxChars(mode) {
  return mode === 'analyze' ? MAX_ANALYZE_CHARS : MAX_EXPLAIN_CHARS;
}

function jsonResponse(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// Browser hygiene only: CORS is not real auth for this worker.
// Real abuse protection comes from size caps, burst throttling, and conservative budget accounting.
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = origin.startsWith('chrome-extension://') || origin === 'null' ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function assertRateLimitStorage(env) {
  return !!env.RATE_LIMIT_KV;
}

function isLocalDevRequest(request, env) {
  const url = new URL(request.url);
  return url.hostname === '127.0.0.1'
    || url.hostname === 'localhost'
    || env.APP_ENV === 'development';
}

function getDailyExpirationTtl(now = new Date()) {
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));
  return Math.max(60, Math.ceil((tomorrow - now) / 1000));
}

function getUtcWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getSecondsUntilNextUtcWeek(date = new Date()) {
  const day = date.getUTCDay();
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
  const next = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + daysUntilNextMonday
  ));
  next.setUTCHours(0, 0, 0, 0);
  return Math.max(60, Math.ceil((next - date) / 1000));
}

function isValidInstallId(value) {
  return typeof value === 'string' && INSTALL_ID_PATTERN.test(value);
}


function getNowSec() {
  return Math.floor(Date.now() / 1000);
}



function estimateRequestCost(text, mode) {
  const inputTokens = Math.ceil((text || '').length / 3);
  const outputReserve = mode === 'analyze' ? 2200 : 1000;
  const safetyMargin = 500;
  return inputTokens + outputReserve + safetyMargin;
}

// Global budget is attempt-based on purpose: even failed provider calls still create cost/risk.
// KV get/put is best-effort under concurrency, so the estimate is intentionally pessimistic.
async function reserveGlobalBudget(env, text, mode) {
  const controls = checkEmergencyControls(env);
  const budgetLimit = controls.maxBudgetOverride || GLOBAL_DAILY_TOKEN_BUDGET;
  const today = new Date().toISOString().split('T')[0];
  const key = `global:tokens:${today}`;
  const used = Number.parseInt((await env.RATE_LIMIT_KV.get(key)) || '0', 10);
  const estimatedCost = estimateRequestCost(text, mode);
  if (used + estimatedCost > budgetLimit) return { allowed: false, reserved: used };

  await env.RATE_LIMIT_KV.put(key, String(used + estimatedCost), {
    expirationTtl: getDailyExpirationTtl(),
  });
  return { allowed: true };
}

// Burst throttling is also approximate under parallel attack because KV updates are not atomic.
// We keep the buckets intentionally small to make this best-effort guard conservative.
async function checkBurstLimit(env, ip, mode) {
  const bucket = getBurstBucket(mode);
  const { windowSec, max } = BURST_LIMITS[bucket];
  const nowSec = Math.floor(Date.now() / 1000);
  const slot = Math.floor(nowSec / windowSec);
  const key = `burst:${bucket}:${ip}:${slot}`;
  const count = Number.parseInt((await env.RATE_LIMIT_KV.get(key)) || '0', 10);
  const nextCount = count + 1;
  const slotEndsAt = (slot + 1) * windowSec;

  await env.RATE_LIMIT_KV.put(key, String(nextCount), {
    expirationTtl: Math.max(60, slotEndsAt - nowSec),
  });

  if (nextCount > max) return { allowed: false };
  return { allowed: true };
}

// Fairness stays per install, while burst throttling remains IP-based anti-abuse.
// KV is still best-effort here, which means weekly counts remain approximate under parallel requests.
async function checkUserRateLimit(env, installId, mode, effectivePlan) {
  const bucket = getModeBucket(mode);
  const limit = getModeLimit(mode, effectivePlan);
  const weekKey = getUtcWeekKey();
  const key = `quota:${effectivePlan}:${bucket}:${installId}:${weekKey}`;
  const count = Number.parseInt((await env.RATE_LIMIT_KV.get(key)) || '0', 10);
  if (count >= limit) return { allowed: false, remaining: 0, limit };
  return { allowed: true, remaining: limit - count, limit };
}

async function consumeUserRateLimit(env, installId, mode, effectivePlan) {
  const bucket = getModeBucket(mode);
  const limit = getModeLimit(mode, effectivePlan);
  const now = new Date();
  const weekKey = getUtcWeekKey(now);
  const key = `quota:${effectivePlan}:${bucket}:${installId}:${weekKey}`;
  const count = Number.parseInt((await env.RATE_LIMIT_KV.get(key)) || '0', 10);
  const nextCount = count + 1;

  await env.RATE_LIMIT_KV.put(key, String(nextCount), {
    expirationTtl: getSecondsUntilNextUtcWeek(now),
  });

  return { remaining: Math.max(0, limit - nextCount), limit };
}

// ─── Gemini 2.5 Flash-Lite ────────────────────────────────────────────────────

async function callGemini(env, prompt, mode) {
  const maxTokens = mode === 'analyze' ? 2000 : 800;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.AI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 }
      })
    }
  );
  if (!response.ok) throw new Error(`provider_error:${response.status}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    logEvent('gemini_empty_200_response', { mode });
    throw new Error('provider_error:empty_response');
  }
  return text;
}

function buildPrompt(mode, text, language, previousExplanation) {
  if (mode === 'explain') {
    return SMART_EXPLAIN_PROMPT(text, language);
  }
  if (mode === 'explain_rephrase') {
    return SMART_EXPLAIN_REPHRASE_PROMPT(text, language, previousExplanation);
  }
  if (mode === 'explain_example') {
    return SMART_EXPLAIN_EXAMPLE_PROMPT(text, language, previousExplanation);
  }
  if (mode === 'explain_application') {
    return SMART_EXPLAIN_APPLICATION_PROMPT(text, language, previousExplanation);
  }
  if (mode === 'explain_importance') {
    return SMART_EXPLAIN_IMPORTANCE_PROMPT(text, language, previousExplanation);
  }
  return SMART_ANALYZE_PROMPT(text, language);
}

function normalizeNewlines(text) {
  return (text || '').replace(/\r\n?/g, '\n');
}

function getLanguageBase(language) {
  if (!language || typeof language !== 'string') return 'en';
  const trimmed = language.trim().toLowerCase().replace('_', '-');
  const [base] = trimmed.split('-');
  return ANALYZE_FALLBACK_COPY[base] ? base : 'en';
}

function getAnalyzeFallbackCopy(language) {
  return ANALYZE_FALLBACK_COPY[getLanguageBase(language)];
}

function cleanAnalyzeSection(text) {
  return normalizeNewlines(text)
    .replace(/^\s*(?:\*\*)?(?:ESSENCE|NOTES|NEXT\s*STEPS)(?:\*\*)?\s*:?\s*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tryParseAnalyzeSections(raw) {
  const normalizedRaw = normalizeNewlines(raw);
  const s1 = normalizedRaw.indexOf(ANALYZE_DELIMITERS.section1);
  const s2 = normalizedRaw.indexOf(ANALYZE_DELIMITERS.section2);
  const s3 = normalizedRaw.indexOf(ANALYZE_DELIMITERS.section3);

  if (s1 === -1 || s2 === -1 || s3 === -1 || !(s1 < s2 && s2 < s3)) {
    return null;
  }

  const essence = cleanAnalyzeSection(
    normalizedRaw.slice(s1 + ANALYZE_DELIMITERS.section1.length, s2),
  );
  const notes = cleanAnalyzeSection(
    normalizedRaw.slice(s2 + ANALYZE_DELIMITERS.section2.length, s3),
  );
  const nextSteps = cleanAnalyzeSection(
    normalizedRaw.slice(s3 + ANALYZE_DELIMITERS.section3.length),
  );

  if (!essence || !notes || !nextSteps) {
    return null;
  }

  return { essence, notes, nextSteps };
}

function stripAnalyzeMarkers(raw) {
  return normalizeNewlines(raw)
    .replace(/<<<SECTION_[123]>>>/g, '\n')
    .replace(/^\s*(?:\*\*)?(?:ESSENCE|NOTES|NEXT\s*STEPS)(?:\*\*)?\s*:?\s*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitMeaningfulParagraphs(text) {
  return normalizeNewlines(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function splitSentences(text) {
  const matches = normalizeNewlines(text)
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g);
  return (matches || []).map((sentence) => sentence.trim()).filter(Boolean);
}

function buildEssenceFallback(text) {
  const paragraphs = splitMeaningfulParagraphs(text);
  const source = paragraphs[0] || text.trim();
  const sentences = splitSentences(source);

  if (sentences.length >= 3) {
    return sentences.slice(0, Math.min(sentences.length, 5)).join(' ').trim();
  }

  const allSentences = splitSentences(text);
  if (allSentences.length) {
    return allSentences.slice(0, Math.min(allSentences.length, 5)).join(' ').trim();
  }

  return source;
}

function extractExistingNextSteps(text) {
  const headings = Object.values(ANALYZE_FALLBACK_COPY)
    .flatMap((copy) => copy.headings);
  const lowerText = text.toLowerCase();

  for (const heading of headings) {
    const index = lowerText.indexOf(heading.toLowerCase());
    if (index !== -1) {
      const existing = text.slice(index).trim();
      if (existing) {
        return existing;
      }
    }
  }

  return '';
}

function buildNotesFallback(text, essence, nextSteps) {
  let notes = text.trim();

  if (nextSteps) {
    const nextStepsIndex = notes.indexOf(nextSteps);
    if (nextStepsIndex > 0) {
      notes = notes.slice(0, nextStepsIndex).trim();
    }
  }

  if (essence && notes.startsWith(essence)) {
    notes = notes.slice(essence.length).trim();
  }

  if (notes) {
    return notes;
  }

  const paragraphs = splitMeaningfulParagraphs(text);
  if (paragraphs.length > 1) {
    return paragraphs.slice(1).join('\n\n').trim();
  }

  return text.trim();
}

function normalizeAnalyzeResult(raw, language) {
  const text = typeof raw === 'string' ? raw : String(raw || '');
  const parsedSections = tryParseAnalyzeSections(text);
  if (parsedSections) {
    return { raw: text, sections: parsedSections };
  }

  const fallbackCopy = getAnalyzeFallbackCopy(language);
  const cleaned = stripAnalyzeMarkers(text);
  const nextSteps = extractExistingNextSteps(cleaned) || fallbackCopy.nextSteps;
  const essence = buildEssenceFallback(cleaned) || fallbackCopy.essenceUnavailable;
  const notes = buildNotesFallback(cleaned, essence, nextSteps) || cleaned || essence;

  return {
    raw: text,
    sections: {
      essence,
      notes,
      nextSteps,
    },
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleProcessRequest(request, env, cors, ip) {
  const controls = checkEmergencyControls(env);
  if (controls.maintenanceMode || controls.aiDisabled) {
    logEvent('request_503_maintenance_or_ai_disabled', { maintenanceMode: controls.maintenanceMode, aiDisabled: controls.aiDisabled });
    return jsonResponse({ error: 'service_unavailable' }, 503, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    logEvent('request_400_invalid_json', { mode: 'unknown', installId: 'unknown' });
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }

  const { text, mode, language, previousExplanation, installId } = body;
  if (typeof text !== 'string' || !text || !mode) {
    logEvent('request_400_missing_field', { mode: mode || 'unknown', installId: installId || 'unknown' });
    return jsonResponse({ error: 'Missing text or mode' }, 400, cors);
  }

  if (!isValidInstallId(installId)) {
    logEvent('request_400_invalid_installId', { mode, installId: installId || 'unknown' });
    return jsonResponse({ error: 'Missing or invalid installId' }, 400, cors);
  }

  if (!VALID_MODES.includes(mode)) {
    logEvent('request_400_invalid_mode', { mode, installId });
    return jsonResponse({ error: 'Invalid mode' }, 400, cors);
  }

  if (text.length > getMaxChars(mode)) {
    logEvent('request_413_oversize', { mode, installId, charCount: text.length, maxChars: getMaxChars(mode) });
    return jsonResponse({ error: 'Request too large' }, 413, cors);
  }

  const hasRateLimitStorage = assertRateLimitStorage(env);

  if (hasRateLimitStorage) {
    const burst = await checkBurstLimit(env, ip, mode);
    if (!burst.allowed) {
      logEvent('request_429_burst_limit', { mode, installId });
      return jsonResponse({ error: 'burst_limit' }, 429, cors);
    }

    const globalBudget = await reserveGlobalBudget(env, text, mode);
    if (!globalBudget.allowed) {
      logEvent('request_503_global_budget_exceeded', { mode, installId, budgetReserved: globalBudget.reserved });
      return jsonResponse({ error: 'service_unavailable' }, 503, cors);
    }
  }

  const prompt = buildPrompt(mode, text, language, previousExplanation);

  try {
    const rawResult = await callGemini(env, prompt, mode);
    const result = mode === 'analyze'
      ? normalizeAnalyzeResult(rawResult, language)
      : rawResult;

    logEvent('request_200_success', { mode, installId, charCount: text.length, hasRateLimitStorage });
    return jsonResponse({
      result,
    }, 200, cors);
  } catch (err) {
    const isProviderError = err.message.startsWith('provider_error');
    const eventName = isProviderError ? 'request_500_provider_error' : 'request_500_internal_error';
    logEvent(eventName, { mode, installId, error: err.message });
    // Return stable error code for provider failures; keep detailed error in logs
    const errorCode = isProviderError ? 'provider_error' : 'internal_error';
    return jsonResponse({
      error: errorCode,
    }, 500, cors);
  }
}


export default {
  async fetch(request, env) {
    const cors = getCorsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const url = new URL(request.url);

    if (url.pathname === '/process') {
      return handleProcessRequest(request, env, cors, ip);
    }

    return new Response('Not found', { status: 404, headers: cors });
  }
};
