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

const stripHtml = (value = '') => decodeEntities(value)
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function normalize(value) {
  return stripHtml(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function absoluteUrl(candidate, base) {
  try { return new URL(candidate, base).href; } catch { return base; }
}

function parseRss(xml, source) {
  const chunks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return chunks.slice(0, 80).map((chunk) => {
    const read = (tag) => (chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? '');
    const link = chunk.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? read('link');
    return {
      title: stripHtml(read('title')),
      summary: stripHtml(read('description') || read('summary') || read('content')).slice(0, 600),
      articleUrl: absoluteUrl(stripHtml(link), source.url),
      publishedAt: stripHtml(read('pubDate') || read('published') || read('updated')) || '',
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
    results.push({ title, summary: '', articleUrl, publishedAt: '', source });
    if (results.length >= 35) break;
  }
  return results;
}

async function fetchSource(source, report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'user-agent': 'E-Mobility-Intel-MVP/1.0 (public-source monitor)' }
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
    { title: '示例：電池安全公告追蹤', summary: '示例資料，請以官方原文確認安全、維修與召回資訊。', articleUrl: 'https://example.com/demo-safety', publishedAt: isoDate, source: byId.cpsc_recalls },
    { title: '示例：電動輔助自行車驅動系統技術更新', summary: '示例資料，用來驗證技術元件分類與 PPT 素材輸出流程。', articleUrl: 'https://example.com/demo-component', publishedAt: isoDate, source: byId.bosch_ebike },
    { title: '示例：微型移動法規變更檢視', summary: '示例資料，用來驗證法規高優先度標記。此內容不是法律意見。', articleUrl: 'https://example.com/demo-regulation', publishedAt: isoDate, source: byId.eu_transport }
  ].filter((item) => item.source);
}

function scoreItem(item, taxonomy) {
  const haystack = normalize(`${item.title} ${item.summary}`);
  const relevant = taxonomy.relevanceTerms.some((term) => haystack.includes(normalize(term)));
  const category = taxonomy.categories
    .map((entry) => ({
      name: entry.name,
      matches: entry.terms.filter((term) => haystack.includes(normalize(term))).length,
      isSourceDefault: entry.name === item.source.defaultCategory
    }))
    .filter((entry) => entry.matches > 0)
    .sort((a, b) => b.matches - a.matches || Number(b.isSourceDefault) - Number(a.isSourceDefault))[0]?.name
    ?? item.source.defaultCategory;
  const urgent = taxonomy.urgencyTerms.some((term) => haystack.includes(normalize(term)));
  const importance = urgent ? 'urgent' : (category === '法規更新' || category === '安全召回' ? 'high' : item.source.priority);
  return { ...item, category, importance, relevant, titleKey: normalize(item.title) };
}

function toCsv(rows, headers) {
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

function citation(item) {
  return `${item.source.name}（${item.publishedAt || '發布日期待確認'}），〈${item.title}〉，${item.articleUrl}（擷取：${isoDate}）。`;
}

function toRecord(item, index) {
  return {
    '編號': `${isoDate}-${String(index + 1).padStart(3, '0')}`,
    '擷取日期': isoDate,
    '發布日期': item.publishedAt,
    '類別': item.category,
    '重要性': item.importance,
    '區域': item.source.region,
    '來源名稱': item.source.name,
    '標題': item.title,
    '原文摘要': item.summary || '請開啟原文確認內容；此筆來自公告／新聞頁標題擷取。',
    '原文網址': item.articleUrl,
    'PPT狀態': item.importance === 'urgent' || item.importance === 'high' ? '優先製作' : '待挑選',
    '素材授權': '待確認原始來源授權',
    '引用格式': citation(item),
    '審核狀態': isDemo ? '示例資料' : '待人工確認'
  };
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return { knownKeys: Array.isArray(parsed.knownKeys) ? parsed.knownKeys : [], lastRun: parsed.lastRun ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') return { knownKeys: [], lastRun: null };
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const compact = { version: 1, lastRun: new Date().toISOString(), knownKeys: state.knownKeys.slice(-5000) };
  await fs.writeFile(stateFile, JSON.stringify(compact, null, 2), 'utf8');
}

async function writeDashboard(records, report) {
  const templatePath = path.join(root, 'templates', 'intel_dashboard.html');
  const destination = path.join(root, '資訊工作台.html');
  const template = await fs.readFile(templatePath, 'utf8');
  const payload = {
    date: isoDate,
    mode: report.mode,
    modeLabel: report.mode === 'demo' ? '示例模式' : (report.mode === 'baseline' ? '建立基準' : '每日更新'),
    items: records,
    sources: report.sources
  };
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  await fs.writeFile(destination, template.replace('__DASHBOARD_DATA__', safeJson), 'utf8');
}

async function main() {
  const [sources, taxonomy] = await Promise.all([
    fs.readFile(cfg('sources.json'), 'utf8').then(JSON.parse),
    fs.readFile(cfg('taxonomy.json'), 'utf8').then(JSON.parse)
  ]);
  const enabled = sources.filter((source) => source.enabled);
  const report = { runDate: isoDate, mode: isDemo ? 'demo' : (isBaseline ? 'baseline' : 'live'), fetchedAt: new Date().toISOString(), sources: [], totalCandidates: 0, totalRelevant: 0, totalNew: 0, totalExported: 0 };
  if (isDemo) {
    report.sources = enabled.map((source) => ({ id: source.id, name: source.name, status: 'skipped_demo' }));
  }
  const candidates = isDemo ? demoItems(enabled) : (await Promise.all(enabled.map((source) => fetchSource(source, report)))).flat();
  report.totalCandidates = candidates.length;
  const deduped = [];
  const seen = new Set();
  for (const item of candidates.map((candidate) => scoreItem(candidate, taxonomy))) {
    if ((!item.relevant && !isDemo) || seen.has(item.titleKey)) continue;
    seen.add(item.titleKey);
    deduped.push(item);
  }
  const ordered = deduped
    .sort((a, b) => ['urgent', 'high', 'normal', 'low'].indexOf(a.importance) - ['urgent', 'high', 'normal', 'low'].indexOf(b.importance))
    .slice(0, maxItems);
  report.totalRelevant = deduped.length;
  const state = isDemo ? { knownKeys: [], lastRun: null } : await loadState();
  const known = new Set(state.knownKeys);
  const itemKeys = (item) => [`url:${item.articleUrl}`, `title:${item.titleKey}`];
  const newItems = isDemo ? ordered : ordered.filter((item) => itemKeys(item).every((key) => !known.has(key)));
  if (!isDemo) {
    state.knownKeys = [...state.knownKeys, ...ordered.flatMap(itemKeys)];
    await saveState(state);
  }
  report.totalNew = newItems.length;
  const exportItems = isBaseline ? [] : newItems;
  report.totalExported = exportItems.length;
  const records = exportItems.map(toRecord);
  const dayDir = path.join(outputRoot, isoDate);
  await fs.mkdir(dayDir, { recursive: true });
  const headers = Object.keys(records[0] ?? toRecord({ title: '', summary: '', articleUrl: '', publishedAt: '', category: '', importance: 'normal', source: { region: '', name: '', priority: 'normal' } }, 0));
  await fs.writeFile(path.join(dayDir, 'information_log.csv'), toCsv(records, headers), 'utf8');
  const byCategory = new Map();
  for (const record of records) byCategory.set(record['類別'], [...(byCategory.get(record['類別']) ?? []), record]);
  const brief = [
    `# 電動微移動每日情報｜${isoDate}`,
    '',
    `模式：${isDemo ? '示例資料（不可對外引用）' : (isBaseline ? '建立基準（不輸出歷史項目）' : '公開來源自動擷取（請人工確認）')}`,
    isBaseline ? `已記錄 ${ordered.length} 個既有項目；下一次執行起只輸出新出現的標題／網址。` : `共匯出 ${records.length} 則；優先處理：${records.filter((r) => ['urgent', 'high'].includes(r['重要性'])).length} 則。`,
    '',
    ...[...byCategory.entries()].flatMap(([category, rows]) => [
      `## ${category}`,
      '',
      ...rows.map((row) => `- **[${row['標題']}](${row['原文網址']})**（${row['區域']}｜${row['重要性']}）  \n  ${row['原文摘要']}  \n  來源：${row['來源名稱']}`),
      ''
    ]),
    '## 使用提醒',
    '',
    '- 法規、安全與召回內容請回到官方原文確認。',
    '- 外部素材使用前請確認授權；保留引用格式。'
  ].join('\n');
  const ppt = [
    `# PowerPoint 素材包｜${isoDate}`,
    '',
    '每一則可作為一頁簡報的基礎。請把「引用格式」放入投影片備註或頁腳。',
    '',
    ...records.flatMap((row, index) => [
      `## ${index + 1}. ${row['標題']}`,
      '',
      `- 類別／重要性：${row['類別']}／${row['重要性']}`,
      `- 一句重點：${row['原文摘要']}`,
      `- 建議畫面：官方產品圖、官方公告截圖或自行繪製的比較圖；${row['素材授權']}。`,
      `- 原文：[${row['來源名稱']}](${row['原文網址']})`,
      `- 引用格式：${row['引用格式']}`,
      ''
    ])
  ].join('\n');
  await Promise.all([
    fs.writeFile(path.join(dayDir, 'daily_brief.md'), brief, 'utf8'),
    fs.writeFile(path.join(dayDir, 'ppt_material.md'), ppt, 'utf8'),
    fs.writeFile(path.join(dayDir, 'ppt_material.json'), JSON.stringify(records, null, 2), 'utf8'),
    fs.writeFile(path.join(dayDir, 'run_report.json'), JSON.stringify(report, null, 2), 'utf8')
  ]);
  await writeDashboard(records, report);
  console.log(`完成：${dayDir}`);
  console.log(isDemo
    ? `匯出 ${records.length} 則示例資料；未連線抓取來源。`
    : (isBaseline
      ? `已建立基準：記錄 ${ordered.length} 個項目；來源成功 ${report.sources.filter((source) => source.status === 'ok').length}/${enabled.length}。`
      : `匯出 ${records.length} 則新項目；來源成功 ${report.sources.filter((source) => source.status === 'ok').length}/${enabled.length}。`));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
