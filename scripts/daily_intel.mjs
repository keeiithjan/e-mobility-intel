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
const maxItems = Number(option('--limit', '80'));
const historyLimit = Number(option('--history-limit', '240'));
const importanceOrder = ['urgent', 'high', 'normal', 'low'];

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
  const mediaPattern = /<(?:media:(?:content|thumbnail|image)|enclosure)\b([^>]*)>/gi;
  for (const match of xml.matchAll(mediaPattern)) {
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
    const publisher = stripHtml(readTag(chunk, 'source'));
    return {
      title: stripHtml(readTag(chunk, 'title')),
      summary: stripHtml(readTag(chunk, 'description') || readTag(chunk, 'summary') || readTag(chunk, 'content')).slice(0, 700),
      articleUrl: absoluteUrl(stripHtml(link), source.url),
      publishedAt: stripHtml(readTag(chunk, 'pubDate') || readTag(chunk, 'published') || readTag(chunk, 'updated') || readTag(chunk, 'dc:date')),
      publisher,
      imageUrl: extractImageUrl(chunk, source.url),
      source
    };
  }).filter((item) => item.title);
}

function parseWeb(html, source) {
  const results = [];
  const seen = new Set();
  const pattern = /<(h[1-3]|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(pattern)) {
    const title = stripHtml(match[3]);
    const href = match[2].match(/href=["']([^"']+)["']/i)?.[1] ?? source.url;
    const articleUrl = absoluteUrl(href, source.url);
    const key = normalize(title);
    if (title.length < 18 || title.length > 240 || seen.has(key)) continue;
    seen.add(key);
    results.push({ title, summary: '', articleUrl, publishedAt: '', publisher: '', imageUrl: '', source });
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

async function enrichImages(items, report) {
  const limit = Math.max(0, Number(option('--image-limit', '60')));
  const targets = items.filter((item) => !item.imageUrl && /^https?:\/\//i.test(item.articleUrl)).slice(0, limit);
  let found = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(item.articleUrl, {
          signal: controller.signal,
          headers: { 'user-agent': 'E-Mobility-Intel/2.0 (public-source monitor)' }
        });
        if (!response.ok) continue;
        const html = await response.text();
        const imageUrl = extractOpenGraphImage(html, response.url || item.articleUrl);
        if (imageUrl) {
          item.imageUrl = imageUrl;
          item.imageCredit = '原始報導／Google News 縮圖（內部辨識用）';
          found += 1;
        }
      } catch {
        // Image enrichment is optional. The primary source record stays valid.
      } finally {
        clearTimeout(timeout);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
  report.imageEnrichment = { attempted: targets.length, found };
}

async function fetchSource(source, report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'user-agent': 'E-Mobility-Intel/2.0 (public-source monitor)' }
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

function demoItems(sources) {
  const byId = Object.fromEntries(sources.map((source) => [source.id, source]));
  return [
    { title: '示例：電池安全公告追蹤', summary: '示例資料，用來確認安全、維修與召回資訊的呈現方式。', articleUrl: 'https://example.com/demo-safety', publishedAt: isoDate, source: byId.cpsc_recalls },
    { title: '示例：電動輔助自行車驅動系統技術更新', summary: '示例資料，用來驗證技術元件分類與 PPT 素材輸出流程。', articleUrl: 'https://example.com/demo-component', publishedAt: isoDate, source: byId.electrek_ebikes },
    { title: '示例：微型移動法規變更檢視', summary: '示例資料，用來驗證法規優先度標記與來源追溯。', articleUrl: 'https://example.com/demo-regulation', publishedAt: isoDate, source: byId.eu_transport }
  ].filter((item) => item.source);
}

function scoreItem(item, taxonomy) {
  const haystack = normalize(`${item.title} ${item.summary}`);
  const relevant = taxonomy.relevanceTerms.some((term) => haystack.includes(normalize(term)));
  const urgent = taxonomy.urgencyTerms.some((term) => haystack.includes(normalize(term)));
  let category = taxonomy.categories
    .map((entry) => ({
      name: entry.name,
      matches: entry.terms.filter((term) => haystack.includes(normalize(term))).length,
      isSourceDefault: entry.name === item.source.defaultCategory
    }))
    .filter((entry) => entry.matches > 0)
    .sort((a, b) => b.matches - a.matches || Number(b.isSourceDefault) - Number(a.isSourceDefault))[0]?.name
    ?? item.source.defaultCategory;
  // Accident / fire / fatality coverage can arrive via a general news feed,
  // whose default category is not safety.  The urgency signal is decisive in
  // that case, making the card easier to spot and filter in the workspace.
  if (urgent && category !== '安全召回') category = '安全召回';
  const importance = urgent ? 'urgent' : (['法規更新', '安全召回'].includes(category) ? 'high' : item.source.priority);
  return { ...item, category, importance, relevant, titleKey: normalize(item.title) };
}

function itemKeys(item) {
  return [`url:${item.articleUrl}`, `title:${item.titleKey}`];
}

function sourceName(item) {
  return item.publisher || item.source?.name || '未知來源';
}

function itemTimestamp(item) {
  const parsed = Date.parse(item.publishedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortItems(left, right) {
  // A monitoring workspace should lead with what is current.  Importance is
  // still the second ordering rule, so same-day recalls and legal changes are
  // kept ahead of ordinary coverage without letting undated, old notices fill
  // the entire dashboard.
  const dateDifference = itemTimestamp(right) - itemTimestamp(left);
  const importanceDifference = importanceOrder.indexOf(left.importance) - importanceOrder.indexOf(right.importance);
  return dateDifference || importanceDifference || String(right.title).localeCompare(String(left.title));
}

function toCsv(rows, headers) {
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

function citation(item) {
  return `${sourceName(item)}｜${item.publishedAt || '網頁未提供日期'}｜${item.title}｜${item.articleUrl}｜擷取日 ${isoDate}`;
}

function editorialTags(item) {
  const haystack = normalize(`${item.title} ${item.summary}`);
  const tags = [];
  if (/e bike|ebike|electric bike|electric bicycle|pedelec/.test(haystack)) tags.push('電動輔助自行車');
  if (/e scooter|electric scooter|kick scooter/.test(haystack)) tags.push('電動滑板車');
  if (/battery|bms|cell|charger/.test(haystack)) tags.push('電池／充電');
  if (/motor|drive unit|drive system|controller|firmware|sensor|torque/.test(haystack)) tags.push('動力與控制');
  if (/recall|warning|fire|hazard|injury|crash|fatal/.test(haystack)) tags.push('安全風險');
  if (/regulation|legislation|law|standard|policy|ordinance|compliance|incentive|subsid/.test(haystack)) tags.push('法規／政策');
  if (/launch|new model|introduces|unveils|release|debut/.test(haystack)) tags.push('新品上市');
  if (/market|trend|investment|partnership|supply chain|funding|sales|demand|industry/.test(haystack)) tags.push('產業動態');
  return [...new Set(tags)].slice(0, 3);
}

function editorialCopy(item) {
  const tags = editorialTags(item);
  const focus = tags.length ? tags.join('、') : '電動微型移動市場動態';
  const byCategory = {
    '安全召回': { insight: `自動判讀焦點：${focus}。本則屬安全訊號，應先確認涉及的產品、地點、批次與事故／召回範圍。`, action: '先開啟原文核對型號、受影響市場與官方處置；若涉及自家產品，立即建立內部追蹤。', ppt: '可作為安全風險、使用情境或品質管理頁面的佐證。' },
    '法規更新': { insight: `自動判讀焦點：${focus}。本則可能牽動上路資格、產品規格、補助或營運規則。`, action: '核對適用國家／城市、生效日期與是否影響速度、功率、保險或認證。', ppt: '可作為法規地圖、合規風險或市場進入策略頁面的來源。' },
    '技術元件': { insight: `自動判讀焦點：${focus}。本則與零組件、電池或驅動系統技術有關。`, action: '比對規格、供應商、相容性與量產時程；回原文確認數據與測試條件。', ppt: '可作為技術路線、供應鏈或產品差異化頁面的素材。' },
    '品牌新品': { insight: `自動判讀焦點：${focus}。本則屬產品、服務或品牌動態。`, action: '核對售價、續航、重量、上市市場與同級競品，再判定是否需要深入追蹤。', ppt: '可作為新品雷達、競品比較或產品定位頁面的素材。' },
    '產業趨勢': { insight: `自動判讀焦點：${focus}。本則提供市場、投資、通路或合作的早期訊號。`, action: '辨識消息是官方公告、媒體觀察或單一市場事件；以第二來源交叉驗證。', ppt: '可作為市場趨勢、機會假設或高階主管簡報的觀察素材。' }
  };
  return { tags, ...(byCategory[item.category] ?? byCategory['產業趨勢']) };
}

function toRecord(item, index) {
  const editorial = editorialCopy(item);
  return {
    '流水號': `${isoDate}-${String(index + 1).padStart(3, '0')}`,
    '擷取日期': isoDate,
    '發布日期': item.publishedAt || '',
    '分類': item.category,
    '優先級': item.importance,
    '地區': item.source.region,
    '來源名稱': sourceName(item),
    '標題': item.title,
    '摘要': item.summary || '來源頁未提供摘要；請開啟原文確認完整內容。',
    '原文網址': item.articleUrl,
    'PPT候選': ['urgent', 'high'].includes(item.importance) ? '建議優先製作' : '可備用',
    '素材建議': '先確認原文授權；簡報請保留來源名稱與網址。',
    '引用格式': citation(item),
    '中文判讀': editorial.insight,
    '建議行動': editorial.action,
    'PPT切角': editorial.ppt,
    '圖片網址': item.imageUrl || '',
    '圖片使用提醒': item.imageUrl ? '圖片來自原始 RSS／報導縮圖；對外使用前請回原文確認授權。' : '',
    '擷取模式': isDemo ? '示例模式' : '公開來源自動擷取'
  };
}

function toHistoryItem(item, firstSeenAt = isoDate) {
  const editorial = editorialCopy(item);
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
    summary: item.summary || '來源頁未提供摘要；請開啟原文確認完整內容。',
    articleUrl: item.articleUrl,
    pptCandidate: ['urgent', 'high'].includes(item.importance),
    citation: citation(item),
    insightZh: editorial.insight,
    actionZh: editorial.action,
    pptAngleZh: editorial.ppt,
    topicTags: editorial.tags,
    imageUrl: item.imageUrl || '',
    imageCredit: item.imageUrl ? '原始 RSS／報導縮圖' : ''
  };
}

function hydrateHistoryItem(item) {
  const editorial = editorialCopy(item);
  return {
    ...item,
    insightZh: item.insightZh || editorial.insight,
    actionZh: item.actionZh || editorial.action,
    pptAngleZh: item.pptAngleZh || editorial.ppt,
    topicTags: Array.isArray(item.topicTags) && item.topicTags.length ? item.topicTags : editorial.tags,
    imageUrl: item.imageUrl || '',
    imageCredit: item.imageCredit || ''
  };
}

function mergeHistory(existing, fresh) {
  const merged = new Map();
  for (const item of existing) {
    const key = item.key || `url:${item.articleUrl}`;
    merged.set(key, { ...item, key });
  }
  for (const item of fresh) {
    const next = toHistoryItem(item);
    const prior = merged.get(next.key);
    merged.set(next.key, { ...prior, ...next, firstSeenAt: prior?.firstSeenAt || next.firstSeenAt });
  }
  return [...merged.values()]
    .sort((left, right) => sortItems(left, right) || String(right.firstSeenAt).localeCompare(String(left.firstSeenAt)))
    .slice(0, historyLimit);
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return {
      knownKeys: Array.isArray(parsed.knownKeys) ? parsed.knownKeys : [],
      history: Array.isArray(parsed.history) ? parsed.history.map(hydrateHistoryItem) : [],
      lastRun: parsed.lastRun ?? null
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { knownKeys: [], history: [], lastRun: null };
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const compact = {
    version: 2,
    lastRun: new Date().toISOString(),
    knownKeys: state.knownKeys.slice(-5000),
    history: state.history.slice(0, historyLimit)
  };
  await fs.writeFile(stateFile, JSON.stringify(compact, null, 2), 'utf8');
}

async function writeDashboard(items, report) {
  const templatePath = path.join(root, 'templates', 'intel_dashboard.html');
  const destination = path.join(root, '資訊工作台.html');
  const template = await fs.readFile(templatePath, 'utf8');
  const payload = {
    date: isoDate,
    mode: report.mode,
    modeLabel: report.mode === 'demo' ? '示例模式' : (report.mode === 'baseline' ? '建立基準' : '每日更新'),
    newCount: report.totalNew,
    historyCount: items.length,
    items,
    sources: report.sources
  };
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  await fs.writeFile(destination, template.replace('__DASHBOARD_DATA__', safeJson), 'utf8');
}

function createBrief(records, newItems) {
  const byCategory = new Map();
  for (const record of records) byCategory.set(record['分類'], [...(byCategory.get(record['分類']) ?? []), record]);
  return [
    `# 電動微型移動每日情報｜${isoDate}`,
    '',
    `本次新增 **${records.length}** 項，優先項目 **${records.filter((record) => ['urgent', 'high'].includes(record['優先級'])).length}** 項。`,
    records.length ? '' : '本次未偵測到未看過的新項目；工作台仍會顯示近期累積情報。',
    '',
    ...[...byCategory.entries()].flatMap(([category, rows]) => [
      `## ${category}`,
      '',
      ...rows.map((row) => `- **[${row['標題']}](${row['原文網址']})**｜${row['地區']}｜${row['優先級']}  \n  **中文判讀：**${row['中文判讀']}  \n  **建議行動：**${row['建議行動']}  \n  原文摘要：${row['摘要']}  \n  來源：${row['來源名稱']}`),
      ''
    ]),
    '## 使用提醒',
    '',
    '- 法規、安全與召回資訊請以原始官方頁面為準。',
    '- 放入簡報前請再次確認原文內容與圖片授權。',
    `- 本次新項目的未處理數：${newItems.length}。`
  ].join('\n');
}

function createPptMaterial(records) {
  return [
    `# PowerPoint 素材候選｜${isoDate}`,
    '',
    '請優先使用 urgent／high 項目；每張投影片保留來源與擷取日期。',
    '',
    ...records.flatMap((row, index) => [
      `## ${index + 1}. ${row['標題']}`,
      '',
      `- 分類／優先級：${row['分類']}／${row['優先級']}`,
      `- 中文判讀：${row['中文判讀']}`,
      `- 建議行動：${row['建議行動']}`,
      `- PPT 切角：${row['PPT切角']}`,
      `- 原文摘要：${row['摘要']}`,
      `- 素材建議：${row['素材建議']}`,
      row['圖片網址'] ? `- 圖片（內部辨識用）：[原始 RSS／報導縮圖](${row['圖片網址']})` : '- 圖片：本則未擷取到可用縮圖。',
      `- 原文：[${row['來源名稱']}](${row['原文網址']})`,
      `- 引用：${row['引用格式']}`,
      ''
    ])
  ].join('\n');
}

async function main() {
  const [sources, taxonomy] = await Promise.all([
    fs.readFile(cfg('sources.json'), 'utf8').then(JSON.parse),
    fs.readFile(cfg('taxonomy.json'), 'utf8').then(JSON.parse)
  ]);
  const enabled = sources.filter((source) => source.enabled);
  const report = {
    runDate: isoDate,
    mode: isDemo ? 'demo' : (isBaseline ? 'baseline' : 'live'),
    fetchedAt: new Date().toISOString(),
    sources: [],
    totalCandidates: 0,
    totalRelevant: 0,
    totalNew: 0,
    totalExported: 0,
    totalHistory: 0
  };
  if (isDemo) report.sources = enabled.map((source) => ({ id: source.id, name: source.name, status: 'skipped_demo' }));

  const candidates = isDemo
    ? demoItems(enabled)
    : (await Promise.all(enabled.map((source) => fetchSource(source, report)))).flat();
  report.totalCandidates = candidates.length;

  const deduped = [];
  const seenTitles = new Set();
  for (const item of candidates.map((candidate) => scoreItem(candidate, taxonomy))) {
    if ((!item.relevant && !isDemo) || seenTitles.has(item.titleKey)) continue;
    seenTitles.add(item.titleKey);
    deduped.push(item);
  }
  const ordered = deduped.sort(sortItems).slice(0, maxItems);
  report.totalRelevant = deduped.length;
  if (!isDemo) await enrichImages(ordered, report);

  const state = isDemo ? { knownKeys: [], history: [], lastRun: null } : await loadState();
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
  const dashboardItems = isDemo ? ordered.map((item) => toHistoryItem(item)) : state.history;
  report.totalHistory = dashboardItems.length;

  const dayDir = path.join(outputRoot, isoDate);
  await fs.mkdir(dayDir, { recursive: true });
  const emptyRecord = toRecord({ title: '', summary: '', articleUrl: '', publishedAt: '', category: '', importance: 'normal', source: { region: '', name: '', priority: 'normal' } }, 0);
  const headers = Object.keys(records[0] ?? emptyRecord);
  await Promise.all([
    fs.writeFile(path.join(dayDir, 'information_log.csv'), toCsv(records, headers), 'utf8'),
    fs.writeFile(path.join(dayDir, 'daily_brief.md'), createBrief(records, newItems), 'utf8'),
    fs.writeFile(path.join(dayDir, 'ppt_material.md'), createPptMaterial(records), 'utf8'),
    fs.writeFile(path.join(dayDir, 'ppt_material.json'), JSON.stringify(records, null, 2), 'utf8'),
    fs.writeFile(path.join(dayDir, 'run_report.json'), JSON.stringify(report, null, 2), 'utf8')
  ]);
  await writeDashboard(dashboardItems, report);

  console.log(`完成：${dayDir}`);
  if (isDemo) console.log(`匯出 ${records.length} 則示例資料；未連線抓取來源。`);
  else if (isBaseline) console.log(`已建立基準：記錄 ${ordered.length} 個項目；工作台累積 ${dashboardItems.length} 項；來源成功 ${report.sources.filter((source) => source.status === 'ok').length}/${enabled.length}。`);
  else console.log(`匯出 ${records.length} 則新項目；工作台累積 ${dashboardItems.length} 項；來源成功 ${report.sources.filter((source) => source.status === 'ok').length}/${enabled.length}。`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
