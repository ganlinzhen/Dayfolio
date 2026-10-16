// 公共来源使用独立 HTTPS 连接；DNS 结果逐次审查后固定到本次连接，避免二次解析绕过。
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { runtimeError } from '../utils/schedule';

export function isPublicAddress(input: string): boolean {
  const family = isIP(input);
  if (family === 4) {
    const [a, b, c] = input.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && c <= 2 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    // 只允许当前全球单播区间，排除特殊用途、文档和封装地址；映射 IPv4 也不走旁路。
    const [first, second = '0'] = input.toLowerCase().split(':');
    const a = parseInt(first, 16), b = parseInt(second || '0', 16);
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 &&
      !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && !(a === 0x3fff && b <= 0x0fff);
  }
  return false;
}
export function assertPublicHost(hostname: string): void {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(host)) { if (!isPublicAddress(host)) runtimeError('PERMISSION_DENIED', '公共来源不能连接本地、内网或保留地址'); return; }
  if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host))
    runtimeError('PERMISSION_DENIED', '公共来源必须使用可解析的公网域名');
}
export function publicLookup(resolve: (hostname: string) => Promise<LookupAddress[]> = hostname => lookup(hostname, { all: true, verbatim: true })): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(records => {
      if (!records.length || records.some(record => !isPublicAddress(record.address)))
        return runtimeError('PERMISSION_DENIED', '来源 DNS 包含本地、内网或保留地址');
      const chosen = records.find(record => record.family === 4) ?? records[0];
      // 不把域名再次交给系统解析；同时出现私有地址时整次拒绝，而不是挑一个公共地址放行。
      if (options.all) callback(null, [chosen]); else callback(null, chosen.address, chosen.family);
    }).catch(error => callback(error instanceof Error ? error : new Error('来源 DNS 解析失败'), '', 0));
  };
}

export const publicHttpsFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input)); assertPublicHost(url.hostname);
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, lookup: publicLookup(), signal: init?.signal ?? undefined,
      headers: { Accept: 'application/json', 'User-Agent': 'Dayfolio-runtime/1', 'Accept-Encoding': 'gzip, deflate, br' },
    }, incoming => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const encoding = (headers.get('content-encoding') ?? 'identity').toLowerCase();
      let stream: Readable = incoming;
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      if (decoder) {
        incoming.on('error', error => decoder.destroy(error));
        decoder.on('close', () => incoming.destroy());
        stream = incoming.pipe(decoder);
      } else if (encoding !== 'identity') { incoming.destroy(); reject(new Error('来源使用不支持的内容编码')); return; }
      const status = incoming.statusCode ?? 500;
      if ([204, 205, 304].includes(status)) { incoming.resume(); resolve(new Response(null, { status, headers })); return; }
      const iterator = stream[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(new Uint8Array(next.value)); }
          catch (error) { controller.error(error); }
        },
        async cancel() { stream.destroy(); await iterator.return?.(); },
      });
      resolve(new Response(body, { status, headers }));
    });
    req.on('error', reject); req.end();
  });
};
