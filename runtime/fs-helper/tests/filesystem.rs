#![cfg(unix)]
use areal_runtime_protocol::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

struct Fixture(tempfile::TempDir);
impl Fixture {
    fn new() -> Self {
        Self(tempfile::tempdir().unwrap())
    }
    fn run(&self, command: FileCommand) -> Result<Value> {
        areal_runtime_fs::execute(FileHelperRequest {
            root: self.0.path().to_str().unwrap().into(),
            command,
        })
    }
    fn read(&self, path: &str) -> Result<Value> {
        self.run(FileCommand::Read {
            path: path.into(),
            offset: 0,
            max_bytes: MAX_FILE_CHUNK,
        })
    }
    fn write(&self, path: &str, bytes: &[u8], expected: ExpectedFile) -> Result<Value> {
        self.run(FileCommand::Write {
            path: path.into(),
            data_base64: STANDARD.encode(bytes),
            expected,
        })
    }
}
#[test]
fn conditional_binary_create_replace_and_unique_patch_preserve_mode() {
    let f = Fixture::new();
    let first = f.write("code", b"a\0\xff", ExpectedFile::Absent).unwrap();
    assert_eq!(
        STANDARD
            .decode(f.read("code").unwrap()["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"a\0\xff"
    );
    assert_eq!(
        f.write("code", b"bad", ExpectedFile::Absent)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    fs::set_permissions(f.0.path().join("code"), fs::Permissions::from_mode(0o751)).unwrap();
    let second = f
        .write(
            "code",
            b"hello world",
            ExpectedFile::Sha256 {
                value: first["sha256"].as_str().unwrap().into(),
            },
        )
        .unwrap();
    assert_eq!(
        fs::metadata(f.0.path().join("code"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o751
    );
    assert_eq!(
        f.write(
            "code",
            b"bad",
            ExpectedFile::Sha256 {
                value: first["sha256"].as_str().unwrap().into()
            }
        )
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    f.run(FileCommand::ApplyPatch {
        path: "code".into(),
        old_text: "world".into(),
        new_text: "Rust".into(),
        expected_sha256: second["sha256"].as_str().unwrap().into(),
    })
    .unwrap();
    assert_eq!(fs::read(f.0.path().join("code")).unwrap(), b"hello Rust");
    assert_eq!(fs::read_dir(f.0.path()).unwrap().count(), 1);
}
#[test]
fn overlapping_matches_and_all_symlink_components_are_rejected() {
    let f = Fixture::new();
    let written = f.write("file", b"aaa", ExpectedFile::Absent).unwrap();
    assert_eq!(
        f.run(FileCommand::ApplyPatch {
            path: "file".into(),
            old_text: "aa".into(),
            new_text: "x".into(),
            expected_sha256: written["sha256"].as_str().unwrap().into()
        })
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    symlink("file", f.0.path().join("link")).unwrap();
    symlink(f.0.path(), f.0.path().join("redirect")).unwrap();
    for path in [
        "link",
        "redirect/file",
        "../file",
        "./file",
        "/file",
        "a/../file",
    ] {
        assert!(f.read(path).is_err(), "{path}");
    }
    assert_eq!(
        f.run(FileCommand::Stat {
            path: "link".into()
        })
        .unwrap()["kind"],
        "symlink"
    );
    assert!(
        f.write(
            "link",
            b"bad",
            ExpectedFile::Sha256 {
                value: written["sha256"].as_str().unwrap().into()
            }
        )
        .is_err()
    );
    assert_eq!(fs::read(f.0.path().join("file")).unwrap(), b"aaa");
    fs::hard_link(f.0.path().join("file"), f.0.path().join("hard")).unwrap();
    assert!(f.read("file").is_err());
}

#[test]
fn batch_patch_is_single_conditional_edit() {
    let f = Fixture::new();
    let written = f
        .write("code", b"alpha\nbeta\n", ExpectedFile::Absent)
        .unwrap();
    f.run(FileCommand::ApplyPatches {
        path: "code".into(),
        patches: vec![
            TextPatch {
                old_text: "alpha".into(),
                new_text: "one".into(),
            },
            TextPatch {
                old_text: "beta".into(),
                new_text: "two".into(),
            },
        ],
        expected_sha256: written["sha256"].as_str().unwrap().into(),
    })
    .unwrap();
    assert_eq!(fs::read(f.0.path().join("code")).unwrap(), b"one\ntwo\n");
}

#[test]
fn legacy_single_patch_matches_one_element_batch() {
    for (old_text, stale, expected) in [
        ("alpha", false, None),
        ("missing", false, Some(ErrorCode::Conflict)),
        ("beta", false, Some(ErrorCode::Conflict)),
        ("alpha", true, Some(ErrorCode::Conflict)),
        ("", false, Some(ErrorCode::InvalidArgument)),
    ] {
        let f = Fixture::new();
        let original = b"alpha\nbeta beta\n";
        let written = f.write("single", original, ExpectedFile::Absent).unwrap();
        f.write("batch", original, ExpectedFile::Absent).unwrap();
        let digest = if stale {
            "0".repeat(64)
        } else {
            written["sha256"].as_str().unwrap().into()
        };
        let single = f.run(FileCommand::ApplyPatch {
            path: "single".into(),
            old_text: old_text.into(),
            new_text: "one".into(),
            expected_sha256: digest.clone(),
        });
        let batch = f.run(FileCommand::ApplyPatches {
            path: "batch".into(),
            patches: vec![TextPatch {
                old_text: old_text.into(),
                new_text: "one".into(),
            }],
            expected_sha256: digest,
        });
        match expected {
            Some(code) => {
                let single = single.unwrap_err();
                let batch = batch.unwrap_err();
                assert_eq!(single.code, code);
                assert_eq!(batch.code, code);
                assert_eq!(single.message, batch.message);
                assert_eq!(fs::read(f.0.path().join("single")).unwrap(), original);
            }
            None => {
                assert_eq!(single.unwrap(), batch.unwrap());
                assert_eq!(
                    fs::read(f.0.path().join("single")).unwrap(),
                    b"one\nbeta beta\n"
                );
            }
        }
        assert_eq!(
            fs::read(f.0.path().join("single")).unwrap(),
            fs::read(f.0.path().join("batch")).unwrap()
        );
    }
}

#[test]
fn batch_patch_conflict_never_commits_earlier_replacements() {
    let f = Fixture::new();
    let original = b"alpha\nbeta beta\n";
    let written = f.write("code", original, ExpectedFile::Absent).unwrap();
    for (second, expected) in [
        ("missing", written["sha256"].as_str().unwrap()),
        ("beta", written["sha256"].as_str().unwrap()),
        (
            "alpha",
            "0000000000000000000000000000000000000000000000000000000000000000",
        ),
    ] {
        let result = f.run(FileCommand::ApplyPatches {
            path: "code".into(),
            patches: vec![
                TextPatch {
                    old_text: "alpha".into(),
                    new_text: "one".into(),
                },
                TextPatch {
                    old_text: second.into(),
                    new_text: "two".into(),
                },
            ],
            expected_sha256: expected.into(),
        });
        let error = result.unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        if second != "alpha" {
            assert!(error.message.starts_with("patch 2:"));
            assert!(error.message.contains("no changes written"));
            assert!(error.message.contains(if second == "missing" {
                "was not found"
            } else {
                "matched more than once"
            }));
        }
        assert_eq!(fs::read(f.0.path().join("code")).unwrap(), original);
    }
}

#[test]
fn bounded_ranges_directory_pagination_and_special_files() {
    let f = Fixture::new();
    for name in ["c", "a", "b"] {
        f.write(name, b"012345", ExpectedFile::Absent).unwrap();
    }
    let range = f
        .run(FileCommand::Read {
            path: "a".into(),
            offset: 2,
            max_bytes: 2,
        })
        .unwrap();
    assert_eq!(
        STANDARD
            .decode(range["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"23"
    );
    assert_eq!(range["nextOffset"], 4);
    assert_eq!(range["eof"], false);
    let page = f
        .run(FileCommand::List {
            path: "".into(),
            after: None,
            limit: 2,
        })
        .unwrap();
    assert_eq!(page["entries"][0]["name"], "a");
    assert_eq!(page["nextCursor"], "b");
    let page = f
        .run(FileCommand::List {
            path: "".into(),
            after: Some("b".into()),
            limit: 2,
        })
        .unwrap();
    assert_eq!(page["entries"][0]["name"], "c");
    assert!(page["nextCursor"].is_null());
    assert!(
        f.write(
            "oversize",
            &vec![0; MAX_FILE_CHUNK + 1],
            ExpectedFile::Absent
        )
        .is_err()
    );
    assert!(
        std::process::Command::new("mkfifo")
            .arg(f.0.path().join("fifo"))
            .status()
            .unwrap()
            .success()
    );
    assert!(f.read("fifo").is_err()); // NONBLOCK prevents a FIFO from hanging the helper.
    assert!(f.read("").is_err());
}

#[test]
fn long_escaped_directory_names_preserve_bounded_pages_and_lossless_cursors() {
    let f = Fixture::new();
    let mut expected = Vec::new();
    for index in 0..60 {
        let name = format!("{index:03}{}", "\u{1}".repeat(200));
        fs::write(f.0.path().join(&name), b"").unwrap();
        expected.push(name);
    }
    let mut after = None;
    let mut actual = Vec::new();
    loop {
        let page = f
            .run(FileCommand::List {
                path: "".into(),
                after: after.clone(),
                limit: 256,
            })
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() < MAX_FILE_CHUNK);
        let entries = page["entries"].as_array().unwrap();
        assert!(!entries.is_empty());
        actual.extend(
            entries
                .iter()
                .map(|entry| entry["name"].as_str().unwrap().to_owned()),
        );
        let next = page["nextCursor"].as_str().map(str::to_owned);
        if next.is_none() {
            break;
        }
        assert!(after.is_none() || next > after);
        after = next;
    }
    assert_eq!(actual, expected);
}

#[test]
fn staged_delivery_supports_large_binary_creation_modes_and_conditional_delete() {
    let f = Fixture::new();
    let upload_id = uuid::Uuid::new_v4().to_string();
    let bytes = vec![0xff; 150_000];
    for (i, chunk) in bytes.chunks(MAX_FILE_CHUNK).enumerate() {
        f.run(FileCommand::StageFileChunk {
            path: "new/bin/data".into(),
            upload_id: upload_id.clone(),
            offset: (i * MAX_FILE_CHUNK) as u64,
            data_base64: STANDARD.encode(chunk),
        })
        .unwrap();
    }
    assert!(!f.0.path().join("new/bin/data").exists());
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(&bytes));
    f.run(FileCommand::CommitFile {
        path: "new/bin/data".into(),
        upload_id,
        expected: ExpectedFile::Absent,
        expected_executable: None,
        sha256: digest.clone(),
        executable: true,
    })
    .unwrap();
    assert_eq!(fs::read(f.0.path().join("new/bin/data")).unwrap(), bytes);
    assert_eq!(f.read("new/bin/data").unwrap()["executable"], true);
    assert_eq!(
        f.run(FileCommand::RemoveFile {
            path: "new/bin/data".into(),
            expected_sha256: digest.clone(),
            expected_executable: false,
        })
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    f.run(FileCommand::RemoveFile {
        path: "new/bin/data".into(),
        expected_sha256: digest,
        expected_executable: true,
    })
    .unwrap();
    assert!(!f.0.path().join("new/bin/data").exists());
    assert_eq!(fs::read_dir(f.0.path().join("new/bin")).unwrap().count(), 0);
}

#[test]
fn staged_delivery_rejects_stale_baseline_tampered_upload_and_symlink_parent() {
    let f = Fixture::new();
    let old = f.write("file", b"old", ExpectedFile::Absent).unwrap();
    let upload_id = uuid::Uuid::new_v4().to_string();
    f.run(FileCommand::StageFileChunk {
        path: "file".into(),
        upload_id: upload_id.clone(),
        offset: 0,
        data_base64: STANDARD.encode(b"new"),
    })
    .unwrap();
    let command = |sha256: String| FileCommand::CommitFile {
        path: "file".into(),
        upload_id: upload_id.clone(),
        expected: ExpectedFile::Sha256 {
            value: old["sha256"].as_str().unwrap().into(),
        },
        expected_executable: Some(false),
        sha256,
        executable: false,
    };
    assert_eq!(
        f.run(command("0".repeat(64))).unwrap_err().code,
        ErrorCode::Conflict
    );
    fs::write(f.0.path().join("file"), b"external").unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        f.run(command(format!("{:x}", Sha256::digest(b"new"))))
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(f.0.path().join("file")).unwrap(), b"external");
    symlink(f.0.path(), f.0.path().join("redirect")).unwrap();
    assert!(
        f.run(FileCommand::StageFileChunk {
            path: "redirect/file".into(),
            upload_id,
            offset: 0,
            data_base64: STANDARD.encode(b"bad")
        })
        .is_err()
    );
}

#[test]
fn staged_content_delivery_never_broadens_existing_read_write_permissions() {
    use sha2::{Digest, Sha256};
    for (before, executable, after) in [
        (0o600, false, 0o600),
        (0o600, true, 0o700),
        (0o640, true, 0o750),
        (0o751, true, 0o751),
        (0o750, false, 0o640),
    ] {
        let f = Fixture::new();
        let original = f.write("private", b"old", ExpectedFile::Absent).unwrap();
        fs::set_permissions(
            f.0.path().join("private"),
            fs::Permissions::from_mode(before),
        )
        .unwrap();
        let upload_id = uuid::Uuid::new_v4().to_string();
        f.run(FileCommand::StageFileChunk {
            path: "private".into(),
            upload_id: upload_id.clone(),
            offset: 0,
            data_base64: STANDARD.encode(b"new content"),
        })
        .unwrap();
        f.run(FileCommand::CommitFile {
            path: "private".into(),
            upload_id,
            expected: ExpectedFile::Sha256 {
                value: original["sha256"].as_str().unwrap().into(),
            },
            expected_executable: Some(before & 0o111 != 0),
            sha256: format!("{:x}", Sha256::digest(b"new content")),
            executable,
        })
        .unwrap();
        assert_eq!(
            fs::read(f.0.path().join("private")).unwrap(),
            b"new content"
        );
        assert_eq!(
            fs::metadata(f.0.path().join("private"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            after
        );
    }
}
