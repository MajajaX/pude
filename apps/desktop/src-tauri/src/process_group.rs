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
}
