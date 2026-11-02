//! 只校准同一次 generation 中未改写的请求前缀；工具、历史或媒体变化时回退原始估算。
use super::*;

pub(crate) struct UsageCalibration {
    messages: Vec<Message>,
    tools: Vec<Value>,
    estimated: usize,
    input: u64,
}

impl UsageCalibration {
    pub(crate) fn observe(
        messages: &[Message],
        tools: &[Value],
        estimated: usize,
        input: u64,
    ) -> Option<Self> {
        // 普通 URL/文件内容可以在两次请求之间变化；内联媒体才具备可比较的内容身份。
        let immutable = messages.iter().all(|message| {
            message.content.iter().all(|part| match part {
                ContentPart::Text(_) => true,
                ContentPart::Image { source, .. }
                | ContentPart::Audio { source }
                | ContentPart::File { source, .. } => {
                    matches!(source, MediaSource::Url(url) if url.starts_with("data:"))
                }
            })
        });
        (estimated > 0 && input > 0 && immutable).then(|| Self {
            messages: messages.to_vec(),
            tools: tools.to_vec(),
            estimated,
            input,
        })
    }

    fn baseline(&self, messages: &[Message], tools: &[Value]) -> Option<(usize, u64)> {
        (tools == self.tools && messages.starts_with(&self.messages))
            .then_some((self.estimated, self.input))
    }
}

pub(crate) struct ContextRequest<'a> {
    pub messages: &'a [Message],
    pub tools: &'a [Value],
    pub raw_tokens: usize,
    pub estimated_tokens: usize,
    pub previous_usage: Option<(usize, u64)>,
    calibration: Option<&'a UsageCalibration>,
}

impl<'a> ContextRequest<'a> {
    pub(crate) fn new(
        messages: &'a [Message],
        tools: &'a [Value],
        raw_tokens: usize,
        calibration: Option<&'a UsageCalibration>,
    ) -> Self {
        let previous_usage = calibration.and_then(|c| c.baseline(messages, tools));
        Self {
            messages,
            tools,
            raw_tokens,
            estimated_tokens: calibrated(raw_tokens, previous_usage),
            previous_usage,
            calibration,
        }
    }

    pub(crate) fn prefix_tokens(&self, prefix: &[Message]) -> anyhow::Result<usize> {
        let raw = request_tokens(prefix, self.tools)?;
        if let Some(c) = self.calibration.filter(|c| c.tools == self.tools) {
            if prefix.starts_with(&c.messages) {
                return Ok(calibrated(raw, Some((c.estimated, c.input))));
            }
            if c.messages.starts_with(prefix) {
                // 前缀不长于已结算输入。完整输入加余量是其上界，不按字节比例猜 tokenizer。
                return Ok(calibrated(c.estimated, Some((c.estimated, c.input))));
            }
        }
        Ok(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_usage_replaces_the_settled_estimate_but_not_new_content() {
        let prefix = vec![Message::text("user", "history".repeat(2000))];
        let tools = vec![json!({"function":{"name":"inspect"}})];
        let before = request_tokens(&prefix, &tools).unwrap();
        let usage = UsageCalibration::observe(&prefix, &tools, before, 700).unwrap();
        let mut next = prefix.clone();
        next.push(Message::text("tool", "new evidence".repeat(200)));
        let raw = request_tokens(&next, &tools).unwrap();
        let request = ContextRequest::new(&next, &tools, raw, Some(&usage));
        assert_eq!(request.estimated_tokens, 770 + raw - before);
        assert!(request.estimated_tokens < raw);
        assert_eq!(request.prefix_tokens(&prefix).unwrap(), 770);
    }

    #[test]
    fn changed_history_tools_and_missing_usage_cannot_borrow_old_calibration() {
        let prefix = vec![Message::text("user", "original".repeat(1000))];
        let tools = vec![json!({"function":{"name":"read"}})];
        let before = request_tokens(&prefix, &tools).unwrap();
        let usage = UsageCalibration::observe(&prefix, &tools, before, 50).unwrap();
        let changed = vec![Message::text("user", "different".repeat(1000))];
        let other_tools = vec![json!({"function":{"name":"write"}})];
        for (messages, definitions) in [(&changed, &tools), (&prefix, &other_tools)] {
            let raw = request_tokens(messages, definitions).unwrap();
            assert_eq!(
                ContextRequest::new(messages, definitions, raw, Some(&usage)).estimated_tokens,
                raw
            );
        }
        assert!(UsageCalibration::observe(&prefix, &tools, before, 0).is_none());
        assert_eq!(
            ContextRequest::new(&prefix, &tools, before, None).estimated_tokens,
            before
        );
    }

    #[test]
    fn media_identity_must_be_immutable_and_new_media_keeps_its_full_estimate() {
        let mut message = Message::text("user", "image evidence");
        message.content.push(ContentPart::Image {
            source: MediaSource::Url("https://example.test/mutable.png".into()),
            detail: None,
        });
        assert!(UsageCalibration::observe(&[message.clone()], &[], 5000, 100).is_none());
        message.content[1] = ContentPart::Image {
            source: MediaSource::Url("data:image/png;base64,immutable".into()),
            detail: None,
        };
        let prefix = vec![message.clone()];
        let before = request_tokens(&prefix, &[]).unwrap();
        let usage = UsageCalibration::observe(&prefix, &[], before, 100).unwrap();
        let next = vec![message.clone(), message];
        let raw = request_tokens(&next, &[]).unwrap();
        assert_eq!(
            ContextRequest::new(&next, &[], raw, Some(&usage)).estimated_tokens,
            110 + raw - before
        );
    }

    #[test]
    fn summary_keeps_exact_request_prefix_and_checks_its_full_budget() {
        let history = vec![
            Message::text("user", "original contract"),
            Message::text("assistant", "observed work"),
        ];
        let mut messages = vec![Message::text("system", "stable instructions")];
        messages.extend(history.clone());
        messages.push(Message::text(
            "user",
            "later task must stay outside this checkpoint",
        ));
        let tools = vec![json!({"function":{"name":"read"}})];
        let raw = request_tokens(&messages, &tools).unwrap();
        let request = ContextRequest::new(&messages, &tools, raw, None);
        let (summary, count, _) = prefix_summary_input(&history, &request, "summarize only", None)
            .unwrap()
            .unwrap();
        assert_eq!(&summary[..count], &messages[..3]);
        assert_eq!(summary.last().unwrap().role, "developer");
        assert_eq!(summary.last().unwrap().text_content(), "summarize only");
        assert!(
            prefix_summary_input(&history, &request, "summarize only", Some(1))
                .unwrap()
                .is_none()
        );
        assert!(
            prefix_summary_input(
                &[Message::text("user", "changed")],
                &request,
                "summarize",
                None
            )
            .unwrap()
            .is_none()
        );
    }
}
