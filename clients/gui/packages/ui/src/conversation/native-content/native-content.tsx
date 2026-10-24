import { useState } from "react";
import { nativeContentRegistry, nativeContentToText, type NativeContent as NativeData } from "../../lib/conversation-content.js";
import { Button } from "../../components/button/button.js";
import { Disclosure } from "../../components/disclosure/disclosure.js";

export function NativeContent({ value, copyLabel = "复制内容", copiedLabel = "已复制", failedLabel = "复制失败，请手动选择文本", dataLabel = "查看数据" }: { value: NativeData; copyLabel?: string; copiedLabel?: string; failedLabel?: string; dataLabel?: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const asText = nativeContentToText(value);
  const chartMax = value.type === "bar-chart" ? Math.max(1, ...value.items.map(item => Math.abs(item.value))) : 1;
  return <section className="areal-native-content" aria-label={value.title} data-content-type={value.type} data-tone={value.type === "callout" ? value.tone : undefined}>
    <header><h3>{value.title}</h3><Button variant="ghost" size="sm" aria-label={copyLabel} onClick={() => { void navigator.clipboard.writeText(asText).then(() => setCopy("copied"), () => setCopy("failed")); }}>{copy === "copied" ? copiedLabel : copyLabel}</Button></header>
    {copy !== "idle" && <span className="sr-only" role="status">{copy === "copied" ? copiedLabel : failedLabel}</span>}
    {value.type === "metric" && <><p className="areal-native-metric">{value.value}{value.unit && <small>{value.unit}</small>}</p>{value.note && <p>{value.note}</p>}</>}
    {value.type === "key-value" && <dl>{value.items.map((item, i) => <div key={i}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
    {value.type === "table" && <div className="areal-native-table"><table><thead><tr>{value.columns.map((column, i) => <th key={i} scope="col">{column}</th>)}</tr></thead><tbody>{value.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>}
    {value.type === "timeline" && <ol className="areal-native-timeline">{value.items.map((item, i) => <li key={i}><strong>{item.label}</strong><p>{item.text}</p></li>)}</ol>}
    {value.type === "callout" && <p>{value.text}</p>}
    {value.type === "bar-chart" && <><ul className="areal-native-bars" aria-label={nativeContentRegistry[value.type].label}>{value.items.map((item, i) => <li key={i}><span>{item.label}</span><span className="areal-native-track" aria-hidden="true"><span style={{ width: `${Math.abs(item.value) / chartMax * 100}%` }} /></span><span>{item.value}{value.unit ? ` ${value.unit}` : ""}</span></li>)}</ul><Disclosure label={dataLabel} textRole="interface"><pre>{asText}</pre></Disclosure></>}
  </section>;
}
