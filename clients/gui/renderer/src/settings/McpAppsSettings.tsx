import { SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";
import { Button } from "@areal/ui";
import { useI18n, type UiMessage, formatUiMessage } from "../i18n/IntlProvider.js";
import { SettingsSelect, SettingsSwitch } from "./SettingsPageParts.js";
import { ActionButton } from "../components/ui/action-button.js";
import { Input } from "../components/ui/input.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { McpAppIcon } from "../McpAppIcon.js";
import type { McpMetadataImageLoader } from "../mcp-app-services.js";
import type {
  ManagementRequest,
  ManagementRequestMap,
  ManagementResponse,
  ManagementResponseMap,
} from "../services.js";
export type McpAppServer = ManagementResponseMap["mcpApps"]["data"][number];
export type McpAppTool = McpAppServer["tools"][number];
export type McpAppsCommand = <P extends ManagementRequest>(
  request: P,
) => Promise<ManagementResponse<P>>;
export const toolTitle = (tool: McpAppTool) => tool.title ?? tool.annotations?.title ?? tool.name;
export function mcpAppEntrypoints<Server extends McpAppServer>(
  servers: readonly Server[],
  kind: "global" | "thread" | "file",
  fileName?: string,
) {
  return servers.flatMap((server) =>
    server.tools
      .filter((tool) => {
        const meta = tool._meta?.["openai/ui"] as { entrypoints?: unknown } | undefined;
        return (
          Array.isArray(meta?.entrypoints) &&
          meta.entrypoints.some((entry: unknown) => {
            if (typeof entry !== "object" || !entry) return false;
            const value = entry as { type?: unknown; extensions?: unknown };
            return (
              value.type === kind &&
              (kind !== "file" ||
                (Array.isArray(value.extensions) &&
                  value.extensions.some(
                    (ext) =>
                      typeof ext === "string" &&
                      /^\.[a-z0-9._-]+$/i.test(ext) &&
                      fileName?.toLowerCase().endsWith(ext.toLowerCase()),
                  )))
            );
          })
        );
      })
      .map((tool) => ({ server, tool })),
  );
}
const base = { title: z.string().min(1), description: z.string().optional() };
const fieldSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("boolean") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("string"),
      enum: z.array(z.string()).min(1).optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.enum(["number", "integer"]),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      multipleOf: z.number().positive().optional(),
    })
    .strict(),
]);
const settingsSchema = z
  .object({
    schema: z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string(), fieldSchema),
        required: z.array(z.string()).optional(),
      })
      .strict(),
    values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
    layout: z
      .array(
        z
          .object({
            kind: z.literal("group"),
            title: z.string(),
            items: z.array(
              z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("property"), property: z.string() }).strict(),
                z
                  .object({
                    kind: z.literal("tool"),
                    tool: z.string(),
                    title: z.string().optional(),
                    description: z.string().optional(),
                  })
                  .strict(),
              ]),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
type Settings = z.infer<typeof settingsSchema>;
type Field = z.infer<typeof fieldSchema>;
export function validSetting(field: Field, value: unknown): boolean {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "string")
    return (
      typeof value === "string" &&
      (!field.enum || field.enum.includes(value)) &&
      (field.minLength === undefined || [...value].length >= field.minLength) &&
      (field.maxLength === undefined || [...value].length <= field.maxLength) &&
      (field.pattern === undefined || new RegExp(field.pattern, "u").test(value))
    );
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (field.type !== "integer" || Number.isSafeInteger(value)) &&
    (field.minimum === undefined || value >= field.minimum) &&
    (field.maximum === undefined || value <= field.maximum) &&
    (field.multipleOf === undefined ||
      Math.abs(value / field.multipleOf - Math.round(value / field.multipleOf)) < 1e-9)
  );
}
export function parseMcpSettings(value: unknown, tools: McpAppTool[]): Settings {
  const data = settingsSchema.parse(value),
    properties = data.schema.properties;
  for (const name of data.schema.required ?? [])
    if (!(name in properties)) throw Error("Unknown required setting");
  for (const [name, field] of Object.entries(properties)) {
    if (field.type === "string" && field.pattern !== undefined) new RegExp(field.pattern, "u");
    if (!Object.hasOwn(data.values, name) || !validSetting(field, data.values[name]))
      throw Error("Invalid effective setting value");
  }
  if (Object.keys(data.values).some((name) => !Object.hasOwn(properties, name)))
    throw Error("Unknown setting value");
  const placed = new Set<string>();
  for (const group of data.layout ?? [])
    for (const item of group.items) {
      if (item.kind === "property") {
        if (!Object.hasOwn(properties, item.property) || placed.has(item.property))
          throw Error("Invalid settings layout");
        placed.add(item.property);
      } else if (!tools.some((tool) => tool.name === item.tool))
        throw Error("Unknown same-server settings tool");
    }
  return data;
}
function structured(value: unknown): unknown {
  if (typeof value !== "object" || !value) throw Error("Invalid extension response");
  const data = value as {
    structuredContent?: unknown;
    result?: { structuredContent?: unknown };
    isError?: boolean;
  };
  if (data.isError) throw Error("Extension tool failed");
  return data.structuredContent ?? data.result?.structuredContent ?? value;
}
export function McpAppsSettings({
  server,
  projectId,
  threadId,
  command,
  onTool,
}: {
  server: McpAppServer;
  projectId: string;
  threadId: string;
  command: McpAppsCommand;
  onTool: (server: McpAppServer, tool: McpAppTool) => Promise<void>;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Settings | null>(null),
    [values, setValues] = useState<Record<string, string | number | boolean>>({}),
    [error, setError] = useState<UiMessage | string>(""),
    [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const call = (
    kind: ManagementRequestMap["mcpExtensionCall"]["kind"],
    args: ManagementRequestMap["mcpExtensionCall"]["arguments"],
  ) =>
    command({
      operation: "mcpExtensionCall",
      projectId,
      threadId,
      serverId: server.serverId,
      expectedGeneration: server.generation,
      kind,
      arguments: args,
      requestId: crypto.randomUUID(),
    });
  useEffect(() => {
    const version = ++epoch.current;
    setData(null);
    setError("");
    setBusy(true);
    void call("settingsRead", {})
      .then((result) => {
        const next = parseMcpSettings(structured(result), server.tools);
        if (epoch.current !== version) return;
        setData(next);
        setValues(next.values);
      })
      .catch(() => {
        if (epoch.current === version)
          setError({ id: "settings.mcpAppsSettings.thisAppUsesAnUnsupportedSettingsFormat" });
      })
      .finally(() => {
        if (epoch.current === version) setBusy(false);
      });
    return () => {
      epoch.current++;
    };
  }, [server.serverId, server.generation, projectId, threadId]);
  const groups = useMemo(() => {
    if (!data) return [];
    const declared = data.layout ?? [],
      placed = new Set(
        declared.flatMap((group) =>
          group.items.flatMap((item) => (item.kind === "property" ? [item.property] : [])),
        ),
      );
    const remaining = Object.keys(data.schema.properties)
      .filter((name) => !placed.has(name))
      .map((property) => ({ kind: "property" as const, property }));
    return [
      ...declared,
      ...(remaining.length
        ? [
            {
              kind: "group" as const,
              title: declared.length
                ? t("settings.mcpAppsSettings.otherSettings")
                : t("settings.mcpAppsSettings.settings"),
              items: remaining,
            },
          ]
        : []),
    ];
  }, [data, t]);
  async function save() {
    if (!data || busy) return;
    const version = epoch.current;
    setError("");
    const changed: Record<string, string | number | boolean> = {};
    for (const [name, field] of Object.entries(data.schema.properties)) {
      if (!validSetting(field, values[name])) {
        setError({
          id: "settings.mcpAppsSettings.checkTheValueOfValue",
          values: { value0: field.title },
        });
        return;
      }
      if (values[name] !== data.values[name]) changed[name] = values[name];
    }
    if (!Object.keys(changed).length) return;
    setBusy(true);
    try {
      await call("settingsUpdate", { set: changed });
      const next = parseMcpSettings(structured(await call("settingsRead", {})), server.tools);
      if (version === epoch.current) {
        setData(next);
        setValues(next.values);
      }
    } catch {
      if (version === epoch.current)
        setError({ id: "settings.mcpAppsSettings.theSettingsUpdateIsUnconfirmedRefreshAnd" });
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label={t("settings.mcpAppsSettings.valueSettings", {
        value0: server.title ?? server.serverId,
      })}
    >
      <h3>{server.title ?? server.serverId}</h3>
      {error && <p role="alert">{formatUiMessage(t, error)}</p>}
      {groups.map((group, index) => (
        <fieldset key={index} disabled={busy} className="m-0 border-0 p-0">
          <legend className="settings-section-heading">{group.title}</legend>
          <SettingsGroupCard>
            {group.items.map((item, index) => {
              if (item.kind === "tool") {
                const tool = server.tools.find((tool) => tool.name === item.tool)!;
                return (
                  <SettingsRow
                    key={index}
                    label={toolTitle(tool)}
                    control={
                      <ActionButton
                        aria-label={t("settings.mcpAppsSettings.runValue", {
                          value0: toolTitle(tool),
                        })}
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void onTool(server, tool)
                            .catch(() =>
                              setError({
                                id: "settings.mcpAppsSettings.theOperationDidNotCompleteTryAgain",
                              }),
                            )
                            .finally(() => setBusy(false));
                        }}
                      >
                        {t("settings.mcpAppsSettings.run")}
                      </ActionButton>
                    }
                  />
                );
              }
              const name = item.property,
                field = data!.schema.properties[name],
                value = values[name];
              return (
                <SettingsRow
                  key={name}
                  label={field.title}
                  description={field.description}
                  control={
                    field.type === "boolean" ? (
                      <SettingsSwitch
                        aria-label={field.title}
                        disabled={busy}
                        checked={value === true}
                        onCheckedChange={(checked) => setValues({ ...values, [name]: checked })}
                      />
                    ) : field.type === "string" && field.enum ? (
                      <SettingsSelect
                        aria-label={field.title}
                        disabled={busy}
                        value={String(value)}
                        onValueChange={(selectedValue) =>
                          setValues({ ...values, [name]: selectedValue })
                        }
                      >
                        {field.enum.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </SettingsSelect>
                    ) : (
                      <Input
                        aria-label={field.title}
                        disabled={busy}
                        type={field.type === "string" ? "text" : "number"}
                        value={String(value ?? "")}
                        onChange={(event) =>
                          setValues({
                            ...values,
                            [name]:
                              field.type === "string"
                                ? event.target.value
                                : event.target.value === ""
                                  ? ""
                                  : Number(event.target.value),
                          })
                        }
                      />
                    )
                  }
                />
              );
            })}
          </SettingsGroupCard>
        </fieldset>
      ))}
      <ActionButton pending={busy} disabled={!data} onClick={() => void save()}>
        {busy ? t("settings.mcpAppsSettings.working") : t("settings.mcpAppsSettings.saveSettings")}
      </ActionButton>
    </section>
  );
}
export function McpAppEntrypoints({
  servers,
  kind,
  fileName,
  loadMetadataImage,
  onOpen,
}: {
  servers: McpAppServer[];
  kind: "global" | "thread" | "file";
  fileName?: string;
  loadMetadataImage?: McpMetadataImageLoader;
  onOpen: (server: McpAppServer, tool: McpAppTool) => void;
}) {
  const { t } = useI18n();
  const entries = mcpAppEntrypoints(servers, kind, fileName);
  return (
    <nav aria-label={t("settings.mcpAppsSettings.appEntryPoints")}>
      {entries.map(({ server, tool }) => (
        <Button
          unstyled
          data-slot={undefined}
          type="submit"
          key={`${server.serverId}:${tool.name}`}
          onClick={() => onOpen(server, tool)}
        >
          <McpAppIcon
            icon={tool.icons?.[0] ?? server.icons?.[0]}
            loadMetadataImage={loadMetadataImage}
          />
          {toolTitle(tool)}
        </Button>
      ))}
    </nav>
  );
}
export type McpMentionResource = {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
};
export function McpAppsMentions({
  server,
  projectId,
  threadId,
  command,
  onSelect,
}: {
  server: McpAppServer;
  projectId: string;
  threadId: string;
  command: McpAppsCommand;
  onSelect: (item: McpMentionResource) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<McpMentionResource[]>([]),
    [error, setError] = useState<UiMessage | string>("");
  const epoch = useRef(0);
  useEffect(() => {
    const version = ++epoch.current;
    setItems([]);
    setError("");
    const timer = setTimeout(() => {
      void command({
        operation: "mcpExtensionCall",
        projectId,
        threadId,
        serverId: server.serverId,
        expectedGeneration: server.generation,
        kind: "mentionsSearch",
        arguments: { query },
        requestId: crypto.randomUUID(),
      })
        .then((value) => {
          const data = z
            .object({
              items: z
                .array(
                  z
                    .object({
                      type: z.literal("resource_link"),
                      uri: z.string().min(1),
                      name: z.string().min(1),
                      title: z.string().optional(),
                      mimeType: z.string().optional(),
                      _meta: z.record(z.string(), z.unknown()).optional(),
                    })
                    .passthrough(),
                )
                .max(500),
            })
            .parse(structured(value));
          if (version === epoch.current) setItems(data.items);
        })
        .catch(() => {
          if (version === epoch.current)
            setError({ id: "settings.mcpAppsSettings.couldNotSearchThisAppTryAgain" });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      epoch.current++;
    };
  }, [query, server.serverId, server.generation, projectId, threadId]);
  return (
    <section aria-label={t("settings.mcpAppsSettings.appReferences")}>
      <label>
        {t("settings.mcpAppsSettings.searchReferences")}
        <Input
          unstyled
          data-slot={undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error && <p role="alert">{formatUiMessage(t, error)}</p>}
      <ul>
        {items.map((item, index) => (
          <li key={`${item.uri}:${index}`}>
            <Button unstyled data-slot={undefined} type="submit" onClick={() => onSelect(item)}>
              {item.title ?? item.name}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
