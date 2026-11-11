use portable_pty::CommandBuilder;
use std::env;
use std::path::{Path, PathBuf};

const VIRTUAL_ENVIRONMENT_NAMES: [&str; 3] = [".venv", "venv", "env"];

/// Returns the terminal notice describing the detected environment. The
/// environment is only put on PATH when the user has trusted the workspace to
/// activate it, because its executables would otherwise shadow system tools.
pub fn configure_project_environment(
    command: &mut CommandBuilder,
    workspace: &Path,
    activate: bool,
) -> Option<String> {
    let (environment, scripts) = find_project_environment(workspace)?;
    let label = environment
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    if !activate {
        return Some(format!(
            "Python environment found: {label} (not activated). Run \"Trust Python environment\" from the command palette to activate it.\r\n"
        ));
    }
    let existing_path = env::var_os("PATH").unwrap_or_default();
    let paths = std::iter::once(scripts).chain(env::split_paths(&existing_path));
    let path = env::join_paths(paths).ok()?;
    command.env("VIRTUAL_ENV", environment.as_os_str());
    command.env("PATH", path);
    command.env_remove("PYTHONHOME");
    Some(format!("Python environment active: {label}\r\n"))
}

fn find_project_environment(workspace: &Path) -> Option<(PathBuf, PathBuf)> {
    for name in VIRTUAL_ENVIRONMENT_NAMES {
        let environment = workspace.join(name);
        if !environment.join("pyvenv.cfg").is_file() {
            continue;
        }
        let scripts = if cfg!(windows) {
            environment.join("Scripts")
        } else {
            environment.join("bin")
        };
        let python = if cfg!(windows) {
            scripts.join("python.exe")
        } else {
            scripts.join("python")
        };
        if python.is_file() {
            return Some((environment, scripts));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{configure_project_environment, find_project_environment};
    use portable_pty::CommandBuilder;
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn scripts_directory(environment: &Path) -> PathBuf {
        if cfg!(windows) {
            environment.join("Scripts")
        } else {
            environment.join("bin")
        }
    }

    fn temporary_workspace() -> PathBuf {
        env::temp_dir().join(format!("pude-python-env-{}", uuid::Uuid::new_v4()))
    }

    fn create_complete_environment(workspace: &Path) -> (PathBuf, PathBuf) {
        let environment = workspace.join(".venv");
        let scripts = scripts_directory(&environment);
        fs::create_dir_all(&scripts).unwrap();
        fs::write(environment.join("pyvenv.cfg"), b"home = python").unwrap();
        fs::write(
            scripts.join(if cfg!(windows) {
                "python.exe"
            } else {
                "python"
            }),
            b"",
        )
        .unwrap();
        (environment, scripts)
    }

    #[test]
    fn detects_only_complete_project_virtual_environments() {
        let workspace = temporary_workspace();
        let environment = workspace.join(".venv");
        let scripts = scripts_directory(&environment);
        fs::create_dir_all(&scripts).unwrap();
        assert!(find_project_environment(&workspace).is_none());
        fs::write(environment.join("pyvenv.cfg"), b"home = python").unwrap();
        assert!(find_project_environment(&workspace).is_none());
        create_complete_environment(&workspace);
        assert_eq!(
            find_project_environment(&workspace),
            Some((environment, scripts))
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn trusted_workspaces_put_the_environment_first_on_path() {
        let workspace = temporary_workspace();
        let (environment, scripts) = create_complete_environment(&workspace);
        let mut command = CommandBuilder::new("python");
        assert_eq!(
            configure_project_environment(&mut command, &workspace, true),
            Some("Python environment active: .venv\r\n".to_string())
        );
        assert_eq!(
            command.get_env("VIRTUAL_ENV"),
            Some(environment.as_os_str())
        );
        assert_eq!(
            env::split_paths(command.get_env("PATH").unwrap()).next(),
            Some(scripts)
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn untrusted_workspaces_only_report_the_environment() {
        let workspace = temporary_workspace();
        create_complete_environment(&workspace);
        let mut command = CommandBuilder::new("python");
        let inherited = |command: &CommandBuilder| {
            ["VIRTUAL_ENV", "PATH", "PYTHONHOME"]
                .map(|name| command.get_env(name).map(ToOwned::to_owned))
        };
        let before = inherited(&command);
        assert_eq!(
            configure_project_environment(&mut command, &workspace, false),
            Some(
                "Python environment found: .venv (not activated). Run \"Trust Python environment\" from the command palette to activate it.\r\n"
                    .to_string()
            )
        );
        assert_eq!(inherited(&command), before);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn workspaces_without_an_environment_get_no_notice() {
        let workspace = temporary_workspace();
        fs::create_dir_all(&workspace).unwrap();
        let mut command = CommandBuilder::new("python");
        for activate in [false, true] {
            assert_eq!(
                configure_project_environment(&mut command, &workspace, activate),
                None
            );
        }
        fs::remove_dir_all(workspace).unwrap();
    }
}
