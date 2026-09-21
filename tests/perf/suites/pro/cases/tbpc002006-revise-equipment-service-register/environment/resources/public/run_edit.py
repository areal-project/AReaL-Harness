#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

NAME = re.compile(r"^[a-z][a-z0-9_]*$")
INTEGER = re.compile(r"^-?(?:0|[1-9][0-9]*)$")

class ProgramError(ValueError):
    pass

def object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProgramError("duplicate JSON key")
        result[key] = value
    return result

def validate_condition(condition):
    if not isinstance(condition, dict):
        raise ProgramError("condition must be an object")
    keys = set(condition)
    if keys == {"all"} or keys == {"any"}:
        children = condition[next(iter(keys))]
        if not isinstance(children, list) or not children:
            raise ProgramError("all/any requires a nonempty array")
        for child in children:
            validate_condition(child)
        return
    if keys == {"not"}:
        validate_condition(condition["not"])
        return
    if "field" not in condition or not isinstance(condition["field"], str) or not NAME.fullmatch(condition["field"]):
        raise ProgramError("invalid condition field")
    operations = keys - {"field"}
    if len(operations) != 1:
        raise ProgramError("condition requires exactly one operation")
    operation = next(iter(operations))
    value = condition[operation]
    if operation == "exists":
        if value is not True:
            raise ProgramError("exists must be true")
    elif operation == "eq":
        if not isinstance(value, str):
            raise ProgramError("eq requires a string")
    elif operation == "in":
        if not isinstance(value, list) or not value or any(not isinstance(item, str) for item in value):
            raise ProgramError("in requires a nonempty string array")
    elif operation in {"int_lt", "int_le", "int_gt", "int_ge"}:
        if not isinstance(value, int) or isinstance(value, bool):
            raise ProgramError("integer comparison requires an integer")
    else:
        raise ProgramError("unknown condition operation")

def validate_rule(rule):
    if not isinstance(rule, dict) or "when" not in rule:
        raise ProgramError("rule requires when")
    actions = [name for name in ("set", "delete") if name in rule]
    if len(actions) != 1 or set(rule) != {"when", actions[0]}:
        raise ProgramError("rule requires exactly one action")
    validate_condition(rule["when"])
    if actions[0] == "set":
        action = rule["set"]
        if not isinstance(action, dict) or set(action) != {"field", "value"}:
            raise ProgramError("invalid set action")
        if not isinstance(action["field"], str) or not NAME.fullmatch(action["field"]) or not isinstance(action["value"], str) or "\n" in action["value"] or "\r" in action["value"]:
            raise ProgramError("invalid set value")
    else:
        field = rule["delete"]
        if not isinstance(field, str) or not NAME.fullmatch(field):
            raise ProgramError("invalid delete action")

def load_program(path):
    raw = Path(path).read_bytes()
    if len(raw) > 4096:
        raise ProgramError("program byte budget exceeded")
    text = raw.decode("utf-8")
    rules = []
    for line in text.splitlines():
        if not line.strip():
            continue
        rules.append(json.loads(line, object_pairs_hook=object_without_duplicates))
    if not rules or len(rules) > 12:
        raise ProgramError("program rule budget violated")
    for rule in rules:
        validate_rule(rule)
    return rules

def matches(condition, fields):
    if set(condition) == {"all"}:
        return all(matches(child, fields) for child in condition["all"])
    if set(condition) == {"any"}:
        return any(matches(child, fields) for child in condition["any"])
    if set(condition) == {"not"}:
        return not matches(condition["not"], fields)
    field = condition["field"]
    operation = next(iter(set(condition) - {"field"}))
    if operation == "exists":
        return field in fields
    if field not in fields:
        return False
    actual = fields[field]
    expected = condition[operation]
    if operation == "eq":
        return actual == expected
    if operation == "in":
        return actual in expected
    if not INTEGER.fullmatch(actual):
        return False
    number = int(actual)
    return {
        "int_lt": number < expected,
        "int_le": number <= expected,
        "int_gt": number > expected,
        "int_ge": number >= expected,
    }[operation]

def parse_records(text):
    lines = text.splitlines(keepends=True)
    if any(not line.endswith("\n") for line in lines) or "\r" in text:
        raise ProgramError("input must use LF-terminated lines")
    records = []
    active = None
    for index, line in enumerate(lines):
        if line.startswith("@@ record "):
            if active is not None or not line[10:-1]:
                raise ProgramError("invalid record start")
            active = {"start": index, "fields": {}, "field_lines": {}}
        elif line == "@@ end\n":
            if active is None:
                raise ProgramError("unexpected record end")
            active["end"] = index
            records.append(active)
            active = None
        elif active is not None and line != "\n" and not line.startswith("#"):
            body = line[:-1]
            if "=" not in body:
                raise ProgramError("invalid record line")
            name, value = body.split("=", 1)
            if not NAME.fullmatch(name) or name in active["fields"]:
                raise ProgramError("invalid or duplicate field")
            active["fields"][name] = value
            active["field_lines"][name] = index
    if active is not None:
        raise ProgramError("unterminated record")
    return lines, records

def transform(rules, text):
    lines, records = parse_records(text)
    replacements = {}
    deleted = set()
    insertions = {}
    for record in records:
        original = dict(record["fields"])
        final = dict(original)
        new_order = []
        for rule in rules:
            if not matches(rule["when"], original):
                continue
            if "set" in rule:
                field = rule["set"]["field"]
                if field not in final and field not in original and field not in new_order:
                    new_order.append(field)
                final[field] = rule["set"]["value"]
            else:
                final.pop(rule["delete"], None)
        for field, line_index in record["field_lines"].items():
            if field not in final:
                deleted.add(line_index)
            elif final[field] != original[field]:
                replacements[line_index] = f"{field}={final[field]}\n"
        insertions[record["end"]] = [f"{field}={final[field]}\n" for field in new_order if field in final]
    output = []
    for index, line in enumerate(lines):
        output.extend(insertions.get(index, []))
        if index not in deleted:
            output.append(replacements.get(index, line))
    return "".join(output)

def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: run_edit.py PROGRAM INPUT OUTPUT")
    try:
        rules = load_program(sys.argv[1])
        text = Path(sys.argv[2]).read_bytes().decode("utf-8")
        output = transform(rules, text)
        Path(sys.argv[3]).write_bytes(output.encode("utf-8"))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(2)

if __name__ == "__main__":
    main()
