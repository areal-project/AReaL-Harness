//! 仅在 Core 原子确认空闲后轮换执行 epoch；保留宿主身份、实例锁和持久历史。
use super::*;

#[derive(Default)]
pub(super) struct Rotation {
    disabled: bool,
}

fn eligible(status: &Value) -> bool {
    status["runtime"]["rotationRecommended"] == true
        && status["runtime"]["admissionOpen"] == true
        && status["runtime"]["recovery"].is_null()
        && status["runtime"]["activeProcesses"] == 0
        && status["lifecycle"]["version"] == 1
        && status["lifecycle"]["admission"] == "open"
        && status["lifecycle"]["ifIdle"]["allowed"] == true
        && status["lifecycle"]["settled"]["allowed"] == true
}

async fn admit(service: &Service, shutdown: &CancellationToken) -> Option<Value> {
    // 未收到成功回执时不能推断准入关闭权；宿主退出也不能被维护 RPC 长时间阻塞。
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => None,
        result = timeout(Duration::from_secs(3), rpc(service, "areal/server/drain",
            json!({"strategy":"runtimeRotation","timeoutMs":0}))) => result.ok()?.ok(),
    }
}

impl Rotation {
    pub(super) async fn check(
        &mut self,
        spec: &LaunchSpec,
        launch: LaunchContext<'_>,
        service: &mut Service,
        child: &mut Child,
        shutdown: &CancellationToken,
    ) -> Result<()> {
        if self.disabled {
            return Ok(());
        }
        // 观察失败不证明容量或清理状态；保留原实例，下一轮重新观察。
        let Ok(Ok(status)) = timeout(
            Duration::from_secs(3),
            rpc(service, "areal/server/status", json!({})),
        )
        .await
        else {
            return Ok(());
        };
        if !eligible(&status) {
            return Ok(());
        }
        if !matches!(
            storage::has_admitted_stop_receipt(&spec.directory()?, &service.identity),
            Ok(false)
        ) {
            return Ok(());
        }
        // 维护不得顺便升级二进制、放宽权限或应用待重启配置。模型已支持热更新，单独核对。
        let Ok(mut fresh) = LaunchSpec::in_bin(&spec.args, spec.bin_dir.clone()) else {
            return Ok(());
        };
        if fresh.fingerprint != spec.fingerprint
            || fresh.service_id != spec.service_id
            || status["configuration"]["modelRevision"].as_str()
                != fresh.components.get("model").map(String::as_str)
            || status["configuration"]["error"].is_string()
        {
            return Ok(());
        }
        fresh.owner = spec.owner.clone();
        if shutdown.is_cancelled() {
            return Ok(());
        }
        let Some(drained) = admit(service, shutdown).await else {
            // 可能是并发显式 drain，或维护受理结果不明；两者都不能授权替代实例。
            return Ok(());
        };
        // 新工作可能赢得准入锁；Core 此时返回仍开放的状态，维护只推迟，不取消它。
        if drained["draining"] != true {
            return Ok(());
        }
        ensure!(
            drained["lifecycle"]["ifIdle"]["allowed"] == true
                && drained["lifecycle"]["admission"] == "draining"
                && drained["lifecycle"]["settled"]["allowed"] == true
                && drained["restartSafe"] == true,
            "Runtime rotation admission or settlement is unconfirmed"
        );
        eprintln!(
            "Rotating idle Core/Runtime: {}",
            status["runtime"]["runtimeEpoch"]
        );
        finish(child, ExitExpectation::RequireSuccess).await?;
        ensure!(
            storage::store_available(&service.identity.data_dir)?,
            "previous Core still owns the store after rotation cleanup"
        );
        if shutdown.is_cancelled() {
            return Ok(());
        }
        *child = start_launcher(&fresh, launch).await?;
        let next = wait_ready(&fresh, &service.identity, launch.ready, child, shutdown).await?;
        storage::write(
            &spec.directory()?.join("components.json"),
            &fresh.components,
        )?;
        storage::write(&spec.directory()?.join("service.json"), &next)?;
        *service = next;
        // 部署小到启动本身已达预警时，禁止在无新工作下反复重启。
        // 新实例已就绪；辅助观察失败不能再停止它，下次维护周期继续观察。
        self.disabled = timeout(
            Duration::from_secs(3),
            rpc(service, "areal/server/status", json!({})),
        )
        .await
        .is_ok_and(|result| {
            result.is_ok_and(|status| status["runtime"]["rotationRecommended"] == true)
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};

    async fn stalled_admission(cancel: bool) {
        let directory = tempfile::tempdir().unwrap();
        let auth = directory.path().join("auth.json");
        storage::write(
            &auth,
            &json!({"version":1,"principals":[{
                "id":"fixture", "token":"fixture-token", "permissions":["manage"]
            }]}),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = Service {
            identity: Identity {
                protocol_version: VERSION,
                service_id: "fixture".into(),
                generation: "fixture".into(),
                workspace: directory.path().into(),
                data_dir: directory.path().into(),
                config_fingerprint: "fixture".into(),
            },
            owner: None,
            endpoint: format!("ws://{}", listener.local_addr().unwrap()),
            web_url: String::new(),
            auth_file: auth,
            log_file: directory.path().join("host.log"),
            host_pid: 1,
            core_pid: 2,
            state: State::Ready,
        };
        let (sent, entered) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let request: Value = serde_json::from_str(text).unwrap();
                if request["method"] == "initialize" {
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            json!({"id":request["id"],"result":{}}).to_string().into(),
                        ))
                        .await
                        .unwrap();
                } else if request["method"] == "areal/server/drain" {
                    assert_eq!(
                        request["params"],
                        json!({"strategy":"runtimeRotation","timeoutMs":0})
                    );
                    sent.send(()).unwrap();
                    // 请求已经到达，但受理结果未知；不通过丢响应伪造未受理。
                    std::future::pending::<()>().await;
                    break;
                }
            }
        });
        let shutdown = CancellationToken::new();
        let request_shutdown = shutdown.clone();
        let operation = tokio::spawn(async move { admit(&service, &request_shutdown).await });
        timeout(Duration::from_secs(5), entered)
            .await
            .unwrap()
            .unwrap();
        assert!(!operation.is_finished());
        if cancel {
            shutdown.cancel();
            assert!(
                timeout(Duration::from_secs(1), operation)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_none()
            );
        } else {
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(3)).await;
            let result = operation.await.unwrap();
            tokio::time::resume();
            assert!(result.is_none());
        }
        peer.abort();
        let _ = peer.await;
    }

    #[tokio::test]
    async fn stalled_rotation_admission_times_out_without_replacement_permission() {
        stalled_admission(false).await;
    }

    #[tokio::test]
    async fn shutdown_cancels_stalled_rotation_admission_without_replacement_permission() {
        stalled_admission(true).await;
    }
}
