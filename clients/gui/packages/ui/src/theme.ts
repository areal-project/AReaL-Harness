export type Palette = { background: string; foreground: string; accent: string; contrast: number; translucentSidebar: boolean };

export function readableForeground(background: string): "#000000" | "#ffffff" {
  const rgb = background
    .slice(1)
    .match(/../g)!
    .map((n) => parseInt(n, 16));
  // WCAG relative luminance: choose readable text for both default themes
  // and custom colors used for neutral primary and send controls.
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    ? "#000000" : "#ffffff";
}

export function paletteVariables(p: Palette, dark = false): Record<string, string> {
  const mix = (percent: number) =>
    `color-mix(in srgb, ${p.foreground} ${percent}%, ${p.background})`;
  const ink = (percent: number) =>
    `color-mix(in srgb, ${p.foreground} ${percent}%, transparent)`;
  const contrastDelta = p.contrast - (dark ? 60 : 45);
  const fileReference = p.accent === "#3a83f7" ? "#2c67c5" : p.accent;
  return {
    "--color-background": p.background,
    "--color-foreground": p.foreground,
    "--color-brand": p.accent,
    "--color-file-reference": dark ? `color-mix(in srgb, ${fileReference} 80%, ${p.foreground})` : fileReference,
    // Completed process metadata keeps the observed dark hierarchy; on light
    // surfaces it uses the existing readable secondary-text contrast role.
    "--color-process-settled": dark ? ink(50 + contrastDelta * 0.15) : mix(69.5 + contrastDelta * 0.15),
    // Completed file results have their own raised surface and half-pixel
    // stroke; the generic transparent surface remains for other controls.
    "--color-result-card": dark ? `color-mix(in srgb, ${mix(2100 / 231)} 50%, transparent)` : ink(3 + contrastDelta * 0.03),
    "--shadow-result-card": `0 0 0 .5px ${ink((dark ? 15.6 : 8) + contrastDelta * 0.08)}`,
    "--color-result-icon": dark ? `color-mix(in srgb, ${p.background} 83.333333%, #000000)` : p.background,
    "--color-history-comment": dark ? mix(2100 / 231) : p.background,
    // Compact viewer source/actions share the observed elevated control surface.
    "--color-viewer-control": dark ? mix(2100 / 231) : ink(3),
    "--color-history-comment-hover": dark ? `color-mix(in srgb, ${mix(3000 / 231)} 96%, transparent)` : p.background,
    "--color-primary": p.foreground,
    "--color-primary-foreground": dark && p.foreground === "#ffffff" ? "#2d2d2d" : readableForeground(p.foreground),
    "--color-composer-action": "var(--color-primary)",
    "--color-composer-action-foreground": "var(--color-primary-foreground)",
    "--color-accent": mix(6),
    "--color-secondary": ink(5),
    // Captured Codex user-message roles; custom themes retain their own palette.
    "--color-user-message": p.background === (dark ? "#181818" : "#ffffff") ? (dark ? "#173e76" : "#e8f3fe") : mix(6),
    "--color-user-message-text": p.background === (dark ? "#181818" : "#ffffff") ? (dark ? "#f6fafe" : "#0c274a") : p.foreground,
    "--color-background-win-alt": mix(4),
    // The current reference paints titlebar/rail outside a shared page surface.
    // Accepted dark design: solid #242424 chrome and #1e1e1e navigation,
    // derived from the active palette so custom colors remain supported.
    "--color-shell": dark
      ? mix(1200 / 231)
      : mix(4),
    "--color-navigation-background": dark
      ? mix(600 / 231)
      : p.translucentSidebar ? `color-mix(in oklab, ${p.background} 70%, transparent)` : p.background,
    "--color-navigation-selected": dark ? mix(2400 / 231) : ink(5.5 + contrastDelta * 0.04),
    "--shadow-page-surface": `0 0 0 .5px ${ink(dark ? 6 : 8)}, 0 4px 16px #0000000d`,
    // Settings uses its own saved-reference sidebar material; native version differences remain explicit.
    "--color-sidebar": dark
      ? (p.background === "#181818"
          ? `rgb(40 40 40 / ${p.translucentSidebar ? 0.7 : 1})`
          : p.translucentSidebar ? `color-mix(in srgb, ${mix(3800 / 231)} 70%, transparent)` : mix(3800 / 231))
      : p.translucentSidebar ? `color-mix(in srgb, ${p.background} 70%, transparent)` : p.background,
    // Row rest stays transparent; hover/current use the same foreground layer.
    "--color-sidebar-item": dark && p.background === "#181818"
      ? "rgba(255, 255, 255, 0.08)"
      : ink(5.5 + contrastDelta * 0.04),
    "--color-composer": `color-mix(in srgb, ${dark ? mix(3000 / 231) : p.background} ${dark ? 96 : 86.4706}%, transparent)`,
    "--shadow-composer": dark
      ? (p.background === "#181818" && p.foreground === "#ffffff"
          ? "var(--composer-shadow-dark)"
          : `inset 0 0 1px 0 ${ink(20)}`)
      : "var(--composer-shadow-light)",
    "--color-background-alt": mix(3),
    "--color-card": p.background,
    // Settings groups have a separate raised surface (default dark #232323).
    "--color-settings-card": dark ? mix(1100 / 231) : p.background,
    "--color-header": p.background,
    "--color-panel": p.background,
    "--color-popover": p.background,
    // Codex dropdown surface: light white / dark #2d2d2d at 90%, blur 8px.
    "--color-menu": `color-mix(in srgb, ${dark ? mix(2100 / 231) : p.background} 90%, transparent)`,
    "--color-menu-border": ink((dark ? 8.2 : 8) + contrastDelta * 0.08),
    "--color-menu-hover": ink(5.5),
    "--color-composer-catalog": dark ? mix(2000 / 231) : p.background,
    "--color-input": p.background,
    "--color-input-focused": p.background,
    "--color-input-border": "var(--color-border)",
    "--color-input-border-hover": "var(--color-border-hover)",
    "--color-foreground-subtle": mix(69.5 + contrastDelta * 0.15),
    "--color-foreground-subtlest": mix(49.5 + contrastDelta * 0.15),
    // Active settings explanations follow the observed dark 65% layer.
    // Preserve the existing contrast slope and stronger light role; disabled
    // controls and settled process metadata keep their separate owners.
    "--color-settings-secondary": dark ? ink(65 + contrastDelta * 0.15) : mix(69.5 + contrastDelta * 0.15),
    "--color-border": ink((dark ? 8.4 : 7.8) + contrastDelta * 0.08),
    "--color-border-hover": ink(11.7 + contrastDelta * 0.1),
    "--color-hover": ink(5.5 + contrastDelta * 0.04),
    "--color-selected": ink(5.5 + contrastDelta * 0.04),
    "--color-surface": ink(3 + contrastDelta * 0.03),
    "--color-surface-hover": ink(5.5 + contrastDelta * 0.04),
    "--color-input-border-focused": p.accent,
  };
}
