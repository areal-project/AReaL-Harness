#[cfg(target_os = "linux")]
#[test]
fn helper_rejects_missing_private_descriptors() {
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_areal-runtime-reaper"))
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
}
