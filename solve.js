// csv-reader-fast: a drop-in replacement for csv-reader 1.0.0's readCsv, written
// for speed. It returns the same answer for every input — {columns, rows, errors} —
// following csv-reader 1.0.0's broken-row policy exactly: a U+FEFF at the very start
// is dropped; a record ends at LF or CRLF and a line with no characters is no
// record; outside a quoted field a CR not followed by LF is dropped (stray_cr); a
// field that opens with a quote runs to the next quote that is not doubled ("" inside
// it is one quote, each CRLF or lone CR inside it is one LF); what follows its
// closing quote, up to the next comma or line break, is appended as it stands
// (quote_junk); a quote that never closes is a literal character and the text after
// it is read again as an unquoted field (unterminated_quote); a quote inside an
// unquoted field is literal; fields stay strings, never trimmed or converted; rows
// are padded with "" (short_row) or cut (long_row) to the first record's width.
//
// Where the reference reads one character at a time and builds every field up a
// character at a time, this reader jumps: an unquoted field finds its next delimiter
// with indexOf, a quoted field finds its closing quote with indexOf, and values are
// slices of the input, never built up. The only character-at-a-time work left is
// the record-start skip of empty lines.

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The result of the last field read, written by the readers below.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function err(code, recordLine, recordRow) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field from pos, starting from `value` ("" normally, '"' after
  // an unterminated quote, a quoted value whose junk follows it). A CR not followed
  // by LF is dropped (stray_cr). fAdded counts the characters kept, not `value`'s own.
  // The next delimiter is found with one native character-class search, not three
  // separate scans: on the practice set this is the faster of the two.
  const DELIM = /[,\n\r]/g;
  function readUnquoted(value, recordLine, recordRow) {
    let added = 0;
    for (;;) {
      DELIM.lastIndex = pos;
      const hit = DELIM.exec(text);
      let m = -1;
      let kind = -1; // 0 comma, 1 LF, 2 CR
      if (hit !== null) {
        m = hit.index;
        const ch = hit[0];
        kind = ch === ',' ? 0 : ch === '\n' ? 1 : 2;
      }
      if (m === -1) {
        // No delimiter left: the rest of the text is the field.
        if (pos < n) { value += text.slice(pos, n); added += n - pos; pos = n; }
        fValue = value; fEnded = END; fAdded = added;
        return;
      }
      if (kind === 0) {
        value += text.slice(pos, m); added += m - pos; pos = m + 1;
        fValue = value; fEnded = COMMA; fAdded = added;
        return;
      }
      if (kind === 1) {
        value += text.slice(pos, m); added += m - pos; pos = m + 1; line += 1;
        fValue = value; fEnded = LINE_BREAK; fAdded = added;
        return;
      }
      // A CR: a line break when followed by LF, else a stray CR, dropped.
      if (text.charCodeAt(m + 1) === 10) {
        value += text.slice(pos, m); added += m - pos; pos = m + 2; line += 1;
        fValue = value; fEnded = LINE_BREAK; fAdded = added;
        return;
      }
      err('stray_cr', recordLine, recordRow);
      value += text.slice(pos, m); added += m - pos; pos = m + 1;
      // The field goes on after the dropped CR.
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted(recordLine, recordRow) {
    const open = pos;
    const openLine = line;
    pos += 1;
    let p = pos;
    let hasDouble = false;
    let closed = -1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) { hasDouble = true; p = q + 2; continue; }
      closed = q;
      break;
    }
    if (closed === -1) {
      // The quote never closes: it is a literal character, and the text after it
      // is read again as unquoted.
      pos = open + 1;
      line = openLine;
      err('unterminated_quote', recordLine, recordRow);
      readUnquoted('"', recordLine, recordRow);
      return;
    }
    // The quoted segment is [open + 1, closed).
    let hasNL = false;
    const ni = text.indexOf('\n', open + 1);
    if (ni !== -1 && ni < closed) hasNL = true;
    else {
      const ri = text.indexOf('\r', open + 1);
      if (ri !== -1 && ri < closed) hasNL = true;
    }
    let value = text.slice(open + 1, closed);
    if (hasNL) {
      // Each CRLF, lone CR and LF inside the quotes is one line and one LF.
      const breaks = value.match(/\r\n|\r|\n/g);
      line += breaks === null ? 0 : breaks.length;
      value = value.replace(/\r\n?/g, '\n');
    }
    if (hasDouble) value = value.replaceAll('""', '"');
    pos = closed + 1;
    if (pos >= n) { fValue = value; fEnded = END; fAdded = 0; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fValue = value; fEnded = COMMA; fAdded = 0; return; }
    if (c === 10) { pos += 1; line += 1; fValue = value; fEnded = LINE_BREAK; fAdded = 0; return; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; fValue = value; fEnded = LINE_BREAK; fAdded = 0; return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    readUnquoted(value, recordLine, recordRow);
    if (fAdded > 0) err('quote_junk', recordLine, recordRow);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    // The record being read: the line it starts on and the index in rows it
    // takes (null: the header).
    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    // Fast path: a record with no quote and no stray CR (a trailing CR is the
    // CRLF line break) splits at once instead of field by field.
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    const qi = text.indexOf('"', pos);
    const ri = text.indexOf('\r', pos);
    if ((qi === -1 || qi >= segEnd) && (ri === -1 || ri >= segEnd || (nl !== -1 && ri === segEnd - 1))) {
      const end = (nl !== -1 && ri === segEnd - 1) ? segEnd - 1 : segEnd;
      const fields = text.slice(pos, end).split(',');
      if (nl !== -1) { pos = nl + 1; line += 1; } else pos = n;
      if (width < 0) width = fields.length;
      if (header && columns === null) { columns = fields; continue; }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted(recordLine, recordRow);
      } else {
        quoted = false;
        readUnquoted('', recordLine, recordRow);
      }
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
