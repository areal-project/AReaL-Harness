//! 无宿主 I/O 的一次性 JavaScript 解释器。原生调用由 Core 接管，不开放 QuickJS libc。
use rquickjs::{Context, Ctx, Exception, Function, Promise, Runtime, Value};
use serde_json::Value as Json;
use std::{sync::mpsc, time::Instant};
use tokio_util::sync::CancellationToken;

pub(super) struct Request {
    pub name: String,
    pub arguments: Json,
    pub reply: mpsc::SyncSender<Result<Json, String>>,
}

#[derive(Default, Debug)]
pub(super) struct Output {
    pub parts: Vec<Json>,
    pub error: Option<String>,
}

fn exception(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if error.is_exception() {
        let value = ctx.catch();
        if let Some(error) = value.as_exception() {
            return error
                .message()
                .unwrap_or_else(|| "JavaScript exception".into());
        }
        if let Some(text) = value.as_string().and_then(|s| s.to_string().ok()) {
            return text;
        }
    }
    error.to_string()
}

pub(super) fn run(
    code: String,
    names: Vec<String>,
    requests: tokio::sync::mpsc::UnboundedSender<Request>,
    cancel: CancellationToken,
    deadline: Instant,
) -> Output {
    let mut output = Output::default();
    let result = (|| -> Result<(), String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(64 * 1024 * 1024);
        runtime.set_max_stack_size(512 * 1024);
        let interrupt = cancel.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            interrupt.is_cancelled() || Instant::now() >= deadline
        })));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        context.with(|ctx| -> Result<(), String> {
            let stopped = cancel.clone();
            let call = Function::new(
                ctx.clone(),
                move |ctx: Ctx<'_>, name: String, arguments: String| -> rquickjs::Result<String> {
                    if stopped.is_cancelled() || Instant::now() >= deadline {
                        return Err(Exception::throw_message(
                            &ctx,
                            "program cancelled or timed out",
                        ));
                    }
                    if arguments.len() > super::MAX_CODE {
                        return Err(Exception::throw_message(
                            &ctx,
                            "native arguments exceed program limit",
                        ));
                    }
                    let arguments = serde_json::from_str(&arguments)
                        .map_err(|_| Exception::throw_message(&ctx, "invalid native arguments"))?;
                    let (reply, received) = mpsc::sync_channel(1);
                    requests
                        .send(Request {
                            name,
                            arguments,
                            reply,
                        })
                        .map_err(|_| Exception::throw_message(&ctx, "program dispatcher closed"))?;
                    loop {
                        // 同步边界只阻塞此专属解释器线程。Core 异步执行并结算原生工具；
                        // 不产生脱离 Turn 的 Promise 或操作，Promise.all 仍保持串行上限。
                        match received.recv_timeout(std::time::Duration::from_millis(20)) {
                            Ok(Ok(result)) => return Ok(result.to_string()),
                            Ok(Err(error)) => return Err(Exception::throw_message(&ctx, &error)),
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                return Err(Exception::throw_message(
                                    &ctx,
                                    "program dispatcher closed",
                                ));
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                        }
                        if stopped.is_cancelled() || Instant::now() >= deadline {
                            return Err(Exception::throw_message(
                                &ctx,
                                "program cancelled or timed out",
                            ));
                        }
                    }
                },
            )
            .map_err(|e| exception(&ctx, e))?;
            // 工厂私有闭包保留宿主回调和输出；用户代码只能使用声明的 tools/text/image。
            let factory: Function = ctx
                .eval(include_str!("bootstrap.js"))
                .map_err(|e| exception(&ctx, e))?;
            let runner: rquickjs::Object = factory
                .call((
                    call,
                    serde_json::to_string(&names).unwrap(),
                    super::MAX_TEXT as u32,
                ))
                .map_err(|e| exception(&ctx, e))?;
            let execute: Function = runner.get("execute").map_err(|e| exception(&ctx, e))?;
            let promise: Promise = execute.call((code,)).map_err(|e| exception(&ctx, e))?;
            let finished = loop {
                if let Some(result) = promise.result::<Value>() {
                    break result.map(|_| ()).map_err(|e| exception(&ctx, e));
                }
                if cancel.is_cancelled() || Instant::now() >= deadline {
                    break Err("program cancelled or timed out".into());
                }
                if !ctx.execute_pending_job() {
                    break Err("program awaited a Promise with no producer".into());
                }
            };
            let get: Function = runner.get("output").map_err(|e| exception(&ctx, e))?;
            if let Ok(parts) = get.call::<_, String>(()) {
                output.parts = serde_json::from_str(&parts).unwrap_or_default();
            }
            finished
        })
    })();
    output.error = result.err();
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn javascript_has_no_host_io_and_bounds_cpu() {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let result = run(
            "text([typeof process,typeof require,typeof fetch,typeof console])".into(),
            vec![],
            tx.clone(),
            CancellationToken::new(),
            Instant::now() + std::time::Duration::from_secs(1),
        );
        assert_eq!(result.error, None);
        assert!(
            result.parts[0]["text"]
                .as_str()
                .unwrap()
                .contains("undefined")
        );
        let start = Instant::now();
        let result = run(
            "while(true){}".into(),
            vec![],
            tx,
            CancellationToken::new(),
            start + std::time::Duration::from_millis(40),
        );
        assert!(result.error.is_some());
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn data_dependencies_filter_intermediates_and_preserve_no_detached_calls() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let worker = std::thread::spawn(move || {
            run(
            "const a=await tools.fs_list({path:'a'}); const b=await tools.fs_read({path:a.data.next}); text(b.data.answer);".into(),
            vec!["fs_list".into(),"fs_read".into()],tx,CancellationToken::new(),Instant::now()+std::time::Duration::from_secs(2))
        });
        let a = rx.blocking_recv().unwrap();
        assert_eq!(a.arguments["path"], "a");
        a.reply
            .send(Ok(
                serde_json::json!({"data":{"next":"b","irrelevant":"large intermediate"}}),
            ))
            .unwrap();
        let b = rx.blocking_recv().unwrap();
        assert_eq!(b.arguments["path"], "b");
        b.reply
            .send(Ok(serde_json::json!({"data":{"answer":42}})))
            .unwrap();
        let result = worker.join().unwrap();
        assert_eq!(result.error, None);
        assert_eq!(
            result.parts,
            vec![serde_json::json!({"type":"inputText","text":"42"})]
        );
    }

    #[test]
    fn selected_text_uses_utf8_bytes_and_large_previews_do_not_abort_the_program() {
        for (code, expected_bytes, failed) in [
            ("text('a'.repeat(8000)); text('tail');", 8000, false),
            ("text('中😀'.repeat(4000)); text('tail');", 28000, false),
            ("text('a'.repeat(1048576));", 1048576, false),
            ("text('😀'.repeat(262145));", 0, true),
        ] {
            let (tx, _) = tokio::sync::mpsc::unbounded_channel();
            let output = run(
                code.into(),
                vec![],
                tx,
                CancellationToken::new(),
                Instant::now() + std::time::Duration::from_secs(5),
            );
            assert_eq!(output.error.is_some(), failed, "{output:?}");
            if !failed {
                assert_eq!(
                    output.parts[0]["text"].as_str().unwrap().len(),
                    expected_bytes
                );
                if expected_bytes < 1048576 {
                    assert_eq!(output.parts[1]["text"], "tail");
                }
            }
        }
    }

    #[test]
    fn native_result_display_deduplicates_data_without_removing_execution_facts() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let worker = std::thread::spawn(move || {
            run(
            "const r=await tools.read({}); if(!r.text) throw Error('missing raw access'); text(r);".into(),
            vec!["read".into()], tx, CancellationToken::new(), Instant::now() + std::time::Duration::from_secs(2))
        });
        rx.blocking_recv()
            .unwrap()
            .reply
            .send(Ok(serde_json::json!({
                "success":true,"outcome":"succeeded","callId":"original","itemId":"item",
                "data":{"answer":"observed"},"text":"{\"answer\":\"observed\"}","availableImages":0
            })))
            .unwrap();
        let result = worker.join().unwrap();
        assert_eq!(result.error, None);
        let view: Json = serde_json::from_str(result.parts[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(view["data"]["answer"], "observed");
        assert!(view.get("text").is_none());
        assert_eq!(view["outcome"], "succeeded");
        assert_eq!(view["itemId"], "item");
    }
}
