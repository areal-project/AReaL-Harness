use super::*;
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;

#[tokio::test]
async fn lifetime_is_cloexec_and_only_writer_close_ends_owner() {
    let (reader, writer) = UnixStream::pair().unwrap();
    let lifetime = GuiLifetime::claim(reader.into_raw_fd()).unwrap();
    let flags = unsafe { libc::fcntl(lifetime.as_raw_fd(), libc::F_GETFD) };
    assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), lifetime.closed())
            .await
            .is_err()
    );
    drop(writer);
    tokio::time::timeout(std::time::Duration::from_secs(1), lifetime.closed())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn owner_pipe_remains_open_until_its_writer_is_dropped() {
    let (writer, lifetime) = OwnerLifetime::pair().unwrap();
    for fd in [writer._fd.as_raw_fd(), lifetime.as_raw_fd()] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
    }
    lifetime.check_open().unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), lifetime.closed())
            .await
            .is_err()
    );
    drop(writer);
    assert!(lifetime.check_open().is_err());
    tokio::time::timeout(std::time::Duration::from_secs(1), lifetime.closed())
        .await
        .unwrap()
        .unwrap();
}

#[test]
fn neutral_environment_and_legacy_environment_cannot_be_combined() {
    for (owner_key, fd_key) in [
        (SERVICE_OWNER_ENV, SERVICE_LIFETIME_FD_ENV),
        (OWNER_ENV, LIFETIME_FD_ENV),
    ] {
        let vars = [(owner_key, OsString::from("owner")), (fd_key, "3".into())];
        let observed = environment(|key| {
            vars.iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.clone())
        })
        .unwrap();
        assert_eq!(observed.owner, Some("owner".into()));
        assert_eq!(observed.lifetime_fd, Some("3".into()));
    }
    for neutral in [SERVICE_OWNER_ENV, SERVICE_LIFETIME_FD_ENV] {
        for legacy in [OWNER_ENV, LIFETIME_FD_ENV] {
            assert!(
                environment(|key| {
                    [neutral, legacy]
                        .contains(&key)
                        .then(|| "same-value".into())
                })
                .is_err()
            );
        }
    }
    let empty = environment(|_| None).unwrap();
    assert!(empty.owner.is_none());
    assert!(empty.lifetime_fd.is_none());
}

#[test]
fn host_owner_requires_uuid_identity_and_exact_generation() {
    let valid = serde_json::json!({
        "kind":"host",
        "hostId":"a6f126a8-3f0d-4ff2-b64d-a1e5becffdd8",
        "generation":"1b878780-56e0-4e40-b79a-cdc04340a56d"
    });
    let expected = parse_owner(&valid.to_string()).unwrap();
    check(Some(&expected), Some(&expected)).unwrap();
    for field in ["hostId", "generation"] {
        let mut invalid = valid.clone();
        invalid[field] = "invalid".into();
        assert!(parse_owner(&invalid.to_string()).is_err());
        let mut other = valid.clone();
        other[field] = "c0292042-4fac-4bf7-8532-498cf03091dc".into();
        let actual = parse_owner(&other.to_string()).unwrap();
        assert!(check(Some(&expected), Some(&actual)).is_err());
    }
    assert!(check(Some(&expected), None).is_err());
    assert!(check(None, Some(&expected)).is_err());
    let profile = tempfile::tempdir().unwrap();
    let gui = Owner::Gui {
        app_run_id: "a6f126a8-3f0d-4ff2-b64d-a1e5becffdd8".into(),
        profile: profile.path().canonicalize().unwrap(),
    };
    assert!(check(Some(&expected), Some(&gui)).is_err());
}

#[test]
fn owner_parser_rejects_invalid_application_identity_and_profile() {
    let profile = tempfile::tempdir().unwrap();
    let path = profile.path().canonicalize().unwrap();
    let valid = serde_json::json!({"kind":"gui","appRunId":"a6f126a8-3f0d-4ff2-b64d-a1e5becffdd8","profile":path});
    assert!(parse_owner(&valid.to_string()).is_ok());
    for (key, value) in [
        ("appRunId", "invalid"),
        ("profile", "relative/profile"),
        ("kind", "cli"),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value.into();
        assert!(parse_owner(&invalid.to_string()).is_err());
    }
}
