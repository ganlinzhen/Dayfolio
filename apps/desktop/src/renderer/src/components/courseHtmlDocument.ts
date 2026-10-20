// 课程总览和讲义共用离线文档：课程负责内容样式，阅读器统一最外层宽度。
// 与导入消毒构成双保险：仅允许内联样式，不加载外部资源或运行脚本。
const LESSON_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;

export const courseHtmlDocument = (html: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${LESSON_CSP}
<style>
body{font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.8;color:#1a1a19}
h1,h2,h3{line-height:1.4}
pre{background:#f5f4f0;padding:12px;border-radius:8px;overflow-x:auto}
table{border-collapse:collapse}
td,th{border:1px solid #e8e7e3;padding:6px 10px}
</style></head><body>${html}
<style data-dayfolio-course-layout>
/* 放在课程样式之后，兼容已导入课程中的 body 重置和固定宽度正文。 */
html{box-sizing:border-box}
body{box-sizing:border-box!important;width:100%!important;min-width:0!important;max-width:none!important;margin:0!important;padding:clamp(16px,2.5vw,32px)!important;overflow-wrap:anywhere}
body > :is(main,article,section,div){box-sizing:border-box!important;width:100%!important;min-width:0!important;max-width:none!important;margin-left:auto!important;margin-right:auto!important}
img,svg,video{max-width:100%;height:auto}
</style></body></html>`;
