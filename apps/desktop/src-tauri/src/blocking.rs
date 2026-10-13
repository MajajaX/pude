use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{sync_channel, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::async_runtime::{channel, Receiver as AsyncReceiver, Sender as AsyncSender};

const FILE_QUEUE_CAPACITY: usize = 8;
const GIT_QUEUE_CAPACITY: usize = 4;
const TERMINAL_QUEUE_CAPACITY: usize = 8;
const MISC_QUEUE_CAPACITY: usize = 4;
const MAX_RESOURCE_QUEUES: usize = 128;
const MAX_RESOURCE_JOBS: usize = 128;
const RESOURCE_BATCH_JOBS: usize = 1;
const BUSY_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const BUSY_POLL_INTERVAL: Duration = Duration::from_millis(25);
const BUSY_ERROR_PREFIX: &str = "BUSY:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BlockingClass {
    File,
    Git,
    Terminal,
    Misc,
}

impl BlockingClass {
    fn queue_capacity(self) -> usize {
        match self {
            Self::File => FILE_QUEUE_CAPACITY,
            Self::Git => GIT_QUEUE_CAPACITY,
            Self::Terminal => TERMINAL_QUEUE_CAPACITY,
            Self::Misc => MISC_QUEUE_CAPACITY,
        }
    }
}

impl fmt::Display for BlockingClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::File => "file",
            Self::Git => "Git",
            Self::Terminal => "terminal",
            Self::Misc => "application",
        })
    }
}

type Job = Box<dyn FnOnce() + Send + 'static>;

fn pool_worker_count() -> usize {
    thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(4)
        .max(1)
}

struct WorkQueue {
    sender: SyncSender<Job>,
}

impl WorkQueue {
    fn new(name: &str, workers: usize, capacity: usize) -> Result<Arc<Self>, String> {
        let (sender, receiver) = sync_channel::<Job>(capacity);
        let shared = Arc::new(Mutex::new(receiver));
        for index in 0..workers.max(1) {
            let shared = Arc::clone(&shared);
            let worker_name = format!("pude-blocking-{name}-{index}");
            thread::Builder::new()
                .name(worker_name)
                .spawn(move || run_queue(shared))
                .map_err(|error| format!("Unable to start blocking worker. {error}"))?;
        }
        Ok(Arc::new(Self { sender }))
    }
}

fn run_queue(shared: Arc<Mutex<Receiver<Job>>>) {
    loop {
        let job = {
            // A malformed task must fail its own request and leave the queue
            // workers alive for the jobs behind it. `run` catches task panics
            // and reports them through the async result channel; this boundary
            // also protects direct scheduler users.
            let guard = match shared.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };
            guard.recv()
        };
        match job {
            Ok(job) => {
                let _ = catch_unwind(AssertUnwindSafe(job));
            }
            Err(_) => break,
        }
    }
}

// Resource chains give "same key serialization on a fixed pool": jobs that
// share a resource key execute strictly in submission order, while jobs with
// different keys run in parallel on the shared resource workers. No thread is
// created per key.
struct ResourceChain {
    pending: usize,
    running: bool,
    jobs: VecDeque<Job>,
}

#[derive(Default)]
struct ResourceChains {
    chains: HashMap<String, ResourceChain>,
    pending: usize,
}

struct ResourcePool {
    chains: Mutex<ResourceChains>,
    dispatch: Mutex<Receiver<String>>,
    dispatch_sender: Sender<String>,
}

impl ResourcePool {
    fn new(workers: usize) -> Result<Arc<Self>, String> {
        let (dispatch_sender, dispatch_receiver) = std::sync::mpsc::channel::<String>();
        let pool = Arc::new(Self {
            chains: Mutex::new(ResourceChains::default()),
            dispatch: Mutex::new(dispatch_receiver),
            dispatch_sender,
        });
        for index in 0..workers.max(1) {
            let pool = Arc::clone(&pool);
            thread::Builder::new()
                .name(format!("pude-blocking-resource-{index}"))
                .spawn(move || run_resource_worker(pool))
                .map_err(|error| format!("Unable to start blocking worker. {error}"))?;
        }
        Ok(pool)
    }

    fn submit(&self, resource_key: String, job: Job, capacity: usize) -> Result<(), SubmitError> {
        let needs_dispatch = {
            let mut state = self.chains.lock().map_err(|_| {
                SubmitError::Failed("The blocking scheduler is unavailable.".to_string())
            })?;
            if state.pending >= MAX_RESOURCE_JOBS
                || state
                    .chains
                    .get(&resource_key)
                    .is_some_and(|chain| chain.pending >= capacity)
                || (!state.chains.contains_key(&resource_key)
                    && state.chains.len() >= MAX_RESOURCE_QUEUES)
            {
                return Err(SubmitError::Full(job));
            }
            state.pending += 1;
            let chain = state
                .chains
                .entry(resource_key.clone())
                .or_insert_with(|| ResourceChain {
                    pending: 0,
                    running: false,
                    jobs: VecDeque::new(),
                });
            chain.pending += 1;
            chain.jobs.push_back(job);
            if chain.running {
                false
            } else {
                chain.running = true;
                true
            }
        };
        if needs_dispatch {
            // Unbounded channel with a permanently live worker pool: this send
            // never blocks, and losing it would strand a running chain forever.
            self.dispatch_sender.send(resource_key).map_err(|_| {
                SubmitError::Failed(
                    "The blocking resource workers stopped unexpectedly.".to_string(),
                )
            })?;
        }
        Ok(())
    }
}

fn run_resource_worker(pool: Arc<ResourcePool>) {
    loop {
        let key = {
            let guard = match pool.dispatch.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };
            match guard.recv() {
                Ok(key) => key,
                Err(_) => break,
            }
        };
        let mut completed_in_batch = 0usize;
        while completed_in_batch < RESOURCE_BATCH_JOBS {
            let job = {
                let mut state = match pool.chains.lock() {
                    Ok(state) => state,
                    Err(_) => return,
                };
                let Some(chain) = state.chains.get_mut(&key) else {
                    break;
                };
                match chain.jobs.pop_front() {
                    Some(job) => Some(job),
                    None => {
                        chain.running = false;
                        if chain.pending == 0 {
                            state.chains.remove(&key);
                        }
                        None
                    }
                }
            };
            let Some(job) = job else {
                break;
            };
            let _ = catch_unwind(AssertUnwindSafe(job));
            completed_in_batch += 1;

            let should_rotate = {
                let mut state = match pool.chains.lock() {
                    Ok(state) => state,
                    Err(_) => return,
                };
                state.pending = state.pending.saturating_sub(1);
                let Some(chain) = state.chains.get_mut(&key) else {
                    continue;
                };
                chain.pending = chain.pending.saturating_sub(1);
                if !chain.jobs.is_empty() {
                    // Keep the key marked running while its dispatch token is
                    // in flight so submitters cannot create duplicate tokens.
                    true
                } else {
                    chain.running = false;
                    if chain.pending == 0 {
                        state.chains.remove(&key);
                    }
                    false
                }
            };
            if should_rotate {
                // Requeue behind every other ready key after one bounded batch.
                if pool.dispatch_sender.send(key.clone()).is_err() {
                    return;
                }
                break;
            }
        }
    }
}

struct BlockingScheduler {
    class_queues: [Arc<WorkQueue>; 4],
    resource_pool: Arc<ResourcePool>,
}

enum SubmitError {
    Full(Job),
    Failed(String),
}

impl fmt::Debug for SubmitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full(_) => f.write_str("Full(..)"),
            Self::Failed(message) => write!(f, "Failed({message:?})"),
        }
    }
}

impl BlockingScheduler {
    fn new() -> Result<Self, String> {
        Ok(Self {
            class_queues: [
                WorkQueue::new(
                    "file",
                    pool_worker_count(),
                    BlockingClass::File.queue_capacity(),
                )?,
                WorkQueue::new("git", 1, BlockingClass::Git.queue_capacity())?,
                WorkQueue::new("terminal", 1, BlockingClass::Terminal.queue_capacity())?,
                WorkQueue::new("misc", 1, BlockingClass::Misc.queue_capacity())?,
            ],
            resource_pool: ResourcePool::new(pool_worker_count())?,
        })
    }

    fn class_queue(&self, class: BlockingClass) -> &Arc<WorkQueue> {
        &self.class_queues[class as usize]
    }

    fn try_submit(
        &self,
        class: BlockingClass,
        resource: Option<&str>,
        job: Job,
    ) -> Result<(), SubmitError> {
        match resource {
            Some(key) if !key.is_empty() => {
                let resource_key = format!("{}:{key}", class as u8);
                self.resource_pool
                    .submit(resource_key, job, class.queue_capacity() + 1)
            }
            _ => self
                .class_queue(class)
                .sender
                .try_send(job)
                .map_err(|error| match error {
                    TrySendError::Full(job) => SubmitError::Full(job),
                    TrySendError::Disconnected(_) => SubmitError::Failed(format!(
                        "The {class} operation queue stopped unexpectedly."
                    )),
                }),
        }
    }
}

fn scheduler() -> Result<&'static BlockingScheduler, String> {
    static SCHEDULER: OnceLock<Result<BlockingScheduler, String>> = OnceLock::new();
    SCHEDULER
        .get_or_init(BlockingScheduler::new)
        .as_ref()
        .map_err(Clone::clone)
}

async fn submit_with_backpressure(
    scheduler: &BlockingScheduler,
    class: BlockingClass,
    resource: Option<&str>,
    job: Job,
    wait: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + wait;
    let mut job = job;
    loop {
        match scheduler.try_submit(class, resource, job) {
            Ok(()) => return Ok(()),
            Err(SubmitError::Failed(message)) => return Err(message),
            Err(SubmitError::Full(returned)) => {
                job = returned;
                if Instant::now() >= deadline {
                    return Err(format!(
                        "{BUSY_ERROR_PREFIX} The {class} operation queue is full. Wait for the current work to finish and retry."
                    ));
                }
                tokio::time::sleep(BUSY_POLL_INTERVAL).await;
            }
        }
    }
}

pub async fn run<T, F>(
    label: &'static str,
    class: BlockingClass,
    resource: Option<String>,
    task: F,
) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let (sender, mut receiver): (
        AsyncSender<Result<T, String>>,
        AsyncReceiver<Result<T, String>>,
    ) = channel(1);
    let job = Box::new(move || {
        let result = catch_unwind(AssertUnwindSafe(task))
            .map_err(|_| format!("{label} task panicked."))
            .and_then(|result| result);
        let _ = sender.try_send(result);
    });
    submit_with_backpressure(
        scheduler()?,
        class,
        resource.as_deref(),
        job,
        BUSY_WAIT_TIMEOUT,
    )
    .await?;
    receiver
        .recv()
        .await
        .ok_or_else(|| format!("{label} task stopped before returning a result."))?
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Barrier, Mutex};
    use std::time::{Duration, Instant};

    use super::{
        pool_worker_count, BlockingClass, BlockingScheduler, ResourcePool, SubmitError, WorkQueue,
        BUSY_ERROR_PREFIX,
    };

    fn test_scheduler(file_capacity: usize) -> Arc<BlockingScheduler> {
        test_scheduler_with_workers(file_capacity, pool_worker_count())
    }

    fn test_scheduler_with_workers(
        file_capacity: usize,
        file_workers: usize,
    ) -> Arc<BlockingScheduler> {
        Arc::new(BlockingScheduler {
            class_queues: [
                WorkQueue::new("file", file_workers, file_capacity)
                    .expect("file workers should start"),
                WorkQueue::new("git", 1, 4).expect("git worker should start"),
                WorkQueue::new("terminal", 1, 4).expect("terminal worker should start"),
                WorkQueue::new("misc", 1, 4).expect("misc worker should start"),
            ],
            resource_pool: ResourcePool::new(2).expect("resource workers should start"),
        })
    }

    fn submit(scheduler: &BlockingScheduler, class: BlockingClass, job: super::Job) {
        match scheduler.try_submit(class, None, job) {
            Ok(()) => {}
            Err(SubmitError::Failed(message)) => panic!("submit failed: {message}"),
            Err(SubmitError::Full(_)) => panic!("submit unexpectedly hit a full queue"),
        }
    }

    #[test]
    fn classes_have_finite_queue_capacities() {
        assert!(BlockingClass::File.queue_capacity() > 0);
        assert!(BlockingClass::Git.queue_capacity() > 0);
        assert!(BlockingClass::Terminal.queue_capacity() > 0);
        assert!(BlockingClass::Misc.queue_capacity() > 0);
    }

    #[test]
    fn file_pool_runs_reads_in_parallel() {
        if pool_worker_count() < 2 {
            return;
        }
        let scheduler = test_scheduler(8);
        let barrier = Arc::new(Barrier::new(2));
        let (done_sender, done_receiver) = sync_channel(2);
        for _ in 0..2 {
            let barrier = Arc::clone(&barrier);
            let done_sender = done_sender.clone();
            submit(
                &scheduler,
                BlockingClass::File,
                Box::new(move || {
                    barrier.wait();
                    let _ = done_sender.send(());
                }),
            );
        }
        for _ in 0..2 {
            done_receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("both file jobs should run concurrently");
        }
    }

    #[test]
    fn same_resource_is_serial_while_different_resources_run_in_parallel() {
        let scheduler = test_scheduler(8);
        let order = Arc::new(Mutex::new(Vec::new()));
        let (started_sender, started_receiver) = sync_channel(0);
        let (release_sender, release_receiver) = sync_channel::<()>(0);
        let (done_sender, done_receiver) = sync_channel(4);

        let first_order = Arc::clone(&order);
        let first_done = done_sender.clone();
        scheduler
            .try_submit(
                BlockingClass::File,
                Some("same-file"),
                Box::new(move || {
                    first_order.lock().unwrap().push("first-start");
                    let _ = started_sender.send(());
                    let _ = release_receiver.recv();
                    first_order.lock().unwrap().push("first-end");
                    let _ = first_done.send(());
                }),
            )
            .expect("the first job should be admitted");
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the first job should start");

        let second_order = Arc::clone(&order);
        let second_done = done_sender.clone();
        scheduler
            .try_submit(
                BlockingClass::File,
                Some("same-file"),
                Box::new(move || {
                    second_order.lock().unwrap().push("second");
                    let _ = second_done.send(());
                }),
            )
            .expect("the second job should queue behind the first");

        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            order.lock().unwrap().as_slice(),
            ["first-start"],
            "the same-key job must wait for the running one"
        );
        release_sender.send(()).unwrap();
        for _ in 0..2 {
            done_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("same-key jobs should complete in order");
        }
        assert_eq!(
            order.lock().unwrap().as_slice(),
            ["first-start", "first-end", "second"]
        );

        // Different keys on the resource pool must not deadlock and may run in parallel.
        if pool_worker_count() < 2 {
            return;
        }
        let pair = Arc::new(Barrier::new(2));
        for key in ["resource-a", "resource-b"] {
            let pair = Arc::clone(&pair);
            let done_sender = done_sender.clone();
            scheduler
                .try_submit(
                    BlockingClass::File,
                    Some(key),
                    Box::new(move || {
                        pair.wait();
                        let _ = done_sender.send(());
                    }),
                )
                .expect("each resource job should be admitted");
        }
        for _ in 0..2 {
            done_receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("different-key jobs should run in parallel");
        }
    }

    #[test]
    fn full_queue_waits_for_space_instead_of_failing() {
        let scheduler = test_scheduler_with_workers(1, 1);
        let (block_sender, block_receiver) = sync_channel::<()>(0);
        let (done_sender, done_receiver) = sync_channel(1);

        let (started_sender, started_receiver) = sync_channel(0);
        submit(
            &scheduler,
            BlockingClass::File,
            Box::new(move || {
                let _ = started_sender.send(());
                let _ = block_receiver.recv();
            }),
        );
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the blocker job should start before the queue fills");
        submit(&scheduler, BlockingClass::File, Box::new(|| {}));
        let extra = scheduler.try_submit(BlockingClass::File, None, Box::new(|| {}));
        assert!(
            matches!(extra, Err(SubmitError::Full(_))),
            "the buffered slot should be occupied while the worker is blocked"
        );

        let waiting_scheduler = Arc::clone(&scheduler);
        let waiter = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("test runtime should build");
            runtime.block_on(super::submit_with_backpressure(
                &waiting_scheduler,
                BlockingClass::File,
                None,
                Box::new(move || {
                    let _ = done_sender.send(());
                }),
                Duration::from_secs(5),
            ))
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            done_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err(),
            "the waiting job should not run before space frees up"
        );
        block_sender.send(()).unwrap();
        waiter
            .join()
            .expect("waiter should not panic")
            .expect("the waiting job should be admitted within five seconds");
        done_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("the admitted job should complete");
    }

    #[test]
    fn busy_timeout_error_has_recognizable_prefix() {
        let scheduler = test_scheduler_with_workers(1, 1);
        let (block_sender, block_receiver) = sync_channel::<()>(0);
        let (never_sender, never_receiver) = sync_channel::<()>(0);
        let (started_sender, started_receiver) = sync_channel(0);
        submit(
            &scheduler,
            BlockingClass::File,
            Box::new(move || {
                let _ = started_sender.send(());
                let _ = block_receiver.recv();
            }),
        );
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the blocker job should start before the queue fills");
        submit(
            &scheduler,
            BlockingClass::File,
            Box::new(move || {
                let _ = never_receiver.recv();
            }),
        );

        let started = Instant::now();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("test runtime should build");
        let result = runtime.block_on(super::submit_with_backpressure(
            &scheduler,
            BlockingClass::File,
            None,
            Box::new(|| {}),
            Duration::from_millis(300),
        ));
        let error = result.expect_err("a permanently full queue should time out");
        assert!(
            error.starts_with(BUSY_ERROR_PREFIX),
            "busy error should carry the recognizable prefix: {error}"
        );
        assert!(started.elapsed() >= Duration::from_millis(250));

        drop(block_sender);
        drop(never_sender);
    }

    #[test]
    fn a_panicking_job_does_not_stop_the_shared_worker() {
        let scheduler = test_scheduler(4);
        submit(
            &scheduler,
            BlockingClass::Misc,
            Box::new(|| panic!("test task")),
        );
        let (done_sender, done_receiver) = sync_channel(0);
        submit(
            &scheduler,
            BlockingClass::Misc,
            Box::new(move || {
                let _ = done_sender.send(());
            }),
        );
        done_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the worker should continue after a panic");
    }

    #[test]
    fn resource_chains_are_reaped_after_draining() {
        let pool = ResourcePool::new(2).expect("resource workers should start");
        let (done_sender, done_receiver) = sync_channel(1);
        let done = done_sender.clone();
        pool.submit(
            "0:key".to_string(),
            Box::new(move || {
                let _ = done.send(());
            }),
            8,
        )
        .expect("the chain job should be admitted");
        done_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the chain job should complete");
        drop(done_sender);
        std::thread::sleep(Duration::from_millis(50));
        let state = pool.chains.lock().unwrap();
        assert!(
            state.chains.is_empty(),
            "drained chains should be reaped from the map"
        );
    }

    #[test]
    fn zero_pending_chain_still_owned_by_a_worker_is_not_replaced() {
        let (dispatch_sender, dispatch_receiver) = std::sync::mpsc::channel();
        let pool = ResourcePool {
            chains: std::sync::Mutex::new(super::ResourceChains::default()),
            dispatch: std::sync::Mutex::new(dispatch_receiver),
            dispatch_sender,
        };
        // Pause at the old race boundary: the last task finished, but its
        // worker still owns the chain and has not inspected the next job.
        pool.chains.lock().unwrap().chains.insert(
            "owned".into(),
            super::ResourceChain {
                pending: 0,
                running: true,
                jobs: Default::default(),
            },
        );
        pool.submit("owned".into(), Box::new(|| {}), 2).unwrap();
        let state = pool.chains.lock().unwrap();
        assert!(state.chains["owned"].running);
        assert_eq!(state.chains["owned"].pending, 1);
        assert_eq!(state.pending, 1);
        assert!(matches!(
            pool.dispatch.lock().unwrap().try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn resource_limits_return_the_job_for_backpressure() {
        let pool = ResourcePool::new(1).unwrap();
        let (started, started_rx) = sync_channel(0);
        let (release, release_rx) = sync_channel(0);
        pool.submit(
            "blocked".into(),
            Box::new(move || {
                started.send(()).unwrap();
                release_rx.recv().unwrap();
            }),
            2,
        )
        .unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        pool.submit("blocked".into(), Box::new(|| {}), 2).unwrap();
        assert!(matches!(
            pool.submit("blocked".into(), Box::new(|| {}), 2),
            Err(SubmitError::Full(_))
        ));
        for index in 2..super::MAX_RESOURCE_JOBS {
            pool.submit(format!("key-{index}"), Box::new(|| {}), 2)
                .unwrap();
        }
        assert_eq!(
            pool.chains.lock().unwrap().pending,
            super::MAX_RESOURCE_JOBS
        );
        assert!(matches!(
            pool.submit("extra".into(), Box::new(|| {}), 2),
            Err(SubmitError::Full(_))
        ));
        release.send(()).unwrap();
    }

    #[test]
    fn resource_workers_rotate_ready_keys_under_sustained_hot_load() {
        const WORKERS: usize = 2;
        const COLD_JOBS: usize = 30;

        let pool = ResourcePool::new(WORKERS).expect("resource workers should start");
        let feeding = Arc::new(AtomicBool::new(true));
        let trace = Arc::new(Mutex::new(Vec::<String>::new()));
        let first_jobs = Arc::new(Barrier::new(WORKERS + 1));
        for index in 0..WORKERS {
            let key = format!("hot-{index}");
            pool.submit(
                key.clone(),
                hot_resource_job(
                    Arc::downgrade(&pool),
                    key,
                    Arc::clone(&feeding),
                    Arc::clone(&trace),
                    Some(Arc::clone(&first_jobs)),
                ),
                16,
            )
            .expect("hot resource should be admitted");
        }
        first_jobs.wait();

        let mut wait_times = Vec::with_capacity(COLD_JOBS);
        for index in 0..COLD_JOBS {
            let (started_sender, started_receiver) = sync_channel(1);
            let task_trace = Arc::clone(&trace);
            {
                let mut trace_guard = trace.lock().unwrap();
                trace_guard.push(format!("accepted-cold-{index}"));
                let accepted = Instant::now();
                pool.submit(
                    format!("cold-{index}"),
                    Box::new(move || {
                        task_trace
                            .lock()
                            .unwrap()
                            .push(format!("started-cold-{index}"));
                        let _ = started_sender.send(Instant::now());
                        std::thread::sleep(Duration::from_millis(1));
                    }),
                    8,
                )
                .expect("cold resource should be admitted while capacity remains");
                drop(trace_guard);
                let started = started_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("accepted cold key should run while hot keys stay busy");
                wait_times.push(started.saturating_duration_since(accepted));
            }
        }

        feeding.store(false, Ordering::Release);
        wait_for_resource_pool_to_drain(&pool);

        let trace = trace.lock().unwrap();
        for index in 0..COLD_JOBS {
            let accepted = trace
                .iter()
                .position(|event| event == &format!("accepted-cold-{index}"))
                .expect("cold key acceptance should be traced");
            let started = trace
                .iter()
                .position(|event| event == &format!("started-cold-{index}"))
                .expect("cold key start should be traced");
            assert!(started > accepted, "cold task started before admission");
            let hot_starts_ahead = trace[accepted + 1..started]
                .iter()
                .filter(|event| event.starts_with("started-hot-"))
                .count();
            assert!(
                hot_starts_ahead <= WORKERS * super::RESOURCE_BATCH_JOBS,
                "cold key {index} waited behind {hot_starts_ahead} hot jobs"
            );
        }

        wait_times.sort_unstable();
        let p95_index = (wait_times.len() * 95 + 99) / 100 - 1;
        let p95 = wait_times[p95_index];
        let maximum = *wait_times.last().unwrap();
        assert!(
            p95 < Duration::from_millis(250),
            "cold key P95 wait was {p95:?}"
        );
        assert!(
            maximum < Duration::from_millis(500),
            "cold key maximum wait was {maximum:?}"
        );
        assert!(
            trace
                .iter()
                .filter(|event| event.starts_with("started-hot-"))
                .count()
                > WORKERS * super::RESOURCE_BATCH_JOBS * 2,
            "hot keys should continue producing while cold work progresses"
        );
    }

    #[test]
    fn panicking_and_canceled_resource_jobs_release_their_pending_slots() {
        let pool = ResourcePool::new(1).expect("resource worker should start");
        let canceled = Arc::new(AtomicBool::new(false));
        let canceled_job = Arc::clone(&canceled);
        let (panic_started_sender, panic_started_receiver) = sync_channel(0);
        let (panic_release_sender, panic_release_receiver) = sync_channel(0);
        let (done_sender, done_receiver) = sync_channel(1);

        pool.submit(
            "cleanup".into(),
            Box::new(move || {
                let _ = panic_started_sender.send(());
                let _ = panic_release_receiver.recv();
                panic!("resource task panic");
            }),
            4,
        )
        .unwrap();
        panic_started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the first cleanup job should start");
        pool.submit(
            "cleanup".into(),
            Box::new(move || {
                if !canceled_job.load(Ordering::Acquire) {
                    panic!("test cancellation should be visible before this job runs");
                }
                let _ = done_sender.send(());
            }),
            4,
        )
        .unwrap();
        canceled.store(true, Ordering::Release);
        panic_release_sender.send(()).unwrap();
        done_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the cooperatively canceled job should leave its worker healthy");
        wait_for_resource_pool_to_drain(&pool);
        assert_eq!(pool.chains.lock().unwrap().pending, 0);
        assert!(pool.chains.lock().unwrap().chains.is_empty());
    }

    fn hot_resource_job(
        pool: std::sync::Weak<ResourcePool>,
        key: String,
        feeding: Arc<AtomicBool>,
        trace: Arc<Mutex<Vec<String>>>,
        first_jobs: Option<Arc<Barrier>>,
    ) -> super::Job {
        Box::new(move || {
            trace.lock().unwrap().push(format!("started-{key}"));
            if let Some(first_jobs) = first_jobs {
                first_jobs.wait();
            }
            std::thread::sleep(Duration::from_millis(2));
            if feeding.load(Ordering::Acquire) {
                if let Some(pool) = pool.upgrade() {
                    let next = hot_resource_job(
                        Arc::downgrade(&pool),
                        key.clone(),
                        Arc::clone(&feeding),
                        Arc::clone(&trace),
                        None,
                    );
                    let _ = pool.submit(key, next, 16);
                }
            }
        })
    }

    fn wait_for_resource_pool_to_drain(pool: &ResourcePool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let state = pool.chains.lock().unwrap();
            if state.pending == 0 && state.chains.is_empty() {
                return;
            }
            drop(state);
            assert!(
                Instant::now() < deadline,
                "resource pool did not drain after producers stopped"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    #[ignore = "million-submission concurrency stress; run explicitly for scheduler acceptance"]
    fn million_same_key_submissions_preserve_order_and_never_overlap() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let pool = ResourcePool::new(4).unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let overlaps = Arc::new(AtomicUsize::new(0));
        let (sender, receiver) = std::sync::mpsc::channel();
        for batch in 0..500_000 {
            for offset in 0..2 {
                let active = Arc::clone(&active);
                let completed = Arc::clone(&completed);
                let overlaps = Arc::clone(&overlaps);
                let sender = sender.clone();
                pool.submit(
                    "stress".into(),
                    Box::new(move || {
                        if active.fetch_add(1, Ordering::SeqCst) != 0 {
                            overlaps.fetch_add(1, Ordering::SeqCst);
                        }
                        std::thread::yield_now();
                        let expected = batch * 2 + offset;
                        assert_eq!(completed.fetch_add(1, Ordering::SeqCst), expected);
                        active.fetch_sub(1, Ordering::SeqCst);
                        sender.send(()).unwrap();
                    }),
                    8,
                )
                .unwrap();
            }
            receiver.recv_timeout(Duration::from_secs(2)).unwrap();
            receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        assert_eq!(completed.load(Ordering::SeqCst), 1_000_000);
        assert_eq!(overlaps.load(Ordering::SeqCst), 0);
    }
}
