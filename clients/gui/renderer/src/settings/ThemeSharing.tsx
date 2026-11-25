import { useI18n, UiMessageError, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { Copy, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog.js";
import { CODE_PREVIEW_THEME_OPTIONS } from "../lib/codePreviewPreferences.js";
import {
  CODE_FONTS,
  UI_FONTS,
  validColor,
  type ThemeFonts,
  type Palette,
} from "./applicationSettings.js";
import { setApplicationPreferences, useApplicationPreferences } from "./applicationPreferences.js";
import { setCodePreferences, useCodePreferences } from "./preferences.js";
import type { CodePreviewTheme } from "@/lib/codePreviewSettings.js";

const prefix = "areal-theme-v1:";
type Fonts = ThemeFonts;
type SharedTheme = {
  variant: "light" | "dark";
  palette: Omit<Palette, "fonts">;
  fonts: Fonts;
  codeTheme: CodePreviewTheme;
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function parseTheme(text: string, variant: SharedTheme["variant"]): SharedTheme {
  const value = text.trim();
  if (!value.startsWith(prefix))
    throw new UiMessageError({ id: "settings.themeSharing.pasteThemeString" });
  const data: unknown = JSON.parse(value.slice(prefix.length));
  if (!object(data) || data.variant !== variant)
    throw new UiMessageError({ id: "settings.themeSharing.modeMismatch" });
  const palette = data.palette,
    fonts = data.fonts;
  if (
    !object(palette) ||
    !validColor(palette.background) ||
    !validColor(palette.foreground) ||
    !validColor(palette.accent) ||
    typeof palette.contrast !== "number" ||
    !Number.isFinite(palette.contrast) ||
    palette.contrast < 0 ||
    palette.contrast > 100 ||
    typeof palette.translucentSidebar !== "boolean"
  )
    throw new UiMessageError({ id: "settings.themeSharing.invalidColors" });
  if (
    !object(fonts) ||
    typeof fonts.uiFont !== "string" ||
    !Object.hasOwn(UI_FONTS, fonts.uiFont) ||
    typeof fonts.contentFont !== "string" ||
    (fonts.contentFont !== "inherit" && !Object.hasOwn(UI_FONTS, fonts.contentFont)) ||
    typeof fonts.codeFont !== "string" ||
    !Object.hasOwn(CODE_FONTS, fonts.codeFont)
  )
    throw new UiMessageError({ id: "settings.themeSharing.unsupportedFonts" });
  const codeTheme = CODE_PREVIEW_THEME_OPTIONS.find(
    (option) => option.value === data.codeTheme,
  )?.value;
  if (!codeTheme) throw new UiMessageError({ id: "settings.themeSharing.unsupportedCodeTheme" });
  return {
    variant,
    palette: {
      background: palette.background,
      foreground: palette.foreground,
      accent: palette.accent,
      contrast: palette.contrast,
      translucentSidebar: palette.translucentSidebar,
    },
    fonts: {
      uiFont: fonts.uiFont as Fonts["uiFont"],
      contentFont: fonts.contentFont as Fonts["contentFont"],
      codeFont: fonts.codeFont as Fonts["codeFont"],
    },
    codeTheme,
  };
}

export function ThemeSharing({ mode }: { mode: SharedTheme["variant"] }) {
  const { t } = useI18n();
  const prefs = useApplicationPreferences(),
    code = useCodePreferences();
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [error, setError] = useState<string | UiMessage>("");
  const [notice, setNotice] = useState<UiMessage | undefined>(),
    [copying, setCopying] = useState(false);
  const label =
      mode === "light" ? t("settings.themeSharing.light") : t("settings.themeSharing.dark"),
    codeKey = `${mode}Theme` as const;
  let parsed: SharedTheme | undefined,
    invalid = "";
  if (text.trim()) {
    try {
      parsed = parseTheme(text, mode);
    } catch (cause) {
      invalid =
        cause instanceof SyntaxError
          ? t("settings.themeSharing.theThemeStringIsIncompleteOrInvalid")
          : cause instanceof UiMessageError
            ? formatUiMessage(t, cause.descriptor)
            : (cause as Error).message;
    }
  }
  const copy = async () => {
    setCopying(true);
    setError("");
    setNotice(undefined);
    const { fonts, ...palette } = prefs[mode];
    const payload: SharedTheme = { variant: mode, palette, codeTheme: code[codeKey], fonts };
    try {
      await navigator.clipboard.writeText(prefix + JSON.stringify(payload));
      setNotice({ id: "settings.themeSharing.themeCopied" });
    } catch {
      setError({ id: "settings.themeSharing.copyFailedCheckClipboardPermissionsAndTry" });
    } finally {
      setCopying(false);
    }
  };
  const apply = () => {
    if (!parsed) return;
    setError("");
    // Keep the existing preference owners. If the second write fails, restore
    // the first before reporting failure; neither setter publishes failed writes.
    let codeSaved = false;
    try {
      setCodePreferences({ [codeKey]: parsed.codeTheme });
      codeSaved = true;
      setApplicationPreferences({ [mode]: { ...parsed.palette, fonts: parsed.fonts } });
      setOpen(false);
      setText("");
      setNotice({ id: "settings.themeSharing.themeImported" });
    } catch {
      try {
        if (codeSaved) setCodePreferences({ [codeKey]: code[codeKey] });
      } catch {
        setError({ id: "settings.themeSharing.saveFailedAndTheCodeThemeCould" });
        return;
      }
      setError({ id: "settings.themeSharing.saveFailedTheOriginalThemeIsRetained" });
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost-subtle"
        size="icon"
        aria-label={t("settings.themeSharing.importValueTheme", { value0: label })}
        onClick={() => {
          setText("");
          setError("");
          setNotice(undefined);
          setOpen(true);
        }}
        title={t("settings.themeSharing.importValueTheme", { value0: label })}
      >
        <Download size={16} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost-subtle"
        size="icon"
        aria-label={t("settings.themeSharing.copyValueTheme", { value0: label })}
        disabled={copying}
        onClick={() => void copy()}
        title={t("settings.themeSharing.copyValueTheme", { value0: label })}
      >
        <Copy size={16} aria-hidden="true" />
      </Button>
      {!open && error && (
        <span role="alert" className="text-ui-xs text-destructive">
          {formatUiMessage(t, error)}
        </span>
      )}
      {notice && (
        <span role="status" className="text-ui-xs text-foreground-subtle">
          {formatUiMessage(t, notice)}
        </span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.themeSharing.importTheme")}</DialogTitle>
            <DialogDescription>
              {t("settings.themeSharing.importDescription", { mode: label })}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t("settings.themeSharing.valueThemeString", { value0: label })}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError("");
            }}
            placeholder={prefix + "…"}
            spellCheck={false}
            mono
            className="min-h-28"
          />
          {(error || invalid) && (
            <p role="alert" className="text-ui-sm text-destructive">
              {formatUiMessage(t, error) || invalid}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("settings.themeSharing.cancel")}
            </Button>
            <Button disabled={!parsed} onClick={apply}>
              {t("settings.themeSharing.import")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
