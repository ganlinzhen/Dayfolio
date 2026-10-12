// 帮助文档同步：apps/help/docs/*.md → 桌面端渲染层生成文件
// 修改文档后运行：npm run help:sync（根目录）或 cd apps/help && npm run sync
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname; // apps/help/
const docsDir = join(root, 'docs');
const outFile = join(root, '../desktop/src/renderer/src/generated/helpContent.ts');

/** 解析 frontmatter（title 必填、description 可选），返回元信息与正文 */
function parseFrontmatter(raw, file) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error(`${file} 缺少 frontmatter（至少要有 title）`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.title) throw new Error(`${file} frontmatter 缺少 title`);
  return { title: meta.title, description: meta.description ?? '', body: raw.slice(m[0].length) };
}

const files = (await readdir(docsDir)).filter((f) => f.endsWith('.md')).sort();
if (files.length === 0) throw new Error('apps/help/docs/ 下没有 markdown 文档');

const docs = [];
for (const file of files) {
  const raw = await readFile(join(docsDir, file), 'utf8');
  const { title, description, body } = parseFrontmatter(raw, file);
  docs.push({ id: file.replace(/\.md$/, ''), title, description, markdown: body.trim() });
}

const content =
  '// ⚠️ 本文件由 apps/help/scripts/sync.mjs 自动生成，禁止手改。\n' +
  '// 修改帮助内容：编辑 apps/help/docs/*.md，然后运行 npm run help:sync\n\n' +
  'export interface HelpDoc {\n' +
  '  id: string;\n' +
  '  title: string;\n' +
  '  description: string;\n' +
  '  markdown: string;\n' +
  '}\n\n' +
  `export const HELP_DOCS: HelpDoc[] = ${JSON.stringify(docs, null, 2)};\n\n` +
  `export const HELP_SYNCED_AT = ${JSON.stringify(new Date().toISOString())};\n`;

// 内容无变化就不重写（时间戳不参与比较），避免 git 噪音
let existing = '';
try {
  existing = await readFile(outFile, 'utf8');
} catch {
  /* 首次生成 */
}
const stripTs = (s) => s.replace(/export const HELP_SYNCED_AT = .*/s, '');
if (stripTs(existing) === stripTs(content)) {
  console.log(`[help:sync] ${docs.length} 篇文档无变化，跳过写入`);
} else {
  await mkdir(join(root, '../desktop/src/renderer/src/generated'), { recursive: true });
  await writeFile(outFile, content, 'utf8');
  console.log(`[help:sync] 已同步 ${docs.length} 篇文档 → desktop/src/renderer/src/generated/helpContent.ts`);
}
