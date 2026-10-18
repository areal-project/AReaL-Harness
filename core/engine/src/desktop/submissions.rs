//! 管理写入复用持久受理日志；崩溃后的 pending 是 UNKNOWN，禁止自动执行重试。
use super::*;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Submission {
    identity: String,
    request_id: String,
    method: String,
    digest: String,
    state: String,
    response: Option<Value>,
}
pub(super) struct Submissions {
    gate: Mutex<()>,
    entries: Mutex<BTreeMap<String, Submission>>,
}
impl Submissions {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let path = root.join("desktop/submissions.json");
        let mut entries: BTreeMap<String, Submission> = if path.exists() {
            anyhow::ensure!(
                std::fs::metadata(&path)?.len() <= 8 * 1024 * 1024,
                "submission journal exceeds 8 MiB"
            );
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            BTreeMap::new()
        };
        for record in entries.values_mut() {
            if record.state == "accepted" {
                record.state = "unknown".into();
            }
        }
        Ok(Self {
            gate: Mutex::new(()),
            entries: Mutex::new(entries),
        })
    }
}
impl Engine {
    pub async fn management_submission<F, Fut>(
        self: &Arc<Self>,
        identity: String,
        request_id: String,
        method: String,
        parameters: Value,
        run: F,
    ) -> Result<Value>
    where
        F: FnOnce(Arc<Engine>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Value> + Send + 'static,
    {
        self.mutate(move|engine|async move{
   if !valid_id(&request_id){return Err(invalid("invalid requestId"));}
   let key=digest(&(&identity,&method,&request_id))?;let hash=digest(&parameters)?;
   let _gate=engine.desktop.submissions.gate.lock().await;
   let mut entries=engine.desktop.submissions.entries.lock().await;
   if let Some(record)=entries.get(&key){if record.digest!=hash{return Err(Error::Conflict);}return record.response.clone().ok_or_else(||invalid("UNKNOWN_SUBMISSION: inspect current state; mutation was not replayed"));}
   if entries.len()>=4096{return Err(Error::Exhausted("management submission capacity reached; keys are retained for deployment lifetime".into()));}
   if serde_json::to_vec(&*entries).map_err(invalid)?.len()>8*1024*1024-512*1024{return Err(Error::Exhausted("management receipt byte capacity reached".into()));}
   let record=Submission{identity,request_id,method,digest:hash,state:"accepted".into(),response:None};entries.insert(key.clone(),record);
   if let Err(e)=engine.store.save_metadata("submissions",&*entries).await{entries.remove(&key);return Err(invalid(e));}
   drop(entries);
   let mut result=run(engine.clone()).await;
   let mut entries=engine.desktop.submissions.entries.lock().await;
   if serde_json::to_vec(&result).map_err(invalid)?.len()>256*1024 {result=json!({"error":{"code":-32005,"message":"mutation completed; response exceeds receipt budget; inspect authoritative state"}}); }
   let record=entries.get_mut(&key).unwrap();record.state="completed".into();record.response=Some(result.clone());
   if let Err(e)=engine.store.save_metadata("submissions",&*entries).await{let record=entries.get_mut(&key).unwrap();record.state="unknown".into();record.response=None;return Err(invalid(e));}
   Ok(result)
  }).await
    }
    pub async fn management_receipts(&self, identity: &str, request_id: &str) -> Value {
        let entries = self.desktop.submissions.entries.lock().await;
        json!({"data":entries.values().filter(|r|r.identity==identity&&r.request_id==request_id).collect::<Vec<_>>(),"retention":"deploymentLifetime","capacity":4096})
    }
}
