import { describe, expect, it } from 'vitest';
import { compactEditionSummary } from '../src/renderer/src/components/news-edition-summary';

describe('每日模块摘要显示', () => {
  it('移除与标签重复的日期、模块名和引导词', () => {
    expect(compactEditionSummary('今日 时事关注重点：产业发展取得新进展。', '时事关注')).toBe('产业发展取得新进展。');
    expect(compactEditionSummary('本期国内重点：政策已经发布。', '国内')).toBe('政策已经发布。');
    expect(compactEditionSummary('10月27日 国内综合总结：第一条事实。第二条事实。', '国内')).toBe('第一条事实。第二条事实。');
    expect(compactEditionSummary('2026-10-27 国内要闻: 消息已发布。', '国内')).toBe('消息已发布。');
    expect(compactEditionSummary('10.27国内：消息已发布。', '国内')).toBe('消息已发布。');
  });

  it('兼容空格、换行和模块名中的正则符号', () => {
    expect(compactEditionSummary('  同日补充\n AI (研究)+ 摘要：\n 新模型已发布。\n后续进展。', 'AI (研究)+')).toBe('新模型已发布。\n后续进展。');
    expect(compactEditionSummary('AIx研究x+摘要：消息。', 'AI (研究)+')).toBe('AIx研究x+摘要：消息。');
  });

  it('保留事实正文、缺少明确冒号的内容和移除后为空的内容', () => {
    for (const text of ['国内市场增长，出口保持稳定。', '10月27日公开的国内进展涉及政策。', '本期国内重点新闻已经发布。', '国际重点：消息。', '国内：  ', '']) {
      expect(compactEditionSummary(text, '国内')).toBe(text);
    }
    expect(compactEditionSummary('国内：消息。', '')).toBe('国内：消息。');
  });
});
