export type DelimitedPreview = { rows: string[][]; truncated: boolean; malformed: boolean };

export function parseDelimitedPreview(text: string, delimiter: "," | "\t"): DelimitedPreview {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  let truncated = false;
  let malformed = false;
  const finishCell = () => {
    if (row.length < 100) row.push(cell);
    else truncated = true;
    cell = "";
    closedQuote = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < input.length; index++) {
    if (rows.length === 200) {
      truncated = true;
      break;
    }
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else cell += char;
      continue;
    }
    if (char === delimiter) finishCell();
    else if (char === "\n" || char === "\r") {
      finishRow();
      if (char === "\r" && input[index + 1] === "\n") index++;
    } else if (char === '"' && !cell && !closedQuote) quoted = true;
    else {
      if (closedQuote || char === '"') malformed = true;
      cell += char;
    }
  }
  if (quoted) malformed = true;
  if (rows.length < 200 && (cell || row.length || closedQuote)) finishRow();
  return { rows, truncated, malformed };
}
