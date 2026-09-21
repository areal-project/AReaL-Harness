use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use ratatui::style::{Color, Modifier, Style};
use std::{io::Write, path::PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum Theme {
    #[default]
    Dark,
    Light,
    Terminal,
}
impl Theme {
    pub const ALL: [Self; 3] = [Self::Dark, Self::Light, Self::Terminal];
    pub fn name(self) -> &'static str {
        match self {
            Self::Dark => "Milk Tea Dark",
            Self::Light => "Milk Tea Light",
            Self::Terminal => "Terminal",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
            Self::Terminal => "terminal",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum ColorMode {
    #[default]
    Auto,
    Always,
    Never,
}
impl ColorMode {
    pub fn key(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Always => "always",
            Self::Never => "never",
        }
    }
}

#[derive(Args, Default, Debug)]
pub struct UiArgs {
    /// 客户端主题，不改变 Core 配置。
    #[arg(long, env = "AREAL_TUI_THEME", value_enum)]
    pub theme: Option<Theme>,
    #[arg(long, env = "AREAL_TUI_COLOR", value_enum)]
    pub color: Option<ColorMode>,
    #[arg(long, env = "AREAL_TUI_CONFIG")]
    pub tui_config: Option<PathBuf>,
    #[arg(long, env = "AREAL_TUI_NO_LOGO", num_args = 0..=1, default_missing_value = "true", require_equals = true)]
    pub no_logo: Option<bool>,
    #[arg(long, env = "AREAL_TUI_ASCII", num_args = 0..=1, default_missing_value = "true", require_equals = true)]
    pub ascii: Option<bool>,
}

#[derive(Debug)]
pub struct Preferences {
    pub theme: Theme,
    pub color: ColorMode,
    pub no_logo: bool,
    pub ascii: bool,
    pub path: Option<PathBuf>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: Theme::Dark,
            color: ColorMode::Auto,
            no_logo: false,
            ascii: false,
            path: None,
        }
    }
}
impl Preferences {
    pub fn load(args: &UiArgs) -> Result<Self> {
        let path = args.tui_config.clone().or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME")
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
                .map(|p| p.join("areal-harness/tui.toml"))
        });
        let mut prefs = Self {
            path: path.clone(),
            ..Self::default()
        };
        if let Some(path) = path {
            match std::fs::read_to_string(&path) {
                Ok(text) => prefs
                    .parse(&text)
                    .with_context(|| format!("invalid TUI preferences: {}", path.display()))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && args.tui_config.is_none() => {
                }
                Err(e) => {
                    return Err(e)
                        .with_context(|| format!("read TUI preferences: {}", path.display()));
                }
            }
        }
        if let Some(theme) = args.theme {
            prefs.theme = theme;
        }
        if let Some(color) = args.color {
            prefs.color = color;
        }
        if let Some(value) = args.no_logo {
            prefs.no_logo = value;
        }
        if let Some(value) = args.ascii {
            prefs.ascii = value;
        }
        Ok(prefs)
    }
    fn parse(&mut self, text: &str) -> Result<()> {
        let doc = toml_edit::Document::parse(text)?;
        for (key, value) in doc.iter() {
            match key {
                "theme" => {
                    self.theme =
                        Theme::from_str(value.as_str().context("theme must be a string")?, false)
                            .map_err(anyhow::Error::msg)?
                }
                "color" => {
                    self.color = ColorMode::from_str(
                        value.as_str().context("color must be a string")?,
                        false,
                    )
                    .map_err(anyhow::Error::msg)?
                }
                "no_logo" => self.no_logo = value.as_bool().context("no_logo must be a boolean")?,
                "ascii" => self.ascii = value.as_bool().context("ascii must be a boolean")?,
                _ => bail!("unknown TUI preference: {key}"),
            }
        }
        Ok(())
    }
    pub fn save(&self) -> Result<()> {
        let path = self
            .path
            .as_ref()
            .context("no client config directory available")?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(std::path::Path::new("."));
        std::fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        write!(
            file,
            "theme = {:?}\ncolor = {:?}\nno_logo = {}\nascii = {}\n",
            self.theme.key(),
            self.color.key(),
            self.no_logo,
            self.ascii
        )?;
        file.as_file().sync_all()?;
        file.persist(path)?;
        Ok(())
    }
    pub fn palette(&self) -> Palette {
        let no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
        let dumb = std::env::var("TERM").is_ok_and(|v| v == "dumb");
        let enabled = !no_color
            && self.color != ColorMode::Never
            && (self.color == ColorMode::Always || !dumb);
        let truecolor = self.color == ColorMode::Always
            || std::env::var("COLORTERM")
                .is_ok_and(|v| matches!(v.as_str(), "truecolor" | "24bit"));
        Palette::new(self.theme, enabled, truecolor)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Text,
    Muted,
    Accent,
    User,
    Agent,
    Tool,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Copy)]
pub struct Palette {
    pub base: Style,
    pub surface: Style,
    colors: [Color; 9],
}
impl Palette {
    pub fn new(theme: Theme, enabled: bool, truecolor: bool) -> Self {
        use Color::*;
        let (bg, panel, colors) = match theme {
            Theme::Dark => (
                Rgb(28, 27, 25),
                Rgb(36, 34, 31),
                [
                    Rgb(238, 231, 218),
                    Rgb(182, 172, 157),
                    Rgb(232, 190, 119),
                    Rgb(145, 188, 233),
                    Rgb(130, 199, 177),
                    Rgb(200, 164, 231),
                    Rgb(130, 199, 177),
                    Rgb(232, 190, 119),
                    Rgb(255, 157, 145),
                ],
            ),
            Theme::Light => (
                Rgb(250, 247, 241),
                Rgb(241, 236, 227),
                [
                    Rgb(51, 45, 37),
                    Rgb(108, 99, 87),
                    Rgb(136, 96, 23),
                    Rgb(37, 91, 148),
                    Rgb(23, 107, 95),
                    Rgb(118, 82, 160),
                    Rgb(23, 107, 95),
                    Rgb(136, 96, 23),
                    Rgb(180, 60, 54),
                ],
            ),
            Theme::Terminal => (
                Reset,
                Reset,
                [Reset, Gray, Yellow, Blue, Cyan, Magenta, Green, Yellow, Red],
            ),
        };
        let convert = |color| {
            if !enabled {
                return Reset;
            }
            if !truecolor && let Rgb(r, g, b) = color {
                if r.max(g).max(b) - r.min(g).min(b) < 16 {
                    return Indexed(
                        232 + ((u16::from(r) + u16::from(g) + u16::from(b)) / 3 * 23 / 255) as u8,
                    );
                }
                let level = |v: u8| (u16::from(v) * 5 / 255) as u8;
                return Indexed(16 + 36 * level(r) + 6 * level(g) + level(b));
            }
            color
        };
        let colors = colors.map(convert);
        Self {
            base: Style::default().fg(colors[0]).bg(convert(bg)),
            surface: Style::default().fg(colors[0]).bg(convert(panel)),
            colors,
        }
    }
    pub fn style(self, role: Role) -> Style {
        Style::default().fg(self.colors[role as usize])
    }
    pub fn selected(self) -> Style {
        self.surface
            .add_modifier(Modifier::BOLD | Modifier::REVERSED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_roundtrip_and_invalid_values() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Preferences {
            path: Some(dir.path().join("tui.toml")),
            ..Default::default()
        };
        p.parse("theme = 'light'\ncolor = 'never'\nascii = true")
            .unwrap();
        p.save().unwrap();
        let loaded = Preferences::load(&UiArgs {
            tui_config: p.path.clone(),
            theme: Some(Theme::Terminal),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(loaded.theme, Theme::Terminal);
        assert_eq!(loaded.color, ColorMode::Never);
        assert!(loaded.ascii);
        assert!(p.parse("theme = 'typo'").is_err());
        assert!(p.parse("no_logo = 'yes'").is_err());
        assert!(p.parse("unknown = true").is_err());
    }
    #[test]
    fn monochrome_removes_all_color_but_keeps_selection() {
        let p = Palette::new(Theme::Dark, false, true);
        assert_eq!(p.base.fg, Some(Color::Reset));
        assert_eq!(p.style(Role::Error).fg, Some(Color::Reset));
        assert!(p.selected().add_modifier.contains(Modifier::REVERSED));
    }
}
