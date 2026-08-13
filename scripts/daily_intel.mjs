import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = (name) => path.join(root, 'config', name);
const args = new Set(process.argv.slice(2));
const option = (name, fallback = undefined) => {
  const list = process.argv.slice(2);
  const index = list.indexOf(name);
  return index >= 0 && list[index + 1] ? list[index + 1] : fallback;
};

const isoDate = option('--date', new Date().toISOString().slice(0, 10));
const outputRoot = path.resolve(option('--out', path.join(root, 'daily-output')));
const stateFile = path.resolve(option('--state', path.join(root, 'state', 'seen_items.json')));
const isDemo = args.has('--demo');
const isBaseline = args.has('--baseline');
const maxItems = Number(option('--limit', '60'));
const historyLimit = Number(option('--history-limit', '240'));
const dashboardLimit = Number(option('--dashboard-limit', '28'));
const aiSummaryLimit = Number(option('--ai-summary-limit', '28'));

const categoryWeight = {
  '技術元件': 95,
  '品牌新品': 92,
  '售後維修': 86,
  '法規更新': 76,
  '安全召回': 65,
  '產業趨勢': 45
};
const categoryCaps = {
  '技術元件': 18,
  '品牌新品': 18,
  '售後維修': 14,
  '法規更新': 10,
  '安全召回': 6,
  '產業趨勢': 8
};
const priorityWeight = { urgent: 18, high: 12, normal: 5, low: 0 };

function decodeEntities(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)));
}

function stripHtml(value = '') {
  return decodeEntities(value)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value = '') {
  return stripHtml(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function absoluteUrl(candidate, base) {
  try { return new URL(candidate, base).href; } catch { return base; }
}

function readTag(xml, tag) {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? '';
}

function extractImageUrl(xml, base) {
  const candidates = [];
  for (const match of xml.matchAll(/<(?:media:(?:content|thumbnail|image)|enclosure)\b([^>]*)>/gi)) {
    const url = match[1].match(/\burl=["']([^"']+)["']/i)?.[1];
    if (url) candidates.push(url);
  }
  for (const match of xml.matchAll(/<img\b([^>]*)>/gi)) {
    const url = match[1].match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (url) candidates.push(url);
  }
  const first = candidates.find((candidate) => /^https?:|^\//i.test(decodeEntities(candidate)));
  return first ? absoluteUrl(decodeEntities(first), base) : '';
}

function parseRss(xml, source) {
  const chunks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return chunks.slice(0, 100).map((chunk) => {
    const link = chunk.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? readTag(chunk, 'link');
    return {
      title: stripHtml(readTag(chunk, 'title')),
      summary: stripHtml(readTag(chunk, 'description') || readTag(chunk, 'summary') || readTag(chunk, 'content')).slice(0, 900),
      articleUrl: absoluteUrl(stripHtml(link), source.url),
      publishedAt: stripHtml(readTag(chunk, 'pubDate') || readTag(chunk, 'published') || readTag(chunk, 'updated') || readTag(chunk, 'dc:date')),
      publisher: stripHtml(readTag(chunk, 'source')),
      imageUrl: extractImageUrl(chunk, source.url),
      source
    };
  }).filter((item) => item.title);
}

function parseWeb(html, source) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/<(h[1-3]|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const title = stripHtml(match[3]);
    const href = match[2].match(/href=["']([^"']+)["']/i)?.[1] ?? source.url;
    const key = normalize(title);
    if (title.length < 18 || title.length > 240 || seen.has(key)) continue;
    seen.add(key);
    results.push({ title, summary: '', articleUrl: absoluteUrl(href, source.url), publishedAt: '', publisher: '', imageUrl: '', source });
    if (results.length >= 45) break;
  }
  return results;
}

function extractOpenGraphImage(html, base) {
  const patterns = [
    /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image|twitter:image:src)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image|twitter:image:src)["'][^>]*>/i
  ];
  for (const pattern of patterns) {
    const value = html.match(pattern)?.[1];
    if (value) return absoluteUrl(decodeEntities(value), base);
  }
  return '';
}

async function fetchSource(source, report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'user-agent': 'E-Mobility-Intel/3.0 (public-source monitor)' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const found = source.kind === 'rss' ? parseRss(text, source) : parseWeb(text, source);
    report.sources.push({ id: source.id, name: source.name, status: 'ok', candidates: found.length });
    return found;
  } catch (error) {
    report.sources.push({ id: source.id, name: source.name, status: 'failed', error: String(error.message) });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichImages(items, report) {
  const limit = Math.max(0, Number(option('--image-limit', '36')));
  const targets = items.filter((item) => !item.imageUrl && /^https?:\/\//i.test(item.articleUrl)).slice(0, limit);
  let cursor = 0;
  let found = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(item.articleUrl, { signal: controller.signal, headers: { 'user-agent': 'E-Mobility-Intel/3.0 (public-source monitor)' } });
        if (!response.ok) continue;
        const imageUrl = extractOpenGraphImage(await response.text(), response.url || item.articleUrl);
        if (imageUrl) { item.imageUrl = imageUrl; item.imageCredit = '原始報導縮圖'; found += 1; }
      } catch {
        // Images are optional enrichment; article metadata remains usable.
      } finally {
        clearTimeout(timeout);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, targets.length) }, worker));
  report.imageEnrichment = { attempted: targets.length, found };
}

function containsAny(haystack, terms = []) {
  return terms.some((term) => haystack.includes(normalize(term)));
}

function containsRequiredTerm(haystack, term) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`, 'u').test(haystack);
}

function containsRequiredAny(haystack, terms = []) {
  return terms.some((term) => containsRequiredTerm(haystack, term));
}

function sourceName(item) {
  return item.publisher || item.source?.name || '未知來源';
}

function itemTimestamp(item) {
  const parsed = Date.parse(item.publishedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function itemAgeDays(item) {
  const timestamp = itemTimestamp(item);
  if (!timestamp) return 45;
  return Math.max(0, (Date.now() - timestamp) / 86400000);
}

function isGenericIncident(item, taxonomy) {
  const haystack = normalize(`${item.title} ${item.summary}`);
  return containsAny(haystack, taxonomy.genericIncidentTerms) && !containsAny(haystack, taxonomy.actionableSafetyTerms);
}

function isLowSignal(item, taxonomy) {
  const haystack = normalize(`${item.title} ${item.summary}`);
  return containsAny(haystack, taxonomy.lowSignalTerms);
}

function scoreItem(item, taxonomy) {
  const haystack = normalize(`${item.title} ${item.summary}`);
  const titleStack = normalize(item.title);
  const relevant = containsAny(haystack, taxonomy.relevanceTerms);
  if (isGenericIncident(item, taxonomy)) return { ...item, relevant: false, excludedReason: 'generic_incident', titleKey: normalize(item.title) };
  if (isLowSignal(item, taxonomy)) return { ...item, relevant: false, excludedReason: 'low_signal', titleKey: normalize(item.title) };
  if (item.source.requiredTerms?.length && !containsRequiredAny(titleStack, item.source.requiredTerms)) {
    return { ...item, relevant: false, excludedReason: 'source_focus_mismatch', titleKey: normalize(item.title) };
  }
  if (item.source.id === 'news_launch' && containsAny(haystack, taxonomy.launchNoiseTerms)) {
    return { ...item, relevant: false, excludedReason: 'launch_context_noise', titleKey: normalize(item.title) };
  }
  const category = taxonomy.categories
    .map((entry) => ({ name: entry.name, matches: entry.terms.filter((term) => haystack.includes(normalize(term))).length, preferred: entry.name === item.source.defaultCategory }))
    .filter((entry) => entry.matches > 0)
    .sort((a, b) => b.matches - a.matches || Number(b.preferred) - Number(a.preferred))[0]?.name
    ?? item.source.defaultCategory;
  const actionableSafety = containsAny(haystack, taxonomy.actionableSafetyTerms);
  const finalCategory = actionableSafety ? '安全召回' : category;
  if (finalCategory === '售後維修' && !actionableSafety && !containsAny(haystack, taxonomy.majorServiceTerms)) {
    return { ...item, relevant: false, excludedReason: 'not_major_service', titleKey: normalize(item.title) };
  }
  const importance = actionableSafety ? 'high' : (['法規更新', '售後維修'].includes(finalCategory) ? 'high' : item.source.priority);
  return { ...item, category: finalCategory, importance, relevant, titleKey: normalize(item.title) };
}

function focusScore(item) {
  const fresh = Math.max(0, 55 - itemAgeDays(item) * 2.5);
  return (categoryWeight[item.category] ?? 25) + (priorityWeight[item.importance] ?? 0) + fresh;
}

function sortItems(left, right) {
  return focusScore(right) - focusScore(left)
    || itemTimestamp(right) - itemTimestamp(left)
    || String(right.title).localeCompare(String(left.title));
}

function storyTokens(title = '') {
  const ignored = new Set(['electric', 'e', 'bike', 'bikes', 'scooter', 'scooters', 'launch', 'launches', 'launched', 'new', 'model', 'with', 'for', 'the', 'and', 'from', 'this', 'that', 'its', 'into', 'ahead', 'due', 'update', 'range', 'price', 'prices', 'start', 'starts', 'buyers', 'buyer', 'first', 'time', 'powered', 'based', 'features', 'feature', 'india', 'global', 'in', 'at', 'on', 'of', 'to', 'a', 'an']);
  return new Set(normalize(title).split(' ').filter((token) => token.length >= 2 && !/^\d/.test(token) && !ignored.has(token)));
}

function isSameStory(left, right) {
  const leftTokens = storyTokens(left.title);
  const rightTokens = storyTokens(right.title);
  if (leftTokens.size < 2 || rightTokens.size < 2) return false;
  const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return common >= 2 && common / Math.min(leftTokens.size, rightTokens.size) >= 0.5;
}

function dedupeTopics(items) {
  const kept = [];
  for (const item of [...items].sort(sortItems)) {
    if (!kept.some((prior) => prior.category === item.category && isSameStory(prior, item))) kept.push(item);
  }
  return kept;
}

function selectBalanced(items) {
  const count = Object.fromEntries(Object.keys(categoryCaps).map((category) => [category, 0]));
  const selected = [];
  for (const item of [...items].sort(sortItems)) {
    const cap = categoryCaps[item.category] ?? 6;
    if ((count[item.category] ?? 0) >= cap) continue;
    selected.push(item);
    count[item.category] = (count[item.category] ?? 0) + 1;
    if (selected.length >= maxItems) break;
  }
  return selected;
}

function itemKeys(item) {
  return [`url:${item.articleUrl}`, `title:${item.titleKey}`];
}

function cleanShortText(value, maxLength) {
  return stripHtml(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function createChineseBriefs(items, report) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    report.aiSummary = { status: 'skipped', reason: 'OPENAI_API_KEY 未設定；保留原文摘要。' };
    return;
  }
  const targets = items.filter((item) => !item.titleZh || !item.briefZh).slice(0, aiSummaryLimit);
  if (!targets.length) {
    report.aiSummary = { status: 'cached', requested: 0, completed: 0 };
    return;
  }
  let completed = 0;
  const failures = [];
  for (let start = 0; start < targets.length; start += 8) {
    const batch = targets.slice(start, start + 8);
    const input = batch.map((item, index) => ({ id: index, category: item.category, source: sourceName(item), publishedAt: item.publishedAt, title: item.title, description: item.summary }));
    const schema = {
      name: 'taiwanese_chinese_mobility_digest',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'integer' }, titleZh: { type: 'string' }, briefZh: { type: 'string' } },
              required: ['id', 'titleZh', 'briefZh']
            }
          }
        },
        required: ['items']
      }
    };
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-5-mini',
          temperature: 0.2,
          response_format: { type: 'json_schema', json_schema: schema },
          messages: [
            { role: 'developer', content: '你是電動輔助自行車與電動滑板車產業編輯。只依給定原文標題與描述，寫繁體中文。titleZh 要像自然中文新聞標題，最多 30 個中文字；briefZh 是 35 到 60 個中文字的精簡內容整理或意譯。不要使用「值得關注、建議行動、焦點、此則、本則、可能牽動」等制式語，也不要補充原文沒有的數字、規格或因果。' },
            { role: 'user', content: JSON.stringify(input) }
          ]
        })
      });
      if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
      const payload = await response.json();
      const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? '{}');
      for (const row of parsed.items ?? []) {
        const item = batch[row.id];
        if (!item) continue;
        item.titleZh = cleanShortText(row.titleZh, 68);
        item.briefZh = cleanShortText(row.briefZh, 140);
        completed += 1;
      }
    } catch (error) {
      failures.push(String(error.message));
    }
  }
  report.aiSummary = { status: failures.length ? 'partial' : 'ok', requested: targets.length, completed, failures: failures.slice(0, 3) };
}

function toCsv(rows, headers) {
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

function citation(item) {
  return `${sourceName(item)}｜${item.publishedAt || '未提供發布日期'}｜${item.title}｜${item.articleUrl}｜擷取日 ${isoDate}`;
}

function toRecord(item, index) {
  return {
    '流水號': `${isoDate}-${String(index + 1).padStart(3, '0')}`,
    '擷取日期': isoDate,
    '發布日期': item.publishedAt || '',
    '分類': item.category,
    '優先級': item.importance,
    '地區': item.source.region,
    '來源名稱': sourceName(item),
    '原文標題': item.title,
    '中文標題': item.titleZh || '',
    '繁中摘要': item.briefZh || '',
    '原文摘要': item.summary || '來源頁未提供摘要。',
    '原文網址': item.articleUrl,
    '圖片網址': item.imageUrl || '',
    '引用格式': citation(item),
    '資料狀態': isDemo ? '示例資料' : '公開來源每日更新'
  };
}

function toHistoryItem(item, firstSeenAt = isoDate) {
  return {
    key: `url:${item.articleUrl}`,
    firstSeenAt,
    publishedAt: item.publishedAt || '',
    category: item.category,
    importance: item.importance,
    region: item.source.region,
    sourceName: sourceName(item),
    sourceFeed: item.source.name,
    title: item.title,
    titleZh: item.titleZh || '',
    briefZh: item.briefZh || '',
    summary: item.summary || '來源頁未提供摘要。',
    articleUrl: item.articleUrl,
    imageUrl: item.imageUrl || '',
    imageCredit: item.imageCredit || '',
    citation: citation(item)
  };
}

function hydrateHistoryItem(item) {
  return { ...item, titleZh: item.titleZh || '', briefZh: item.briefZh || '', imageUrl: item.imageUrl || '', imageCredit: item.imageCredit || '' };
}

function mergeHistory(existing, fresh) {
  const merged = new Map(existing.map((item) => [item.key || `url:${item.articleUrl}`, { ...item, key: item.key || `url:${item.articleUrl}` }]));
  for (const item of fresh) {
    const next = toHistoryItem(item);
    const prior = merged.get(next.key);
    merged.set(next.key, {
      ...prior,
      ...next,
      firstSeenAt: prior?.firstSeenAt || next.firstSeenAt,
      titleZh: next.titleZh || prior?.titleZh || '',
      briefZh: next.briefZh || prior?.briefZh || '',
      imageUrl: next.imageUrl || prior?.imageUrl || '',
      imageCredit: next.imageCredit || prior?.imageCredit || ''
    });
  }
  return dedupeTopics([...merged.values()]).slice(0, historyLimit);
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return { knownKeys: Array.isArray(parsed.knownKeys) ? parsed.knownKeys : [], history: Array.isArray(parsed.history) ? parsed.history.map(hydrateHistoryItem) : [], lastRun: parsed.lastRun ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') return { knownKeys: [], history: [], lastRun: null };
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ version: 3, lastRun: new Date().toISOString(), knownKeys: state.knownKeys.slice(-5000), history: state.history.slice(0, historyLimit) }, null, 2), 'utf8');
}

function dashboardItems(items, taxonomy) {
  const pool = items.filter((item) => !isGenericIncident(item, taxonomy)).sort(sortItems);
  const minimumMix = { '技術元件': 9, '品牌新品': 9, '售後維修': 5, '法規更新': 3, '安全召回': 2, '產業趨勢': 1 };
  const picked = [];
  for (const [category, amount] of Object.entries(minimumMix)) {
    picked.push(...pool.filter((item) => item.category === category).slice(0, amount));
  }
  const seen = new Set(picked.map((item) => item.key || item.articleUrl));
  for (const item of pool) {
    if (picked.length >= dashboardLimit) break;
    const key = item.key || item.articleUrl;
    if (!seen.has(key)) { picked.push(item); seen.add(key); }
  }
  return picked.slice(0, dashboardLimit);
}

async function writeDashboard(items, report, taxonomy) {
  const template = await fs.readFile(path.join(root, 'templates', 'intel_dashboard.html'), 'utf8');
  const featured = dashboardItems(items, taxonomy);
  const payload = {
    date: isoDate,
    mode: report.mode,
    modeLabel: report.mode === 'demo' ? '示例模式' : (report.mode === 'baseline' ? '建立資料庫' : '每日更新'),
    updatedAt: report.fetchedAt,
    newCount: report.totalNew,
    displayedCount: featured.length,
    historyCount: items.length,
    items: featured,
    sources: report.sources,
    aiSummary: report.aiSummary ?? { status: 'not_run' }
  };
  await fs.writeFile(path.join(root, '資訊工作台.html'), template.replace('__DASHBOARD_DATA__', JSON.stringify(payload).replace(/</g, '\\u003c')), 'utf8');
}

function createBrief(records) {
  const byCategory = new Map();
  for (const record of records) byCategory.set(record['分類'], [...(byCategory.get(record['分類']) ?? []), record]);
  return [
    `# 電動微型移動每日情報｜${isoDate}`,
    '',
    `本次新增 **${records.length}** 項。`,
    '',
    ...[...byCategory.entries()].flatMap(([category, rows]) => [
      `## ${category}`,
      '',
      ...rows.map((row) => `- **[${row['中文標題'] || row['原文標題']}](${row['原文網址']})**｜${row['來源名稱']}｜${row['發布日期'] || '未提供日期'}  \n  ${row['繁中摘要'] || row['原文摘要']}`),
      ''
    ]),
    '## 使用提醒',
    '',
    '- 繁中摘要由 AI 依原文標題與摘要整理；法規、規格、維修與召回請回到原文確認。',
    '- 圖片若有提供，對外使用前請確認原始網站的授權。'
  ].join('\n');
}

function createPptMaterial(records) {
  return [
    `# PowerPoint 素材候選｜${isoDate}`,
    '',
    ...records.filter((row) => ['技術元件', '品牌新品', '售後維修', '法規更新', '安全召回'].includes(row['分類'])).flatMap((row, index) => [
      `## ${index + 1}. ${row['中文標題'] || row['原文標題']}`,
      '',
      `- 分類：${row['分類']}｜${row['地區']}`,
      `- 摘要：${row['繁中摘要'] || row['原文摘要']}`,
      row['圖片網址'] ? `- 圖片（先確認授權）：[原始報導縮圖](${row['圖片網址']})` : '- 圖片：未擷取到可用縮圖。',
      `- 原文：[${row['來源名稱']}](${row['原文網址']})`,
      `- 引用：${row['引用格式']}`,
      ''
    ])
  ].join('\n');
}

function demoItems(sources) {
  const source = Object.fromEntries(sources.map((entry) => [entry.id, entry]));
  return [
    { title: 'New e-bike drive system improves torque sensing and compact packaging', summary: 'A new drive system announcement highlights a revised torque sensor and more compact motor integration for urban e-bikes.', articleUrl: 'https://example.com/demo-drive', publishedAt: isoDate, source: source.bikerumor || sources[0] },
    { title: 'Electric scooter manufacturer unveils a new commuter model', summary: 'The product launch includes updated battery capacity and a revised chassis for city commuting.', articleUrl: 'https://example.com/demo-launch', publishedAt: isoDate, source: source.electrek_scooters || sources[0] },
    { title: 'E-bike firmware service bulletin issued for selected drive units', summary: 'Dealers are asked to apply a firmware update to improve system reliability on selected drive units.', articleUrl: 'https://example.com/demo-service', publishedAt: isoDate, source: source.news_service || sources[0] }
  ];
}

async function main() {
  const [sources, taxonomy] = await Promise.all([fs.readFile(cfg('sources.json'), 'utf8').then(JSON.parse), fs.readFile(cfg('taxonomy.json'), 'utf8').then(JSON.parse)]);
  const enabled = sources.filter((source) => source.enabled);
  const report = { runDate: isoDate, mode: isDemo ? 'demo' : (isBaseline ? 'baseline' : 'live'), fetchedAt: new Date().toISOString(), sources: [], totalCandidates: 0, totalRelevant: 0, totalNew: 0, totalExported: 0, totalHistory: 0 };
  if (isDemo) report.sources = enabled.map((source) => ({ id: source.id, name: source.name, status: 'skipped_demo' }));
  const candidates = isDemo ? demoItems(enabled) : (await Promise.all(enabled.map((source) => fetchSource(source, report)))).flat();
  report.totalCandidates = candidates.length;
  const seenTitles = new Set();
  const relevant = [];
  for (const item of candidates.map((candidate) => scoreItem(candidate, taxonomy))) {
    if ((!item.relevant && !isDemo) || seenTitles.has(item.titleKey)) continue;
    seenTitles.add(item.titleKey);
    relevant.push(item);
  }
  const focused = dedupeTopics(relevant);
  report.totalRelevant = focused.length;
  const ordered = selectBalanced(focused);
  if (!isDemo) {
    await enrichImages(ordered, report);
    await createChineseBriefs(ordered, report);
  }
  const state = isDemo ? { knownKeys: [], history: [], lastRun: null } : await loadState();
  state.history = dedupeTopics(state.history.filter((item) => !isGenericIncident(item, taxonomy)));
  const known = new Set(state.knownKeys);
  const newItems = isDemo ? ordered : ordered.filter((item) => itemKeys(item).every((key) => !known.has(key)));
  if (!isDemo) {
    state.knownKeys = [...state.knownKeys, ...ordered.flatMap(itemKeys)];
    state.history = mergeHistory(state.history, ordered);
    await saveState(state);
  }
  report.totalNew = newItems.length;
  const exportItems = isBaseline ? [] : newItems;
  report.totalExported = exportItems.length;
  const records = exportItems.map(toRecord);
  const allDashboardItems = isDemo ? ordered.map((item) => toHistoryItem(item)) : state.history;
  report.totalHistory = allDashboardItems.length;
  const dayDir = path.join(outputRoot, isoDate);
  await fs.mkdir(dayDir, { recursive: true });
  const emptyRecord = toRecord({ title: '', summary: '', articleUrl: '', publishedAt: '', category: '', importance: 'normal', source: { region: '', name: '', priority: 'normal' } }, 0);
  const headers = Object.keys(records[0] ?? emptyRecord);
  await Promise.all([
    fs.writeFile(path.join(dayDir, 'information_log.csv'), toCsv(records, headers), 'utf8'),
    fs.writeFile(path.join(dayDir, 'daily_brief.md'), createBrief(records), 'utf8'),
    fs.writeFile(path.join(dayDir, 'ppt_material.md'), createPptMaterial(records), 'utf8'),
    fs.writeFile(path.join(dayDir, 'ppt_material.json'), JSON.stringify(records, null, 2), 'utf8'),
    fs.writeFile(path.join(dayDir, 'run_report.json'), JSON.stringify(report, null, 2), 'utf8')
  ]);
  await writeDashboard(allDashboardItems, report, taxonomy);
  console.log(`完成：${dayDir}`);
  console.log(`候選 ${report.totalCandidates}；相關 ${report.totalRelevant}；新增 ${report.totalNew}；工作台顯示 ${Math.min(allDashboardItems.length, dashboardLimit)}；來源成功 ${report.sources.filter((source) => source.status === 'ok').length}/${enabled.length}。`);
  if (report.aiSummary?.status === 'skipped') console.log('AI 繁中摘要未啟用：請在 GitHub Secrets 設定 OPENAI_API_KEY。');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
