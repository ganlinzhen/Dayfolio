export function compactEditionSummary(summary: string, moduleName: string): string {
  const name = moduleName.trim();
  if (!summary || !name) return summary;

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dateOrPeriod = '(?:今日|本日|本期|昨日|同日补充|(?:\\d{4}年)?\\d{1,2}月\\d{1,2}日|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[./]\\d{1,2})';
  const prefix = new RegExp(`^\\s*(?:${dateOrPeriod}\\s*)?${escapedName}\\s*(?:综合总结|重点|要闻|摘要|总结)?\\s*[:：]\\s*`);
  const match = prefix.exec(summary);
  if (!match) return summary;

  const body = summary.slice(match[0].length);
  return body.trim() ? body : summary;
}
