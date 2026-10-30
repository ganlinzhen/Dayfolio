// 固定来源仅提供待核实候选；抓取和解析不写数据库，也不把来源内容当作指令。
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { assertPublicHost, publicHttpsFetch } from './provider-https';

export type NewsRssModule = 'domestic' | 'international' | 'ai' | 'events';
export interface NewsRssSource { id: string; name: string; url: string; modules: NewsRssModule[] }
export interface NewsRssCandidate {
  source_id: string; source_name: string; source_url: string; title: string;
  published_at: string; summary: string; modules: NewsRssModule[]; verification: 'pending';
}
export interface NewsRssResult {
  candidates: NewsRssCandidate[];
  sources: Array<{ id: string; status: 'ok' | 'failed'; candidates: number; reason?: string }>;
}
export const DEFAULT_NEWS_RSS_SOURCES: NewsRssSource[] = [
  { id: 'chinanews-china', name: '中国新闻网国内', url: 'https://www.chinanews.com.cn/rss/china.xml', modules: ['domestic'] },
  { id: 'chinanews-world', name: '中国新闻网国际', url: 'https://www.chinanews.com.cn/rss/world.xml', modules: ['international', 'events'] },
  { id: 'un-news', name: '联合国新闻', url: 'https://news.un.org/feed/subscribe/zh/news/all/rss.xml', modules: ['international', 'events'] },
  { id: 'npr-world', name: 'NPR 世界新闻', url: 'https://feeds.npr.org/1004/rss.xml', modules: ['international', 'events'] },
  { id: 'openai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml', modules: ['ai'] },
  { id: 'google-ai', name: 'Google AI', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', modules: ['ai'] },
  { id: 'deepmind', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', modules: ['ai'] },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', modules: ['ai'] },
  { id: 'codex-releases', name: 'Codex 发布', url: 'https://github.com/openai/codex/releases.atom', modules: ['ai'] },
  { id: 'claude-code-releases', name: 'Claude Code 发布', url: 'https://github.com/anthropics/claude-code/releases.atom', modules: ['ai'] },
];

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PER_SOURCE = 25;
const MAX_TOTAL = 120;
const CONCURRENCY = 4;
const TIMEOUT_MS = 8000;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
  parseTagValue: false, parseAttributeValue: false, processEntities: true, trimValues: true });
const array = (v: unknown): unknown[] => v == null ? [] : Array.isArray(v) ? v : [v];
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function value(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  const o = object(v); return typeof o['#text'] === 'string' ? o['#text'] : '';
}
function clean(v: unknown, limit: number): string {
  const decoded = value(v).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  });
  return decoded.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}
function safeUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    assertPublicHost(url.hostname);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return null; }
}
function publication(raw: string, start: number, end: number): string | null {
  // 日期必须包含时间和明确时区；日期、更新时间均不能冒充精确发布时间。
  const text = raw.trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  const rfc = text.match(/^(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC|[+-]\d{4})$/i);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const year = Number(iso?.[1] ?? rfc?.[3]), month = iso ? Number(iso[2]) : months.indexOf(rfc?.[2].toLowerCase() ?? '') + 1, day = Number(iso?.[3] ?? rfc?.[1]);
  if ((!iso && !rfc) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const date = Date.parse(text); return Number.isFinite(date) && date >= start && date <= end ? new Date(date).toISOString() : null;
}
function parseFeed(xml: string, source: NewsRssSource, start: number, end: number): NewsRssCandidate[] {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('不接受 DTD 或实体声明');
  if (XMLValidator.validate(xml) !== true) throw new Error('XML 格式无效');
  const root = object(parser.parse(xml));
  const channel = object(object(root.rss).channel);
  const atom = object(root.feed);
  const entries = channel.item != null ? array(channel.item) : array(atom.entry);
  if (!Object.keys(channel).length && !Object.keys(atom).length) throw new Error('不是 RSS 或 Atom 来源');
  const candidates: NewsRssCandidate[] = [];
  const seenIds = new Set<string>();
  for (const raw of entries) {
    const item = object(raw), title = clean(item.title, 240);
    const date = publication(value(item.pubDate || item['dc:date'] || item.published), start, end);
    const links = array(item.link);
    const link = links.find(v => { const o = object(v); return o['@_href'] && (!o['@_rel'] || o['@_rel'] === 'alternate'); });
    const url = safeUrl(link ? value(object(link)['@_href']) : value(item.link), source.url);
    if (!title || !date || !url) continue;
    const identity = value(item.guid || item.id).trim();
    if (identity && seenIds.has(identity)) continue;
    if (identity) seenIds.add(identity);
    candidates.push({ source_id: source.id, source_name: source.name, source_url: url, title, published_at: date,
      summary: clean(item.description || item.summary || item['content:encoded'] || item.content, 600), modules: [...source.modules], verification: 'pending' });
  }
  return candidates.sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, MAX_PER_SOURCE);
}
function checkSourceUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('来源地址必须为无凭据的公网 HTTPS');
  assertPublicHost(url.hostname); return url;
}
async function readFeed(source: NewsRssSource, fetcher: typeof fetch, timeoutMs: number, outerSignal?: AbortSignal): Promise<string> {
  const approved = checkSourceUrl(source.url), timeout = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  let current = approved;
  for (let redirects = 0; redirects <= 3; redirects++) {
    checkSourceUrl(current.toString());
    if (current.origin !== approved.origin) throw new Error('来源重定向超出授权域名');
    const response = await fetcher(current.toString(), { method: 'GET', redirect: 'manual', credentials: 'omit', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('来源重定向无效');
      current = new URL(location, current); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`来源 HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await response.body?.cancel(); throw new Error('来源超过大小限制'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('来源响应为空');
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_BYTES) { await reader.cancel(); throw new Error('来源超过大小限制'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('来源不是有效 UTF-8'); }
  }
  throw new Error('来源重定向失败');
}

/** 本接口只返回候选，不证明条目事实、发布时间或来源许可已核实。 */
export async function collectNewsRssCandidates(options: { windowStart: string; windowEnd: string; sources?: NewsRssSource[]; fetcher?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<NewsRssResult> {
  const start = Date.parse(options.windowStart), end = Date.parse(options.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('新闻采集时间窗无效');
  const sources = options.sources ?? DEFAULT_NEWS_RSS_SOURCES;
  if (sources.length > 50 || new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('新闻来源数量过多或身份重复');
  const result: Array<{ id: string; status: 'ok' | 'failed'; candidates: NewsRssCandidate[]; reason?: string }> = new Array(sources.length);
  let index = 0;
  async function worker() {
    while (index < sources.length) {
      const i = index++, source = sources[i];
      try {
        const xml = await readFeed(source, options.fetcher ?? publicHttpsFetch, Math.max(1, Math.min(options.timeoutMs ?? TIMEOUT_MS, 30_000)), options.signal);
        result[i] = { id: source.id, status: 'ok', candidates: parseFeed(xml, source, start, end) };
      } catch (error) {
        // 网络和正文可能包含私有信息，不向执行器输出任意异常文本。
        const message = error instanceof Error ? error.message : '';
        const reason = options.signal?.aborted ? '采集已取消' : /abort|timeout/i.test(message) ? '来源请求超时' : /^来源 HTTP \d{3}$/.test(message) ? message : '来源不可用或格式无效';
        result[i] = { id: source.id, status: 'failed', candidates: [], reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, () => worker()));
  const seen = new Map<string, NewsRssCandidate>();
  for (const candidate of result.flatMap(item => item.candidates)) {
    const previous = seen.get(candidate.source_url);
    if (previous) { previous.modules = [...new Set([...previous.modules, ...candidate.modules])]; continue; }
    seen.set(candidate.source_url, candidate);
  }
  return { candidates: [...seen.values()].sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, MAX_TOTAL),
    sources: result.map(item => ({ id: item.id, status: item.status, candidates: item.candidates.length, ...(item.reason ? { reason: item.reason } : {}) })) };
}
