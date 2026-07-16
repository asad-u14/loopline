/**
 * Minimal, safe markdown → HTML for the ticket webview. Escapes HTML first, then
 * applies a small subset (headings, lists, blockquotes, code, bold, links).
 * Pure and dependency-free so it's unit-testable and XSS-safe.
 */

export function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s: string): string {
  let t = escapeHtml(s);
  // inline code
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // bold
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // [text](url) links (http/https only)
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text, url) => `<a href="${url}">${text}</a>`
  );
  return t;
}

export function mdToHtml(md: string): string {
  if (!md) {
    return "";
  }
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };

  let i = 0;
  const isBlock = (t: string) => /^(#{1,6}\s|[-*]\s|\d+[.)]\s|>\s|```)/.test(t);

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      closeLists();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (trimmed === "") {
      closeLists();
      i++;
      continue;
    }

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }

    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }

    const bq = trimmed.match(/^>\s?(.*)$/);
    if (bq) {
      closeLists();
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
      i++;
      continue;
    }

    // paragraph: accumulate until a blank line or a block starter
    closeLists();
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlock(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  closeLists();
  return out.join("\n");
}
