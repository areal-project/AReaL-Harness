// API 总窗口；输入预算仍需扣除输出预留。来源见 docs/guides/configuration.md。
const CONTEXT_WINDOWS: &[(&str, usize)] = &[
    ("gpt-6.1-sol", 1_050_000),
    ("gpt-6.1-terra", 1_050_000),
    ("gpt-6-sol", 1_050_000),
    ("gpt-6-astra", 1_050_000),
    ("gpt-6-luna", 1_050_000),
    ("gpt-5.6-sol", 1_050_000),
    ("gpt-5.6", 1_050_000),
    ("gpt-5.6-terra", 1_050_000),
    ("gpt-5.6-luna", 1_050_000),
    ("gpt-5.4", 1_050_000),
    ("gpt-5.4-pro", 1_050_000),
    ("gpt-5.4-mini", 400_000),
    ("gpt-5.4-nano", 400_000),
    ("gpt-5.3-codex", 400_000),
    ("claude-fable-5-1", 1_000_000),
    ("claude-fable-5", 1_000_000),
    ("claude-mythos-5-1", 1_000_000),
    ("claude-mythos-5", 1_000_000),
    ("claude-mythos-preview", 1_000_000),
    ("claude-opus-5-5", 1_000_000),
    ("claude-opus-5", 1_000_000),
    ("claude-opus-4-8", 1_000_000),
    ("claude-opus-4-7", 1_000_000),
    ("claude-opus-4-6", 1_000_000),
    ("claude-sonnet-5-5", 1_000_000),
    ("claude-sonnet-5", 1_000_000),
    ("claude-sonnet-4-6", 1_000_000),
    ("claude-haiku-5-5", 1_000_000),
    ("deepseek-flash", 1_000_000),
    ("deepseek-v4-pro", 1_000_000),
    ("deepseek-v4-flash", 1_000_000),
    ("deepseek-v4-flash-vision-exp", 1_000_000),
    ("qwen3.8-max", 1_000_000),
    ("qwen3.8-flash", 1_000_000),
    ("qwen3.7-max", 1_000_000),
    ("qwen3.7-plus", 1_000_000),
    ("qwen3.7-flash", 1_000_000),
    ("qwen-plus", 1_000_000),
    ("qwen3.6-plus", 1_000_000),
    ("qwen3.6-plus-2026-04-02", 1_000_000),
    ("kimi-k3", 1_048_576),
    ("kimi-k3.1-pro", 1_048_576),
    ("kimi-k3.1-pro-highspeed", 1_048_576),
    ("kimi-k2.5", 262_144),
    ("kimi-k2.6", 262_144),
    ("kimi-k2-0905-preview", 262_144),
    ("kimi-k2-turbo-preview", 262_144),
    ("glm-5", 200_000),
    ("glm-5.1", 200_000),
];

pub(crate) fn known_context_window(model_id: &str) -> Option<usize> {
    CONTEXT_WINDOWS
        .iter()
        .find_map(|(id, tokens)| (*id == model_id).then_some(*tokens))
}

// 订阅默认与 API 总窗口不同；账号目录有报告时由调用方优先采用。
pub(crate) fn subscription_context_window(model_id: &str) -> Option<usize> {
    match model_id {
        "gpt-6.1-sol" | "gpt-6.1-terra" => Some(500_000),
        "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra"
        | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini" => Some(272_000),
        "gpt-5.3-codex-spark" => Some(128_000),
        _ => None,
    }
}
