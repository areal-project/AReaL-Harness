import { Button, Input, Textarea } from "@areal/ui";
import { rawText } from "./errors/errorCopy.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { McpAppIcon } from "./McpAppIcon.js";
import type { McpFormResource, McpMetadataImageLoader } from "./mcp-app-services.js";
const icon = z
  .object({
    src: z
      .string()
      .refine(
        (src) => src.startsWith("https://") || /^data:image\/[a-z0-9.+-]+;base64,/i.test(src),
      ),
    mimeType: z.string().optional(),
    sizes: z.array(z.string()).optional(),
    theme: z.enum(["light", "dark"]).optional(),
  })
  .strict();
const option = z
  .object({
    const: z.string(),
    title: z.string(),
    description: z.string().optional(),
    "x-openai-thumbnail": icon.optional(),
  })
  .strict();
const resource = z
  .object({
    uri: z.string().min(1),
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().nonnegative().optional(),
    icons: z.array(icon).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const resourceInput = z
  .object({
    type: z.enum(["resource", "file"]),
    selection: z.enum(["explicit", "implicit"]).optional(),
    options: z.array(resource),
    userOptions: z
      .object({
        kind: z.enum(["file", "directory"]).optional(),
        accept: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const stringKeys = {
  type: z.literal("string"),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().optional(),
  format: z.enum(["email", "uri", "date", "date-time"]).optional(),
  enum: z.array(z.string()).min(1).optional(),
  enumNames: z.array(z.string()).optional(),
  oneOf: z.array(option).optional(),
  "x-openai-suggestions": z.array(option).optional(),
};
const common = { title: z.string().optional(), description: z.string().optional() };
const scalar = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      ...stringKeys,
      default: z.string().optional(),
      "x-openai-input": resourceInput.optional(),
    })
    .strict(),
  z.object({ ...common, type: z.literal("boolean"), default: z.boolean().optional() }).strict(),
  z
    .object({
      ...common,
      type: z.enum(["number", "integer"]),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      multipleOf: z.number().positive().optional(),
      default: z.number().finite().optional(),
    })
    .strict(),
]);
const array = z
  .object({
    ...common,
    type: z.literal("array"),
    items: z.object(stringKeys).strict(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    uniqueItems: z.boolean().optional(),
    default: z.array(z.string()).optional(),
    "x-openai-input": resourceInput.optional(),
  })
  .strict();
const schema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.union([scalar, array])),
    required: z.array(z.string()).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .strict();
type Form = z.infer<typeof schema>;
type Field = Form["properties"][string];
type Values = Record<string, string | number | boolean | string[]>;
function stringValid(
  field: (z.infer<typeof scalar> & { type: "string" }) | z.infer<typeof array>["items"],
  value: unknown,
): boolean {
  if (
    typeof value !== "string" ||
    (field.minLength !== undefined && [...value].length < field.minLength) ||
    (field.maxLength !== undefined && [...value].length > field.maxLength) ||
    (field.enum && !field.enum.includes(value)) ||
    (field.oneOf && !field.oneOf.some((item) => item.const === value)) ||
    (field.pattern !== undefined && !new RegExp(field.pattern, "u").test(value))
  )
    return false;
  if (field.format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (field.format === "uri") {
    try {
      new URL(value);
    } catch {
      return false;
    }
  }
  if (
    field.format === "date" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
  )
    return false;
  if (
    field.format === "date-time" &&
    (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value)))
  )
    return false;
  return true;
}
function valid(field: Field, value: unknown, extra: McpFormResource[] = []): boolean {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number" || field.type === "integer")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.type !== "integer" || Number.isSafeInteger(value)) &&
      (field.minimum === undefined || value >= field.minimum) &&
      (field.maximum === undefined || value <= field.maximum) &&
      (field.multipleOf === undefined ||
        Math.abs(value / field.multipleOf - Math.round(value / field.multipleOf)) < 1e-9)
    );
  if (field.type !== "string" && field.type !== "array") return false;
  const input = field["x-openai-input"];
  if (input) {
    const choices = new Set([...input.options, ...extra].map((item) => item.uri));
    if (
      (field.type === "string" && !choices.has(value as string)) ||
      (field.type === "array" &&
        (!Array.isArray(value) || value.some((item) => !choices.has(item))))
    )
      return false;
  }
  if (field.type === "string") return stringValid(field, value);
  return (
    Array.isArray(value) &&
    (field.minItems === undefined || value.length >= field.minItems) &&
    (field.maxItems === undefined || value.length <= field.maxItems) &&
    (!field.uniqueItems || new Set(value).size === value.length) &&
    value.every((item) => stringValid(field.items, item))
  );
}
export function parseMcpForm(value: unknown, canPickResources: boolean): Form {
  const result = schema.parse(value);
  for (const name of result.required ?? [])
    if (!Object.hasOwn(result.properties, name)) throw Error("Unsupported required property");
  for (const field of Object.values(result.properties)) {
    const string = field.type === "string" ? field : field.type === "array" ? field.items : null;
    if (string?.pattern !== undefined) new RegExp(string.pattern, "u");
    if (string?.enumNames && string.enumNames.length !== string.enum?.length)
      throw Error("Invalid enum labels");
    const input =
      field.type === "string" || field.type === "array" ? field["x-openai-input"] : null;
    if (input) {
      if (
        (field.type === "string" && input.selection !== undefined) ||
        (input.selection === "implicit" && field.default !== undefined)
      )
        throw Error("Invalid resource selection");
      if ((input.userOptions || input.selection === "implicit") && !canPickResources)
        throw Error("Resource upload is unavailable");
    }
    if (field.default !== undefined && !valid(field, field.default))
      throw Error("Invalid form default");
  }
  return result;
}
export type McpFormResponse = { action: "accept" | "decline" | "cancel"; content?: Values };
/** Request identity remains with Core; callbacks must resolve this exact owner/request only. */
export function McpAppForm({
  requestId,
  message,
  requestedSchema,
  loadMetadataImage,
  onRespond,
  onUnsupported,
  onPickResources,
  onReleaseResource,
  onPreview,
}: {
  requestId: string;
  message: string;
  requestedSchema: unknown;
  loadMetadataImage?: McpMetadataImageLoader;
  onRespond: (requestId: string, response: McpFormResponse) => Promise<void>;
  onUnsupported: (requestId: string) => Promise<void>;
  onPickResources?: (fieldName: string) => Promise<McpFormResource[]>;
  onReleaseResource?: (fieldName: string, uri: string) => Promise<void>;
  onPreview?: (target: unknown) => Promise<void>;
}) {
  const parsed = useMemo(() => {
    try {
      return { data: parseMcpForm(requestedSchema, !!onPickResources), error: false };
    } catch {
      return { data: null, error: true };
    }
  }, [requestedSchema, onPickResources]);
  // Key this component by the immutable Core request ID; state never crosses pending owners.
  const [values, setValues] = useState<Values>(() =>
      Object.fromEntries(
        Object.entries(parsed.data?.properties ?? {}).flatMap(([name, field]) => {
          if (field.default !== undefined) return [[name, field.default]];
          if (field.type === "array")
            return [
              [
                name,
                field["x-openai-input"]?.selection === "implicit"
                  ? field["x-openai-input"]!.options.map((item) => item.uri)
                  : [],
              ],
            ];
          return [];
        }),
      ),
    ),
    [added, setAdded] = useState<Record<string, McpFormResource[]>>({}),
    [removed, setRemoved] = useState<Record<string, string[]>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function pick(name: string, field: Field) {
    if (busy || !onPickResources) return;
    setBusy(true);
    setError("");
    try {
      const next = (await onPickResources(name)).map((item) => resource.parse(item));
      if (!mounted.current) {
        await Promise.all(next.map((item) => onReleaseResource?.(name, item.uri)));
        return;
      }
      if (!next.length) return;
      if (field.type !== "array")
        await Promise.all((added[name] ?? []).map((item) => onReleaseResource?.(name, item.uri)));
      setAdded((previous) => ({
        ...previous,
        [name]: field.type === "array" ? [...(previous[name] ?? []), ...next] : next,
      }));
      setValues((previous) => ({
        ...previous,
        [name]:
          field.type === "array"
            ? [
                ...(Array.isArray(previous[name]) ? previous[name] : []),
                ...next.map((item) => item.uri),
              ]
            : next[0].uri,
      }));
    } catch (cause) {
      if (mounted.current)
        setError(
          (rawText(cause) ?? "").includes("RESOURCE_UPLOAD_UNSUPPORTED")
            ? "此服务器不支持本机文件上传。您仍可选择服务器提供的资源。"
            : "资源选择未确认，请检查表单状态。",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function remove(name: string, item: McpFormResource) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if ((added[name] ?? []).some((resource) => resource.uri === item.uri))
        await onReleaseResource?.(name, item.uri);
      setRemoved((previous) => ({ ...previous, [name]: [...(previous[name] ?? []), item.uri] }));
      setAdded((previous) => ({
        ...previous,
        [name]: (previous[name] ?? []).filter((resource) => resource.uri !== item.uri),
      }));
      setValues((previous) => {
        const next = { ...previous };
        if (Array.isArray(previous[name]))
          next[name] = previous[name].filter((uri) => uri !== item.uri);
        else delete next[name];
        return next;
      });
    } catch {
      setError("资源移除尚未确认，请核对表单状态。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function respond(action: McpFormResponse["action"]) {
    if (busy || !parsed.data) return;
    if (action === "accept")
      for (const [name, field] of Object.entries(parsed.data.properties)) {
        if (values[name] === undefined && !parsed.data.required?.includes(name)) continue;
        if (!valid(field, values[name], added[name])) {
          setError(`请检查“${field.title ?? name}”的值。`);
          return;
        }
      }
    setBusy(true);
    try {
      await onRespond(requestId, {
        action,
        ...(action === "accept" ? { content: values } : {}),
      });
    } catch {
      setBusy(false);
      setError("回复尚未确认，请核对请求状态。");
    }
  }
  if (parsed.error)
    return (
      <section role="alert">
        <p>此表单包含不支持的字段，未显示或提交任何字段。</p>
        <Button
          unstyled
          data-slot={undefined}
          type="submit"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onUnsupported(requestId).catch(() => {
              setBusy(false);
              setError("无法回复此请求。");
            });
          }}
        >
          报告不支持
        </Button>
        {error}
      </section>
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void respond("accept");
      }}
    >
      <p>{message}</p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy}>
        {Object.entries(parsed.data!.properties).map(([name, field]) => {
          const value = values[name];
          const input =
            field.type === "string" || field.type === "array" ? field["x-openai-input"] : null;
          const set = (value: Values[string]) =>
            setValues((previous) => ({ ...previous, [name]: value }));
          if (input) {
            const options = [...input.options, ...(added[name] ?? [])].filter(
              (item) => !(removed[name] ?? []).includes(item.uri),
            );
            return (
              <fieldset key={name}>
                <legend>{field.title ?? name}</legend>
                {options.map((item) => {
                  const checked = Array.isArray(value)
                    ? value.includes(item.uri)
                    : value === item.uri;
                  return (
                    <div key={item.uri}>
                      <label>
                        <Input
                          unstyled
                          data-slot={undefined}
                          type={field.type === "array" ? "checkbox" : "radio"}
                          name={name}
                          disabled={busy || input.selection === "implicit"}
                          checked={checked}
                          onChange={(event) =>
                            set(
                              field.type === "array"
                                ? event.target.checked
                                  ? [...(Array.isArray(value) ? value : []), item.uri]
                                  : (Array.isArray(value) ? value : []).filter(
                                      (uri) => uri !== item.uri,
                                    )
                                : item.uri,
                            )
                          }
                        />
                        {item.title ?? item.name}
                      </label>
                      {(input.selection === "implicit" ||
                        (added[name] ?? []).some((resource) => resource.uri === item.uri)) && (
                        <Button
                          unstyled
                          data-slot={undefined}
                          type="button"
                          disabled={busy}
                          onClick={() => void remove(name, item)}
                        >
                          移除 {item.name}
                        </Button>
                      )}
                      {onPreview && item._meta?.["openai/preview"] !== undefined && (
                        <Button
                          unstyled
                          data-slot={undefined}
                          type="button"
                          onClick={() =>
                            void onPreview(item._meta!["openai/preview"]).catch(() =>
                              setError("无法预览此资源。"),
                            )
                          }
                        >
                          预览
                        </Button>
                      )}
                    </div>
                  );
                })}
                {onPickResources && (input.userOptions || input.selection === "implicit") && (
                  <Button
                    unstyled
                    data-slot={undefined}
                    type="button"
                    disabled={busy}
                    onClick={() => void pick(name, field)}
                  >
                    添加
                    {input.userOptions?.kind === "directory" ? "目录" : "文件"}
                  </Button>
                )}
              </fieldset>
            );
          }
          const string =
            field.type === "string" ? field : field.type === "array" ? field.items : null;
          const options =
            string?.oneOf ??
            string?.enum?.map((value, index) => ({
              const: value,
              title: string.enumNames?.[index] ?? value,
            }));
          const suggestions = string?.["x-openai-suggestions"];
          return (
            <label key={name} style={{ display: "block", marginBlock: 12 }}>
              {field.title ?? name}
              {field.description && <small style={{ display: "block" }}>{field.description}</small>}
              {field.type === "boolean" ? (
                <Input
                  unstyled
                  data-slot={undefined}
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => set(event.target.checked)}
                />
              ) : options?.some((item) => "x-openai-thumbnail" in item) ? (
                <span role="group">
                  {options.map((item) => (
                    <label
                      key={item.const}
                      style={{
                        display: "inline-flex",
                        flexDirection: "column",
                        margin: 8,
                      }}
                    >
                      <McpAppIcon
                        loadMetadataImage={loadMetadataImage}
                        size={48}
                        icon={
                          "x-openai-thumbnail" in item
                            ? icon.safeParse(item["x-openai-thumbnail"]).data
                            : undefined
                        }
                      />
                      <Input
                        unstyled
                        data-slot={undefined}
                        type={field.type === "array" ? "checkbox" : "radio"}
                        name={name}
                        checked={
                          Array.isArray(value) ? value.includes(item.const) : value === item.const
                        }
                        onChange={(event) =>
                          set(
                            field.type === "array"
                              ? event.target.checked
                                ? [...(Array.isArray(value) ? value : []), item.const]
                                : (Array.isArray(value) ? value : []).filter(
                                    (entry) => entry !== item.const,
                                  )
                              : item.const,
                          )
                        }
                      />
                      {item.title}
                      {"description" in item && typeof item.description === "string" && (
                        <small>{item.description}</small>
                      )}
                    </label>
                  ))}
                </span>
              ) : options ? (
                <select
                  multiple={field.type === "array"}
                  value={Array.isArray(value) ? value : String(value ?? "")}
                  onChange={(event) =>
                    set(
                      field.type === "array"
                        ? Array.from(event.target.selectedOptions, (item) => item.value)
                        : event.target.value,
                    )
                  }
                >
                  {field.type !== "array" && <option value="">请选择</option>}
                  {options.map((item) => (
                    <option
                      key={item.const}
                      value={item.const}
                      title={
                        "description" in item && typeof item.description === "string"
                          ? item.description
                          : undefined
                      }
                    >
                      {item.title}
                    </option>
                  ))}
                </select>
              ) : field.type === "array" ? (
                <Textarea
                  unstyled
                  data-slot={undefined}
                  value={Array.isArray(value) ? value.join("\n") : ""}
                  placeholder="每行一个值"
                  onChange={(event) =>
                    set(event.target.value ? event.target.value.split("\n") : [])
                  }
                />
              ) : (
                <Input
                  unstyled
                  data-slot={undefined}
                  list={suggestions ? `${requestId}-${name}` : undefined}
                  type={field.type === "string" ? "text" : "number"}
                  value={String(value ?? "")}
                  onChange={(event) =>
                    set(
                      field.type === "string"
                        ? event.target.value
                        : event.target.value === ""
                          ? ""
                          : Number(event.target.value),
                    )
                  }
                />
              )}
              {suggestions && field.type === "array" && (
                <span>
                  {suggestions.map((item) => (
                    <Button
                      unstyled
                      data-slot={undefined}
                      type="button"
                      key={item.const}
                      onClick={() =>
                        set(
                          Array.from(new Set([...(Array.isArray(value) ? value : []), item.const])),
                        )
                      }
                    >
                      {item.title}
                    </Button>
                  ))}
                </span>
              )}
              {suggestions && (
                <datalist id={`${requestId}-${name}`}>
                  {suggestions.map((item) => (
                    <option key={item.const} value={item.const}>
                      {item.title}
                    </option>
                  ))}
                </datalist>
              )}
            </label>
          );
        })}
      </fieldset>
      <Button
        unstyled
        data-slot={undefined}
        type="button"
        disabled={busy}
        onClick={() => void respond("cancel")}
      >
        取消
      </Button>
      <Button
        unstyled
        data-slot={undefined}
        type="button"
        disabled={busy}
        onClick={() => void respond("decline")}
      >
        拒绝
      </Button>
      <Button unstyled data-slot={undefined} type="submit" disabled={busy}>
        提交
      </Button>
    </form>
  );
}
