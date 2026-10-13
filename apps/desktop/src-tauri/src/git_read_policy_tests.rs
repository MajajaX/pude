use super::*;

#[cfg(unix)]
#[test]
fn automatic_reads_disable_fsmonitor_without_changing_repository_config() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("pude-git-read-policy-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let run = |args: &[&str]| {
        let result = Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        result.stdout
    };
    run(&["init", "-q"]);
    run(&["config", "user.name", "fixture"]);
    run(&["config", "user.email", "fixture@example.test"]);
    run(&["config", "maintenance.auto", "false"]);
    fs::write(root.join("tracked-例.txt"), "before\n").unwrap();
    run(&["add", "--", "tracked-例.txt"]);
    run(&["commit", "-qm", "fixture"]);
    fs::write(root.join("tracked-例.txt"), "after\n").unwrap();
    fs::write(root.join("untracked.txt"), "new\n").unwrap();
    let marker = root.join(".git/invoked");
    let hook = root.join(".git/fsmonitor-helper");
    fs::write(
        &hook,
        "#!/bin/sh\nprintf 'invoked\\n' >> .git/invoked\nprintf '/\\000'\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    run(&["config", "core.fsmonitorhookversion", "1"]);
    let config = root.join(".git/config");
    for helper in [hook.to_str().unwrap(), ".git/fsmonitor-helper"] {
        run(&["config", "core.fsmonitor", helper]);
        let original_config = fs::read(&config).unwrap();
        // Establish that the fixture reaches the original implicit execution.
        run(&["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
        run(&["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
        assert!(marker.exists(), "control must invoke repository helper");
        fs::remove_file(&marker).unwrap();
        let expected = run(&[
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=",
            "status",
            "--porcelain=v1",
            "-z",
        ]);
        for spool in [false, true] {
            let spec = GitCommandSpec::read(
                &root,
                vec!["status".into(), "--porcelain=v1".into(), "-z".into()],
            );
            let token = CancellationToken::new();
            let output = if spool {
                execute_process_spooled(spec, &token)
            } else {
                execute_process_piped(spec, &token)
            }
            .unwrap()
            .into_success()
            .unwrap();
            assert_eq!(output.stdout.as_ref(), expected.as_slice());
            assert!(!marker.exists(), "automatic read executed a helper");
            assert_eq!(fs::read(&config).unwrap(), original_config);
        }
    }
    for boolean in ["true", "false"] {
        run(&["config", "core.fsmonitor", boolean]);
        let original_config = fs::read(&config).unwrap();
        let spec = GitCommandSpec::read(
            &root,
            vec!["status".into(), "--porcelain=v1".into(), "-z".into()],
        );
        let output = execute_process_piped(spec, &CancellationToken::new())
            .unwrap()
            .into_success()
            .unwrap();
        assert!(!output.stdout.is_empty());
        assert_eq!(fs::read(&config).unwrap(), original_config);
    }
    // Explicit mutations keep their profile and still update the real index.
    run(&["config", "core.fsmonitor", hook.to_str().unwrap()]);
    let original_config = fs::read(&config).unwrap();
    let mutation = GitCommandSpec::new(
        &root,
        vec!["add".into(), "--".into(), "tracked-例.txt".into()],
    );
    assert_eq!(
        build_git_command(&mutation).get_args().collect::<Vec<_>>(),
        vec![
            std::ffi::OsStr::new("add"),
            std::ffi::OsStr::new("--"),
            std::ffi::OsStr::new("tracked-例.txt")
        ]
    );
    execute_process_piped(mutation, &CancellationToken::new())
        .unwrap()
        .into_success()
        .unwrap();
    assert_eq!(
        run(&["-c", "core.fsmonitor=", "show", ":tracked-例.txt"]),
        b"after\n"
    );
    assert_eq!(fs::read(&config).unwrap(), original_config);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn automatic_read_profile_uses_empty_fsmonitor_value_for_legacy_git() {
    let spec = GitCommandSpec::read(".", vec!["status".into()]);
    let command = build_git_command(&spec);
    let args = command.get_args().collect::<Vec<_>>();
    assert_eq!(
        args,
        ["--no-optional-locks", "-c", "core.fsmonitor=", "status"]
    );
}
