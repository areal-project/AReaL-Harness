import assert from "node:assert/strict";

const namePattern = /^[a-z][a-z0-9-]*$/;
const variable = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const quote = JSON.stringify;

export function renderPalette(tokens) {
  const palette = tokens.palette;
  const definitions = [];
  const resolved = new Set();
  const resolving = new Set();
  const references = Object.entries(palette.references).map(([name, entry]) => {
    assert.ok(namePattern.test(name), `invalid reference name: ${name}`);
    assert.ok(
      typeof entry.value === "string" && entry.source?.trim(),
      `invalid reference: ${name}`,
    );
    return `  ${quote(name)}: ${quote(entry.value)},`;
  });
  const reference = (name) => {
    assert.ok(Object.hasOwn(palette.references, name), `unknown reference: ${name}`);
    return `PALETTE_REFERENCES[${quote(name)}]`;
  };
  const modeNumber = (value) => {
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value), "palette parameter must be finite");
      return String(value);
    }
    assert.deepEqual(Object.keys(value).sort(), ["dark", "light"], "invalid mode parameter");
    return `(dark ? ${modeNumber(value.dark)} : ${modeNumber(value.light)})`;
  };
  const parameter = (name) => {
    assert.ok(Object.hasOwn(palette.parameters, name), `unknown parameter: ${name}`);
    const entry = palette.parameters[name];
    assert.ok(entry.source?.trim(), `missing parameter source: ${name}`);
    const keys = Object.keys(entry).filter((key) => key !== "source");
    assert.equal(keys.length, 1, `ambiguous parameter: ${name}`);
    if (keys[0] === "value") return modeNumber(entry.value);
    if (keys[0] === "ratio") {
      assert.equal(entry.ratio.length, 2, `invalid ratio: ${name}`);
      assert.ok(
        entry.ratio.every(Number.isFinite) && entry.ratio[1] !== 0,
        `invalid ratio: ${name}`,
      );
      return `(${entry.ratio[0]} / ${entry.ratio[1]})`;
    }
    assert.equal(keys[0], "contrast", `unsupported parameter: ${name}`);
    assert.deepEqual(Object.keys(entry.contrast).sort(), ["base", "slope"]);
    assert.ok(Number.isFinite(entry.contrast.slope), `invalid contrast slope: ${name}`);
    return `(${modeNumber(entry.contrast.base)} + contrastDelta * ${entry.contrast.slope})`;
  };
  const condition = (match) => {
    assert.ok(Object.keys(match).length > 0, "default override needs a match");
    return Object.entries(match)
      .map(([key, value]) => {
        if (key === "mode") {
          assert.ok(["light", "dark"].includes(value), `invalid default mode: ${value}`);
          return value === "dark" ? "dark" : "!dark";
        }
        assert.ok(
          ["background", "foreground", "accent"].includes(key),
          `invalid default input: ${key}`,
        );
        return `p.${key} === ${reference(value)}`;
      })
      .join(" && ");
  };
  const semantic = (name) => {
    assert.ok(Object.hasOwn(palette.semantic, name), `unknown semantic: ${name}`);
    assert.ok(!resolving.has(name), `cyclic semantic: ${name}`);
    if (resolved.has(name)) return variable(name);
    assert.ok(namePattern.test(name), `invalid semantic name: ${name}`);
    const entry = palette.semantic[name];
    assert.ok(entry.meaning?.trim() && entry.source?.trim(), `missing semantic metadata: ${name}`);
    resolving.add(name);
    const floor = entry.minimumContrast && parameter(entry.minimumContrast);
    const value = expression(entry.value, floor);
    const overrides = (entry.defaultOverrides ?? []).map(
      (override) => `(${condition(override.match)}) ? ${expression(override.value, floor)} : `,
    );
    definitions.push(`  const ${variable(name)} = ${overrides.join("")}${value};`);
    resolving.delete(name);
    resolved.add(name);
    return variable(name);
  };
  // floor：文字对比度下限。只作用于前景混入背景（或透明后叠在背景上）的混色，把百分比推到达标为止。
  const expression = (rule, floor) => {
    assert.ok(
      rule && typeof rule === "object" && !Array.isArray(rule),
      "palette rule must be an object",
    );
    assert.equal(Object.keys(rule).length, 1, "palette rule must have one operation");
    if (Object.hasOwn(rule, "input")) {
      assert.ok(
        ["background", "foreground", "accent"].includes(rule.input),
        `invalid palette input: ${rule.input}`,
      );
      return `p.${rule.input}`;
    }
    if (Object.hasOwn(rule, "reference")) return reference(rule.reference);
    if (Object.hasOwn(rule, "semantic")) return semantic(rule.semantic);
    if (Object.hasOwn(rule, "mode")) {
      assert.deepEqual(Object.keys(rule.mode).sort(), ["dark", "light"]);
      return `(dark ? ${expression(rule.mode.dark, floor)} : ${expression(rule.mode.light, floor)})`;
    }
    if (Object.hasOwn(rule, "translucent")) {
      assert.deepEqual(Object.keys(rule.translucent).sort(), ["solid", "translucent"]);
      return `(p.translucentSidebar ? ${expression(rule.translucent.translucent)} : ${expression(rule.translucent.solid)})`;
    }
    if (Object.hasOwn(rule, "mix")) {
      assert.deepEqual(Object.keys(rule.mix).sort(), ["from", "into", "percent", "space"]);
      assert.ok(
        ["srgb", "oklab"].includes(rule.mix.space),
        `unsupported color space: ${rule.mix.space}`,
      );
      let percent = parameter(rule.mix.percent);
      if (floor) {
        assert.equal(rule.mix.from.input, "foreground", "contrast floor needs a foreground mix");
        assert.ok(
          rule.mix.into.input === "background" || rule.mix.into.reference === "transparent",
          "contrast floor needs a mix into the background",
        );
        percent = `minimumPercent(p.foreground, p.background, ${percent}, ${floor})`;
      }
      return (
        "`color-mix(in " +
        rule.mix.space +
        ", ${" +
        expression(rule.mix.from) +
        "} ${" +
        percent +
        "}%, ${" +
        expression(rule.mix.into) +
        "})`"
      );
    }
    if (Object.hasOwn(rule, "readableForeground"))
      return `readableForeground(${expression(rule.readableForeground)})`;
    assert.ok(
      Object.hasOwn(rule, "shadows"),
      `unsupported palette operation: ${Object.keys(rule)[0]}`,
    );
    assert.ok(Array.isArray(rule.shadows) && rule.shadows.length > 0, "shadow needs layers");
    return (
      "`" +
      rule.shadows
        .map((layer) => {
          assert.deepEqual(Object.keys(layer).sort(), ["color", "geometry"]);
          assert.ok(/^(?:inset )?[0-9.px ]+$/.test(layer.geometry), "unsupported shadow geometry");
          return layer.geometry + " ${" + expression(layer.color) + "}";
        })
        .join(", ") +
      "`"
    );
  };
  const roles = Object.entries(palette.roles).map(([name, role]) => {
    assert.ok(/^--(?:color|shadow)-[a-z-]+$/.test(name), `invalid CSS palette role: ${name}`);
    assert.ok(["semantic", "component"].includes(role.layer), `invalid palette layer: ${name}`);
    assert.ok(role.meaning?.trim() && role.source?.trim(), `missing palette metadata: ${name}`);
    assert.ok(
      !Object.hasOwn(role, "value") && typeof role.ref === "string",
      `${role.layer} ${name} must contain only a semantic reference`,
    );
    if (role.layer === "component")
      assert.ok(role.mapping?.trim(), `missing component mapping: ${name}`);
    const value = semantic(role.ref);
    if (!role.alias) return `    ${quote(name)}: ${value},`;
    const target = palette.roles[role.alias];
    assert.ok(target, `unknown palette alias: ${name} -> ${role.alias}`);
    assert.equal(target.layer, "semantic", `palette alias must target semantic role: ${name}`);
    assert.equal(target.ref, role.ref, `palette alias disagrees with semantic reference: ${name}`);
    assert.ok(!target.alias, `palette alias cannot chain: ${name}`);
    return `    ${quote(name)}: ${quote(`var(${role.alias})`)},`;
  });
  Object.keys(palette.parameters).forEach(parameter);
  Object.keys(palette.semantic).forEach(semantic);
  const lightContrast = tokens.themes.contrast.$value;
  const darkContrast = tokens.themes.contrast.$extensions["build.areal.ui"].dark;
  assert.ok(
    Number.isFinite(lightContrast) && Number.isFinite(darkContrast),
    "invalid contrast defaults",
  );
  return (
    "// Generated from tokens.json by scripts/palette.mjs. Do not edit.\n" +
    'import type { Palette } from "../theme.js";\n\n' +
    `export const PALETTE_REFERENCES = {\n${references.join("\n")}\n} as const;\n\n` +
    "export function derivePaletteVariables(p: Palette, dark: boolean, readableForeground: (background: string) => string, minimumPercent: (foreground: string, background: string, percent: number, contrast: number) => number): Record<string, string> {\n" +
    `  const contrastDelta = p.contrast - (dark ? ${darkContrast} : ${lightContrast});\n` +
    definitions.join("\n") +
    `\n  return {\n${roles.join("\n")}\n  };\n}\n`
  );
}
