import { useI18n, UiMessageError, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { ActionButton } from "../components/ui/action-button.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { DesktopEnvironmentSettings } from "./DesktopEnvironmentSettings.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Input } from "../components/ui/input.js";
import { CODE_PREVIEW_THEME_OPTIONS } from "../lib/codePreviewPreferences.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./SettingsPageParts.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { useCodePreferences, setCodePreferences } from "./preferences.js";
import {
  useApplicationPreferences,
  setApplicationPreferences,
} from "./applicationPreferences.js";
import {
  DEFAULT_PALETTES,
  UI_FONTS,
  CODE_FONTS,
  validColor,
  type Palette,
} from "./applicationSettings.js";
import { ThemeSharing } from "./ThemeSharing.js";
import { getResolvedOrResolveTheme } from "@pierre/diffs";
import "../lib/diffsHighlighterEngine.js";
import { NotificationSettings } from "./NotificationSettings.js";
import { MenuBarSetting } from "./MenuBarSetting.js";
import { ProjectlessDirectorySetting } from "./ProjectlessDirectorySetting.js";
import { FileOpenSetting } from "./FileOpenSetting.js";
import type { Action, Data, Snapshot, PlatformServices } from "../services.js";
import type { CodePreviewTheme } from "@/lib/codePreviewSettings.js";

const THEME_DIFF = {
  remove: [
    "const themePreview: ThemeConfig = {",
    '  surface: "sidebar",',
    '  accent: "#2563eb",',
    "  contrast: 42,",
    "};",
  ],
  add: [
    "const themePreview: ThemeConfig = {",
    '  surface: "sidebar-elevated",',
    '  accent: "#0ea5e9",',
    "  contrast: 68,",
    "};",
  ],
} as const;

function highlightThemeLine(line: string) {
  return line.split(/(\bconst\b|"[^"]*"|\b\d+\b|[A-Za-z_]\w*|[{}:=,])/g).filter(Boolean).map((part, index) => {
    const kind = part === "const" ? "keyword"
      : part === "ThemeConfig" ? "type"
      : part === "=" ? "operator"
      : part.startsWith('"') ? "string"
      : /^\d+$/.test(part) ? "number"
      : /^[A-Za-z_]/.test(part) ? "ident"
      : "punct";
    return <span key={`${part}-${index}`} className={`tok-${kind}`}>{part}</span>;
  });
}

function ThemeDiffPreview() {
  const { diffMarkers } = useApplicationPreferences();
  return (
    <div className="theme-diff" data-diff-markers={diffMarkers} aria-hidden="true">
      {(["remove", "add"] as const).map((tone) => (
        <div key={tone} className={`theme-diff-pane theme-diff-${tone}`}>
          <div className="theme-diff-gutter">
            {THEME_DIFF[tone].map((_, index) => (
              <span key={index} data-changed={index > 0 && index < 4 ? "true" : undefined}>
                {index + 1}
                {diffMarkers === "signs" && index > 0 && index < 4 && <span className="theme-diff-marker">{tone === "add" ? "+" : "−"}</span>}
              </span>
            ))}
          </div>
          <div className="theme-diff-code">
            {THEME_DIFF[tone].map((line, index) => (
              <span key={line} className="theme-diff-line" data-changed={index > 0 && index < 4 ? "true" : undefined}>
                {highlightThemeLine(line)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Derived decoration only; late theme loads cannot replace a newer selection. */
function CodeThemeSample({ theme }: { theme: CodePreviewTheme }) {
  const { t } = useI18n();
  const [sample, setSample] = useState<{ theme: CodePreviewTheme; style?: CSSProperties }>();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const resolved = await getResolvedOrResolveTheme(theme);
        if (active) setSample({ theme, style: { backgroundColor: resolved.bg, color: resolved.fg, borderColor: `color-mix(in srgb, ${resolved.fg} 16%, transparent)` } });
      } catch {
        if (active) setSample({ theme });
      }
    };
    void load();
    return () => { active = false; };
  }, [theme]);
  const current = sample?.theme === theme ? sample : undefined;
  return <span className="appearance-aa" aria-hidden="true"
    data-code-theme={current?.style ? theme : undefined}
    style={current?.style} title={current && !current.style ? t("settings.displaySettings.previewTemporarilyUnavailable") : undefined}>Aa</span>;
}

export function GeneralSettings({ settings = {}, power, menuBar, projectlessDirectory, chooseProjectlessDirectory, fileOpen, action, connected = false }: { settings?: Data; power?: Snapshot["power"]; menuBar?: Snapshot["menuBar"]; projectlessDirectory?: string; chooseProjectlessDirectory?: PlatformServices["chooseProjectlessDirectory"]; fileOpen?: PlatformServices["fileOpen"]; action?: Action; connected?: boolean }) {
  const { t } = useI18n();
  const prefs = useApplicationPreferences();
  const [powerSaving, setPowerSaving] = useState(false), [powerError, setPowerError] = useState<string | UiMessage>("");
  const powerSavePending = useRef(false);
  const savePower = async (value: boolean) => {
    if (!connected || !action || powerSavePending.current) return;
    powerSavePending.current = true; setPowerSaving(true); setPowerError("");
    try { await action("library", { operation: "settings", key: "preventSleep", value }); }
    catch (error) { setPowerError(error instanceof UiMessageError ? error.descriptor : error instanceof Error ? error.message : { id: "settings.displaySettings.failedToSaveSleepSettings" }); }
    finally { powerSavePending.current = false; setPowerSaving(false); }
  };
  return (
    <div className="settings-sections">
      <SettingsSection title={t("settings.language")}>
        <SettingsGroupCard>
          <SettingsRow label={t("settings.language")} description={t("settings.language.description")} control={<SettingsSelect aria-label={t("settings.language")} value={prefs.locale} onValueChange={locale => setApplicationPreferences({ locale: locale as "zh-CN" | "en" })}><option value="zh-CN">简体中文</option><option value="en">English</option></SettingsSelect>} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title={t("settings.displaySettings.filesAndOpening")}>
        <SettingsGroupCard>
          <ProjectlessDirectorySetting directory={projectlessDirectory} choose={chooseProjectlessDirectory} connected={connected} />
          <FileOpenSetting service={fileOpen} preferred={settings.fileOpenTarget} connected={connected} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title={t("settings.displaySettings.windowsAndTerminal")}>
        <SettingsGroupCard>
          <MenuBarSetting enabled={settings.showInMenuBar !== false} state={menuBar} action={action} connected={connected} />
          <SettingsRow
            label={t("settings.displaySettings.bottomPanel")}
            description={t("settings.displaySettings.showTheBottomPanelControlInThe")}
            control={<SettingsSwitch aria-label={t("settings.displaySettings.bottomPanel")} checked={prefs.showBottomPanelControl} onCheckedChange={(showBottomPanelControl) => setApplicationPreferences({ showBottomPanelControl })} />}
          />
          <SettingsRow
            label={t("settings.displaySettings.defaultTerminalLocation")}
            description={t("settings.displaySettings.defaultLocationForNewTerminalTabs")}
            control={<SettingsSegmentedTabs ariaLabel={t("settings.displaySettings.defaultTerminalLocation")} value={prefs.terminalLocation}
              items={[{ label: t("settings.displaySettings.bottom"), value: "bottom" }, { label: t("settings.displaySettings.right"), value: "right" }]}
              onValueChange={(terminalLocation) => setApplicationPreferences({ terminalLocation })} />}
          />
        </SettingsGroupCard>
      </SettingsSection>
      <DesktopEnvironmentSettings settings={settings} action={action} connected={connected} />
      <SettingsSection title={t("settings.displaySettings.power")}>
        <SettingsGroupCard>
          <SettingsRow
            label={t("settings.displaySettings.preventSystemSleepWhileRunning")}
            description={t("settings.displaySettings.keepTheSystemAwakeWhileTasksRun")}
            control={<SettingsSwitch aria-label={t("settings.displaySettings.preventSystemSleepWhileRunning")} checked={settings.preventSleep !== false}
              disabled={!connected || !action || powerSaving} onCheckedChange={value => void savePower(value)} />}
          />
          {(powerError || power?.error) && <p role="alert" className="px-4 py-2 text-destructive">{formatUiMessage(t, powerError) || power?.error}</p>}
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title={t("settings.displaySettings.editor")}>
        <SettingsGroupCard>
          <SettingsRow
            label={t("settings.displaySettings.predictNextPrompt")}
            description={t("settings.displaySettings.predictNextPromptDescription")}
            control={<SettingsSwitch aria-label={t("settings.displaySettings.predictNextPrompt")} checked={prefs.nextPromptSuggestions}
              onCheckedChange={nextPromptSuggestions => setApplicationPreferences({ nextPromptSuggestions })} />}
          />
          <SettingsRow
            label={t("settings.displaySettings.sendShortcut")}
            description={t("settings.displaySettings.shiftEnterAlwaysInsertsANewLine")}
            control={
              <SettingsSelect aria-label={t("settings.displaySettings.sendShortcut")} value={prefs.sendShortcut} onValueChange={selectedValue => setApplicationPreferences({
                    sendShortcut: selectedValue as "enter" | "modifier",
                  })}>
                <option value="enter">{t("settings.displaySettings.enterToSend")}</option>
                <option value="modifier">{t("settings.displaySettings.ctrlEnterToSend")}</option>
              </SettingsSelect>
            }
          />
          <SettingsRow
            label={t("settings.displaySettings.followUpBehavior")}
            description={t("settings.displaySettings.howNewMessagesAreSentWhileRunning")}
            control={
              <SettingsSegmentedTabs
                ariaLabel={t("settings.displaySettings.followUpBehavior")}
                items={[
                  { label: t("settings.displaySettings.queue"), value: "queue" },
                  { label: t("settings.displaySettings.steer"), value: "steer" },
                ]}
                value={prefs.followUp}
                onValueChange={(val) =>
                  setApplicationPreferences({
                    followUp: val as "queue" | "steer",
                  })
                }
              />
            }
          />
        </SettingsGroupCard>
      </SettingsSection>
      <NotificationSettings settings={settings} action={action} connected={connected} />
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="theme-color-field">
      <input
        type="color"
        aria-label={t("settings.displaySettings.valueColorPicker", { value0: label })}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        aria-label={label}
        value={draft}
        maxLength={7}
        aria-invalid={!validColor(draft)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (validColor(e.target.value)) onChange(e.target.value);
        }}
      />
      <span className="sr-only" role="status">
        {!validColor(draft)
          ? t("settings.displaySettings.enterASixDigitHexadecimalColorThe")
          : ""}
      </span>
    </div>
  );
}

export function AppearanceSettings({
  theme,
  setTheme,
  fontSize,
  setFontSize,
}: {
  theme: string;
  setTheme: (value: string) => void;
  fontSize: number;
  setFontSize: (value: number) => void;
}) {
  const { t } = useI18n();
  const prefs = useApplicationPreferences(),
    code = useCodePreferences();
  const fontSelect = (
    mode: "light" | "dark",
    name: "uiFont" | "contentFont" | "codeFont",
    label: string,
  ) => (
    <SettingsSelect aria-label={label} value={prefs[mode].fonts[name]} onValueChange={selectedValue => setApplicationPreferences({ [mode]: { ...prefs[mode], fonts: { ...prefs[mode].fonts, [name]: selectedValue } } })}>
      {name === "contentFont" && <option value="inherit">{t("settings.displaySettings.sameAsInterfaceFont")}</option>}
      {Object.keys(name === "codeFont" ? CODE_FONTS : UI_FONTS).map((font) => (
        <option key={font} value={font}>
          {(
            {
              system: t("settings.displaySettings.systemDefault"),
              PingFang: t("settings.displaySettings.pingfang"),
              Courier: "Courier New",
            } as Record<string, string>
          )[font] ?? font}
        </option>
      ))}
    </SettingsSelect>
  );
  const sizeInput = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (n: number) => void,
  ) => (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        value={value}
        className="w-16 text-center"
        onChange={(e) => {
          const n = Number(e.target.value);
          if (n >= min && n <= max) onChange(n);
        }}
      />
      <span className="text-ui-sm text-foreground-subtle">px</span>
    </div>
  );
  const codeTheme = (mode: "light" | "dark") => (
    <SettingsSelect aria-label={t("settings.displaySettings.valueCodeTheme", { value0: mode === "light" ? t("settings.displaySettings.light") : t("settings.displaySettings.dark") })} value={code[`${mode}Theme`]} onValueChange={selectedValue => setCodePreferences({
          [`${mode}Theme`]: selectedValue as CodePreviewTheme,
        })}>
      {CODE_PREVIEW_THEME_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SettingsSelect>
  );
  // Palette editing is independent of the active application appearance.
  const activeMode = theme === "data-dense" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  const [mode, setMode] = useState<"light" | "dark">(activeMode);
  const palette = prefs[mode];
  const label = mode === "light" ? t("settings.displaySettings.light") : t("settings.displaySettings.dark");
  const update = (patch: Partial<Palette>) => setApplicationPreferences({ [mode]: { ...palette, ...patch } });
  return (
    <div className="settings-sections">
      <SettingsSection title={t("settings.displaySettings.interface")}>
        <SettingsGroupCard>
          <SettingsRow label={t("settings.displaySettings.interfaceTheme")} control={
            <SettingsSelect aria-label={t("settings.displaySettings.interfaceTheme")} value={theme} onValueChange={value => {
              setTheme(value); if (value !== "system") setMode(value === "data-dense" ? "dark" : "light");
            }}>
              <option value="system">{t("settings.displaySettings.system")}</option><option value="soft-glass">{t("settings.displaySettings.light")}</option><option value="data-dense">{t("settings.displaySettings.dark")}</option>
            </SettingsSelect>
          } />
          <SettingsRow label={t("settings.displaySettings.interfaceFont")} control={fontSelect(activeMode, "uiFont", t("settings.displaySettings.interfaceFont"))} />
          <SettingsRow label={t("settings.displaySettings.interfaceFontSize")} description={t("settings.displaySettings.setTheBaseFontSizeForNavigation")} control={sizeInput(t("settings.displaySettings.interfaceFontSize"), fontSize, 12, 18, setFontSize)} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title={t("settings.displaySettings.reading")}>
        <SettingsGroupCard>
          <SettingsRow label={t("settings.displaySettings.contentFontSize")} description={t("settings.displaySettings.setTheBaseFontSizeForBody")} control={sizeInput(t("settings.displaySettings.contentFontSize2"), prefs.contentSize, 12, 24, n => setApplicationPreferences({ contentSize: n }))} />
          <p className="appearance-reading-preview">{t("settings.displaySettings.readingPreview")}</p>
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title={t("settings.displaySettings.interactionAndMotion")}>
        <SettingsGroupCard>
          <SettingsRow label={t("settings.displaySettings.reduceMotion")} description={t("settings.displaySettings.reduceAnimationOrFollowSystemPreferences")} control={
            <SettingsSelect aria-label={t("settings.displaySettings.reduceMotion")} value={prefs.reducedMotion}
              onValueChange={reducedMotion => setApplicationPreferences({ reducedMotion: reducedMotion as "system" | "on" | "off" })}>
              <option value="system">{t("settings.displaySettings.system")}</option><option value="on">{t("settings.displaySettings.on")}</option><option value="off">{t("settings.displaySettings.off")}</option>
            </SettingsSelect>
          } />
          <SettingsRow label={t("settings.displaySettings.usePointerCursor")} description={t("settings.displaySettings.showAPointerCursorWhenHoveringOver")} control={<SettingsSwitch aria-label={t("settings.displaySettings.usePointerCursor")} checked={prefs.pointerCursor} onCheckedChange={pointerCursor => setApplicationPreferences({ pointerCursor })} />} />
          <SettingsRow label={t("settings.displaySettings.fontSmoothing")} description={t("settings.displaySettings.useNativeMacOSFontAntialiasing")} control={<SettingsSwitch aria-label={t("settings.displaySettings.fontSmoothing")} checked={prefs.fontSmoothing} onCheckedChange={fontSmoothing => setApplicationPreferences({ fontSmoothing })} />} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection>
        <SettingsDisclosure title={t("settings.displaySettings.readingAndCode")}>
          <div className="appearance-theme-content">
            <SettingsGroupCard>
              <SettingsRow label={t("settings.displaySettings.contentFont")} control={fontSelect(activeMode, "contentFont", t("settings.displaySettings.contentFont"))} />
              <SettingsRow label={t("settings.displaySettings.codeFont")} control={fontSelect(activeMode, "codeFont", t("settings.displaySettings.codeFont"))} />
              <SettingsRow label={t("settings.displaySettings.codeFontSize")} description={t("settings.displaySettings.codeFontSizeInChatAndDiff")} control={sizeInput(t("settings.displaySettings.codeFontSize2"), code.fontSizePx, 10, 24, n => setCodePreferences({ fontSizePx: n }))} />
              <SettingsRow label={t("settings.displaySettings.showLineNumbers")} control={<SettingsSwitch aria-label={t("settings.displaySettings.showLineNumbers")} checked={code.showLineNumbers} onCheckedChange={showLineNumbers => setCodePreferences({ showLineNumbers })} />} />
              <SettingsRow label={t("settings.displaySettings.wrapLongLines")} description={t("settings.displaySettings.softWrapCodeLinesThatExceedThe")} control={<SettingsSwitch aria-label={t("settings.displaySettings.wrapLongLines")} checked={code.wrapLongLines} onCheckedChange={wrapLongLines => setCodePreferences({ wrapLongLines })} />} />
              <SettingsRow label={t("settings.displaySettings.diffMarkers")} description={t("settings.displaySettings.showChangesWithColorsOrMarkers")} control={
                <SettingsSegmentedTabs ariaLabel={t("settings.displaySettings.diffMarkers")} value={prefs.diffMarkers} items={[{ label: t("settings.displaySettings.color"), value: "color" }, { label: "+/-", value: "signs" }]}
                  onValueChange={diffMarkers => setApplicationPreferences({ diffMarkers })} />
              } />
            </SettingsGroupCard>
            <ThemeDiffPreview />
          </div>
        </SettingsDisclosure>
      </SettingsSection>
      <SettingsSection>
        <SettingsDisclosure title={t("settings.displaySettings.customizeColors")}>
          <div className="appearance-theme-content">
            <div className="settings-section-action">
              <SettingsSegmentedTabs ariaLabel={t("settings.displaySettings.editColors")} value={mode} onValueChange={setMode}
                items={[{ label: t("settings.displaySettings.lightColors"), value: "light" }, { label: t("settings.displaySettings.darkColors"), value: "dark" }]} />
              <ThemeSharing mode={mode} />
              <ActionButton aria-label={t("settings.displaySettings.restoreValueDefaults", { value0: label })} onClick={() => setApplicationPreferences({ [mode]: DEFAULT_PALETTES[mode] })}>{t("settings.displaySettings.resetValueColors", { value0: label })}</ActionButton>
            </div>
            <SettingsGroupCard density="compact">
              <SettingsRow label={t("settings.displaySettings.codeTheme")} control={<div className="appearance-theme-tools"><CodeThemeSample theme={code[`${mode}Theme`]} />{codeTheme(mode)}</div>} />
              <SettingsRow label={t("settings.displaySettings.interfaceFont")} control={fontSelect(mode, "uiFont", t("settings.displaySettings.valueInterfaceFont", { value0: label }))} />
              <SettingsRow label={t("settings.displaySettings.contentFont")} control={fontSelect(mode, "contentFont", t("settings.displaySettings.valueContentFont", { value0: label }))} />
              <SettingsRow label={t("settings.displaySettings.codeFont")} control={fontSelect(mode, "codeFont", t("settings.displaySettings.valueCodeFont", { value0: label }))} />
              <SettingsRow label={t("settings.displaySettings.accent")} control={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <ColorField label={t("settings.displaySettings.valueAccentColor", { value0: label })} value={palette.accent} onChange={accent => update({ accent })} />
                  <ActionButton disabled={palette.accent.toLowerCase() === DEFAULT_PALETTES[mode].accent} onClick={() => update({ accent: DEFAULT_PALETTES[mode].accent })}>{t("settings.displaySettings.reset")}</ActionButton>
                </div>
              } />
              <SettingsRow label={t("settings.displaySettings.background")} control={<ColorField label={t("settings.displaySettings.valueBackgroundColor", { value0: label })} value={palette.background} onChange={background => update({ background })} />} />
              <SettingsRow label={t("settings.displaySettings.foreground")} control={<ColorField label={t("settings.displaySettings.valueForegroundColor", { value0: label })} value={palette.foreground} onChange={foreground => update({ foreground })} />} />
              <SettingsRow label={t("settings.displaySettings.translucentSidebar")} control={<SettingsSwitch aria-label={t("settings.displaySettings.valueTranslucentSidebar", { value0: label })} checked={palette.translucentSidebar} onCheckedChange={translucentSidebar => update({ translucentSidebar })} />} />
              <SettingsRow label={t("settings.displaySettings.contrast")} control={
                <div className="flex items-center gap-3"><input aria-label={t("settings.displaySettings.valueContrast", { value0: label })} type="range" min="0" max="100" value={palette.contrast} onChange={e => update({ contrast: Number(e.target.value) })} /><output>{palette.contrast}</output></div>
              } />
            </SettingsGroupCard>
          </div>
        </SettingsDisclosure>
      </SettingsSection>
    </div>
  );
}
