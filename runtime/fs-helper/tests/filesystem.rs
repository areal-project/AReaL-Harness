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
