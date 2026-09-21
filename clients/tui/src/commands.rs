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
    ("/sessions", "", "Find and switch sessions"),
    ("/model", "", "Choose a model for this session"),
    ("/new", "", "Start a new session"),
    ("/agents", "", "Inspect this session's child agents"),
    ("/topology", "", "Inspect the full parent/child tree"),
    ("/tasks", "", "Browse the session plan"),
    ("/groups", "", "Browse Workgroups in the side panel"),
    ("/theme", "", "Preview and save a theme"),
    ("/open", "ID", "Open a session by ID or unique prefix"),
    ("/spawn", "PROMPT", "Delegate work under the active Turn"),
    ("/group", "ID", "Inspect a Workgroup"),
    (
        "/group-start",
        "JSON_FILE",
        "Start a Workgroup from a request file"
    ),
    (
        "/group-revise",
        "JSON_FILE",
        "Revise a Workgroup from a request file"
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PickerKind {
    Sessions,
    Models,
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
