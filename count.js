function frontmatter(text) {
  const front = /^(\uFEFF?---\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(text);
  return front && front.index === 0 ? front : null;
}
// Single source of record parsing: skip frontmatter (YAML/BOM/CRLF) and code fences, match record headings.
// Returns [{heading,start,end,line}] in file order; heading excludes the '## ' prefix, start/end are
// character offsets in the original text (heading line start → next heading or end of file), line is 0-based.
function parseRecords(text) {
  const validFront = frontmatter(text);
  const base = validFront ? validFront[0].length : 0;
  const baseLine = validFront ? validFront[0].split(/\r?\n/).length - 1 : 0;
  const body = validFront ? text.slice(base) : text;
  const spans = [];
  let fence = null, line = 0, pos = 0;
  while (pos <= body.length) {
    const nl = body.indexOf('\n', pos);
    const end = nl < 0 ? body.length : nl;
    const raw = body.slice(pos, end);
    const lineText = nl >= 0 && raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lineText);
    if (mark) {
      if (!fence) fence = {char:mark[1][0],length:mark[1].length};
      else if (mark[1][0] === fence.char && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
    } else if (!fence) {
      const heading = /^(## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[ \t]*$/.exec(lineText);
      if (heading) spans.push({heading:heading[1].slice(3),start:base + pos,end:text.length,line:baseLine + line});
    }
    line++;
    if (nl < 0) break;
    pos = nl + 1;
  }
  for (let i = spans.length - 1; i > 0; i--) spans[i - 1].end = spans[i].start;
  return spans;
}
function updateFlomoNoteCount(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const validFront = frontmatter(text);
  const body = validFront ? text.slice(validFront[0].length) : text;
  const count = parseRecords(text).length;
  if (!validFront) return `---${newline}noteCount: ${count}${newline}---${newline}${text}`;
  let yaml = validFront[2];
  if (/^noteCount:[^\r\n]*\r?$/m.test(yaml)) {
    yaml = yaml.replace(/^(noteCount:)[^\r\n]*(\r?)$/m, (_,key,cr) => `${key} ${count}${cr}`);
  } else yaml += `noteCount: ${count}${newline}`;
  return validFront[1] + yaml + validFront[3] + body;
}

module.exports = {parseRecords,updateFlomoNoteCount};
