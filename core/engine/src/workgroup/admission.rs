//! Bounded admission feedback. This controls future dispatch only, never kills
//! workers, changes task contracts, or treats pressure as proof of task failure.
use crate::model::ModelLoad;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub(super) const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const MAX_DECISIONS: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionDecision {
    pub at_seconds: f64,
    pub from: usize,
    pub to: usize,
    pub reason: String,
    pub active: usize,
    pub ready: usize,
    pub pending: usize,
    pub model_queue_fraction: f64,
    pub model_slot_utilization: f64,
}

pub(super) struct Controller {
    pub target: usize,
    max: usize,
    previous: Option<ModelLoad>,
    spare: u8,
    pressure: u8,
    cooldown: u8,
}

impl Controller {
    pub fn new(max: usize, initial: usize, load: Option<ModelLoad>) -> Self {
        Self {
            target: initial.min(max),
            max,
            previous: load,
            spare: 0,
            pressure: 0,
            cooldown: 0,
        }
    }

    pub fn sample(
        &mut self,
        load: Option<ModelLoad>,
        active: usize,
        ready: usize,
        pending: usize,
        at_seconds: f64,
    ) -> Option<AdmissionDecision> {
        let previous = std::mem::replace(&mut self.previous, load.clone());
        let Some((queue, utilization)) = previous
            .as_ref()
            .zip(load.as_ref())
            .and_then(|(a, b)| window(a, b))
        else {
            // Missing/reset/invalid telemetry is not evidence of spare capacity.
            self.spare = 0;
            self.pressure = 0;
            return None;
        };
        let load = load.unwrap();
        let reason = if pending >= 2 {
            Some("verification_backlog")
        } else if queue >= 0.5 {
            Some("model_queue")
        } else {
            None
        };
        self.pressure = if reason.is_some() {
            self.pressure.saturating_add(1)
        } else {
            0
        };
        self.spare = if reason.is_none()
            && queue <= 0.05
            && (1.0 - utilization) * load.capacity as f64 >= 0.5
            && load.started_requests > 0
            && ready > 0
            && active >= self.target
        {
            self.spare.saturating_add(1)
        } else {
            0
        };
        if self.cooldown > 0 {
            self.cooldown -= 1;
            self.spare = 0;
            return None;
        }
        let from = self.target;
        let reason = if self.pressure >= 2 && self.target > 1 && active <= self.target {
            self.target -= 1;
            self.cooldown = 2;
            reason.unwrap()
        } else if self.spare >= 2 && self.target < self.max {
            self.target += 1;
            "spare_model_capacity"
        } else {
            return None;
        };
        self.spare = 0;
        self.pressure = 0;
        Some(AdmissionDecision {
            at_seconds,
            from,
            to: self.target,
            reason: reason.into(),
            active,
            ready,
            pending,
            model_queue_fraction: queue,
            model_slot_utilization: utilization,
        })
    }
}

fn window(a: &ModelLoad, b: &ModelLoad) -> Option<(f64, f64)> {
    let elapsed = b.elapsed_seconds - a.elapsed_seconds;
    let queued = b.queued_seconds - a.queued_seconds;
    let occupied = b.occupied_slot_seconds - a.occupied_slot_seconds;
    if a.capacity == 0
        || a.capacity != b.capacity
        || elapsed <= 0.0
        || !elapsed.is_finite()
        || !queued.is_finite()
        || !occupied.is_finite()
        || queued < 0.0
        || queued > elapsed + 0.001
        || occupied < 0.0
        || occupied > elapsed * b.capacity as f64 + 0.001
        || b.started_requests < a.started_requests
        || b.completed_requests < a.completed_requests
    {
        return None;
    }
    Some((
        (queued / elapsed).clamp(0.0, 1.0),
        (occupied / elapsed / b.capacity as f64).clamp(0.0, 1.0),
    ))
}

impl super::AdmissionStats {
    pub(super) fn decision(&mut self, decision: AdmissionDecision) {
        self.target_workers = decision.to;
        self.peak_target_workers = self.peak_target_workers.max(decision.to);
        if self.decisions.len() < MAX_DECISIONS {
            self.decisions.push(decision);
        } else {
            self.omitted_decisions += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(
        c: &mut Controller,
        queue: f64,
        utilization: f64,
        active: usize,
        ready: usize,
        pending: usize,
    ) -> Option<AdmissionDecision> {
        let mut load = c.previous.clone().unwrap();
        load.elapsed_seconds += 2.0;
        load.queued_seconds += 2.0 * queue;
        load.occupied_slot_seconds += 2.0 * load.capacity as f64 * utilization;
        load.started_requests += 1;
        c.sample(Some(load), active, ready, pending, 0.0)
    }

    fn controller(capacity: usize, initial: usize) -> Controller {
        Controller::new(
            8,
            initial,
            Some(ModelLoad {
                capacity,
                ..ModelLoad::default()
            }),
        )
    }

    #[test]
    fn spare_capacity_grows_one_at_a_time_through_full_eight_slots() {
        let mut c = controller(8, 2);
        for target in 2..8 {
            assert!(sample(&mut c, 0.0, target as f64 / 8.0, target, 8, 0).is_none());
            let decision = sample(&mut c, 0.0, target as f64 / 8.0, target, 8, 0).unwrap();
            assert_eq!((decision.from, decision.to), (target, target + 1));
        }
        assert!(sample(&mut c, 0.0, 0.0, 8, 1, 0).is_none());
        assert_eq!(c.target, 8);
    }

    #[test]
    fn saturation_no_demand_and_no_feedback_do_not_trigger_growth() {
        for (utilization, active, ready) in [(1.0, 2, 8), (0.0, 1, 8), (0.0, 2, 0)] {
            let mut c = controller(2, 2);
            for _ in 0..8 {
                assert!(sample(&mut c, 0.0, utilization, active, ready, 0).is_none());
            }
            assert_eq!(c.target, 2);
        }
        let mut c = controller(8, 2);
        assert!(c.sample(None, 2, 6, 0, 1.0).is_none());
        assert!(c.sample(Some(ModelLoad::default()), 2, 6, 0, 2.0).is_none());
        assert_eq!(c.target, 2);
    }

    #[test]
    fn sustained_queue_reduces_future_dispatch_and_waits_for_active_workers_to_drain() {
        let mut c = controller(2, 8);
        assert!(sample(&mut c, 0.9, 1.0, 8, 10, 0).is_none());
        assert_eq!(
            sample(&mut c, 0.9, 1.0, 8, 10, 0).unwrap().reason,
            "model_queue"
        );
        assert_eq!(c.target, 7);
        for _ in 0..10 {
            assert!(sample(&mut c, 0.9, 1.0, 8, 10, 0).is_none());
        }
        assert_eq!(sample(&mut c, 0.9, 1.0, 7, 10, 0).unwrap().to, 6);
    }

    #[test]
    fn noisy_windows_do_not_oscillate_and_verifier_pressure_is_independent() {
        let mut c = controller(8, 2);
        for _ in 0..10 {
            assert!(sample(&mut c, 0.9, 0.9, 2, 8, 0).is_none());
            assert!(sample(&mut c, 0.0, 0.2, 2, 8, 0).is_none());
        }
        assert!(sample(&mut c, 0.0, 0.0, 0, 8, 2).is_none());
        assert_eq!(
            sample(&mut c, 0.0, 0.0, 0, 8, 2).unwrap().reason,
            "verification_backlog"
        );
        assert_eq!(c.target, 1);
        for _ in 0..8 {
            assert!(sample(&mut c, 0.0, 0.0, 0, 8, 2).is_none());
        }
    }

    #[test]
    fn invalid_or_reset_measurements_are_not_spare_capacity() {
        let a = ModelLoad {
            capacity: 2,
            elapsed_seconds: 2.0,
            queued_seconds: 1.0,
            occupied_slot_seconds: 3.0,
            ..ModelLoad::default()
        };
        for b in [
            ModelLoad {
                capacity: 2,
                elapsed_seconds: 1.0,
                ..a.clone()
            },
            ModelLoad {
                capacity: 1,
                elapsed_seconds: 4.0,
                ..a.clone()
            },
            ModelLoad {
                elapsed_seconds: 4.0,
                queued_seconds: 0.5,
                ..a.clone()
            },
            ModelLoad {
                elapsed_seconds: f64::NAN,
                ..a.clone()
            },
            ModelLoad {
                elapsed_seconds: 4.0,
                occupied_slot_seconds: 10.0,
                ..a.clone()
            },
        ] {
            assert!(window(&a, &b).is_none());
        }
    }
}
