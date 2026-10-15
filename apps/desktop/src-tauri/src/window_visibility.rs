use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct WindowVisibility {
    shown: AtomicBool,
    timer_installed: AtomicBool,
    retired: AtomicBool,
}

impl WindowVisibility {
    pub fn install_timer(&self) -> bool {
        !self.timer_installed.swap(true, Ordering::AcqRel)
    }

    pub fn reveal<E>(&self, show: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        if self.retired.load(Ordering::Acquire) || self.shown.load(Ordering::Acquire) {
            return Ok(false);
        }
        show()?;
        Ok(!self.shown.swap(true, Ordering::AcqRel))
    }
}

#[derive(Default)]
pub struct WindowVisibilityRegistry {
    windows: Mutex<HashMap<String, Arc<WindowVisibility>>>,
}

impl WindowVisibilityRegistry {
    pub fn get(&self, label: &str) -> Arc<WindowVisibility> {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Arc::clone(windows.entry(label.to_string()).or_default())
    }

    pub fn remove(&self, label: &str) {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(window) = windows.remove(label) {
            window.retired.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Barrier};
    use std::time::Duration;

    #[test]
    fn first_and_concurrent_lookups_return_one_guard_without_deadlock() {
        let registry = Arc::new(WindowVisibilityRegistry::default());
        let barrier = Arc::new(Barrier::new(9));
        let (sender, receiver) = mpsc::channel();
        let mut workers = Vec::new();
        for _ in 0..8 {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            let sender = sender.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                sender.send(registry.get("main")).unwrap();
            }));
        }
        barrier.wait();
        let first = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        for _ in 1..8 {
            assert!(Arc::ptr_eq(
                &first,
                &receiver.recv_timeout(Duration::from_secs(1)).unwrap()
            ));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(first.install_timer());
        assert!(!first.install_timer());
    }

    #[test]
    fn failed_reveal_keeps_fallback_available_and_success_is_recorded_once() {
        let guard = WindowVisibility::default();
        assert_eq!(guard.reveal(|| Err("show failed")), Err("show failed"));
        assert_eq!(guard.reveal(|| Ok::<_, &str>(())), Ok(true));
        assert_eq!(
            guard.reveal(|| panic!("already visible")),
            Ok::<_, &str>(false)
        );
    }

    #[test]
    fn destroyed_windows_retire_pending_timers() {
        let registry = WindowVisibilityRegistry::default();
        let guard = registry.get("main");
        registry.remove("main");
        assert_eq!(
            guard.reveal(|| panic!("destroyed window")),
            Ok::<_, &str>(false)
        );
        assert!(!Arc::ptr_eq(&guard, &registry.get("main")));
    }
}
