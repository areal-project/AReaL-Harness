import json
import re
from pathlib import Path

NAME = re.compile(r"^[a-z][a-z0-9_]*$")
INTEGER = re.compile(r"^-?(?:0|[1-9][0-9]*)$")

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value

def validate_condition(condition):
    if not isinstance(condition, dict):
        raise ValueError("condition")
    keys = set(condition)
    if keys in ({"all"}, {"any"}):
        children = condition[next(iter(keys))]
        if not isinstance(children, list) or not children:
            raise ValueError("compound")
        for child in children:
            validate_condition(child)
        return
    if keys == {"not"}:
        validate_condition(condition["not"])
        return
    if "field" not in condition or not isinstance(condition["field"], str) or not NAME.fullmatch(condition["field"]):
        raise ValueError("field")
    operations = keys - {"field"}
    if len(operations) != 1:
        raise ValueError("operation")
    operation = next(iter(operations))
    expected = condition[operation]
    if operation == "exists":
        if expected is not True:
            raise ValueError("exists")
    elif operation == "eq":
        if not isinstance(expected, str):
            raise ValueError("eq")
    elif operation == "in":
        if not isinstance(expected, list) or not expected or any(not isinstance(item, str) for item in expected):
            raise ValueError("in")
    elif operation in {"int_lt", "int_le", "int_gt", "int_ge"}:
        if not isinstance(expected, int) or isinstance(expected, bool):
            raise ValueError("integer")
    else:
        raise ValueError("operation")

def load_program(path):
    raw = Path(path).read_bytes()
    if len(raw) > 4096:
        raise ValueError("byte budget")
    rules = []
    for line in raw.decode("utf-8").splitlines():
        if line.strip():
            rules.append(json.loads(line, object_pairs_hook=unique_object))
    if not 1 <= len(rules) <= 12:
        raise ValueError("rule budget")
    for rule in rules:
        if not isinstance(rule, dict) or "when" not in rule:
            raise ValueError("rule")
        actions = [key for key in ("set", "delete") if key in rule]
        if len(actions) != 1 or set(rule) != {"when", actions[0]}:
            raise ValueError("action")
        validate_condition(rule["when"])
        if actions[0] == "set":
            action = rule["set"]
            if not isinstance(action, dict) or set(action) != {"field", "value"}:
                raise ValueError("set")
            if not isinstance(action["field"], str) or not NAME.fullmatch(action["field"]):
                raise ValueError("set field")
            if not isinstance(action["value"], str) or "\n" in action["value"] or "\r" in action["value"]:
                raise ValueError("set value")
        elif not isinstance(rule["delete"], str) or not NAME.fullmatch(rule["delete"]):
            raise ValueError("delete")
    return rules

def matches(condition, fields):
    keys = set(condition)
    if keys == {"all"}:
        return all(matches(child, fields) for child in condition["all"])
    if keys == {"any"}:
        return any(matches(child, fields) for child in condition["any"])
    if keys == {"not"}:
        return not matches(condition["not"], fields)
    name = condition["field"]
    operation = next(iter(keys - {"field"}))
    if operation == "exists":
        return name in fields
    if name not in fields:
        return False
    actual = fields[name]
    expected = condition[operation]
    if operation == "eq":
        return actual == expected
    if operation == "in":
        return actual in expected
    if not INTEGER.fullmatch(actual):
        return False
    number = int(actual)
    if operation == "int_lt":
        return number < expected
    if operation == "int_le":
        return number <= expected
    if operation == "int_gt":
        return number > expected
    return number >= expected

def transform(program_path, data):
    rules = load_program(program_path)
    text = data.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if any(not line.endswith("\n") for line in lines) or "\r" in text:
        raise ValueError("line endings")
    records = []
    active = None
    for index, line in enumerate(lines):
        if line.startswith("@@ record "):
            if active is not None or not line[10:-1]:
                raise ValueError("record start")
            active = {"fields": {}, "field_lines": {}, "end": None}
        elif line == "@@ end\n":
            if active is None:
                raise ValueError("record end")
            active["end"] = index
            records.append(active)
            active = None
        elif active is not None and line != "\n" and not line.startswith("#"):
            body = line[:-1]
            if "=" not in body:
                raise ValueError("record line")
            name, value = body.split("=", 1)
            if not NAME.fullmatch(name) or name in active["fields"]:
                raise ValueError("record field")
            active["fields"][name] = value
            active["field_lines"][name] = index
    if active is not None:
        raise ValueError("unterminated record")
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
                name = rule["set"]["field"]
                if name not in original and name not in new_order:
                    new_order.append(name)
                final[name] = rule["set"]["value"]
            else:
                final.pop(rule["delete"], None)
        for name, line_index in record["field_lines"].items():
            if name not in final:
                deleted.add(line_index)
            elif final[name] != original[name]:
                replacements[line_index] = f"{name}={final[name]}\n"
        insertions[record["end"]] = [f"{name}={final[name]}\n" for name in new_order if name in final]
    output = []
    for index, line in enumerate(lines):
        output.extend(insertions.get(index, []))
        if index not in deleted:
            output.append(replacements.get(index, line))
    return "".join(output).encode("utf-8")
