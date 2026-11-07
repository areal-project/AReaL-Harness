//! 实验性的参数诊断：解释组合 schema 的失败，不重复回显源码或修改参数。
use jsonschema::{ValidationError, error::ValidationErrorKind};
use std::fmt::Write;

const MAX_BYTES: usize = 4096;
const MAX_BRANCHES: usize = 4;
const MAX_ERRORS: usize = 4;
const MAX_DEPTH: usize = 2;

pub(super) fn describe(error: &ValidationError<'_>) -> String {
    let mut result = String::new();
    let _ = write!(
        result,
        "invalid tool arguments at {}: {}",
        error.instance_path,
        error.masked()
    );
    append_alternatives(error, &mut result, 0);
    if result.len() > MAX_BYTES {
        let mut end = MAX_BYTES - 80;
        while !result.is_char_boundary(end) {
            end -= 1;
        }
        result.truncate(end);
        result.push_str("\nDetails omitted; inspect the tool schema before correcting arguments.");
    }
    result
}

fn append_alternatives(error: &ValidationError<'_>, result: &mut String, depth: usize) {
    if depth >= MAX_DEPTH || result.len() >= MAX_BYTES {
        return;
    }
    let branches = match &error.kind {
        ValidationErrorKind::AnyOf { context } | ValidationErrorKind::OneOfNotValid { context } => {
            context
        }
        _ => return,
    };
    // 展示各分支的实际约束，不替模型选择语义，也不把互斥分支拼成一个对象。
    for (index, errors) in branches.iter().take(MAX_BRANCHES).enumerate() {
        let _ = write!(result, "\nSchema alternative {}:", index + 1);
        for error in errors.iter().take(MAX_ERRORS) {
            let _ = write!(result, "\n  at {}: {}", error.instance_path, error.masked());
            append_alternatives(error, result, depth + 1);
            if result.len() >= MAX_BYTES {
                return;
            }
        }
        if errors.len() > MAX_ERRORS {
            result.push_str("\n  Additional constraints omitted; inspect the tool schema.");
        }
    }
    if branches.len() > MAX_BRANCHES {
        result.push_str("\nAdditional alternatives omitted; inspect the tool schema.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn malformed_edit_explains_each_contract_without_echoing_the_body() {
        let definition = super::super::edit_files::definition();
        let validator = jsonschema::validator_for(&definition.input_schema).unwrap();
        let args = json!({"files":[{"path":"src/a.js","oldText":"private-old-body","newText":"private-new-body"}]});
        let message = describe(&validator.validate(&args).unwrap_err());
        assert!(message.contains("/files/0"));
        assert!(message.contains("Schema alternative 1:"));
        assert!(message.contains("Schema alternative 2:"));
        assert!(message.contains("\"text\" is a required property"));
        assert!(message.contains("\"patches\" is a required property"));
        assert!(!message.contains("private-old-body"));
        assert!(!message.contains("private-new-body"));
        assert!(message.len() <= MAX_BYTES);
        // 反馈不接受别名或改写参数；两种公开合法表达仍由同一个校验器接受。
        for valid in [
            json!({"files":[{"path":"src/a.js","text":"body"}]}),
            json!({"files":[{"path":"src/a.js","patches":[{"oldText":"old","newText":"new"}]}]}),
        ] {
            validator.validate(&valid).unwrap();
        }
    }

    #[test]
    fn scalar_errors_retain_bounds_and_nested_paths() {
        let schema = json!({"type":"object","properties":{"reads":{"type":"array","items":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":200}}}}}});
        let validator = jsonschema::validator_for(&schema).unwrap();
        let args = json!({"reads":[{"limit":300}]});
        let message = describe(&validator.validate(&args).unwrap_err());
        assert!(message.contains("/reads/0/limit"));
        assert!(message.contains("200"));
        assert!(!message.contains("300"));
    }

    #[test]
    fn external_nested_schema_is_bounded_and_utf8_safe() {
        let long_name = "字段".repeat(4000);
        let schema = json!({"type":"object","oneOf":[
            {"required":[long_name]},
            {"anyOf":[{"required":["one"]},{"required":["two"]}]}
        ]});
        let validator = jsonschema::validator_for(&schema).unwrap();
        let args = json!({"payload":"do-not-echo-this"});
        let message = describe(&validator.validate(&args).unwrap_err());
        assert!(message.len() <= MAX_BYTES);
        assert!(message.contains("Details omitted"));
        assert!(!message.contains("do-not-echo-this"));
    }
}
