// 帮助面板：左侧模块目录 + 右侧使用说明
// 内容不是硬编码：来自 apps/help 子项目（构建前由 npm run help:sync 生成 helpContent.ts）
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, call } from '../api';
import { HELP_DOCS, HELP_SYNCED_AT } from '../generated/helpContent';

// ---------- 极简 markdown 渲染（子集见 apps/help/README.md，不引第三方依赖） ----------

/** 行内标记：`code`、**粗体**、[文字](链接) */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}i${i++}`;
    if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push(
        <a key={key} onClick={() => void call(() => api.news.openUrl({ url: lm[2] }))}>
          {lm[1]}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface ListItem {
  text: string;
  level: number;
  children: ListItem[];
}

/** 扁平缩进列表 → 嵌套 <li>（嵌套层统一渲染为无序列表） */
function renderList(flat: Array<{ text: string; level: number }>, ordered: boolean, key: string): ReactNode {
  const root: ListItem[] = [];
  const stack: ListItem[] = [];
  for (const it of flat) {
    const node: ListItem = { text: it.text, level: it.level, children: [] };
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : root).push(node);
    stack.push(node);
  }
  const items = (list: ListItem[], kb: string): ReactNode[] =>
    list.map((it, idx) => (
      <li key={`${kb}-${idx}`}>
        {inline(it.text, `${kb}-${idx}`)}
        {it.children.length > 0 && <ul>{items(it.children, `${kb}-${idx}c`)}</ul>}
      </li>
    ));
  return ordered ? <ol key={key}>{items(root, key)}</ol> : <ul key={key}>{items(root, key)}</ul>;
}

/** 块级解析：标题 / 列表 / 引用 / 围栏代码 / 表格 / 分隔线 / 段落 */
function parseBlocks(md: string): ReactNode[] {
  const lines = md.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const next = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // 收尾围栏
      out.push(
        <pre key={next()}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = (h[1].length === 2 ? 'h2' : h[1].length === 3 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4';
      out.push(<Tag key={next()}>{inline(h[2], next())}</Tag>);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push(<hr key={next()} />);
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) buf.push(lines[i++].slice(2));
      out.push(<blockquote key={next()}>{inline(buf.join(' '), next())}</blockquote>);
      continue;
    }

    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(
          lines[i]
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((s) => s.trim()),
        );
        i++;
      }
      out.push(
        <table key={next()}>
          <thead>
            <tr>{(rows[0] ?? []).map((c, ci) => <th key={ci}>{inline(c, `th${ci}`)}</th>)}</tr>
          </thead>
          <tbody>
            {(rows[1] && /^:?-{2,}/.test(rows[1][0] ?? '') ? rows.slice(2) : rows.slice(1)).map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `td${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    const isUl = (s: string) => /^(\s*)[-*]\s+/.test(s);
    const isOl = (s: string) => /^(\s*)\d+[.、]\s+/.test(s);
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const re = ordered ? /^(\s*)\d+[.、]\s+(.*)$/ : /^(\s*)[-*]\s+(.*)$/;
      const flat: Array<{ text: string; level: number }> = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        flat.push({ text: m[2], level: Math.min(2, Math.floor(m[1].length / 2)) });
        i++;
      }
      out.push(renderList(flat, ordered, next()));
      continue;
    }

    // 段落：连续普通行，遇空行或块级开头即止
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|> |\||(\s*([-*]|\d+[.、])\s))/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(<p key={next()}>{inline(buf.join(' '), next())}</p>);
  }
  return out;
}

// ---------- 面板 ----------

export default function HelpPanel() {
  const [activeId, setActiveId] = useState(HELP_DOCS[0]?.id ?? '');
  const active = HELP_DOCS.find((d) => d.id === activeId) ?? HELP_DOCS[0];
  const articleRef = useRef<HTMLElement>(null);
  const blocks = useMemo(() => (active ? parseBlocks(active.markdown) : []), [active]);

  // 切换章节只重置正文，目录保持原有滚动位置。
  useEffect(() => {
    articleRef.current?.scrollTo({ top: 0 });
  }, [activeId]);

  const syncedAt = new Date(HELP_SYNCED_AT).toLocaleDateString('sv-SE');
  if (!active) return null;

  return (
    <div className="panel help-panel" role="region" aria-label="帮助">
      <header className="panel-head">
        <div className="head-meta mono">
          {HELP_DOCS.length} 个模块 · 更新于 {syncedAt}
        </div>
      </header>
      <div className="help-layout">
        <nav className="help-toc" aria-label="帮助目录">
          {HELP_DOCS.map((d, idx) => (
            <button
              key={d.id}
              className={`help-toc-item ${d.id === active.id ? 'active' : ''}`}
              onClick={() => setActiveId(d.id)}
            >
              <span className="help-toc-num mono">{String(idx + 1).padStart(2, '0')}</span>
              <span className="help-toc-text">
                <span className="help-toc-title">{d.title}</span>
                <span className="help-toc-desc">{d.description}</span>
              </span>
            </button>
          ))}
        </nav>
        <article ref={articleRef} className="help-article" tabIndex={0} aria-label={`${active.title}帮助正文`}>
          <h2 className="help-doc-title serif">{active.title}</h2>
          <div className="help-md">{blocks}</div>
        </article>
      </div>
    </div>
  );
}
