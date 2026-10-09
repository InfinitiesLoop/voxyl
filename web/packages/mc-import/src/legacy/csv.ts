// A small RFC 4180 CSV reader for NEI's Data Dumps. NEI quotes a field only when it has to
// (a comma, a quote or a line break in a display name), so a plain split on "," would tear
// "Block of Iron, Compressed" apart; this follows the quoting rules instead.

/**
 * Splits CSV text into records of fields. A field may be quoted ("a,b", "say ""hi""", a line
 * break inside the quotes); a quote only opens a quoted field at the start of a field, so
 * 5" stays as it is. Records end at LF, CRLF or a lone CR. A blank line is a record of one
 * empty field, as a line-by-line reader (Godot's `get_csv_line`) gives it, so callers skip
 * short records the same way. A final line break does not add an empty record.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  // True from the first character of a record until its line break: tells "a,b\n" (done)
  // from "a,b,\n" (a last, empty field) and from a blank line.
  let inRecord = false;
  let atFieldStart = true;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch === '"' && atFieldStart) {
      // Runs to the closing quote; "" inside is a literal quote. Anything between the closing
      // quote and the next comma is kept as it is, which is what lenient readers do.
      inRecord = true;
      atFieldStart = false;
      for (i++; i < n; i++) {
        if (text[i] !== '"') {
          field += text[i];
        } else if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          break;
        }
      }
    } else if (ch === ",") {
      record.push(field);
      field = "";
      inRecord = true;
      atFieldStart = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      inRecord = false;
      atFieldStart = true;
    } else {
      field += ch;
      inRecord = true;
      atFieldStart = false;
    }
  }
  if (inRecord) {
    record.push(field);
    records.push(record);
  }
  return records;
}
