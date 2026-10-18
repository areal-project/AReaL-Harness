'use strict';

/**
 * Themes — one mapping, many palettes.
 *
 * A theme here is *data*: nine or so colours, in the shape every editor colour
 * scheme already publishes. Everything visual is derived from that by the one
 * function below, which writes the engine's design tokens and the panel's.
 *
 * That is the whole point of the design. If each theme were a stylesheet, then
 * adding one would mean writing CSS against the engine's markup — whose class
 * names are content hashed and change on every engine release — and users could
 * never contribute one. As data, a theme is a file anyone can drop into their
 * themes directory, and the fragile part (which token means what) exists once.
 *
 * The palettes shipped in palettes.json are ports of well-known open-source
 * schemes, all MIT licensed, each carrying its author and source.
 */

const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const BUILTIN_PATH = join(__dirname, 'palettes.json');
const CONTROLS_CSS = readFileSync(join(__dirname, 'controls.css'), 'utf8');

/** Colour keys every palette must define; a theme missing one is rejected. */
const REQUIRED = [
  'bg', 'bgAlt', 'bgRaised', 'bgOverlay',
  'text', 'textMuted', 'textFaint',
  'border', 'accent', 'accentText',
  'green', 'red', 'yellow', 'purple', 'cyan',
];

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Optional style beyond colour. A palette alone cannot express a look — the
 * difference between a soft rounded theme and a hard-edged neon one is radius,
 * border weight and shadow, not hue. These are constrained to numbers and a
 * font list rather than free CSS, because a theme file is user-supplied and its
 * values are written into a stylesheet.
 */
const STYLE_LIMITS = {
  radius: { min: 0, max: 24, fallback: 8 },
  borderWidth: { min: 0, max: 4, fallback: 1 },
  shadowOffset: { min: 0, max: 12, fallback: 0 },
  fontScale: { min: 0.85, max: 1.25, fallback: 1 },
};

// A font stack from a theme file is quoted into CSS, so keep it to characters
// that cannot end a declaration or open a url() — no semicolons, braces, or
// parentheses.
const FONT_SAFE = /^[A-Za-z0-9 ,'"一-龥_-]{0,160}$/;

/**
 * Soft background washes, for themes whose look is a lit surface rather than a
 * flat one — without that, a "glass" theme is just a light grey theme.
 *
 * Structured on purpose. The obvious design is a CSS gradient string in the
 * theme file, and that would hand a downloadable file a way to write arbitrary
 * CSS: a gradient is full of parentheses and commas, which is exactly what the
 * rest of this file refuses to let through. So a theme declares *where* and
 * *what colour*, and the gradient is composed here from clamped numbers and a
 * validated hex.
 */
const MAX_GLOWS = 3;

function glowsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return raw
    .filter((g) => g && typeof g === 'object' && HEX.test(String(g.color ?? '')))
    .slice(0, MAX_GLOWS)
    .map((g) => ({
      color: String(g.color),
      x: clamp(g.x, -50, 150, 50),
      y: clamp(g.y, -50, 150, 50),
      size: clamp(g.size, 10, 200, 70),
      alpha: clamp(g.alpha, 0, 1, 0.5),
    }));
}

function styleOf(theme) {
  const raw = (theme && theme.style) || {};
  const out = {};
  out.glows = glowsOf(raw.glows);
  for (const [key, limit] of Object.entries(STYLE_LIMITS)) {
    const value = Number(raw[key]);
    out[key] = Number.isFinite(value)
      ? Math.min(limit.max, Math.max(limit.min, value))
      : limit.fallback;
  }
  out.fontUi = FONT_SAFE.test(String(raw.fontUi ?? '')) && raw.fontUi ? String(raw.fontUi) : '';
  out.fontMono = FONT_SAFE.test(String(raw.fontMono ?? '')) && raw.fontMono ? String(raw.fontMono) : '';
  out.uppercase = raw.uppercase === true;
  return out;
}

/**
 * Check a theme before it is ever applied. A user-supplied file is untrusted
 * input: a bad colour would land inside a stylesheet, so every value has to be
 * a plain hex colour and nothing else.
 */
function validate(theme) {
  if (!theme || typeof theme !== 'object') return 'not an object';
  if (typeof theme.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(theme.id)) {
    return 'id must be lowercase letters, digits and dashes';
  }
  if (typeof theme.name !== 'string' || !theme.name.trim()) return 'missing name';
  const colors = theme.colors;
  if (!colors || typeof colors !== 'object') return 'missing colors';
  for (const key of REQUIRED) {
    if (!HEX.test(String(colors[key] ?? ''))) return `colors.${key} must be a #rrggbb value`;
  }
  return null;
}

/** Built-in palettes, plus anything valid the user has dropped in. */
function loadThemes(userDir) {
  const themes = [];
  const seen = new Set();
  const add = (theme, origin) => {
    const bad = validate(theme);
    if (bad) {
      console.warn(`[dsh-gui] ignoring theme from ${origin}: ${bad}`);
      return;
    }
    if (seen.has(theme.id)) {
      console.warn(`[dsh-gui] ignoring duplicate theme id "${theme.id}" from ${origin}`);
      return;
    }
    seen.add(theme.id);
    themes.push({ ...theme, custom: origin !== 'built-in' });
  };

  try {
    for (const theme of JSON.parse(readFileSync(BUILTIN_PATH, 'utf8')).themes) add(theme, 'built-in');
  } catch (err) {
    console.warn(`[dsh-gui] built-in themes unreadable: ${err.message}`);
  }

  // A user theme is just a .json file in the themes directory — no install
  // step, no restart beyond a reload of the list.
  if (userDir && existsSync(userDir)) {
    for (const file of readdirSync(userDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        add(JSON.parse(readFileSync(join(userDir, file), 'utf8')), file);
      } catch (err) {
        console.warn(`[dsh-gui] ignoring theme file ${file}: ${err.message}`);
      }
    }
  }
  return themes;
}

/** #rrggbb → "r, g, b", for building rgba() values. */
function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
}

/** Blend two hex colours, for the shades a palette does not name. */
function mix(a, b, weight) {
  const parts = [1, 3, 5].map((i) => {
    const left = parseInt(a.slice(i, i + 2), 16);
    const right = parseInt(b.slice(i, i + 2), 16);
    return Math.round(left + (right - left) * weight);
  });
  return `#${parts.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The single place that knows which engine token means what.
 *
 * Written for both selectors: the engine sets its dark tokens on
 * `body[data-ds-dark-theme]`, so a bare `body` rule alone loses to it.
 */
function engineCss(theme) {
  const c = theme.colors;
  const sel = 'body, body[data-ds-dark-theme]';
  const lines = [
    // Marker: lets a caller tell "the sheet is applied" apart from "the sheet
    // is applied but something else wins", which are very different bugs.
    `--dsh-gui-theme: "${theme.id}"`,
    `--dsw-alias-bg-base: ${c.bg}`,
    `--dsw-alias-bg-layer-1: ${c.bgAlt}`,
    `--dsw-alias-bg-layer-2: ${c.bgRaised}`,
    `--dsw-alias-bg-overlay: ${c.bgOverlay}`,
    `--dsw-alias-bg-module-platform: ${c.bgAlt}`,
    `--dsw-alias-bg-multi-select: ${c.bgRaised}`,
    `--dsw-alias-bg-skeleton: ${mix(c.bg, c.text, 0.08)}`,
    `--dsw-alias-bg-mask-1: rgba(${rgb(c.bg)}, 0.72)`,
    // Kept, but note: no `--dsw-alias-text-*` exists in the current engine
    // build — these four override nothing. Text lives under `label-*` below.
    // They stay in case an older build reads them; they cost nothing and
    // removing them would be guessing in the other direction.
    `--dsw-alias-text-1: ${c.text}`,
    `--dsw-alias-text-2: ${c.textMuted}`,
    `--dsw-alias-text-3: ${c.textFaint}`,
    `--dsw-alias-text-4: ${mix(c.textFaint, c.bg, 0.35)}`,

    // ── labels: the engine's actual text colours ──────────────────────────
    `--dsw-alias-label-primary: ${c.text}`,
    `--dsw-alias-label-primary-bluish: ${c.text}`,
    `--dsw-alias-label-secondary: ${c.textMuted}`,
    `--dsw-alias-label-tertiary: ${c.textFaint}`,
    `--dsw-alias-label-caption: ${c.textFaint}`,
    `--dsw-alias-label-dimmed: ${mix(c.textFaint, c.bg, 0.35)}`,
    // The colour used *on* a light surface, so it has to follow the
    // background, not the text. Left unmapped, a light theme gets a white
    // label on a white button.
    `--dsw-alias-label-primary-foreground: ${c.bg}`,
    `--dsw-alias-label-primary-inverted: ${c.bgOverlay}`,

    // ── surfaces the engine names specifically ────────────────────────────
    // Never mapped before. Every one of these stayed at its dark default, which
    // no dark theme revealed — the sidebar and the composer simply looked
    // right by accident. On a light theme they are black holes in the layout.
    // The mapping is not guesswork: the engine's own dark values line up
    // exactly with the layers of the palette this app was built from
    // (#1b1b1c = bgAlt, #2c2c2e = bgRaised, #353638 = bgOverlay).
    `--dsw-specific-sidebar-fill: ${c.bgAlt}`,
    `--dsw-specific-sidebar-nav-item-hover: ${c.bgRaised}`,
    `--dsw-specific-sidebar-nav-item-active: ${mix(c.bgOverlay, c.text, 0.12)}`,
    `--dsw-specific-sidebar-nav-item-active-accent: ${c.bgOverlay}`,
    `--dsw-specific-bubble: ${c.bgOverlay}`,
    `--dsw-specific-bubble-highlight: ${mix(c.bgOverlay, c.text, 0.12)}`,
    `--dsw-specific-input-major: ${c.bgRaised}`,
    `--dsw-specific-login-input: ${c.bgAlt}`,
    `--dsw-specific-menu: ${c.bgOverlay}`,
    `--dsw-specific-selector: ${c.bgOverlay}`,
    `--dsw-specific-tip: ${c.bgOverlay}`,

    `--dsw-alias-bg-layer-3: ${c.bgOverlay}`,
    `--dsw-alias-border-l1: ${c.border}`,
    `--dsw-alias-border-l2: ${mix(c.border, c.bg, 0.4)}`,
    // These are white-at-low-alpha by default, which is a hairline on a dark
    // surface and nothing at all on a light one. Derive them from the text
    // colour so they are always a hairline against the background they sit on.
    `--dsw-alias-border-l3: rgba(${rgb(c.text)}, 0.16)`,
    `--dsw-alias-border-l4: rgba(${rgb(c.text)}, 0.2)`,
    `--dsw-alias-border-l2-darkmode-thin: rgba(${rgb(c.text)}, 0.06)`,
    `--dsw-alias-border-inverted: rgba(${rgb(c.text)}, 0.06)`,
    `--dsw-alias-border-inverted2: rgba(${rgb(c.text)}, 0.08)`,
    `--dsw-alias-interactive-bg-hover: rgba(${rgb(c.text)}, 0.08)`,
    `--dsw-alias-interactive-bg-active: rgba(${rgb(c.text)}, 0.14)`,
    `--dsw-alias-interactive-bg-hover-accent: rgba(${rgb(c.text)}, 0.24)`,
    `--dsw-alias-interactive-bg-hover-solid: ${c.bgOverlay}`,
    `--dsw-alias-interactive-bg-hover-danger: rgba(${rgb(c.red)}, 0.15)`,

    // ── buttons ───────────────────────────────────────────────────────────
    // contrast-fill and primary-hover both default to the palette's own text
    // colour; on a light theme, leaving them made white-on-white buttons.
    `--dsw-alias-button-contrast-fill: ${c.text}`,
    `--dsw-alias-button-primary-fill: ${c.accent}`,
    `--dsw-alias-button-primary-hover: ${mix(c.accent, c.text, 0.2)}`,
    `--dsw-alias-button-primary-dimmed: ${mix(c.accent, c.bg, 0.6)}`,
    `--dsw-alias-button-ghost-active-fill: ${mix(c.bgOverlay, c.text, 0.12)}`,
    `--dsw-alias-button-ghost-active-hover: ${mix(c.bgOverlay, c.text, 0.28)}`,
    `--dsw-alias-button-ghost-active-border: ${c.textFaint}`,
    `--dsw-alias-button-info-fill: ${c.accent}`,
    `--dsw-alias-button-info-hover: ${mix(c.accent, c.text, 0.2)}`,
    `--dsw-alias-button-tool-bar-fill: rgba(${rgb(mix(c.bgOverlay, c.text, 0.3))}, 0.5)`,
    `--dsw-alias-button-tool-bar-hover: rgba(${rgb(mix(c.bgOverlay, c.text, 0.3))}, 0.6)`,
    `--dsw-alias-button-tool-bar-fill-invisible: rgba(${rgb(c.bg)}, 0.36)`,

    // ── markdown surfaces ─────────────────────────────────────────────────
    `--dsw-alias-markdown-code-block-banner: ${c.bgRaised}`,
    `--dsw-alias-markdown-code-segment-selected: ${c.bgOverlay}`,
    `--dsw-alias-markdown-code-segment-unselected: ${c.bgAlt}`,
    `--dsw-alias-markdown-inline-code: ${c.bgRaised}`,
    `--dsw-alias-markdown-placeholder: ${c.bgRaised}`,
    `--dsw-alias-markdown-tag: ${c.bgRaised}`,
    `--dsw-alias-markdown-citation: ${c.bgOverlay}`,

    // ── scrollbars and states ─────────────────────────────────────────────
    `--dsw-alias-scrollbar-bg-l1: ${mix(c.bgOverlay, c.text, 0.1)}`,
    `--dsw-alias-scrollbar-bg-l2: ${mix(c.bgOverlay, c.text, 0.3)}`,
    `--dsw-alias-scrollbar-hover-l1: ${mix(c.bgOverlay, c.text, 0.3)}`,
    `--dsw-alias-scrollbar-hover-l2: ${mix(c.bgOverlay, c.text, 0.45)}`,
    `--dsw-alias-state-error-primary: ${c.red}`,
    `--dsw-alias-state-error-secondary: ${c.red}`,
    `--dsw-alias-state-business-primary: ${c.accent}`,
    `--dsw-alias-state-business-tertiary: ${mix(c.accent, c.bg, 0.7)}`,
    `--dsw-alias-brand-primary: ${c.accent}`,
    // The engine really does define a token by this name; it looks like a
    // build accident on their side, but overriding only the tidy one leaves
    // brand-coloured surfaces on the original palette.
    `--dsw-alias-brand-primary-new-colorprimary-new-color: ${c.accent}`,
    `--dsw-alias-brand-primary-invert: ${c.accentText}`,
    `--dsw-alias-brand-text: ${c.accent}`,
    `--dsw-alias-button-elevated-fill: ${c.bgRaised}`,
    `--dsw-alias-button-floating-fill: ${c.bgRaised}`,
    `--dsw-alias-button-floating-hover: ${c.bgOverlay}`,
    `--dsw-alias-markdown-code-block: ${c.bgAlt}`,
    `--dsw-alias-success: ${c.green}`,
    `--dsw-alias-error: ${c.red}`,
    `--dsw-alias-warning: ${c.yellow}`,
  ];
  // !important on every declaration, and it is not paranoia: the engine writes
  // its own theme stylesheet after the page hydrates, so it lands later in the
  // cascade than anything injected at did-finish-load and wins ties on order.
  // Measured — an earlier version without this applied cleanly (a marker
  // property did change) while every contested token kept the engine's value.
  const fontUi = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  for (const [name, size, height] of [['xxxs-11', 11, 16], ['xxs-12', 12, 18], ['xs-13', 13, 20], ['s-13', 13, 20], ['s-14', 14, 22], ['m-16', 14, 22]]) {
    lines.push(`--dsw-font-${name}: 400 ${size}px/${height}px ${fontUi}`);
    lines.push(`--dsw-font-${name.replace(/-(\d+)$/, '-strong-$1')}: 600 ${size}px/${height}px ${fontUi}`);
  }
  let css = `${sel} {\n  ${lines.map((l) => `${l} !important`).join(';\n  ')};\n}\n${CONTROLS_CSS}\n`;
  css += `.areal-code-token { color: var(--token-${theme.dark === false ? 'light' : 'dark'}) !important; }\n`;
  // The wash, if the theme has one. Kept out of the token block above because
  // it is a paint on the surface, not a token the engine's components read —
  // and without it a light theme is a grey rectangle in the main view while the
  // panel beside it is lit, which reads as two different apps.
  const image = bgImage(styleOf(theme));
  if (image !== 'none') {
    css += `${sel} {\n  background-image: ${image} !important;\n` +
           `  background-attachment: fixed !important;\n}\n`;
  }
  return css;
}

/** Compose the washes into one background-image value, or `none`. */
function bgImage(style) {
  if (!style.glows.length) return 'none';
  return style.glows
    .map((g) =>
      `radial-gradient(${g.size}% ${g.size}% at ${g.x}% ${g.y}%, ` +
      `rgba(${rgb(g.color)}, ${g.alpha}), rgba(${rgb(g.color)}, 0) 70%)`,
    )
    .join(', ');
}

function panelCss(theme) {
  const c = theme.colors;
  const s = styleOf(theme);
  const lines = [
    `--radius: 8px`,
    `--radius-sm: 6px`,
    `--areal-hover-radius: 12px`,
    `--border-width: ${s.borderWidth}px`,
    // A hard offset shadow is what makes a neo-brutalist theme read as one;
    // at 0 it simply disappears rather than needing a second code path.
    `--shadow-hard: ${s.shadowOffset}px ${s.shadowOffset}px 0 ${c.accent}`,
    `--font-scale: ${s.fontScale}`,
    // `none` rather than omitting it: an undefined var() invalidates the whole
    // declaration, so a theme without glows would erase the background colour
    // of anything that layers an image over it.
    `--bg-image: ${bgImage(s)}`,
    `--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif`,
    `--mono: "SF Mono", ui-monospace, Menlo, Consolas, "PingFang SC", monospace`,
    `--bg: ${c.bg}`,
    `--bg-2: ${c.bgAlt}`,
    `--bg-3: ${c.bgRaised}`,
    `--bg-hover: ${c.bgOverlay}`,
    `--border: rgba(${rgb(c.text)}, 0.07)`,
    `--border-strong: rgba(${rgb(c.text)}, 0.13)`,
    `--text: ${c.text}`,
    `--text-mid: ${c.textMuted}`,
    `--text-dim: ${c.textFaint}`,
    `--accent: ${c.accent}`,
    `--green: ${c.green}`,
    `--red: ${c.red}`,
    `--yellow: ${c.yellow}`,
    `--purple: ${c.purple}`,
    `--add-bg: rgba(${rgb(c.green)}, 0.12)`,
    `--rem-bg: rgba(${rgb(c.red)}, 0.12)`,
  ];
  let css = `:root {\n  ${lines.join(';\n  ')};\n}\n`;
  css += `body { font-family: var(--font-ui); }\n* { letter-spacing: 0; }\nbutton, input, select, textarea { font-family: var(--font-ui); font-size: 13px; }\n`;
  return css;
}

/** Terminal colours, so xterm follows the theme rather than staying fixed. */
function terminalTheme(theme) {
  const c = theme.colors;
  return {
    background: c.bg,
    foreground: c.text,
    cursor: c.accent,
    cursorAccent: c.bg,
    selectionBackground: `rgba(${rgb(c.accent)}, 0.32)`,
    black: c.bgRaised,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.accent,
    magenta: c.purple,
    cyan: c.cyan,
    white: c.text,
    brightBlack: c.textFaint,
    brightRed: mix(c.red, '#ffffff', 0.25),
    brightGreen: mix(c.green, '#ffffff', 0.25),
    brightYellow: mix(c.yellow, '#ffffff', 0.25),
    brightBlue: mix(c.accent, '#ffffff', 0.25),
    brightMagenta: mix(c.purple, '#ffffff', 0.25),
    brightCyan: mix(c.cyan, '#ffffff', 0.25),
    brightWhite: '#ffffff',
  };
}

module.exports = { loadThemes, validate, engineCss, panelCss, terminalTheme, REQUIRED };
