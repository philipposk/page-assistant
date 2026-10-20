// A small, safe markdown renderer for replies: paragraphs, line breaks, lists, rules,
// headings (as bold lines), **bold**, *italic*, `code` and links. No HTML is ever parsed or
// injected — everything becomes React text nodes — so a reply cannot carry markup or script.
// Links: http(s) open in a new tab; in-app paths go through the host's router; anything
// else (javascript:, data:, mailto:) is shown as plain text.

import { Fragment, memo, type ReactNode } from "react";
import { isExternalHttpUrl, isSafeInAppPath } from "../actions/safeNavigate.js";

export interface MarkdownProps {
  text: string;
  /** In-app link clicks. Default: a normal link (full page load). */
  onNavigate?: (path: string) => void;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "h"; text: string }
  | { kind: "hr" }
  | { kind: "code"; text: string };

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", lines: para });
    if (list) blocks.push(list);
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "hr" });
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "h", text: heading[1] });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (para.length) {
        blocks.push({ kind: "p", lines: para });
        para = [];
      }
      if (!list || list.kind !== kind) {
        if (list) blocks.push(list);
        list = { kind, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    if (list) {
      // A continuation line of the last item.
      if (/^\s{2,}/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`;
        continue;
      }
      blocks.push(list);
      list = null;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

// Inline tokens: escapes, code, links, bold, italic. A link label can't contain a bracket and
// every part is bounded, so a reply full of "[" or "[](" renders in linear time.
const INLINE_RE = /\\([\\`*_{}[\]()#+\-.!<>|~])|`([^`\n]{1,2000})`|\[([^\][\n]{0,500})\]\(\s{0,10}([^)\s]{0,2048})(?:\s{1,10}"[^"\n]{0,300}")?\s{0,10}\)|\*\*([^*\n]{1,2000})\*\*|__([^_\n]{1,2000})__|\*([^*\s][^*\n]{0,2000})\*|(?<![\w])_([^_\s][^_\n]{0,2000})_(?![\w])/g;
/** Longest text rendered; a longer reply is cut (the server never sends one this long). */
export const MAX_RENDER_CHARS = 40_000;

export function renderInline(text: string, onNavigate?: (path: string) => void, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  // A fresh regex per call: this recurses (bold inside a link), and a shared global regex's
  // lastIndex would be reset under the outer loop, which then never ends.
  const re = new RegExp(INLINE_RE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined) out.push(link(m[3], m[4] ?? "", key, onNavigate));
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={key}>{renderInline(m[5] ?? m[6], onNavigate, key)}</strong>);
    else if (m[7] !== undefined || m[8] !== undefined) out.push(<em key={key}>{renderInline(m[7] ?? m[8], onNavigate, key)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function link(label: string, href: string, key: string, onNavigate?: (path: string) => void): ReactNode {
  const children = renderInline(label || href, onNavigate, key);
  // Guards take `unknown`; a copy keeps them from narrowing `href` itself to never.
  const target: unknown = href;
  if (isSafeInAppPath(target)) {
    return (
      <a
        key={key}
        href={href}
        onClick={(e) => {
          if (!onNavigate || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onNavigate(href.trim());
        }}
      >
        {children}
      </a>
    );
  }
  if (isExternalHttpUrl(target)) {
    return (
      <a key={key} href={href.trim()} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  }
  return <Fragment key={key}>{children}</Fragment>;
}

/** Memoized: a long chat re-renders on every status tick, and parsing is not free. */
export const Markdown = memo(function Markdown({ text, onNavigate }: MarkdownProps) {
  const t = String(text ?? "");
  const blocks = parseBlocks(t.length > MAX_RENDER_CHARS ? `${t.slice(0, MAX_RENDER_CHARS)}…` : t);
  return (
    <div className="pa-agent-md">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case "hr":
            return <hr key={k} />;
          case "h":
            return (
              <p key={k} className="pa-agent-md-h">
                <strong>{renderInline(b.text, onNavigate, k)}</strong>
              </p>
            );
          case "code":
            return (
              <pre key={k}>
                <code>{b.text}</code>
              </pre>
            );
          case "ul":
          case "ol": {
            const Tag = b.kind;
            return (
              <Tag key={k}>
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(item, onNavigate, `${k}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
          default:
            return (
              <p key={k}>
                {b.lines.map((line, j) => (
                  <Fragment key={j}>
                    {j > 0 ? <br /> : null}
                    {renderInline(line, onNavigate, `${k}-${j}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
});
