// Markdown (what models write) to the HTML subset Telegram's parse_mode "HTML" accepts: b, i, s, code, pre, a,
// blockquote. Anything else becomes text: headings bold, lists bullets, tables a group of "header: value" lines (Telegram
// has no tables). Every text node is escaped, so the result always parses unless a tag is split by chunking; the
// channel sends plain text when Telegram still refuses it.
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const attribute = (text: string) => escape(text).replaceAll('"', "&quot;")
// Telegram refuses relative and unknown links; those stay text, with the target after them.
const linkable = (href: string) => /^(https?:|mailto:|tg:)/i.test(href)

export const telegramHtml = (markdown: string): string => {
  let headers: string[] = []
  let row: string[] = []
  let headerRow = false

  const html = Bun.markdown.render(markdown, {
    text: escape,
    html: children => children, // raw HTML in the source is shown as text (its text nodes are escaped)
    paragraph: children => `${children}\n\n`,
    heading: children => `<b>${children}</b>\n\n`,
    blockquote: children => `<blockquote>${children.trim()}</blockquote>\n\n`,
    code: (children, meta) => `<pre><code${meta?.language ? ` class="language-${attribute(meta.language)}"` : ""}>${children.replace(/\n$/, "")}</code></pre>\n\n`,
    hr: () => "──────────\n\n",
    // A nested list starts on its item's next line; a top-level one ends its block.
    list: (children, meta) => meta.depth > 0 ? `\n${children.trimEnd()}` : `${children}\n`,
    listItem: (children, meta) => {
      const marker = meta.checked === true ? "☑ " : meta.checked === false ? "☐ " : meta.ordered ? `${(meta.start ?? 1) + meta.index}. ` : "• "
      return `${"  ".repeat(meta.depth)}${marker}${children.replace(/\n{2,}/g, "\n").trim()}\n`
    },
    // Cells arrive before their row and rows before their table, in document order.
    th: children => { row.push(children); headerRow = true; return "" },
    td: children => { row.push(children); return "" },
    tr: () => {
      const cells = row
      row = []

      if (headerRow) { headers = cells; headerRow = false; return "" }
      return `• ${cells.map((cell, i) => headers[i] ? `<b>${headers[i]}</b>: ${cell}` : cell).join(" · ")}\n`
    },
    thead: () => "",
    tbody: children => children,
    table: children => { headers = []; return `${children}\n` },
    strong: children => `<b>${children}</b>`,
    emphasis: children => `<i>${children}</i>`,
    strikethrough: children => `<s>${children}</s>`,
    codespan: children => `<code>${children}</code>`,
    link: (children, meta) => linkable(meta.href) ? `<a href="${attribute(meta.href)}">${children}</a>` : `${children} (${escape(meta.href)})`,
    image: (children, meta) => linkable(meta.src) ? `<a href="${attribute(meta.src)}">${children || "image"}</a>` : children || escape(meta.src),
  })

  return html.replace(/\n{3,}/g, "\n\n").trim()
}
