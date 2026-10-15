use std::io;

/// Whether a signal to a process group failed because no live process is left in it.
///
/// macOS reports EPERM instead of ESRCH while every member has exited but has not
/// been reaped yet, so both mean the group is gone.
pub fn is_group_gone(error: &io::Error) -> bool {
    match error.raw_os_error() {
        Some(libc::ESRCH) => true,
        Some(libc::EPERM) => cfg!(target_os = "macos"),
        _ => false,
    }
}

/// A Linux PTY session includes the shell's group and separate job-control
/// groups. The caller must keep the shell unreaped until `terminate` succeeds:
/// the unreaped session leader reserves the SID throughout discovery.
#[cfg(target_os = "linux")]
pub(crate) struct LinuxTerminalSession {
    leader: std::fs::File,
    session_id: i32,
    empty: std::sync::atomic::AtomicBool,
}

#[cfg(target_os = "linux")]
impl LinuxTerminalSession {
    pub(crate) fn check_supported() -> io::Result<()> {
        signal_linux_process(&std::fs::File::open("/proc/self")?, 0)
    }

    pub(crate) fn attach(process_id: u32) -> io::Result<Self> {
        let leader = std::fs::File::open(format!("/proc/{process_id}"))?;
        if linux_process_state(&leader)?.0 != process_id as i32 {
            return Err(io::Error::other("The PTY child is not its session leader."));
        }
        // Fail at startup on kernels before 5.1 or policies that disallow safe
        // signaling. Falling back to kill(pid) would introduce a PID-reuse race.
        signal_linux_process(&leader, 0)?;
        Ok(Self {
            leader,
            session_id: process_id as i32,
            empty: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub(crate) fn terminate(&self, deadline: std::time::Instant) -> io::Result<()> {
        use std::sync::atomic::Ordering;
        if self.empty.load(Ordering::Acquire) {
            return Ok(());
        }
        // Read through the original proc directory, never a fresh numeric PID.
        // A missing/reaped leader is an error, not permission to target a new SID.
        linux_process_state(&self.leader).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Terminal session leader is no longer anchored: {error}"),
            )
        })?;
        loop {
            let mut live_members = false;
            for entry in std::fs::read_dir("/proc")? {
                if std::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Terminal session discovery exceeded the cleanup deadline.",
                    ));
                }
                let entry = entry?;
                let Some(pid) = entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.parse::<i32>().ok())
                else {
                    continue;
                };
                // Linux allows this read-only query even for other users' PIDs.
                // Avoid opening unrelated proc directories under hidepid=1.
                // Revalidate SID through the descriptor before any signal.
                let session_id = unsafe { libc::getsid(pid) };
                if session_id < 0 {
                    let error = io::Error::last_os_error();
                    if linux_process_disappeared(&error) {
                        continue;
                    }
                    return Err(error);
                }
                if session_id != self.session_id {
                    continue;
                }
                let process = match std::fs::File::open(entry.path()) {
                    Ok(process) => process,
                    Err(error) if linux_process_disappeared(&error) => continue,
                    Err(error) => {
                        return Err(io::Error::new(
                            error.kind(),
                            format!("Unable to open terminal job /proc/{pid}: {error}"),
                        ))
                    }
                };
                let (session_id, exited) = match linux_process_state(&process) {
                    Ok(state) => state,
                    Err(error) if linux_process_disappeared(&error) => continue,
                    Err(error) => {
                        return Err(io::Error::new(
                            error.kind(),
                            format!("Unable to inspect terminal job /proc/{pid}: {error}"),
                        ))
                    }
                };
                if session_id != self.session_id || exited {
                    continue;
                }
                live_members = true;
                // The descriptor binds inspection and signaling to the same
                // process, even if it exits and its numeric PID is reused.
                if let Err(error) = signal_linux_process(&process, libc::SIGKILL) {
                    if !linux_process_disappeared(&error) {
                        return Err(error);
                    }
                }
            }
            if !live_members {
                self.empty.store(true, Ordering::Release);
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Terminal session jobs did not exit before the cleanup deadline.",
                ));
            }
            // Rescan to catch children forked while the previous pass ran.
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.empty.load(std::sync::atomic::Ordering::Acquire)
    }
}

#[cfg(target_os = "linux")]
fn linux_process_disappeared(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
}

#[cfg(target_os = "linux")]
fn signal_linux_process(process: &std::fs::File, signal: i32) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            process.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0u32,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOSYS) {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Safe terminal cleanup requires Linux 5.1 or newer (pidfd_send_signal).",
            ))
        } else {
            Err(error)
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_process_state(process: &std::fs::File) -> io::Result<(i32, bool)> {
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    let stat = unsafe {
        libc::openat(
            process.as_raw_fd(),
            c"stat".as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    if stat < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut stat = unsafe { std::fs::File::from_raw_fd(stat) };
    let mut contents = Vec::new();
    stat.read_to_end(&mut contents)?;
    parse_linux_process_state(&contents)
}

#[cfg(target_os = "linux")]
fn parse_linux_process_state(stat: &[u8]) -> io::Result<(i32, bool)> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "Invalid /proc process stat.");
    // comm can contain spaces, closing parentheses, newlines, and non-UTF8 bytes.
    let end = stat
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or_else(invalid)?;
    let tail = std::str::from_utf8(&stat[end + 1..]).map_err(|_| invalid())?;
    let mut fields = tail.split_whitespace();
    let state = fields.next().ok_or_else(invalid)?;
    let session_id = fields
        .nth(2)
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    // A zombie thread-group leader can still have live worker threads after
    // pthread_exit. Field 20 includes the unreaped leader, so only a solitary
    // zombie is wholly exited. Conservatively signal groups with more threads.
    let threads: u32 = fields
        .nth(13)
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    if threads == 0 {
        return Err(invalid());
    }
    Ok((session_id, matches!(state, "Z" | "X" | "x") && threads == 1))
}

#[cfg(test)]
mod tests {
    use super::is_group_gone;
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn missing_group_is_gone_and_other_errors_are_not() {
        assert!(is_group_gone(&io::Error::from_raw_os_error(libc::ESRCH)));
        assert!(!is_group_gone(&io::Error::from_raw_os_error(libc::EINVAL)));
        assert_eq!(
            is_group_gone(&io::Error::from_raw_os_error(libc::EPERM)),
            cfg!(target_os = "macos")
        );
    }

    #[test]
    fn group_with_only_an_unreaped_member_never_reports_a_live_error() {
        let mut leader = Command::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .expect("group leader should start");
        thread::sleep(Duration::from_millis(200));

        let signalled = unsafe { libc::kill(-(leader.id() as i32), 0) };
        if signalled != 0 {
            let error = io::Error::last_os_error();
            assert!(is_group_gone(&error), "unexpected error: {error}");
        }

        leader.wait().expect("group leader should be reaped");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_stat_parser_handles_arbitrary_process_names_and_zombies() {
        assert_eq!(
            super::parse_linux_process_state(
                b"123 (name ) \xff\n)) S 1 123 123 0 0 0 0 0 0 0 0 0 0 0 0 0 1"
            )
            .unwrap(),
            (123, false)
        );
        assert_eq!(
            super::parse_linux_process_state(
                b"124 (sleep) Z 1 124 123 0 0 0 0 0 0 0 0 0 0 0 0 0 1"
            )
            .unwrap(),
            (123, true)
        );
        assert_eq!(
            super::parse_linux_process_state(
                b"124 (sleep) D 1 124 123 0 0 0 0 0 0 0 0 0 0 0 0 0 1"
            )
            .unwrap(),
            (123, false)
        );
        assert_eq!(
            super::parse_linux_process_state(
                b"124 (threaded) Z 1 124 123 0 0 0 0 0 0 0 0 0 0 0 0 0 2"
            )
            .unwrap(),
            (123, false)
        );
        for malformed in [
            b"123 no closing delimiter".as_slice(),
            b"123 (sleep) S 1",
            b"123 (sleep) S 1 2 invalid",
        ] {
            assert!(super::parse_linux_process_state(malformed).is_err());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cleanup_rejects_a_reaped_anchor_and_preserves_other_processes() {
        let mut unrelated = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 0"]);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = command.spawn().unwrap();
        let session = super::LinuxTerminalSession::attach(leader.id()).unwrap();
        leader.wait().unwrap();
        let result = session.terminate(std::time::Instant::now() + Duration::from_secs(1));
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("no longer anchored"));
        assert!(unrelated_alive, "an unrelated process was signaled");
        assert!(
            !session.is_empty(),
            "discovery failure must not report success"
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cleanup_deadline_preserves_the_anchor_for_retry() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = command.spawn().unwrap();
        let session = super::LinuxTerminalSession::attach(leader.id()).unwrap();
        let expired = session.terminate(std::time::Instant::now()).unwrap_err();
        let still_running = leader.try_wait().unwrap().is_none();
        let was_empty = session.is_empty();
        session
            .terminate(std::time::Instant::now() + Duration::from_secs(2))
            .unwrap();
        leader.wait().unwrap();
        assert_eq!(expired.kind(), io::ErrorKind::TimedOut);
        assert!(still_running);
        assert!(!was_empty);
        assert!(session.is_empty());
        // Retried teardown after reaping uses the verified empty state, not SID.
        session.terminate(std::time::Instant::now()).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_cleanup_kills_live_workers_after_their_main_thread_exits() {
        use std::fs;
        use std::time::Instant;
        struct ChildCleanup(std::process::Child);
        impl Drop for ChildCleanup {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        struct JobCleanup(fs::File);
        impl Drop for JobCleanup {
            fn drop(&mut self) {
                let _ = super::signal_linux_process(&self.0, libc::SIGKILL);
            }
        }
        let root = std::env::temp_dir().join(format!("pude-threaded-job-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let pid_file = root.join("pid");
        let tid_file = root.join("tid");
        let script = r#"import ctypes, os, threading, time
from pathlib import Path
def worker():
    Path(os.environ['PUDE_WORKER_TID']).write_text(str(threading.get_native_id()))
    time.sleep(30)
threading.Thread(target=worker).start()
ctypes.CDLL(None).pthread_exit(None)
"#;
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "python3 -c \"$PUDE_WORKER_SCRIPT\" & echo $! > \"$PUDE_JOB_PID\"; wait",
        ]);
        command
            .env("PUDE_WORKER_SCRIPT", script)
            .env("PUDE_JOB_PID", &pid_file)
            .env("PUDE_WORKER_TID", &tid_file);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = ChildCleanup(command.spawn().unwrap());
        let session = super::LinuxTerminalSession::attach(leader.0.id()).unwrap();
        let mut unrelated = ChildCleanup(Command::new("/bin/sleep").arg("30").spawn().unwrap());
        let read_pid = |path: &std::path::Path| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(pid) = fs::read_to_string(path)
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok())
                {
                    break pid;
                }
                assert!(Instant::now() < deadline, "threaded fixture did not start");
                thread::sleep(Duration::from_millis(5));
            }
        };
        let job_pid = read_pid(&pid_file);
        let job = JobCleanup(fs::File::open(format!("/proc/{job_pid}")).unwrap());
        let worker_tid = read_pid(&tid_file);
        let worker = fs::File::open(format!("/proc/{worker_tid}")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stat = fs::read_to_string(format!("/proc/{job_pid}/stat")).unwrap();
            if stat.rsplit_once(')').unwrap().1.split_whitespace().next() == Some("Z") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fixture leader must reach zombie state"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            super::linux_process_state(&job.0).unwrap(),
            (leader.0.id() as i32, false)
        );
        assert!(
            !super::linux_process_state(&worker).unwrap().1,
            "worker must still be alive"
        );
        session
            .terminate(Instant::now() + Duration::from_secs(2))
            .unwrap();
        leader.0.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match super::linux_process_state(&worker) {
                Err(error) if super::linux_process_disappeared(&error) => break,
                state => {
                    assert!(
                        Instant::now() < deadline,
                        "threaded worker survived cleanup: {state:?}"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }
        assert!(session.is_empty());
        assert!(
            unrelated.0.try_wait().unwrap().is_none(),
            "unrelated process must survive"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
