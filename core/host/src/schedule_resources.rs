use crate::{LaunchInputs, ProjectRegistration};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

const BUILTIN_SKILL_ID: &str = "openai-skill-creator";
const MAX_SKILLS: usize = 512;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SchedulePreparation {
    Managed {
        resource_state_path: PathBuf,
        user_managed_skills_root: PathBuf,
        project_managed_skills_root: PathBuf,
        project_resource_scope: String,
        default_profile: Value,
    },
    External {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_profile: Option<Value>,
    },
}

pub struct PreparedResources {
    pub deployment_path: PathBuf,
    pub profile: Option<Value>,
    pub fingerprint: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Skill {
    id: String,
    revision: String,
    root: PathBuf,
    metadata: Metadata,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Metadata {
    name: String,
    description: String,
}

#[derive(Default, Deserialize)]
struct ResourceState {
    revision: u64,
    skills: BTreeMap<String, BTreeMap<String, bool>>,
    #[serde(rename = "mcp")]
    _mcp: Vec<Value>,
}

pub fn materialize(
    home: &Path,
    registration: &ProjectRegistration,
    inputs: &LaunchInputs,
) -> Result<PreparedResources> {
    let source = inputs
        .deployment_path
        .as_ref()
        .context("schedule preparation requires a saved deployment")?;
    let preparation = inputs
        .schedule_preparation
        .as_ref()
        .context("schedule preparation inputs missing")?;
    let SchedulePreparation::Managed {
        resource_state_path,
        user_managed_skills_root,
        project_managed_skills_root,
        project_resource_scope,
        default_profile,
    } = preparation
    else {
        let SchedulePreparation::External { default_profile } = preparation else {
            unreachable!()
        };
        if let Some(default_profile) = default_profile {
            validate_profile_reference(default_profile)?;
        }
        return Ok(PreparedResources {
            deployment_path: source.clone(),
            profile: default_profile.clone(),
            fingerprint: "external".into(),
        });
    };
    validate_profile_reference(default_profile)?;
    for path in [
        resource_state_path,
        user_managed_skills_root,
        project_managed_skills_root,
    ] {
        ensure!(
            path.is_absolute(),
            "schedule resource paths must be absolute"
        );
    }
    let state: ResourceState = match fs::read(resource_state_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ResourceState::default(),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        state.revision <= 9_007_199_254_740_991,
        "invalid resource revision"
    );
    let homedir = inputs
        .homedir
        .as_ref()
        .context("managed schedule preparation requires the user home")?;
    let mut selected = scan(homedir, user_managed_skills_root, "user", false, &state)?;
    for (id, skill) in scan(
        &registration.workspace,
        project_managed_skills_root,
        project_resource_scope,
        true,
        &state,
    )? {
        selected.insert(id, skill);
    }
    let mut deployment: Value = serde_json::from_slice(&fs::read(source)?)?;
    let profiles = deployment["profiles"]
        .as_array()
        .filter(|profiles| !profiles.is_empty())
        .context("saved deployment profiles missing")?;
    for profile in profiles {
        validate_profile_reference(profile)?;
    }
    let base_profile = profiles[0].clone();
    let previous: Vec<Skill> =
        serde_json::from_value(deployment.get("skills").cloned().unwrap_or(json!([])))?;
    let builtin = previous
        .iter()
        .rev()
        .find(|skill| skill.id == BUILTIN_SKILL_ID)
        .context("saved managed deployment has no builtin skill")?
        .clone();
    let builtin_root = source.parent().unwrap().join(&builtin.root);
    bounded(&builtin_root.join("SKILL.md"), 1).context("saved builtin skill is unreadable")?;
    let mut skills: Vec<_> = selected.into_values().flatten().collect();
    skills.push(builtin);
    let mut profile = base_profile.clone();
    profile["allowPluginSkills"] = json!(true);
    profile["skills"] = json!(
        skills
            .iter()
            .map(|skill| { json!({"id": skill.id, "revision": skill.revision}) })
            .collect::<Vec<_>>()
    );
    let comparable = comparable_profile(&profile)?;
    let unchanged = profiles
        .iter()
        .rev()
        .find(|candidate| comparable_profile(candidate).is_ok_and(|value| value == comparable));
    if let Some(unchanged) = unchanged {
        profile = unchanged.clone();
    } else {
        profile["revision"] = json!(format!(
            "resources-{}",
            &storage::digest(&serde_json::to_vec(&profile)?)[..32]
        ));
    }
    let mut retained = BTreeMap::new();
    for mut skill in previous.into_iter().chain(skills) {
        if skill.root.is_relative() {
            skill.root = source.parent().unwrap().join(&skill.root);
        }
        if bounded(&skill.root.join("SKILL.md"), 1).is_ok() {
            retained.insert((skill.id.clone(), skill.revision.clone()), skill);
        }
    }
    ensure!(
        retained.len() <= MAX_SKILLS,
        "skill deployment exceeds 512 retained versions"
    );
    deployment["skills"] = serde_json::to_value(retained.into_values().collect::<Vec<_>>())?;
    deployment["profiles"] = json!([base_profile, profile]);
    let directory = home
        .join("host/launch")
        .join(storage::digest(registration.project_id.as_bytes()));
    storage::private_dir(&directory)?;
    let digest = storage::digest(&serde_json::to_vec(&deployment)?);
    let deployment_path = directory.join(format!("deployment-resources-{digest}.json"));
    storage::write(&deployment_path, &deployment)?;
    Ok(PreparedResources {
        deployment_path,
        profile: Some(json!({"id": profile["id"], "revision": profile["revision"]})),
        fingerprint: profile["revision"].as_str().unwrap().into(),
    })
}

fn validate_profile_reference(profile: &Value) -> Result<()> {
    ensure!(
        profile.is_object() && profile["id"].is_string() && profile["revision"].is_string(),
        "invalid schedule profile reference"
    );
    Ok(())
}

fn comparable_profile(profile: &Value) -> Result<Value> {
    let mut profile = profile.clone();
    let fields = profile
        .as_object_mut()
        .context("profile must be an object")?;
    fields.remove("revision");
    if let Some(Value::Array(skills)) = fields.get_mut("skills") {
        skills.sort_by_key(Value::to_string);
    }
    Ok(profile)
}

fn scan(
    base: &Path,
    managed: &Path,
    scope: &str,
    project: bool,
    state: &ResourceState,
) -> Result<BTreeMap<String, Option<Skill>>> {
    let base = base.canonicalize()?;
    let mut roots = Vec::new();
    for relative in [".agents/skills", ".claude/skills"] {
        match base.join(relative).canonicalize() {
            Ok(root) => {
                ensure!(
                    !project || root.starts_with(&base),
                    "project skill directory escapes workspace"
                );
                roots.push(root);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    match managed.canonicalize() {
        Ok(root) => roots.insert(0, root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut selected = BTreeMap::new();
    for root in &roots {
        let mut entries = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
        ensure!(
            entries.len() <= MAX_SKILLS,
            "skill directory exceeds 512 entries"
        );
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let kind = entry.file_type()?;
            if id == BUILTIN_SKILL_ID
                || !valid_id(&id)
                || selected.contains_key(&id)
                || !(kind.is_dir() || kind.is_symlink())
            {
                continue;
            }
            let skill = (|| -> Result<Skill> {
                let directory = entry.path().canonicalize()?;
                ensure!(
                    !project
                        || roots.iter().any(|root| directory.starts_with(root))
                        || directory.starts_with(&base),
                    "skill directory escapes trusted roots"
                );
                let metadata = metadata(&bounded(&directory.join("SKILL.md"), 32768)?, &id)?;
                let digest = storage::digest(&serde_json::to_vec(&json!([
                    directory,
                    metadata.name,
                    metadata.description
                ]))?);
                Ok(Skill {
                    id: id.clone(),
                    revision: format!("harness-{}", &digest[..32]),
                    root: directory,
                    metadata,
                })
            })()
            .ok();
            let enabled = state.skills.get(scope).and_then(|scope| scope.get(&id)) != Some(&false);
            // 无效或关闭的项目技能仍覆盖同名用户技能。
            selected.insert(id, skill.filter(|_| enabled));
        }
    }
    Ok(selected)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && !matches!(id, "__proto__" | "constructor" | "prototype")
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn bounded(path: &Path, bytes: u64) -> Result<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    ensure!(
        file.metadata()?.is_file(),
        "skill resource must be a regular file"
    );
    let mut data = Vec::new();
    file.take(bytes + 1).read_to_end(&mut data)?;
    Ok(String::from_utf8_lossy(&data).into_owned())
}

fn reject_yaml_aliases(header: &str) -> Result<()> {
    use std::mem::MaybeUninit;
    use unsafe_libyaml::{
        YAML_ALIAS_TOKEN, YAML_STREAM_END_TOKEN, yaml_parser_delete, yaml_parser_initialize,
        yaml_parser_scan, yaml_parser_set_input_string, yaml_parser_t, yaml_token_delete,
        yaml_token_t,
    };
    let mut parser = Box::new(MaybeUninit::<yaml_parser_t>::uninit());
    let parser = parser.as_mut_ptr();
    // parser 地址在扫描期间固定，输入借用覆盖整个调用；成功产出的 token 和 parser 均成对释放。
    unsafe {
        ensure!(
            yaml_parser_initialize(parser).ok,
            "could not initialize YAML scanner"
        );
        yaml_parser_set_input_string(parser, header.as_ptr(), header.len() as u64);
        let result = (|| -> Result<()> {
            loop {
                let mut token = MaybeUninit::<yaml_token_t>::uninit();
                ensure!(
                    yaml_parser_scan(parser, token.as_mut_ptr()).ok,
                    "invalid skill YAML"
                );
                let mut token = token.assume_init();
                let kind = token.type_;
                yaml_token_delete(&mut token);
                ensure!(
                    kind != YAML_ALIAS_TOKEN,
                    "skill YAML aliases are unsupported"
                );
                if kind == YAML_STREAM_END_TOKEN {
                    return Ok(());
                }
            }
        })();
        yaml_parser_delete(parser);
        result
    }
}

fn metadata(text: &str, id: &str) -> Result<Metadata> {
    let lines: Vec<_> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let (name, description) = if lines[0] == "---" {
        let end = lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| matches!(**line, "---" | "..."))
            .map(|(index, _)| index)
            .context("unterminated skill metadata or metadata exceeds 32 KiB")?;
        let header = lines[1..end].join("\n");
        reject_yaml_aliases(&header)?;
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(&format!("{header}\n"))?;
        ensure!(
            value.is_null() || value.is_mapping(),
            "skill metadata must be an object"
        );
        let field = |key: &str| -> Result<String> {
            match value.get(key) {
                None | Some(serde_yaml_ng::Value::Null) => Ok(String::new()),
                Some(serde_yaml_ng::Value::String(text)) => Ok(text.clone()),
                _ => anyhow::bail!("skill name and description must be text"),
            }
        };
        (field("name")?, field("description")?)
    } else {
        (id.into(), lines[0].into())
    };
    let name = name.trim_matches(|character| {
        matches!(character,
            '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
            | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    });
    let name = if name.is_empty() { id } else { name }.to_owned();
    ensure!(name.len() <= 256, "skill name exceeds 256 bytes");
    let description =
        String::from_utf16_lossy(&description.encode_utf16().take(2048).collect::<Vec<_>>());
    Ok(Metadata { name, description })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProjectSource;
    use areal_local_service::LocalArgs;

    struct Fixture {
        _root: tempfile::TempDir,
        home: PathBuf,
        registration: ProjectRegistration,
        inputs: LaunchInputs,
    }
    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let home = root.join("host-home");
            let user = root.join("user");
            let workspace = root.join("workspace");
            for path in [&home, &user, &workspace] {
                fs::create_dir(path).unwrap();
            }
            let builtin = root.join("builtin");
            write_skill(&builtin, "---\nname: Builtin\ndescription: Official\n---\n");
            let source = root.join("deployment.json");
            fs::write(
                &source,
                serde_json::to_vec(&json!({
                    "profiles": [{"id":"standard","revision":"v2","instructions":"software"}],
                    "skills": [{"id":BUILTIN_SKILL_ID,"revision":"builtin-verified","root":builtin,
                        "metadata":{"name":"Builtin","description":"Official"}}]
                }))
                .unwrap(),
            )
            .unwrap();
            Self {
                _root: temporary,
                home,
                registration: ProjectRegistration {
                    project_id: "project".into(),
                    workspace: workspace.clone(),
                    data_dir: root.join("data"),
                    source: ProjectSource::Cli,
                    default_binding: false,
                },
                inputs: LaunchInputs {
                    workspace: workspace.clone(),
                    cwd: workspace,
                    config_home: root.join("config"),
                    homedir: Some(user),
                    config_path: None,
                    deployment_path: Some(source),
                    schedule_preparation: Some(SchedulePreparation::Managed {
                        resource_state_path: root.join("resources.json"),
                        user_managed_skills_root: root.join("managed/user"),
                        project_managed_skills_root: root.join("managed/project"),
                        project_resource_scope: "legacy-project".into(),
                        default_profile: json!({"id":"standard","revision":"v2"}),
                    }),
                    environment: BTreeMap::new(),
                    credential_names: vec![],
                    options: LocalArgs::default(),
                },
            }
        }
        fn prepare(&self) -> PreparedResources {
            materialize(&self.home, &self.registration, &self.inputs).unwrap()
        }
        fn managed(&self, project: bool) -> PathBuf {
            let SchedulePreparation::Managed {
                user_managed_skills_root,
                project_managed_skills_root,
                ..
            } = self.inputs.schedule_preparation.as_ref().unwrap()
            else {
                unreachable!()
            };
            if project {
                project_managed_skills_root.clone()
            } else {
                user_managed_skills_root.clone()
            }
        }
        fn state(&self, skills: Value) {
            let SchedulePreparation::Managed {
                resource_state_path,
                ..
            } = self.inputs.schedule_preparation.as_ref().unwrap()
            else {
                unreachable!()
            };
            fs::write(
                resource_state_path,
                serde_json::to_vec(&json!({"revision":1,"skills":skills,"mcp":[]})).unwrap(),
            )
            .unwrap();
        }
    }
    fn write_skill(root: &Path, text: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("SKILL.md"), text).unwrap();
    }
    fn deployment(prepared: &PreparedResources) -> Value {
        serde_json::from_slice(&fs::read(&prepared.deployment_path).unwrap()).unwrap()
    }
    fn current_skills(deployment: &Value) -> Vec<String> {
        deployment["profiles"][1]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn managed_roots_win_and_project_disabled_or_invalid_entries_shadow_user_skills() {
        let fixture = Fixture::new();
        let user = fixture.inputs.homedir.as_ref().unwrap();
        for id in ["same", "disabled", "invalid"] {
            write_skill(&user.join(".agents/skills").join(id), "user skill");
        }
        write_skill(&fixture.managed(false).join("same"), "managed user");
        write_skill(
            &fixture.registration.workspace.join(".agents/skills/same"),
            "project agents",
        );
        write_skill(
            &fixture.registration.workspace.join(".claude/skills/same"),
            "project claude",
        );
        let winner = fixture.managed(true).join("same");
        write_skill(&winner, "project managed");
        write_skill(&fixture.managed(true).join("disabled"), "disabled project");
        write_skill(
            &fixture.managed(true).join("invalid"),
            "---\nname: []\n---\n",
        );
        fixture.state(json!({"legacy-project":{"disabled":false}}));
        let prepared = fixture.prepare();
        let value = deployment(&prepared);
        assert_eq!(current_skills(&value), ["same", BUILTIN_SKILL_ID]);
        let same = value["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|skill| skill["id"] == "same")
            .unwrap();
        assert_eq!(same["root"], json!(winner.canonicalize().unwrap()));
        assert_eq!(same["metadata"]["description"], "project managed");
        let expected = storage::digest(
            &serde_json::to_vec(&json!([
                winner.canonicalize().unwrap(),
                "same",
                "project managed"
            ]))
            .unwrap(),
        );
        assert_eq!(same["revision"], format!("harness-{}", &expected[..32]));
    }

    #[test]
    fn unchanged_profile_reuses_electron_revision_and_second_pass_is_stable() {
        let mut fixture = Fixture::new();
        write_skill(&fixture.managed(true).join("zeta"), "zeta metadata");
        write_skill(&fixture.managed(true).join("alpha"), "alpha metadata");
        let first = fixture.prepare();
        let mut value = deployment(&first);
        value["profiles"][1]["skills"]
            .as_array_mut()
            .unwrap()
            .reverse();
        value["profiles"][1]["revision"] = json!("resources-electron-original");
        let source = fixture.inputs.deployment_path.as_ref().unwrap();
        fs::write(source, serde_json::to_vec(&value).unwrap()).unwrap();
        let second = fixture.prepare();
        assert_eq!(second.fingerprint, "resources-electron-original");
        assert_eq!(deployment(&second)["profiles"][1], value["profiles"][1]);
        fixture.inputs.deployment_path = Some(second.deployment_path.clone());
        let third = fixture.prepare();
        assert_eq!(third.fingerprint, second.fingerprint);
        assert_eq!(third.deployment_path, second.deployment_path);
    }

    #[test]
    fn retained_skill_revisions_remain_readable_after_metadata_changes_and_disable() {
        let mut fixture = Fixture::new();
        let source = fixture.managed(true).join("changing");
        write_skill(&source, "old metadata");
        let first = fixture.prepare();
        fixture.inputs.deployment_path = Some(first.deployment_path);
        write_skill(&source, "new metadata");
        let second = fixture.prepare();
        let value = deployment(&second);
        let revisions: Vec<_> = value["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|skill| skill["id"] == "changing")
            .collect();
        assert_eq!(revisions.len(), 2);
        for skill in &revisions {
            assert_eq!(
                fs::read_to_string(Path::new(skill["root"].as_str().unwrap()).join("SKILL.md"))
                    .unwrap(),
                "new metadata"
            );
        }
        fixture.inputs.deployment_path = Some(second.deployment_path);
        fixture.state(json!({"legacy-project":{"changing":false}}));
        let third = fixture.prepare();
        let value = deployment(&third);
        assert_eq!(current_skills(&value), [BUILTIN_SKILL_ID]);
        assert_eq!(
            value["skills"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|skill| skill["id"] == "changing")
                .count(),
            2
        );
    }

    #[test]
    fn trust_rules_allow_user_and_workspace_links_but_reject_skill_file_links() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture.home.join("outside");
        write_skill(&outside, "outside");
        let user_root = fixture
            .inputs
            .homedir
            .as_ref()
            .unwrap()
            .join(".agents/skills");
        fs::create_dir_all(&user_root).unwrap();
        symlink(&outside, user_root.join("escape")).unwrap();
        let inside = fixture.registration.workspace.join("shared");
        write_skill(&inside, "workspace shared");
        let project_root = fixture.registration.workspace.join(".agents/skills");
        fs::create_dir_all(&project_root).unwrap();
        symlink(&inside, project_root.join("linked")).unwrap();
        symlink(&outside, project_root.join("project-escape")).unwrap();
        let file_link = project_root.join("file-link");
        fs::create_dir(&file_link).unwrap();
        symlink(outside.join("SKILL.md"), file_link.join("SKILL.md")).unwrap();
        let prepared = fixture.prepare();
        assert_eq!(
            current_skills(&deployment(&prepared)),
            ["escape", "linked", BUILTIN_SKILL_ID]
        );
    }

    #[test]
    fn directory_and_retained_version_limits_fail_before_writing_a_deployment() {
        let fixture = Fixture::new();
        let managed = fixture.managed(true);
        fs::create_dir_all(&managed).unwrap();
        for index in 0..513 {
            fs::write(managed.join(format!("entry-{index}")), "raw entry").unwrap();
        }
        let failure = materialize(&fixture.home, &fixture.registration, &fixture.inputs)
            .err()
            .unwrap()
            .to_string();
        assert!(failure.contains("512 entries"));
        assert!(!fixture.home.join("host/launch").exists());

        let fixture = Fixture::new();
        let source = fixture.inputs.deployment_path.as_ref().unwrap();
        let mut value: Value = serde_json::from_slice(&fs::read(source).unwrap()).unwrap();
        let builtin = value["skills"][0].clone();
        for index in 0..512 {
            let mut previous = builtin.clone();
            previous["id"] = json!("retained");
            previous["revision"] = json!(format!("revision-{index}"));
            value["skills"].as_array_mut().unwrap().push(previous);
        }
        fs::write(source, serde_json::to_vec(&value).unwrap()).unwrap();
        let failure = materialize(&fixture.home, &fixture.registration, &fixture.inputs)
            .err()
            .unwrap()
            .to_string();
        assert!(failure.contains("512 retained versions"));
        assert!(!fixture.home.join("host/launch").exists());
    }

    #[test]
    fn external_deployment_keeps_saved_path_and_profile() {
        let mut fixture = Fixture::new();
        fixture.inputs.schedule_preparation = Some(SchedulePreparation::External {
            default_profile: Some(json!({"id":"custom","revision":"custom-revision"})),
        });
        let prepared = fixture.prepare();
        assert_eq!(
            Some(prepared.deployment_path),
            fixture.inputs.deployment_path
        );
        assert_eq!(
            prepared.profile,
            Some(json!({"id":"custom","revision":"custom-revision"}))
        );
        assert_eq!(prepared.fingerprint, "external");
    }

    #[test]
    fn external_deployment_without_a_selected_profile_preserves_none() {
        let mut fixture = Fixture::new();
        fixture.inputs.schedule_preparation =
            Some(serde_json::from_value(json!({"kind":"external"})).unwrap());
        let prepared = fixture.prepare();
        assert_eq!(
            Some(prepared.deployment_path),
            fixture.inputs.deployment_path
        );
        assert!(prepared.profile.is_none());
        assert_eq!(prepared.fingerprint, "external");
    }

    #[test]
    fn metadata_preserves_yaml_and_plain_text_contract() {
        let meta = metadata(
            "---\r\nname: '  Skill  '\r\ndescription: >\r\n  first\r\n  second\r\n...\r\nbody",
            "id",
        )
        .unwrap();
        assert_eq!(meta.name, "Skill");
        assert_eq!(meta.description, "first second\n");
        assert_eq!(
            metadata("plain first line\nbody", "fallback")
                .unwrap()
                .description,
            "plain first line"
        );
        assert_eq!(
            metadata("---\nname: null\ndescription: null\n---", "fallback")
                .unwrap()
                .name,
            "fallback"
        );
        assert!(metadata("---\nname: &name Skill\ndescription: *name\n---", "id").is_err());
        assert_eq!(
            metadata("---\ndescription: '*name'\n---", "id")
                .unwrap()
                .description,
            "*name"
        );
        assert_eq!(
            metadata("---\ndescription: |\n  *name\n---", "id")
                .unwrap()
                .description,
            "*name\n"
        );
        assert!(metadata("---\nname: 1\n---", "id").is_err());
        assert!(metadata("---\nmissing close", "id").is_err());
        assert!(metadata(&format!("---\nname: {}\n---", "字".repeat(86)), "id").is_err());
        assert_eq!(
            metadata(
                &format!("---\ndescription: {}\n---", "x".repeat(3000)),
                "id"
            )
            .unwrap()
            .description
            .len(),
            2048
        );
    }
}
