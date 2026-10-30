import { describe, expect, it } from 'vitest';
import { collectNewsRssCandidates, type NewsRssSource } from '../src/services/news-rss';

const source: NewsRssSource = { id: 'test', name: '测试源', url: 'https://example.org/feed', modules: ['domestic'] };
const window = { windowStart: '2026-10-28T00:00:00Z', windowEnd: '2026-10-29T00:00:00Z' };
const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title><![CDATA[新闻 &amp; 测试]]></title><guid>same</guid><link>https://example.org/a?utm_source=x</link><pubDate>Wed, 28 Oct 2026 08:10:00 GMT</pubDate><description><![CDATA[<p>正文 <b>重点</b></p><script>不可信</script>]]></description></item>
<item><title>重复</title><link>https://example.org/a</link><pubDate>Wed, 28 Oct 2026 08:10:00 GMT</pubDate></item>
<item><title>同 GUID</title><guid>same</guid><link>https://example.org/changed</link><pubDate>Wed, 28 Oct 2026 08:10:00 GMT</pubDate></item>
<item><title>仅日期</title><link>https://example.org/b</link><pubDate>2026-10-28</pubDate></item>
<item><title>内网地址</title><link>http://127.0.0.1/a</link><pubDate>Wed, 28 Oct 2026 08:10:00 GMT</pubDate></item>
</channel></rss>`;
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>发布</title><link rel="alternate" href="https://example.org/release"/><published>2026-10-28T16:10:00+08:00</published><summary>概要</summary></entry><entry><title>仅更新</title><link href="https://example.org/update"/><updated>2026-10-28T08:10:00Z</updated></entry></feed>`;

describe('RSS 新闻候选', () => {
  it('解析 RSS、净化摘要、过滤不确定时间与内网链接、稳定去重', async () => {
    const result = await collectNewsRssCandidates({ ...window, sources: [source], fetcher: async () => new Response(rss) });
    expect(result.sources[0]).toMatchObject({ status: 'ok', candidates: 2 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ title: '新闻 & 测试', source_url: 'https://example.org/a', summary: '正文 重点', verification: 'pending', published_at: '2026-10-28T08:10:00.000Z' });
  });
  it('支持 Atom 并拒绝把更新时间当发布时间', async () => {
    const result = await collectNewsRssCandidates({ ...window, sources: [source], fetcher: async () => new Response(atom) });
    expect(result.candidates).toMatchObject([{ title: '发布', source_url: 'https://example.org/release', summary: '概要' }]);
  });
  it('故障单源不影响其他来源，拒绝 DTD 和无效 XML', async () => {
    const sources = [source, { ...source, id: 'bad', url: 'https://bad.example/feed' }, { ...source, id: 'malformed', url: 'https://bad.example/invalid' }];
    const result = await collectNewsRssCandidates({ ...window, sources, fetcher: async url => new Response(String(url).endsWith('/invalid') ? '<rss>' : String(url).includes('bad.example') ? '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss>&x;</rss>' : rss) });
    expect(result.sources.map(x => x.status)).toEqual(['ok', 'failed', 'failed']);
    expect(result.candidates).toHaveLength(1);
  });
  it('限制每源大小，拒绝跨域重定向、本地地址与 URL 凭据', async () => {
    const huge = await collectNewsRssCandidates({ ...window, sources: [source], fetcher: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
    expect(huge.sources[0].status).toBe('failed');
    let calls = 0;
    const redirect = await collectNewsRssCandidates({ ...window, sources: [source], fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/feed' } }); } });
    expect(redirect.sources[0].status).toBe('failed'); expect(calls).toBe(1);
    for (const url of ['https://127.0.0.1/feed', 'https://user:secret@example.org/feed', 'http://example.org/feed']) {
      const result = await collectNewsRssCandidates({ ...window, sources: [{ ...source, url }], fetcher: async () => { throw new Error('不应调用'); } });
      expect(result.sources[0].status).toBe('failed');
    }
  });
  it('请求超时后标记失败，不阻塞成功来源', async () => {
    const sources = [source, { ...source, id: 'slow', url: 'https://slow.example/feed' }];
    const fetcher: typeof fetch = async (url, init) => String(url).includes('slow.example') ? new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) : new Response(rss);
    const result = await collectNewsRssCandidates({ ...window, sources, fetcher, timeoutMs: 20 });
    expect(result.sources.map(x => x.status)).toEqual(['ok', 'failed']); expect(result.sources[1].reason).toBe('来源请求超时');
  });
});
