//! Deterministic granularity control using public inputs, never grading results.
use super::{Plan, Strategy, Task, adapt, tree::Tree, validate};
use anyhow::{Result, ensure};
use std::collections::{BTreeMap, BTreeSet};

/// Bytes are a conservative granularity proxy, not an estimate of model time.
/// A small complete assignment should not pay for many isolated tool loops.
pub const SMALL_PLAN_BYTES: usize = 12_000;
const SMALL_BUNDLE_BYTES: usize = 6_000;

fn weight(task: &Task, source: &Tree) -> usize {
    task.instruction.len()
        + task
            .writes
            .iter()
            .map(|p| p.len() + source.get(p).map_or(0, |f| f.bytes.len()))
            .sum::<usize>()
}

fn known_size(task: &Task, source: &Tree) -> bool {
    task.writes
        .iter()
        .all(|p| source.get(p).is_some_and(|f| !f.bytes.is_empty()))
}

fn merge(plan: &mut Plan, left: usize, right: usize) -> Result<()> {
    let removed = plan.tasks.remove(right);
    let target = &mut plan.tasks[left]; // callers always pass left < right
    target
        .instruction
        .push_str(&format!("\n{}: {}", removed.id, removed.instruction));
    for path in removed.writes {
        if !target.writes.contains(&path) {
            target.writes.push(path);
        }
    }
    for check in removed.checks {
        if !target.checks.contains(&check) {
            target.checks.push(check);
        }
    }
    target.depends.extend(removed.depends);
    let retained = target.id.clone();
    for task in &mut plan.tasks {
        task.depends = task
            .depends
            .iter()
            .map(|id| {
                if id == &removed.id {
                    retained.clone()
                } else {
                    id.clone()
                }
            })
            .filter(|id| id != &task.id)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
    }
    validate(plan)
}

/// First coalesce overlapping writers, then remove boundaries that cannot add
/// parallelism. Independent substantial branches remain separate workspaces.
pub fn prepare(
    plan: Plan,
    source: &Tree,
    strategy: Strategy,
    checks: &[Vec<String>],
    workers: usize,
) -> Result<Plan> {
    ensure!((1..=32).contains(&workers), "invalid worker count");
    // 阶段快照不能因粒度合并丢失模型、指令和权限。
    if plan.tasks.iter().any(|t| t.configuration.is_some()) {
        validate(&plan)?;
        return Ok(plan);
    }
    if strategy != Strategy::Single && plan.tasks.iter().any(|t| !t.integration_depends.is_empty())
    {
        validate(&plan)?;
        return Ok(plan);
    }
    if strategy != Strategy::Balanced {
        return adapt(plan, strategy, checks);
    }
    let original = plan.clone();
    let mut plan = adapt(plan, Strategy::Cohesion, checks)?;
    if workers == 1
        || (plan.tasks.iter().all(|t| known_size(t, source))
            && plan.tasks.iter().map(|t| weight(t, source)).sum::<usize>() <= SMALL_PLAN_BYTES)
    {
        // A valid graph can exceed one task's instruction/write capacity. Keep
        // its bounded groups if collapsing everything would violate that limit.
        if let Ok(single) = adapt(original, Strategy::Single, checks) {
            return Ok(single);
        }
    }
    loop {
        let mut pair = None;
        for i in 0..plan.tasks.len() {
            for j in i + 1..plan.tasks.len() {
                let a = &plan.tasks[i];
                let b = &plan.tasks[j];
                let successors = |id: &str| {
                    plan.tasks
                        .iter()
                        .filter(|t| t.depends.iter().any(|d| d == id))
                        .count()
                };
                let linear = (b.depends == [a.id.clone()] && successors(&a.id) == 1)
                    || (a.depends == [b.id.clone()] && successors(&b.id) == 1);
                let same_parents = a.depends.iter().collect::<BTreeSet<_>>()
                    == b.depends.iter().collect::<BTreeSet<_>>();
                let small_peers = same_parents
                    && known_size(a, source)
                    && known_size(b, source)
                    && weight(a, source) + weight(b, source) <= SMALL_BUNDLE_BYTES;
                // The combined task must retain the public task capacity limits.
                let writable = a
                    .writes
                    .iter()
                    .chain(&b.writes)
                    .collect::<BTreeSet<_>>()
                    .len();
                let commands = a
                    .checks
                    .iter()
                    .chain(&b.checks)
                    .collect::<BTreeSet<_>>()
                    .len();
                if (linear || small_peers)
                    && a.instruction.len() + b.instruction.len() + b.id.len() + 3 <= 32000
                    && writable <= 256
                    && commands <= 16
                {
                    pair = Some((i, j));
                    break;
                }
            }
            if pair.is_some() {
                break;
            }
        }
        if let Some((i, j)) = pair {
            merge(&mut plan, i, j)?;
        } else {
            break;
        }
    }
    if plan.tasks.len() == 1 {
        plan.tasks[0].checks = checks.to_vec();
    }
    // At each ready frontier, prefer the heavier remaining dependency path.
    let mut ranks = BTreeMap::new();
    while ranks.len() < plan.tasks.len() {
        for task in &plan.tasks {
            let children: Vec<_> = plan
                .tasks
                .iter()
                .filter(|t| t.depends.contains(&task.id))
                .collect();
            if children.iter().all(|t| ranks.contains_key(&t.id)) {
                let rank =
                    weight(task, source) + children.iter().map(|t| ranks[&t.id]).max().unwrap_or(0);
                ranks.insert(task.id.clone(), rank);
            }
        }
    }
    plan.tasks
        .sort_by(|a, b| ranks[&b.id].cmp(&ranks[&a.id]).then(a.id.cmp(&b.id)));
    validate(&plan)?;
    Ok(plan)
}
