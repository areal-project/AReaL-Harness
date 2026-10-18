//! 仅折叠已识别测试命令的成功进度行；未知行与失败上下文原样保留。

use std::fmt::Write;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Projection {
    pub kind: &'static str,
    pub stdout: String,
    pub stderr: String,
    pub raw_bytes: usize,
    pub displayed_bytes: usize,
    pub omitted_lines: usize,
}

pub(crate) fn project(
    argv: &[String],
    stdout: &str,
    stderr: &str,
    intact: bool,
) -> Option<Projection> {
    if !intact {
        return None;
    }
    let kind = classify(argv)?;
    let (out, out_omitted) = project_stream(kind, stdout);
    let (err, err_omitted) = project_stream(kind, stderr);
    let raw_bytes = stdout.len() + stderr.len();
    let displayed_bytes = out.len() + err.len();
    // 元数据也占上下文；微小节省不足以抵偿视图契约的成本。
    (displayed_bytes + 512 < raw_bytes).then_some(Projection {
        kind,
        stdout: out,
        stderr: err,
        raw_bytes,
        displayed_bytes,
        omitted_lines: out_omitted + err_omitted,
    })
}

fn project_stream(kind: &str, raw: &str) -> (String, usize) {
    let mut text = String::new();
    let mut omitted = 0;
    let mut pending = 0;
    for line in raw.split_inclusive('\n') {
        // 未闭合的末行可能是跨页诊断片段，不做推断。
        if line.ends_with('\n') && successful_progress(kind, line.trim_end()) {
            pending += 1;
            omitted += 1;
            continue;
        }
        if pending > 0 {
            let _ = writeln!(
                text,
                "… {pending} passing test lines omitted (read_process view=raw) …"
            );
            pending = 0;
        }
        text.push_str(line);
    }
    if pending > 0 {
        let _ = writeln!(
            text,
            "… {pending} passing test lines omitted (read_process view=raw) …"
        );
    }
    (text, omitted)
}

pub(super) fn classify(argv: &[String]) -> Option<&'static str> {
    let executable = argv.first()?.rsplit('/').next()?;
    if matches!(executable, "bash" | "sh" | "zsh") {
        let command = argv.get(argv.iter().position(|s| s == "-c")? + 1)?;
        // 复合命令、重定向和引用需要真正的 shell 解析；保守地保留原文。
        if command.chars().any(|c| "|&;<>$`\\\"'()\n".contains(c)) {
            return None;
        }
        return classify_direct(&command.split_whitespace().collect::<Vec<_>>());
    }
    classify_direct(&argv.iter().map(String::as_str).collect::<Vec<_>>())
}

fn classify_direct(argv: &[&str]) -> Option<&'static str> {
    let executable = argv.first()?.rsplit('/').next()?;
    match executable {
        "jest" => Some("jest"),
        "karma" => Some("karma"),
        "mocha" => Some("mocha"),
        "pytest" | "py.test" => Some("pytest"),
        "cargo" if argv.get(1) == Some(&"test") => Some("cargo-test"),
        "go" if argv.get(1) == Some(&"test") => Some("go-test"),
        "python" | "python3" if argv.get(1..3) == Some(&["-m", "pytest"][..]) => Some("pytest"),
        "npx"
            if argv
                .get(1)
                .is_some_and(|arg| matches!(*arg, "jest" | "karma" | "mocha")) =>
        {
            classify_direct(&argv[1..])
        }
        _ => None,
    }
}

fn successful_progress(kind: &str, line: &str) -> bool {
    // 只丢弃明确成功的进度；不按 error/expected 等关键字筛选诊断。
    match kind {
        "pytest" => {
            line.contains("::") && line.contains(" PASSED ") && line.trim_end().ends_with(']')
        }
        "jest" => line.starts_with("PASS ") || line.starts_with(" PASS "),
        "karma" => {
            (line.starts_with("Chrome ") || line.starts_with("Firefox "))
                && line.contains(": Executed ")
                && line.contains(" SUCCESS ")
        }
        "mocha" => line.trim_start().starts_with("✓ ") || line.trim_start().starts_with("✔ "),
        "cargo-test" => line.starts_with("test ") && line.ends_with(" ... ok"),
        "go-test" => line.trim_start().starts_with("--- PASS: "),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn failure_context_streams_and_omission_counts_survive() {
        let progress = "test_x.py::test_ok PASSED [ 10%]\n".repeat(60);
        let diagnostic = "FAIL test_detail\n    - old nested value\n    + new nested value\nfile.py:42: in test_detail\n    assert actual == expected\nAssertionError\n";
        let raw = format!("{progress}{diagnostic}{progress}");
        let view = project(&argv(&["pytest"]), &raw, "stderr remains separate\n", true).unwrap();
        assert!(view.stdout.contains(diagnostic));
        assert_eq!(view.stderr, "stderr remains separate\n");
        assert_eq!(view.omitted_lines, 120);
        assert_eq!(view.raw_bytes, raw.len() + view.stderr.len());
        assert!(view.displayed_bytes < view.raw_bytes);
    }

    #[test]
    fn log_timestamps_and_unknown_lines_are_not_removed() {
        let diagnostic = "12:30:01.123 INFO [karma]: log\n    + nested\n    - difference\nAssertionError\nTOTAL: 1 FAILED\n";
        let raw = format!(
            "{}{diagnostic}",
            "Chrome 120: Executed 1 of 2 SUCCESS (0 secs)\n".repeat(60)
        );
        let view = project(&argv(&["npx", "karma", "start"]), &raw, "", true).unwrap();
        assert!(view.stdout.contains(diagnostic));
    }

    #[test]
    fn arbitrary_arguments_and_compound_commands_are_passthrough() {
        for values in [
            vec!["echo", "pytest"],
            vec!["cat", "jest.log"],
            vec!["bash", "-c", "pytest; echo other"],
            vec!["bash", "-c", "cat pytest.log"],
            vec!["python3", "script.py", "pytest"],
        ] {
            assert_eq!(classify(&argv(&values)), None);
        }
        assert_eq!(
            classify(&argv(&[
                "bash",
                "-o",
                "pipefail",
                "-c",
                "npx jest --runInBand"
            ])),
            Some("jest")
        );
        assert_eq!(
            classify(&argv(&["python3", "-m", "pytest"])),
            Some("pytest")
        );
    }

    #[test]
    fn tiny_views_and_output_loss_are_passthrough() {
        assert!(project(&argv(&["pytest"]), "test_x.py::x PASSED [100%]\n", "", true).is_none());
        assert!(
            project(
                &argv(&["pytest"]),
                &"test_x.py::x PASSED [100%]\n".repeat(60),
                "",
                false
            )
            .is_none()
        );
    }
}
