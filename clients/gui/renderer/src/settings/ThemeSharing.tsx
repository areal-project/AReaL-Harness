import { Copy, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog.js";
import { CODE_PREVIEW_THEME_OPTIONS } from "../lib/codePreviewPreferences.js";
import { CODE_FONTS, UI_FONTS, validColor, type ThemeFonts, type Palette } from "./applicationSettings.js";
import { setApplicationPreferences, useApplicationPreferences } from "./applicationPreferences.js";
import { setCodePreferences, useCodePreferences } from "./preferences.js";
import type { CodePreviewTheme } from "@/lib/codePreviewSettings.js";

const prefix = "areal-theme-v1:";
type Fonts = ThemeFonts;
type SharedTheme = { variant: "light" | "dark"; palette: Omit<Palette, "fonts">; fonts: Fonts; codeTheme: CodePreviewTheme };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseTheme(text: string, variant: SharedTheme["variant"]): SharedTheme {
  const value = text.trim();
  if (!value.startsWith(prefix)) throw Error("请粘贴 AReaL 的主题分享字符串。");
  const data: unknown = JSON.parse(value.slice(prefix.length));
  if (!object(data) || data.variant !== variant) throw Error("主题的浅色／深色模式不匹配。");
  const palette = data.palette, fonts = data.fonts;
  if (!object(palette) || !validColor(palette.background) || !validColor(palette.foreground) || !validColor(palette.accent)
    || typeof palette.contrast !== "number" || !Number.isFinite(palette.contrast) || palette.contrast < 0 || palette.contrast > 100
    || typeof palette.translucentSidebar !== "boolean") throw Error("主题配色或对比度无效。");
  if (!object(fonts) || typeof fonts.uiFont !== "string" || !Object.hasOwn(UI_FONTS, fonts.uiFont)
    || typeof fonts.contentFont !== "string" || (fonts.contentFont !== "inherit" && !Object.hasOwn(UI_FONTS, fonts.contentFont))
    || typeof fonts.codeFont !== "string" || !Object.hasOwn(CODE_FONTS, fonts.codeFont)) throw Error("主题包含不支持的字体设置。");
  const codeTheme = CODE_PREVIEW_THEME_OPTIONS.find(option => option.value === data.codeTheme)?.value;
  if (!codeTheme) throw Error("主题包含不支持的代码主题。");
  return { variant, palette: { background: palette.background, foreground: palette.foreground, accent: palette.accent,
    contrast: palette.contrast, translucentSidebar: palette.translucentSidebar },
    fonts: { uiFont: fonts.uiFont as Fonts["uiFont"], contentFont: fonts.contentFont as Fonts["contentFont"], codeFont: fonts.codeFont as Fonts["codeFont"] }, codeTheme };
}

export function ThemeSharing({ mode }: { mode: SharedTheme["variant"] }) {
  const prefs = useApplicationPreferences(), code = useCodePreferences();
  const [open, setOpen] = useState(false), [text, setText] = useState(""), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [copying, setCopying] = useState(false);
  const label = mode === "light" ? "浅色" : "深色", codeKey = `${mode}Theme` as const;
  let parsed: SharedTheme | undefined, invalid = "";
  if (text.trim()) { try { parsed = parseTheme(text, mode); } catch (cause) { invalid = cause instanceof SyntaxError ? "主题字符串不完整或格式无效。" : (cause as Error).message; } }
  const copy = async () => {
    setCopying(true); setError(""); setNotice("");
    const { fonts, ...palette } = prefs[mode];
    const payload: SharedTheme = { variant: mode, palette, codeTheme: code[codeKey], fonts };
    try { await navigator.clipboard.writeText(prefix + JSON.stringify(payload)); setNotice("主题已复制"); }
    catch { setError("复制失败，请检查剪贴板权限后重试。"); }
    finally { setCopying(false); }
  };
  const apply = () => {
    if (!parsed) return;
    setError("");
    // Keep the existing preference owners. If the second write fails, restore
    // the first before reporting failure; neither setter publishes failed writes.
    let codeSaved = false;
    try {
      setCodePreferences({ [codeKey]: parsed.codeTheme }); codeSaved = true;
      setApplicationPreferences({ [mode]: { ...parsed.palette, fonts: parsed.fonts } });
      setOpen(false); setText(""); setNotice("主题已导入");
    } catch {
      try { if (codeSaved) setCodePreferences({ [codeKey]: code[codeKey] }); }
      catch { setError("保存失败，代码主题未能还原，请检查外观设置后重试。"); return; }
      setError("保存失败，原主题已保留，请重试。");
    }
  };
  return <>
    <button type="button" className="appearance-text-action" aria-label={`导入${label}主题`} onClick={() => { setText(""); setError(""); setNotice(""); setOpen(true); }} title={`导入${label}主题`}><Download size={16} aria-hidden="true" /></button>
    <button type="button" className="appearance-text-action" aria-label={`复制${label}主题`} disabled={copying} onClick={() => void copy()} title={`复制${label}主题`}><Copy size={16} aria-hidden="true" /></button>
    {!open && error && <span role="alert" className="text-ui-xs text-destructive">{error}</span>}
    {notice && <span role="status" className="text-ui-xs text-foreground-subtle">{notice}</span>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>导入主题</DialogTitle><DialogDescription>粘贴 AReaL {label}主题字符串。应用该模式的配色、代码主题和字体设置，其他偏好保持不变。</DialogDescription></DialogHeader>
      <Textarea aria-label={`${label}主题字符串`} value={text} onChange={e => { setText(e.target.value); setError(""); }} placeholder={prefix + "…"} spellCheck={false} className="min-h-28 font-mono" />
      {(error || invalid) && <p role="alert" className="text-ui-sm text-destructive">{error || invalid}</p>}
      <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>取消</Button><Button disabled={!parsed} onClick={apply}>导入</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
