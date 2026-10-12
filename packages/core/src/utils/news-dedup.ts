// 新闻去重键规则（迁移回填与入库共用，保持一致）：
// 优先内容平台 ID（同帖不同标题/改标题仍算同一条），其次规范 URL（去跟踪参数），
// 兜底 标题哈希（无 URL 时）。不同帖不会因同名被合并——标题不作为键的主体。
import { createHash } from 'node:crypto';

/** 规范 URL：小写 host、去结尾斜杠、去 fragment 与跟踪参数（utm_* 等）；**保留语义 query**
 *  （如 ?p=123、?id=456）——不同文章常靠 query 区分，全量去 query 会误并。 */
const TRACKING_PARAM_RE = /^(utm_[a-z_]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref|ref_src|spm|scene|is_send|si)$/i;
function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM_RE.test(k));
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    return `${host}${path}${query}`;
  } catch {
    return raw.trim();
  }
}

export function newsDedupKey(source: string, url: string, title: string): string {
  const u = (url ?? '').trim();
  if (source === 'x') {
    const m = u.match(/\/status\/(\d+)/);
    if (m) return `x:status:${m[1]}`;
  }
  if (source === 'hacker_news') {
    const m = u.match(/item\?id=(\d+)/);
    if (m) return `hn:item:${m[1]}`;
  }
  if (u) {
    const c = canonicalUrl(u);
    if (source === 'zhihu_daily') return `zhihu:${c}`;
    return `url:${c}`;
  }
  return `title:${createHash('sha1').update(`${source}|${title.trim()}`).digest('hex').slice(0, 16)}`;
}
