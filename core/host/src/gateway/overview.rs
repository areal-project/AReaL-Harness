use super::*;
fn attention(value: &Value) -> Value {
    projection::pick(
        value,
        &[
            "attentionRef",
            "kind",
            "threadId",
            "turnId",
            "taskId",
            "runId",
            "interactionId",
            "questionId",
            "summary",
            "status",
        ],
    )
}
fn work(value: &Value) -> Value {
    let mut result = projection::pick(
        value,
        &[
            "kind",
            "threadId",
            "parentThreadId",
            "taskId",
            "runId",
            "title",
            "sourceUpdatedAt",
            "attentionCount",
            "attentionComplete",
            "resultAvailable",
            "workerCount",
            "workersComplete",
            "summaryTruncated",
        ],
    );
    result["execution"] = projection::pick(
        &value["execution"],
        &["state", "turnId", "turnStatus", "runStatus"],
    );
    result["queue"] = projection::pick(&value["queue"], &["pendingCount", "paused"]);
    result["attentionRefs"] = json!(
        value["attentionRefs"]
            .as_array()
            .into_iter()
            .flatten()
            .map(attention)
            .collect::<Vec<_>>()
    );
    result["workers"] = json!(
        value["workers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|worker| projection::pick(worker, &["threadId", "turnId", "status", "settled"]))
            .collect::<Vec<_>>()
    );
    result["availableActions"] = json!([]);
    result
}
impl Session {
    pub(super) async fn overview(
        &self,
        project: &str,
        generation: &str,
        method: &str,
        params: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(params, &["filter", "cursor", "limit"]),
            "INVALID_PARAMS"
        );
        let limit = params
            .get("limit")
            .map(|limit| limit.as_u64().context("INVALID_PARAMS"))
            .transpose()?
            .unwrap_or(30) as usize;
        ensure!(
            (1..=100).contains(&limit)
                && params.get("filter").is_none_or(|filter| matches!(
                    filter.as_str(),
                    Some("all" | "active" | "attention")
                )),
            "INVALID_PARAMS"
        );
        ensure!(
            params
                .get("cursor")
                .is_none_or(|cursor| cursor.as_str().is_some_and(|cursor| cursor.len() <= 1024)),
            "INVALID_PARAMS"
        );
        let mut result = if method == "work.list" {
            let page = self
                .rpc(project, generation, "areal/work/overview", params.clone())
                .await?;
            let rows = page["data"].as_array().context("CORE_UNAVAILABLE")?;
            json!({"data":rows.iter().map(work).collect::<Vec<_>>(),"nextCursor":page["nextCursor"],"complete":page["complete"]})
        } else {
            let mut cursor = None;
            let mut offset = 0usize;
            if let Some(value) = params.get("cursor") {
                let decoded: Vec<Value> = serde_json::from_slice(
                    &URL_SAFE_NO_PAD
                        .decode(value.as_str().context("INVALID_PARAMS")?)
                        .context("INVALID_PARAMS")?,
                )
                .context("INVALID_PARAMS")?;
                ensure!(
                    decoded.len() == 2
                        && (decoded[0].is_null()
                            || decoded[0]
                                .as_str()
                                .is_some_and(|cursor| cursor.len() <= 256))
                        && decoded[1].as_u64().is_some_and(|offset| offset <= 32),
                    "INVALID_PARAMS"
                );
                cursor = decoded[0].as_str().map(str::to_owned);
                offset = decoded[1].as_u64().unwrap() as usize;
            }
            let mut data = vec![];
            let mut complete = false;
            let mut summaries_complete = true;
            for _ in 0..4 {
                if data.len() >= limit {
                    break;
                }
                let mut query = json!({"filter":"attention","limit":1});
                if let Some(cursor) = &cursor {
                    query["cursor"] = json!(cursor);
                }
                let page = self
                    .rpc(project, generation, "areal/work/overview", query)
                    .await?;
                let Some(row) = page["data"].as_array().context("CORE_UNAVAILABLE")?.first() else {
                    complete = page["complete"] == true;
                    break;
                };
                summaries_complete &= row["attentionComplete"] == true;
                let refs = row["attentionRefs"]
                    .as_array()
                    .context("CORE_UNAVAILABLE")?;
                ensure!(offset <= refs.len(), "INVALID_PARAMS");
                let end = refs.len().min(offset + limit - data.len());
                data.extend(refs[offset..end].iter().map(attention));
                offset = end;
                if offset < refs.len() {
                    break;
                }
                offset = 0;
                cursor = page["nextCursor"].as_str().map(str::to_owned);
                if page["complete"] == true {
                    complete = true;
                    break;
                }
            }
            json!({"data":data,"nextCursor":if complete{None}else{Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!([cursor,offset]))?))},"complete":complete,"summariesComplete":summaries_complete})
        };
        result["projectId"] = json!(project);
        result["serviceGeneration"] = json!(generation);
        ensure!(
            serde_json::to_vec(&result)?.len() <= 128 * 1024,
            "LIMIT_EXCEEDED"
        );
        self.authorize(Some(project), "observe")?;
        Ok(result)
    }
}
