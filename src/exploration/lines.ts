export interface SourceLine { readonly number: number; readonly offset: number; readonly length: number; readonly text: string }
export interface PreparedText { readonly lines: readonly SourceLine[]; readonly searchText: string }

export function prepareText(text: string): PreparedText {
  const bytes = Buffer.from(text);
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10 && bytes[index] !== 13) continue;
    if (bytes[index] === 13 && bytes[index + 1] === 10) index++;
    const end = index + 1;
    lines.push({ number: lines.length + 1, offset: start, length: end - start,
      text: Buffer.from(bytes.subarray(start, end)).toString('utf8') });
    start = end;
  }
  if (start < bytes.length) lines.push({ number: lines.length + 1, offset: start, length: bytes.length - start,
    text: Buffer.from(bytes.subarray(start)).toString('utf8') });
  return { lines, searchText: text.replace(/\r\n|\r/g, '\n') };
}
