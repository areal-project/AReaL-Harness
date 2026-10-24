export type NativeContent = { version: 1; title: string } & (
  | { type: "metric"; value: string; unit?: string; note?: string }
  | { type: "key-value"; items: { label: string; value: string }[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "bar-chart"; items: { label: string; value: number }[]; unit?: string }
  | { type: "timeline"; items: { label: string; text: string }[] }
  | { type: "callout"; text: string; tone?: "info" | "success" | "warning" }
);
export type ContentBlock =
  | { kind: "markdown"; offset: number; raw: string }
  | { kind: "native"; offset: number; raw: string; data: NativeContent }
  | { kind: "pending" | "unsupported"; offset: number; raw: string };

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2000;
const fields = (value: RecordValue, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const list = (value: unknown, valid: (item: unknown) => boolean): boolean => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(valid);
const optionalText = (value: unknown) => value === undefined || text(value);
type CatalogEntry = { label: string; minHeight: number; streaming: "placeholder"; actions: readonly []; validate(value: RecordValue): boolean; toText(value: NativeContent): string };

// 注册表只接收数据，不接受组件名、URL、样式、HTML或动作脚本。
export const nativeContentRegistry: Record<NativeContent["type"], CatalogEntry> = {
  metric: { label: "指标", minHeight: 96, streaming: "placeholder", actions: [],
    validate: v => fields(v, ["version", "type", "title", "value", "unit", "note"]) && text(v.value) && optionalText(v.unit) && optionalText(v.note),
    toText: v => v.type === "metric" ? `${v.title}：${v.value}${v.unit ? " " + v.unit : ""}${v.note ? "\n" + v.note : ""}` : "" },
  "key-value": { label: "信息", minHeight: 96, streaming: "placeholder", actions: [],
    validate: v => fields(v, ["version", "type", "title", "items"]) && list(v.items, x => record(x) && fields(x, ["label", "value"]) && text(x.label) && text(x.value)),
    toText: v => v.type === "key-value" ? `${v.title}\n${v.items.map(x => `${x.label}：${x.value}`).join("\n")}` : "" },
  table: { label: "表格", minHeight: 128, streaming: "placeholder", actions: [],
    validate: v => fields(v, ["version", "type", "title", "columns", "rows"]) && Array.isArray(v.columns) && v.columns.length > 0 && v.columns.length <= 20 && v.columns.every(text) && list(v.rows, row => Array.isArray(row) && row.length === (v.columns as unknown[]).length && row.every(cell => typeof cell === "string" && cell.length <= 2000)),
    toText: v => v.type === "table" ? `${v.title}\n${[v.columns, ...v.rows].map(row => row.join("\t")).join("\n")}` : "" },
  "bar-chart": { label: "条形图", minHeight: 128, streaming: "placeholder", actions: [],
    validate: v => fields(v, ["version", "type", "title", "items", "unit"]) && optionalText(v.unit) && list(v.items, x => record(x) && fields(x, ["label", "value"]) && text(x.label) && typeof x.value === "number" && Number.isFinite(x.value) && Math.abs(x.value) <= 1e15),
    toText: v => v.type === "bar-chart" ? `${v.title}${v.unit ? `（${v.unit}）` : ""}\n${v.items.map(x => `${x.label}：${x.value}`).join("\n")}` : "" },
  timeline: { label: "时间线", minHeight: 128, streaming: "placeholder", actions: [],
    validate: v => fields(v, ["version", "type", "title", "items"]) && list(v.items, x => record(x) && fields(x, ["label", "text"]) && text(x.label) && text(x.text)),
    toText: v => v.type === "timeline" ? `${v.title}\n${v.items.map(x => `${x.label}：${x.text}`).join("\n")}` : "" },
  callout: { label: "说明", minHeight: 80, streaming: "placeholder", actions: [],
    validate: v => fields(v, ["version", "type", "title", "text", "tone"]) && text(v.text) && (v.tone === undefined || ["info", "success", "warning"].includes(String(v.tone))),
    toText: v => v.type === "callout" ? `${v.title}\n${v.text}` : "" },
};
export function parseNativeContent(value: unknown): NativeContent | undefined {
  if (!record(value) || value.version !== 1 || !text(value.title) || typeof value.type !== "string" || !Object.hasOwn(nativeContentRegistry, value.type)) return;
  const entry = nativeContentRegistry[value.type as NativeContent["type"]];
  return entry.validate(value) ? value as NativeContent : undefined;
}
export function nativeContentToText(value: NativeContent): string { return nativeContentRegistry[value.type].toText(value); }
export function contentToText(blocks: readonly ContentBlock[]): string { return blocks.map(block => block.kind === "native" ? nativeContentToText(block.data) + (block.raw.endsWith("\r\n") ? "\r\n" : block.raw.endsWith("\n") ? "\n" : "") : block.raw).join(""); }

/** 保留原文和偏移的展示投影；不改写历史，不在不完整围栏内执行任何内容。 */
export function projectNativeContent(source: string, streaming = false): ContentBlock[] {
  const result: ContentBlock[] = [];
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0, cursor = 0;
  let fence: { marker: string; size: number; start: number; body: number; native: boolean } | undefined;
  const markdown = (end: number) => { if (end > cursor) result.push({ kind: "markdown", offset: cursor, raw: source.slice(cursor, end) }); };
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
    if (!fence && match) {
      fence = { marker: match[1][0], size: match[1].length, start: offset, body: offset + line.length, native: match[2].trim() === "areal-ui" };
    } else if (fence && match && match[1][0] === fence.marker && match[1].length >= fence.size && !match[2].trim()) {
      if (fence.native) {
        markdown(fence.start);
        const end = offset + line.length, raw = source.slice(fence.start, end);
        let data: NativeContent | undefined;
        if (end - fence.body <= 48 * 1024) {
          try { data = parseNativeContent(JSON.parse(source.slice(fence.body, offset))); } catch { /* 无效数据按原文回退。 */ }
        }
        result.push(data ? { kind: "native", offset: fence.start, raw, data } : { kind: "unsupported", offset: fence.start, raw });
        cursor = end;
      }
      fence = undefined;
    }
    offset += line.length;
  }
  if (fence?.native) {
    markdown(fence.start);
    result.push({ kind: streaming ? "pending" : "unsupported", offset: fence.start, raw: source.slice(fence.start) });
    cursor = source.length;
  }
  markdown(source.length);
  return result;
}
