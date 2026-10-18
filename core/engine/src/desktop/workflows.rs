//! 版本化 Workflow 是可绑定到 Agent Profile 的 Workgroup Plan；运行记录归属 Thread。
use super::*;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub id: String,
    pub revision: String,
    pub display_name: String,
    pub plan: crate::workgroup::Plan,
}
impl Engine {
    pub fn workflows(&self) -> Value {
        json!({"data":self.desktop.catalog.read().unwrap().workflows.values().collect::<Vec<_>>()})
    }
    pub fn workflow(&self, r: &VersionRef) -> Result<Workflow> {
        self.desktop
            .catalog
            .read()
            .unwrap()
            .workflows
            .get(&format!("{}/{}", r.id, r.revision))
            .cloned()
            .ok_or(Error::NotFound)
    }
    pub async fn start_workflow(
        self: &Arc<Self>,
        identity: String,
        reference: VersionRef,
        request_id: String,
        workers: Option<usize>,
        admission: crate::workgroup::Admission,
    ) -> Result<Value> {
        if !self.accepting_work() {
            return Err(Error::Closed);
        }
        let workflow = self.workflow(&reference)?;
        self.start_workgroup(
            format!("client:{identity}"),
            crate::workgroup::service::Start {
                request_id,
                plan: workflow.plan,
                workers,
                admission,
            },
            self.shutdown.child_token(),
        )
        .await
        .map_err(invalid)
    }
}
