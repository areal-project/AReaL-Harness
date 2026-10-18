use super::*;
use areal_protocol::delegation::{ExecutionOwner, ExecutionRef};

impl Engine {
    pub(crate) async fn task_execution_owner_valid(&self, owner: &ExecutionOwner) -> Result<bool> {
        let ExecutionOwner::TaskRun {
            task_id,
            run_id,
            thread_id,
            goal_id,
        } = owner
        else {
            return Ok(false);
        };
        let tasks = self.task_modes.state.lock().await;
        Ok(tasks.tasks.get(task_id).is_some_and(|task| {
            !task.paused
                && !task.cancelled
                && task.runs.iter().any(|run| {
                    &run.id == run_id
                        && run.thread_id.as_ref() == Some(thread_id)
                        && run.goal_id.as_ref() == Some(goal_id)
                })
        }))
    }

    pub(crate) async fn task_run_owner(&self, parent: &Cell) -> Result<Option<ExecutionOwner>> {
        let state = parent.state.lock().await;
        let Some(goal) = state
            .thread
            .goals
            .goal
            .as_ref()
            .filter(|goal| goal.status == GoalStatus::Active)
        else {
            return Ok(None);
        };
        if parent.research || parent.depth != 0 || state.thread.goal_owner.is_some() {
            return Err(invalid(
                "only the TaskRun coordinator may delegate Run-owned work",
            ));
        }
        let tasks = self.task_modes.state.lock().await;
        let Some((task, run)) = tasks.tasks.values().find_map(|task| {
            task.runs
                .last()
                .filter(|run| run.goal_id.as_deref() == Some(goal.id.as_str()))
                .map(|run| (task, run))
        }) else {
            return Ok(None);
        };
        if task.paused || task.cancelled || run.status.terminal() {
            return Err(Error::Conflict);
        }
        Ok(Some(ExecutionOwner::TaskRun {
            task_id: task.id.clone(),
            run_id: run.id.clone(),
            thread_id: parent.id.clone(),
            goal_id: goal.id.clone(),
        }))
    }

    pub(crate) async fn register_task_execution(
        &self,
        owner: &ExecutionOwner,
        execution_id: &str,
        execution: &ExecutionRef,
    ) -> Result<()> {
        let ExecutionOwner::TaskRun {
            task_id,
            run_id,
            thread_id,
            goal_id,
        } = owner
        else {
            return Err(invalid(
                "TaskRun execution registration requires a TaskRun owner",
            ));
        };
        let mut state = self.task_modes.state.lock().await;
        let mut candidate = state.clone();
        let task = candidate.tasks.get_mut(task_id).ok_or(Error::NotFound)?;
        let run = task
            .runs
            .iter_mut()
            .find(|run| &run.id == run_id)
            .ok_or(Error::NotFound)?;
        if run.thread_id.as_ref() != Some(thread_id) || run.goal_id.as_ref() != Some(goal_id) {
            return Err(Error::Conflict);
        }
        if let Some(worker) = run.workers.iter_mut().find(|worker| {
            worker.execution_id.as_deref() == Some(execution_id)
                || worker.execution_ref().as_ref() == Some(execution)
        }) {
            if worker
                .execution_id
                .as_deref()
                .is_some_and(|id| id != execution_id)
                || worker.execution_ref().as_ref() != Some(execution)
            {
                return Err(Error::Conflict);
            }
            if worker.execution.as_ref() == Some(execution)
                && worker.execution_id.as_deref() == Some(execution_id)
            {
                return Ok(());
            }
            worker.execution = Some(execution.clone());
            worker.execution_id = Some(execution_id.into());
        } else {
            if task.paused || task.cancelled || run.status.terminal() {
                return Err(Error::Conflict);
            }
            if run.workers.len() >= self.limits.max_children_per_turn {
                return Err(Error::Exhausted("TaskRun worker capacity reached".into()));
            }
            let (thread_id, turn_id) = match execution {
                ExecutionRef::Thread { thread_id, turn_id } => (thread_id.clone(), turn_id.clone()),
                ExecutionRef::Workgroup { .. } => (String::new(), String::new()),
            };
            run.workers.push(TaskWorker {
                thread_id,
                turn_id,
                execution: Some(execution.clone()),
                execution_id: Some(execution_id.into()),
                status: "running".into(),
                settled: false,
            });
        }
        task.revision += 1;
        self.save_tasks(&mut state, candidate, task_id).await
    }
}

#[cfg(test)]
#[path = "delegations_tests.rs"]
mod tests;
