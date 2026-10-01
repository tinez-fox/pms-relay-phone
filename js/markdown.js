// Agents' final reports → HTML, for the Reports view. Agent text is untrusted, so this escapes
// everything first and only then adds the few tags it knows. No raw HTML from the report ever
// reaches the page, and links are kept only for http(s) URLs.
//
// Covers what reports actually use: headings, paragraphs, bold/italic, inline code, fenced code,
// bullet and numbered lists (nested by indent), block quotes, tables, links, horizontal rules.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline markup on an already escaped line. Underscore emphasis only at word edges, so
// snake_case and __dunder__ names stay as they are. Code spans are pulled out first so nothing inside them
// is touched.
function inline(s) {
  const codes = [];
  let out = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
  // [text](https://…): the URL was escaped with the rest, so &amp; is already safe in the attribute.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^\w])__([^_\n]+)__(?!\w)/g, '$1<b>$2</b>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
  return out.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${codes[i]}</code>`);
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isRule = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

// Nested lists from indented items. `items`: [{ depth, ordered, html }].
function lists(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && stack.at(-1).depth > it.depth) html += `</li></${stack.pop().tag}>`;
    const top = stack.at(-1);
    if (!top || top.depth < it.depth) {
      const tag = it.ordered ? 'ol' : 'ul';
      stack.push({ depth: it.depth, tag });
      html += `<${tag}><li>${it.html}`;
    } else html += `</li><li>${it.html}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

export function markdown(src) {
  const lines = esc(String(src || '').replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let para = [];
  const endPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    const fence = l.match(/^\s*(```|~~~)/);
    if (fence) {
      endPara();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }
    if (!l.trim()) { endPara(); i++; continue; }
    const h = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { endPara(); const n = Math.min(6, h[1].length + 2); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { endPara(); out.push('<hr>'); i++; continue; }
    if (isTableRow(l) && i + 1 < lines.length && isRule(lines[i + 1])) {
      endPara();
      const head = cells(l);
      const rows = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*&gt;/.test(l)) {
      endPara();
      const q = [];
      for (; i < lines.length && /^\s*&gt;/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (LIST.test(l)) {
      endPara();
      const items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(LIST);
        if (m) { items.push({ depth: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), html: inline(m[3]) }); continue; }
        // A wrapped line of the item above (indented, not blank) joins it.
        if (items.length && /^\s+\S/.test(lines[i])) { items.at(-1).html += ' ' + inline(lines[i].trim()); continue; }
        break;
      }
      out.push(lists(items));
      continue;
    }
    para.push(l.trim());
    i++;
  }
  endPara();
  return out.join('');
}
