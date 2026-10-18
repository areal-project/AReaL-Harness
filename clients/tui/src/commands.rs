use areal_protocol::desktop::ModelRef;

pub struct Command {
    pub name: &'static str,
    pub argument: &'static str,
    pub description: &'static str,
}

macro_rules! commands {
    ($(($name:literal, $argument:literal, $description:literal)),* $(,)?) => {
        pub const COMMANDS: &[Command] = &[$(Command { name: $name, argument: $argument, description: $description }),*];
    };
}

commands![
    (
        "/permissions",
        "[clear-session|clear-project]",
        "Inspect permissions and remembered approvals"
    ),
    ("/goal", "OBJECTIVE", "Start or inspect a durable goal"),
    (
        "/rsi-goal",
        "TEXT",
        "Run three isolated harness templates and choose an output"
    ),
    (
        "/rsi-refresh",
        "",
        "Read RSI candidate status without rerunning"
    ),
    (
        "/rsi-select",
        "CANDIDATE",
        "Persist your choice of RSI winner"
    ),
    (
        "/rsi-artifact",
        "CANDIDATE [OFFSET]",
        "Read an RSI artifact page"
    ),
    (
        "/rsi-evolve",
        "JSON_FILE",
        "Branch a Harness from evaluated feedback"
    ),
    (
        "/rsi-evaluate",
        "JSON_FILE",
        "Record an artifact-bound evaluation"
    ),
    ("/goal-pause", "", "Pause the goal and stop its active Turn"),
    ("/goal-resume", "", "Resume a stopped goal"),
    (
        "/goal-edit",
        "OBJECTIVE",
        "Edit a stopped goal, preserving usage"
    ),
    (
        "/goal-budget",
        "TOKENS|none",
        "Update a stopped goal token budget"
    ),
    ("/goal-clear", "", "Clear a settled goal"),
    ("/sessions", "", "Find and switch sessions"),
    ("/model", "", "Choose a model for this session"),
    ("/skills", "", "Choose a skill for this session"),
    ("/skill", "NAME", "Choose a skill by name"),
    ("/new", "", "Start a new session"),
    (
        "/agents",
        "",
        "Inspect subtask progress, checks and delivery"
    ),
    (
        "/executions",
        "",
        "Inspect subtask progress, checks and delivery"
    ),
    (
        "/execution-cancel",
        "ID",
        "Stop a subtask and wait for cleanup"
    ),
    ("/topology", "", "Inspect the full parent/child tree"),
    ("/tasks", "", "Browse the session plan"),
    ("/groups", "", "Advanced: browse legacy Workgroup history"),
    ("/theme", "", "Preview and save a theme"),
    (
        "/details",
        "",
        "Toggle compact and detailed execution records"
    ),
    (
        "/restore-input",
        "",
        "Restore the last failed submission to the input"
    ),
    ("/open", "ID", "Open a session by ID or unique prefix"),
    ("/spawn", "PROMPT", "Delegate work under the active Turn"),
    ("/group", "ID", "Advanced: inspect a legacy Workgroup"),
    (
        "/group-start",
        "JSON_FILE",
        "Advanced: start a legacy Workgroup from a request file"
    ),
    (
        "/group-revise",
        "JSON_FILE",
        "Advanced: revise a legacy Workgroup from a request file"
    ),
    ("/group-cancel", "ID", "Cancel a Workgroup"),
    ("/more", "", "Load another page of agents"),
    ("/welcome", "", "Show the milk tea welcome page"),
    ("/help", "", "Show keyboard shortcuts"),
    ("/quit", "", "Exit the terminal workspace"),
];

pub fn candidates(input: &str) -> Vec<&'static Command> {
    if !input.starts_with('/') || input.chars().any(char::is_whitespace) {
        return Vec::new();
    }
    COMMANDS
        .iter()
        .filter(|c| c.name.starts_with(input))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsi_goal_completion_exposes_argument_and_help() {
        let matches = candidates("/rsi-go");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "/rsi-goal");
        assert_eq!(matches[0].argument, "TEXT");
        assert!(
            matches[0]
                .description
                .contains("three isolated harness templates")
        );
        assert!(candidates("/rsi-goal query").is_empty());
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PickerKind {
    Sessions,
    Models,
    Skills,
}

pub struct Picker {
    pub kind: PickerKind,
    pub query: String,
    pub selected: usize,
}

impl Picker {
    pub fn new(kind: PickerKind) -> Self {
        Self {
            kind,
            query: String::new(),
            selected: 0,
        }
    }
}

#[derive(Clone)]
pub struct ModelChoice {
    pub label: String,
    pub model: Option<ModelRef>,
    pub available: bool,
}

#[derive(Clone)]
pub struct SkillChoice {
    pub id: String,
    pub revision: String,
    pub label: String,
    pub description: String,
    pub available: bool,
}
