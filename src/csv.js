/**
 * The little CSV this app needs: reading a recipients file someone filled in
 * by hand in Excel or Google Sheets, and writing the blank one they start from.
 *
 * Reading copes with what those tools actually produce: a UTF-8 byte-order
 * mark, CRLF or LF line endings, quoted cells containing commas, quotes and
 * line breaks, and a semicolon or tab instead of a comma — Excel uses a
 * semicolon wherever the comma is the decimal separator.
 */

/** Counts a delimiter in a line, ignoring anything inside quotes. */
function countOutside(line, delim) {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === delim && !quoted) n++;
  }
  return n;
}

export function parseCsv(input) {
  const text = String(input).replace(/^﻿/, '');
  const header = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t']
    .map((d) => [d, countOutside(header, d)])
    .sort((a, b) => b[1] - a[1])[0];
  const sep = delim[1] > 0 ? delim[0] : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // A blank line, or one that is nothing but empty cells, is not a row.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * A cell a spreadsheet would run as a formula, made inert. The blank file
 * carries role names the template's author typed, and a name beginning with
 * "=" must not become a formula on whoever opens the download.
 */
const inert = (cell) => (/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell);

export function toCsv(rows) {
  return rows
    .map((r) =>
      r
        .map((raw) => {
          const cell = inert(String(raw ?? ''));
          return /[",;\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
        })
        .join(',')
    )
    .join('\r\n') + '\r\n';
}
