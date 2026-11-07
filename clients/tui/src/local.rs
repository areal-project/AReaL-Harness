use anyhow::Result;

pub use areal_local_service::LocalArgs;

#[derive(Clone)]
pub(crate) struct HostProject {
    pub(crate) client: areal_host::Client,
    pub(crate) project_id: String,
}

impl HostProject {
    pub(crate) async fn update_notice(&self) -> Result<Option<String>> {
        let client = areal_host::Client::connect_at(self.client.home().to_path_buf()).await?;
        let version_notice = client.version_notice();
        if !client
            .status()
            .await?
            .capabilities
            .iter()
            .any(|c| c == "updates")
        {
            return Ok(version_notice);
        }
        let state = client.update_status().await?;
        let host = &client.identity().executable_version;
        if state["restartPending"] == true {
            let mut notice = format!(
                "Host {host} · update {} pending · apply explicitly with areal host update apply",
                state["targetVersion"].as_str().unwrap_or("unknown")
            );
            if let Some(version_notice) = version_notice {
                notice.push_str(" · ");
                notice.push_str(&version_notice);
            }
            return Ok(Some(notice));
        }
        Ok(version_notice)
    }
    pub(crate) async fn observe_service(&self) -> Result<areal_protocol::service::Service> {
        let client = areal_host::Client::connect_at(self.client.home().to_path_buf()).await?;
        let opened = client.reconnect(&self.project_id).await?;
        Ok(opened.service()?.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::super::Args;
    use clap::Parser;

    #[test]
    fn all_local_clients_monitor_trajectory() {
        let shared = Args::try_parse_from(["areal", "--config", "chosen.toml"]).unwrap();
        assert_eq!(
            shared.trajectory_monitor_config(),
            Some(Some("chosen.toml".into()))
        );
        for args in [
            vec!["areal", "--local-mode", "owned"],
            vec!["areal", "--prompt", "hello"],
            vec!["areal", "--local-mode", "shared", "--prompt", "hello"],
            vec!["areal", "--goal", "finish"],
            vec!["areal", "--input-file", "input.json"],
        ] {
            assert_eq!(
                Args::try_parse_from(args)
                    .unwrap()
                    .trajectory_monitor_config(),
                Some(None)
            );
        }
        let remote = ["areal", "--endpoint", "ws://localhost:1234"];
        assert!(
            Args::try_parse_from(remote)
                .unwrap()
                .trajectory_monitor_config()
                .is_none()
        );
        let child = Args::try_parse_from(remote.into_iter().chain([
            "--local-trajectory-monitor",
            "--local-trajectory-config",
            "/resolved/chosen.toml",
        ]))
        .unwrap();
        assert_eq!(
            child.trajectory_monitor_config(),
            Some(Some("/resolved/chosen.toml".into()))
        );
        assert!(Args::try_parse_from(["areal", "--local-trajectory-monitor"]).is_err());
        assert!(
            Args::try_parse_from(
                remote
                    .into_iter()
                    .chain(["--local-trajectory-config", "/resolved/chosen.toml"])
            )
            .is_err()
        );
    }

    #[test]
    fn default_is_local_and_remote_alias_is_explicit() {
        assert!(Args::try_parse_from(["areal"]).unwrap().endpoint.is_none());
        let args = Args::try_parse_from([
            "areal",
            "--remote",
            "ws://127.0.0.1:4500",
            "--resume",
            "thread-id",
        ])
        .unwrap();
        assert_eq!(args.endpoint.as_deref(), Some("ws://127.0.0.1:4500"));
        assert_eq!(args.resume.as_deref(), Some("thread-id"));
    }

    #[test]
    fn host_migration_preserves_default_profile_selection() {
        for (arguments, expected) in [
            (vec!["areal"], false),
            (vec!["areal", "--local-mode", "owned"], true),
            (vec!["areal", "--prompt", "hello"], true),
            (vec!["areal", "--goal", "finish"], true),
            (vec!["areal", "--input-file", "input.json"], true),
            (
                vec!["areal", "--local-mode", "shared", "--prompt", "hello"],
                false,
            ),
            (vec!["areal", "--endpoint", "ws://localhost:1234"], true),
        ] {
            assert_eq!(
                Args::try_parse_from(arguments)
                    .unwrap()
                    .selects_default_profile(),
                expected
            );
        }
    }

    #[test]
    fn agent_profile_is_selected_by_id_and_revision() {
        let args = Args::try_parse_from(["areal", "--prompt", "hello", "--agent", "code-agent@v2"])
            .unwrap();
        assert_eq!(args.agent.as_deref(), Some("code-agent@v2"));
        assert_eq!(
            areal_local_service::parse_agent_profile(args.agent.as_deref().unwrap())
                .unwrap()
                .id,
            "code-agent"
        );
        let remote = Args::try_parse_from([
            "areal",
            "--endpoint",
            "ws://127.0.0.1:4500",
            "--prompt",
            "hello",
            "--agent",
            "code-agent@v2",
        ])
        .unwrap();
        assert_eq!(remote.agent.as_deref(), Some("code-agent@v2"));
    }

    #[test]
    fn remote_rejects_local_configuration_instead_of_ignoring_it() {
        for local in [
            vec!["--config", "/tmp/config.toml"],
            vec!["--model-provider", "company"],
            vec!["--workspace", "/tmp/workspace"],
            vec!["--data-dir", "/tmp/data"],
            vec!["--model", "model"],
            vec!["--model-endpoint", "http://localhost/model"],
            vec!["--api-key-env", "KEY"],
            vec!["--allow-write"],
        ] {
            let mut args = vec!["areal", "--endpoint", "ws://127.0.0.1:4500"];
            args.extend(local);
            assert!(Args::try_parse_from(args).is_err());
        }
    }
    #[test]
    fn appearance_options_are_valid_for_both_launch_modes() {
        for endpoint in [vec![], vec!["--endpoint", "ws://127.0.0.1:4500"]] {
            let mut args = vec!["areal"];
            args.extend(endpoint);
            args.extend([
                "--theme=light",
                "--color=never",
                "--ascii",
                "--no-logo=false",
                "--mouse=false",
            ]);
            let args = Args::try_parse_from(args).unwrap();
            assert_eq!(args.ui.theme, Some(crate::theme::Theme::Light));
            assert_eq!(args.ui.color, Some(crate::theme::ColorMode::Never));
            assert_eq!(args.ui.no_logo, Some(false));
            assert_eq!(args.ui.ascii, Some(true));
            assert_eq!(args.ui.mouse, Some(false));
        }
    }
}
