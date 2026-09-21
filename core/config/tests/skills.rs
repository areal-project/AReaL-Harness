use areal_config::skills::discover;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn skill(base: &Path, directory: &str, name: &str, body: &str) -> PathBuf {
    let root = base.join(directory).join(name);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("SKILL.md"), body).unwrap();
    root
}

#[test]
fn project_overrides_global_and_agents_overrides_claude_by_directory_name() {
    let user = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    skill(user.path(), ".claude/skills", "review", "global claude");
    skill(user.path(), ".agents/skills", "review", "global agents");
    skill(project.path(), ".claude/skills", "review", "project claude");
    let winner = skill(project.path(), ".agents/skills", "review", "project agents");
    skill(user.path(), ".agents/skills", "global-only", "global");
    skill(project.path(), ".claude/skills", "legacy", "legacy");
    for expected in [
        "project agents",
        "project claude",
        "global agents",
        "global claude",
    ] {
        let found = discover(Some(project.path()), Some(user.path()))
            .unwrap()
            .skills;
        assert_eq!(
            found.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["global-only", "legacy", "review"]
        );
        let selected = found.iter().find(|s| s.id == "review").unwrap();
        assert_eq!(
            fs::read_to_string(selected.root.join("SKILL.md")).unwrap(),
            expected
        );
        if expected == "project agents" {
            assert_eq!(selected.root, winner.canonicalize().unwrap());
        }
        fs::remove_dir_all(&selected.root).unwrap();
    }
}

#[test]
fn metadata_versions_are_stable_and_do_not_hash_supporting_resources() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let a = skill(first.path(), ".agents/skills", "review", "body");
    let b = skill(second.path(), ".agents/skills", "review", "body");
    for root in [&a, &b] {
        fs::create_dir(root.join("references")).unwrap();
        fs::write(root.join("references/check.md"), "check v1").unwrap();
    }
    let revision = discover(Some(first.path()), None).unwrap().skills[0]
        .revision
        .clone();
    assert_eq!(
        revision,
        discover(Some(second.path()), None).unwrap().skills[0].revision
    );
    fs::write(b.join("references/check.md"), "check v2").unwrap();
    assert_eq!(
        revision,
        discover(Some(second.path()), None).unwrap().skills[0].revision
    );
    fs::write(
        b.join("SKILL.md"),
        "---\nname: review\ndescription: updated\n---\nbody",
    )
    .unwrap();
    assert_ne!(
        revision,
        discover(Some(second.path()), None).unwrap().skills[0].revision
    );
}

#[test]
fn missing_roots_and_non_skill_entries_do_not_require_a_home() {
    let project = tempfile::tempdir().unwrap();
    assert!(
        discover(Some(project.path()), None)
            .unwrap()
            .skills
            .is_empty()
    );
    assert!(discover(None, None).unwrap().skills.is_empty());
    fs::create_dir_all(project.path().join(".agents/skills/empty")).unwrap();
    fs::write(project.path().join(".agents/skills/README.md"), "index").unwrap();
    skill(project.path(), ".agents/skills", ".internal", "hidden");
    assert!(
        discover(Some(project.path()), None)
            .unwrap()
            .skills
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn installer_links_deduplicate_and_can_reference_global_canonical_skills() {
    use std::os::unix::fs::symlink;
    let user = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let global = skill(user.path(), ".agents/skills", "global", "global");
    let local = skill(project.path(), ".agents/skills", "review", "project");
    fs::create_dir_all(project.path().join(".claude/skills")).unwrap();
    symlink(
        "../../.agents/skills/review",
        project.path().join(".claude/skills/review"),
    )
    .unwrap();
    symlink(&global, project.path().join(".claude/skills/global")).unwrap();
    let found = discover(Some(project.path()), Some(user.path()))
        .unwrap()
        .skills;
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].root, global.canonicalize().unwrap());
    assert_eq!(found[1].root, local.canonicalize().unwrap());
    fs::remove_dir_all(&local).unwrap();
    symlink(&global, &local).unwrap();
    let found = discover(Some(project.path()), Some(user.path()))
        .unwrap()
        .skills;
    assert_eq!(found[1].root, global.canonicalize().unwrap());
}

#[cfg(unix)]
#[test]
fn escaping_dangling_and_cyclic_directory_links_are_rejected() {
    use std::os::unix::fs::symlink;
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let foreign = skill(outside.path(), "private", "secret", "secret");
    let root = project.path().join(".agents/skills");
    fs::create_dir_all(&root).unwrap();
    let link = root.join("review");
    for target in [foreign, outside.path().join("missing"), link.clone()] {
        symlink(&target, &link).unwrap();
        let discovery = discover(Some(project.path()), None).unwrap();
        assert!(discovery.skills.is_empty());
        assert_eq!(discovery.warnings.len(), 1);
        assert!(discovery.warnings[0].contains("review"));
        fs::remove_file(&link).unwrap();
    }
    fs::remove_dir(&root).unwrap();
    symlink(outside.path(), &root).unwrap();
    assert!(discover(Some(project.path()), None).is_err());
}

#[cfg(unix)]
#[test]
fn only_entrypoint_links_are_rejected_during_discovery() {
    use std::os::unix::fs::symlink;
    let project = tempfile::tempdir().unwrap();
    let root = skill(project.path(), ".agents/skills", "review", "body");
    symlink("SKILL.md", root.join("extra.md")).unwrap();
    let discovery = discover(Some(project.path()), None).unwrap();
    assert_eq!(discovery.skills.len(), 1);
    assert!(discovery.warnings.is_empty());
    fs::rename(root.join("SKILL.md"), root.join("body.md")).unwrap();
    symlink("body.md", root.join("SKILL.md")).unwrap();
    let discovery = discover(Some(project.path()), None).unwrap();
    assert!(discovery.skills.is_empty());
    assert_eq!(discovery.warnings.len(), 1);
    assert!(discovery.warnings[0].contains("SKILL.md"));
}

#[test]
fn large_assets_and_bodies_do_not_affect_metadata_discovery() {
    let user = tempfile::tempdir().unwrap();
    let root = skill(
        user.path(),
        ".agents/skills",
        "fireworks-tech-graph",
        "---\nname: fireworks\ndescription: >-\n  Draw technical\n  diagrams.\nunknown: [ignored]\n---\n",
    );
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(root.join("SKILL.md"))
        .unwrap()
        .write_all(&vec![0xff; 3 * 1024 * 1024])
        .unwrap();
    fs::File::create(root.join("sample-style1-flat.png"))
        .unwrap()
        .set_len(320_819)
        .unwrap();
    fs::File::create(root.join("large.bin"))
        .unwrap()
        .set_len(1024 * 1024 * 1024)
        .unwrap();
    for i in 0..300 {
        fs::write(root.join(format!("extra-{i}")), "").unwrap();
    }
    let discovery = discover(None, Some(user.path())).unwrap();
    assert!(discovery.warnings.is_empty());
    assert_eq!(discovery.skills.len(), 1);
    assert_eq!(discovery.skills[0].id, "fireworks-tech-graph");
    assert_eq!(discovery.skills[0].metadata.name, "fireworks");
    assert_eq!(
        discovery.skills[0].metadata.description,
        "Draw technical diagrams."
    );
}

#[test]
fn invalid_skills_warn_without_losing_valid_skills_or_falling_back_to_shadowed_copies() {
    let user = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    skill(user.path(), ".agents/skills", "review", "global");
    skill(
        project.path(),
        ".agents/skills",
        "review",
        "---\nname: [bad yaml type]\n---\n",
    );
    skill(user.path(), ".agents/skills", "valid", "body");
    let discovery = discover(Some(project.path()), Some(user.path())).unwrap();
    assert_eq!(
        discovery
            .skills
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["valid"]
    );
    assert_eq!(discovery.warnings.len(), 1);
    assert!(discovery.warnings[0].contains("review"));
    assert!(discovery.warnings[0].contains("invalid skill frontmatter"));
    assert!(discovery.warnings[0].contains(project.path().to_str().unwrap()));
    let broken = project.path().join(".agents/skills/review/SKILL.md");
    for body in [
        "---\nmissing terminator".to_string(),
        format!("---\ndescription: {}", "a".repeat(40 * 1024)),
    ] {
        fs::write(&broken, body).unwrap();
        let discovery = discover(Some(project.path()), Some(user.path())).unwrap();
        assert_eq!(discovery.skills.len(), 1);
        assert_eq!(discovery.warnings.len(), 1);
    }
}

#[test]
fn combined_skill_count_is_bounded() {
    let user = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    for i in 0..128 {
        skill(user.path(), ".agents/skills", &format!("s-{i}"), "body");
    }
    skill(project.path(), ".agents/skills", "extra", "body");
    assert!(discover(Some(project.path()), Some(user.path())).is_err());
}
