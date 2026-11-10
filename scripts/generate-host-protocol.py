#!/usr/bin/env python3
"""Generate standalone structural types from the bounded Host JSON Schema."""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = Path("schemas/areal-host-protocol-v1.json")
OUTPUTS = (
    Path("core/protocol/generated/host_protocol.rs"),
    Path("clients/gui/packages/remote-client/generated/host-protocol.d.ts"),
)
ANNOTATIONS = {
    "description",
    "title",
    "examples",
    "default",
    "$comment",
    "x-source",
    "x-maxUtf8Bytes",
    "x-opaque",
    "x-nonWhitespace",
    "x-constraints",
    "x-sensitive",
}
CONSTRAINTS = {
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "pattern",
    "format",
    "minProperties",
    "maxProperties",
}
KEYWORDS = (
    ANNOTATIONS
    | CONSTRAINTS
    | {
        "$ref",
        "type",
        "const",
        "enum",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "prefixItems",
        "oneOf",
        "anyOf",
    }
)


def pascal(value):
    return "".join(
        part[:1].upper() + part[1:] for part in re.split(r"[^A-Za-z0-9]+", value) if part
    )


def snake(value):
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value).lower()
    return (
        "r#" + value
        if value
        in {
            "type",
            "match",
            "ref",
            "self",
            "loop",
            "move",
            "where",
            "use",
            "mod",
            "enum",
            "struct",
            "fn",
            "async",
            "await",
            "in",
            "as",
            "super",
            "crate",
        }
        else value
    )


def validate_schema(document, root=ROOT):
    core_document = json.loads((root / "schemas/areal-core-v1.json").read_text())
    definitions = document["$defs"]
    root_keywords = {
        "$schema",
        "$id",
        "$defs",
        "title",
        "description",
        "anyOf",
        "x-current",
        "x-proposals",
    }
    if set(document) - root_keywords:
        raise ValueError(f"unsupported root keywords {sorted(set(document) - root_keywords)}")

    def visit(value, path):
        if not isinstance(value, dict):
            raise ValueError(f"{path}: schemas must be objects")
        unknown = set(value) - KEYWORDS
        if unknown:
            raise ValueError(f"{path}: unsupported keywords {sorted(unknown)}")
        if "$ref" in value:
            ref = value["$ref"]
            if set(value) - ANNOTATIONS != {"$ref"}:
                raise ValueError(f"{path}: reference siblings are unsupported")
            if ref.startswith("urn:areal:core-protocol:v1#/"):
                if not path.startswith("WorkbenchPrivate"):
                    raise ValueError(f"{path}: external Core contracts are private-only")
                current = core_document
                try:
                    for part in ref.split("#/", 1)[1].split("/"):
                        current = current[part.replace("~1", "/").replace("~0", "~")]
                except (KeyError, TypeError):
                    raise ValueError(f"{path}: unresolved Core reference {ref}") from None
                return
            if not ref.startswith("#/$defs/") or ref[8:] not in definitions:
                raise ValueError(f"{path}: unresolved reference {ref}")
            if set(value) - ANNOTATIONS != {"$ref"}:
                raise ValueError(f"{path}: reference siblings are unsupported")
            return
        if value.get("x-opaque"):
            if not value.get("description") or not value.get("x-source"):
                raise ValueError(f"{path}: opaque leaves require rationale and owner")
            return
        combinations = [key for key in ("oneOf", "anyOf") if key in value]
        if combinations:
            if len(combinations) != 1 or set(value) - ANNOTATIONS != set(combinations):
                raise ValueError(f"{path}: unsupported union siblings")
            variants = value[combinations[0]]
            if len(variants) < 2:
                raise ValueError(f"{path}: union needs at least two variants")
            for index, variant in enumerate(variants):
                visit(variant, f"{path}/{index}")
            return
        kind = value.get("type")
        if not isinstance(kind, str) or kind not in {
            "object",
            "array",
            "string",
            "integer",
            "number",
            "boolean",
            "null",
        }:
            raise ValueError(f"{path}: missing or unsupported type {kind}")
        if "enum" in value and (
            kind != "string" or not all(isinstance(v, str) for v in value["enum"])
        ):
            raise ValueError(f"{path}: only string enums are supported")
        if "enum" in value and (not value["enum"] or len(set(value["enum"])) != len(value["enum"])):
            raise ValueError(f"{path}: enum must contain distinct values")
        if "const" in value and not isinstance(value["const"], (str, int, float, bool)):
            raise ValueError(f"{path}: unsupported const")
        if kind == "object":
            properties = value.get("properties", {})
            if not set(value.get("required", [])).issubset(properties):
                raise ValueError(f"{path}: required property not declared")
            for key, child in properties.items():
                if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]*", key):
                    raise ValueError(f"{path}: unsupported property name {key}")
                visit(child, f"{path}/{key}")
            extra = value.get("additionalProperties", True)
            if isinstance(extra, dict):
                if properties:
                    raise ValueError(
                        f"{path}: typed additionalProperties with named properties is unsupported"
                    )
                visit(extra, f"{path}/additionalProperties")
            elif not isinstance(extra, bool):
                raise ValueError(f"{path}: invalid additionalProperties")
        if kind == "array":
            if "prefixItems" in value:
                items = value["prefixItems"]
                if (
                    not isinstance(items, list)
                    or not items
                    or value.get("items") is not False
                    or value.get("minItems") != len(items)
                    or value.get("maxItems") != len(items)
                ):
                    raise ValueError(f"{path}: tuple arrays must have an exact closed length")
                for index, item in enumerate(items):
                    visit(item, f"{path}/prefixItems/{index}")
            else:
                visit(value["items"], f"{path}/items")

    for name, value in definitions.items():
        if not re.fullmatch(r"[A-Z][A-Za-z0-9]*", name):
            raise ValueError(f"invalid definition name {name}")
        visit(value, name)
    if "anyOf" in document:
        visit({"anyOf": document["anyOf"]}, "root")
    for transport in ("local", "remote", "loopback", "workbench"):
        methods = document["x-current"][transport]["methods"]
        for method, entry in methods.items():
            for kind in ("request", "result"):
                visit({"$ref": entry[kind]}, f"{transport}/{method}/{kind}")
            request = definitions[entry["request"][8:]]
            direction = entry.get("direction")
            tag = (
                "call" if transport == "workbench" and direction == "workbenchToHost" else "method"
            )
            if transport == "workbench" and (
                direction not in {"workbenchToHost", "hostToWorkbench"}
                or entry.get("x-owner")
                != ("host" if direction == "workbenchToHost" else "workbench")
            ):
                raise ValueError(f"{transport}/{method}: invalid private owner or direction")
            if (
                request["properties"][tag].get("const") != method
                or request.get("additionalProperties") is not False
            ):
                raise ValueError(
                    f"{transport}/{method}: request envelope must be closed and method-specific"
                )

    for event, entry in document["x-current"]["workbench"].get("events", {}).items():
        if entry.get("direction") not in {"workbenchToHost", "hostToWorkbench"} or entry.get(
            "x-owner"
        ) != ("workbench" if entry["direction"] == "workbenchToHost" else "host"):
            raise ValueError(f"workbench/{event}: invalid event owner or direction")
        visit({"$ref": entry["schema"]}, f"workbench/{event}/schema")

        def event_shape(shape):
            variants = shape.get("oneOf", shape.get("anyOf"))
            if variants is not None:
                for variant in variants:
                    event_shape(variant)
                return
            if (
                shape.get("additionalProperties") is not False
                or shape.get("properties", {}).get("event", {}).get("const") != event
            ):
                raise ValueError(
                    f"workbench/{event}: event envelope must be closed and event-specific"
                )

        event_shape(definitions[entry["schema"][8:]])


def current_inventory(root):
    server = (root / "core/host/src/server.rs").read_text()
    subscription = (root / "core/host/src/subscription/host.rs").read_text()
    remote = (root / "core/host/src/gateway/session.rs").read_text()
    match = re.search(r"const METHODS: &\[&str\] = &\[(.*?)\];", remote, re.S)
    if not match:
        raise ValueError("Remote METHODS declaration moved; update inventory extractor")
    local = set()
    for source, start, end in (
        (server, "fn client_state(", "fn "),
        (server, "async fn dispatch(&self", "async fn register("),
        (subscription, "async fn subscription_dispatch(", "\n    async fn "),
    ):
        offset = source.index(start)
        body = source[offset:]
        if start == "fn client_state(":
            body = body[: body.index("\n    fn ", 1)]
        elif end in body[len(start) :]:
            body = body[: body.index(end, len(start))]
        for arm in re.findall(r'((?:"[A-Za-z][A-Za-z0-9_.:/-]*"\s*(?:\|\s*)?)+)\s*=>', body):
            local.update(re.findall(r'"([A-Za-z][A-Za-z0-9_.:/-]*)"', arm))
    connection = server[
        server.index("async fn connection_loop(") : server.index(
            "impl Host {", server.index("async fn connection_loop(")
        )
    ]
    local.update(re.findall(r'request\.method\s*==\s*"([A-Za-z][A-Za-z0-9_.:/-]*)"', connection))
    dispatch_connection = server[
        server.index("async fn dispatch_connection(") : server.index("async fn dispatch(&self")
    ]
    local.update(re.findall(r'method\s*==\s*"([A-Za-z][A-Za-z0-9_.:/-]*)"', dispatch_connection))
    loopback = (root / "core/host/src/loopback.rs").read_text()
    loopback_match = re.search(r"const METHODS: &\[&str\] = &\[(.*?)\];", loopback, re.S)
    if not loopback_match:
        raise ValueError("Loopback METHODS declaration moved; update inventory extractor")
    shared_reads = (root / "core/host/src/gateway/shared_reads.rs").read_text()
    read_match = re.search(r"const METHODS: &\[&str\] = &\[(.*?)\];", shared_reads, re.S)
    if not read_match:
        raise ValueError("Negotiated read METHODS declaration moved; update inventory extractor")
    uploads = (root / "core/host/src/gateway/uploads.rs").read_text()
    upload_match = re.search(r"const METHODS: &\[&str\] = &\[(.*?)\];", uploads, re.S)
    if not upload_match:
        raise ValueError("Negotiated write METHODS declaration moved; update inventory extractor")
    workbench = (root / "core/host/src/workbench_route.rs").read_text()
    workbench_match = re.search(r"const METHODS: &\[&str\] = &\[(.*?)\];", workbench, re.S)
    if not workbench_match:
        raise ValueError("Workbench METHODS declaration moved; update inventory extractor")
    backend = (root / "services/workbench/src/backend-main.cjs").read_text()
    private = re.search(r"const privateMethods = \[(.*?)\];", backend, re.S)
    if not private:
        raise ValueError("Workbench private ready declaration moved; update inventory extractor")
    reverse = workbench[
        workbench.index("pub(super) fn reverse(") : workbench.index("\nfn projects(")
    ]
    reverse_methods = set()
    for arm in re.findall(
        r'((?:"[A-Za-z][A-Za-z0-9_.:/-]*"\s*(?:\|\s*)?)+)(?:\s+if\s+[^=]+)?\s*=>', reverse
    ):
        reverse_methods.update(re.findall(r'"([A-Za-z][A-Za-z0-9_.:/-]*)"', arm))
    private_events = set(
        re.findall(r'request\.event\s*===\s*"([A-Za-z][A-Za-z0-9_.:/-]*)"', backend)
    )
    private_events.update(
        set(re.findall(r'event:\s*"([A-Za-z][A-Za-z0-9_.:/-]*)"', backend)) - {"ready"}
    )
    return {
        "workbenchEvents": private_events,
        "workbench": (reverse_methods - private_events)
        | set(re.findall(r'"([A-Za-z][A-Za-z0-9_.:/-]*)"', private[1])),
        "loopback": {"hello"}
        | set(re.findall(r'"([A-Za-z][A-Za-z0-9_.:/-]*)"', loopback_match[1])),
        "local": local,
        "remote": set(
            re.findall(
                r'"([A-Za-z][A-Za-z0-9_.:/-]*)"',
                match[1] + read_match[1] + upload_match[1] + workbench_match[1],
            )
        ),
    }


def check_inventory(document, root):
    for transport, actual in current_inventory(root).items():
        declared = (
            set(document["x-current"]["workbench"]["events"])
            if transport == "workbenchEvents"
            else set(document["x-current"][transport]["methods"])
        )
        if actual != declared:
            raise ValueError(
                f"{transport} method inventory drift: missing={sorted(actual - declared)}, stale={sorted(declared - actual)}"
            )


class Emitter:
    def __init__(self, document):
        self.defs = {
            name: copy.deepcopy(value)
            for name, value in document["$defs"].items()
            if not name.startswith("WorkbenchPrivate")
        }
        self.private_aliases = set()

        def collect(value):
            if isinstance(value, dict):
                reference = value.get("$ref", "")
                if reference.startswith("#/$defs/WorkbenchPrivate"):
                    self.private_aliases.add(reference[8:])
                for child in value.values():
                    collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)

        for value in self.defs.values():
            collect(value)
        for name in self.private_aliases:
            self.defs[name] = {"x-opaque": True}

    def name_inline(self, value, name):
        if "$ref" in value:
            return value["$ref"][8:]
        if name in self.defs and self.defs[name] != value:
            raise ValueError(f"generated inline name collision: {name}")
        self.defs[name] = value
        return name

    def rust_type(self, value, name):
        if "$ref" in value:
            return value["$ref"][8:]
        if value.get("x-opaque"):
            return "serde_json::Value"
        if (
            "oneOf" in value
            or "anyOf" in value
            or value.get("type") == "object"
            or "enum" in value
            or isinstance(value.get("const"), str)
        ):
            return self.name_inline(value, name)
        if value["type"] == "array":
            if "prefixItems" in value:
                fields = [
                    self.rust_type(item, name + "Item" + str(index + 1))
                    for index, item in enumerate(value["prefixItems"])
                ]
                return "(" + ", ".join(fields) + ("," if len(fields) == 1 else "") + ")"
            return f"Vec<{self.rust_type(value['items'], name + 'Item')}>"
        return {
            "string": "String",
            "integer": "u64" if value.get("minimum", -1) >= 0 else "i64",
            "number": "f64",
            "boolean": "bool",
            "null": "()",
        }[value["type"]]

    def ts_type(self, value):
        if "$ref" in value:
            return value["$ref"][8:]
        if value.get("x-opaque"):
            return "JsonValue"
        if "const" in value:
            return json.dumps(value["const"], ensure_ascii=False)
        if "enum" in value:
            return " | ".join(json.dumps(item) for item in value["enum"])
        for union in ("oneOf", "anyOf"):
            if union in value:
                return " | ".join(self.ts_type(item) for item in value[union])
        kind = value["type"]
        if kind == "array":
            if "prefixItems" in value:
                return "[" + ", ".join(self.ts_type(item) for item in value["prefixItems"]) + "]"
            return f"Array<{self.ts_type(value['items'])}>"
        if kind == "object":
            required = value.get("required", [])
            fields = [
                f"{json.dumps(key)}{'' if key in required else '?'}: {self.ts_type(child)};"
                for key, child in value.get("properties", {}).items()
            ]
            extra = value.get("additionalProperties", True)
            if extra is not False:
                fields.append(
                    f"[key: string]: {self.ts_type(extra) if isinstance(extra, dict) and not fields else 'unknown'};"
                )
            return "{ " + " ".join(fields) + " }"
        return {
            "integer": "number",
            "number": "number",
            "string": "string",
            "boolean": "boolean",
            "null": "null",
        }[kind]

    def rust_definition(self, name, value):
        derive = "#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]"
        if "oneOf" in value or "anyOf" in value:
            variants = value.get("oneOf", value.get("anyOf"))
            lines = [derive, "#[serde(untagged)]", f"pub enum {name} {{"]
            # 结构体分支间接存储；字符串和容器已在堆上，不再增加一层分配。
            for index, child in enumerate(variants):
                kind = self.rust_type(child, name + "Variant" + str(index + 1))
                scalar = kind in {"()", "bool", "i64", "u64", "f64", "String", "serde_json::Value"}
                if not scalar and not kind.startswith(("Vec<", "std::collections::")):
                    kind = f"Box<{kind}>"
                lines.append(f"    Variant{index + 1}({kind}),")
            return "\n".join(lines + ["}"])
        if "enum" in value or isinstance(value.get("const"), str):
            values = value.get("enum", [value.get("const")])
            lines = [derive, f"pub enum {name} {{"]
            for index, literal in enumerate(values):
                lines += [f"    #[serde(rename = {json.dumps(literal)})]", f"    Value{index + 1},"]
            return "\n".join(lines + ["}"])
        if value.get("type") != "object" or value.get("x-opaque"):
            return f"pub type {name} = {self.rust_type(value, name)};"
        lines = [
            "#[derive(Clone, serde::Serialize, serde::Deserialize)]"
            if value.get("x-sensitive")
            else derive
        ]
        extra = value.get("additionalProperties", True)
        if extra is False:
            lines.append("#[serde(deny_unknown_fields)]")
        lines.append(f"pub struct {name} {{")
        required = value.get("required", [])
        for key, child in value.get("properties", {}).items():
            typ = self.rust_type(child, name + "Field" + pascal(key))
            attrs = [f"rename = {json.dumps(key)}"]
            if key not in required:
                typ = f"Option<{typ}>"
                attrs += [
                    "default",
                    'skip_serializing_if = "Option::is_none"',
                    'deserialize_with = "deserialize_present"',
                ]
            lines += ["    #[serde(" + ", ".join(attrs) + ")]", f"    pub {snake(key)}: {typ},"]
        if extra is not False:
            typ = (
                self.rust_type(extra, name + "Extra")
                if isinstance(extra, dict)
                else "serde_json::Value"
            )
            lines += [
                "    #[serde(flatten)]",
                f"    pub additional_properties: std::collections::BTreeMap<String, {typ}>,",
            ]
        lines.append("}")
        if value.get("x-sensitive"):
            lines += [
                f"impl std::fmt::Debug for {name} {{",
                "    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {",
                f'        formatter.write_str("{name}([REDACTED])")',
                "    }",
                "}",
            ]
        return "\n".join(lines)

    def render(self, document):
        digest = hashlib.sha256(
            json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        header = f"// Generated by scripts/generate-host-protocol.py. Do not edit.\n// Schema SHA-256: {digest}\n// Structural types only; schema and runtime enforce scalar and semantic constraints.\n// Referenced private transport aliases retain JSON projections; their owning schemas remain exact.\n"
        rust = {}
        while set(self.defs) - set(rust):
            for name in sorted(set(self.defs) - set(rust)):
                rust[name] = self.rust_definition(name, self.defs[name])
        helper = "fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>\nwhere D: serde::Deserializer<'de>, T: serde::Deserialize<'de> {\n    T::deserialize(deserializer).map(Some)\n}\n"
        limits = {
            "LOCAL_MAX_FRAME_BYTES": document["x-current"]["local"]["framing"]["maxFrameBytes"]
        }
        limits.update(
            {
                "REMOTE_" + snake(key).upper(): value
                for key, value in document["x-current"]["remote"]["limits"].items()
            }
        )
        constants = "\n".join(
            f"pub const {key}: u64 = {value};" for key, value in sorted(limits.items())
        )
        rust_output = (
            header
            + "#![allow(dead_code)]\n\n"
            + constants
            + "\n\n"
            + helper
            + "\n"
            + "\n\n".join(rust[name] for name in sorted(rust))
            + "\n"
        )
        ts = [
            header,
            "export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };",
            "",
        ]
        ts += [f"export declare const {key}: {value};" for key, value in sorted(limits.items())]
        ts += [
            f"export type {name} = {self.ts_type(value)};"
            for name, value in sorted(document["$defs"].items())
            if not name.startswith("WorkbenchPrivate")
        ]
        ts += [
            "// Private transport projections remain JSON values; their finite owning schemas and runtime Core decoders enforce the full contract."
        ]
        ts += [f"export type {name} = JsonValue;" for name in sorted(self.private_aliases)]
        for transport in ("local", "remote", "loopback"):
            ts += ["", f"export interface {pascal(transport)}MethodMap {{"]
            for method, entry in sorted(document["x-current"][transport]["methods"].items()):
                ts.append(
                    f"  {json.dumps(method)}: {{ request: {entry['request'][8:]}; result: {entry['result'][8:]} }};"
                )
            ts.append("}")
        rust_output = subprocess.run(
            ["rustfmt", "--edition", "2024", "--emit", "stdout"],
            input=rust_output,
            text=True,
            capture_output=True,
            check=True,
        ).stdout
        return rust_output, "\n".join(ts) + "\n"


def generate(root=ROOT, check=False):
    document = json.loads((root / SCHEMA).read_text())
    validate_schema(document, root)
    check_inventory(document, root)
    outputs = Emitter(document).render(document)
    for relative, content in zip(OUTPUTS, outputs):
        path = root / relative
        if check:
            if not path.exists() or path.read_text() != content:
                raise ValueError(
                    f"stale generated file: {relative}; run python3 scripts/generate-host-protocol.py"
                )
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        document = generate(check=args.check)
    except (ValueError, KeyError) as error:
        print(error, file=sys.stderr)
        return 1
    print(
        f"Host protocol {'checked' if args.check else 'generated'} ({len(document['x-current']['local']['methods'])} local, {len(document['x-current']['remote']['methods'])} remote methods)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
