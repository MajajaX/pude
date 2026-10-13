use portable_pty::CommandBuilder;
use std::env;
use std::path::{Path, PathBuf};

const VIRTUAL_ENVIRONMENT_NAMES: [&str; 3] = [".venv", "venv", "env"];

pub fn activate_project_environment(
    command: &mut CommandBuilder,
    workspace: &Path,
) -> Option<PathBuf> {
    let (environment, scripts) = find_project_environment(workspace)?;
    let existing_path = env::var_os("PATH").unwrap_or_default();
    let paths = std::iter::once(scripts).chain(env::split_paths(&existing_path));
    let path = env::join_paths(paths).ok()?;
    command.env("VIRTUAL_ENV", environment.as_os_str());
    command.env("PATH", path);
    command.env_remove("PYTHONHOME");
    Some(environment)
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
    use super::{activate_project_environment, find_project_environment};
    use portable_pty::CommandBuilder;
    use std::env;
    use std::fs;

    #[test]
    fn detects_only_complete_project_virtual_environments() {
        let workspace =
            std::env::temp_dir().join(format!("pude-python-env-{}", uuid::Uuid::new_v4()));
        let environment = workspace.join(".venv");
        let scripts = if cfg!(windows) {
            environment.join("Scripts")
        } else {
            environment.join("bin")
        };
        fs::create_dir_all(&scripts).unwrap();
        assert!(find_project_environment(&workspace).is_none());
        fs::write(environment.join("pyvenv.cfg"), b"home = python").unwrap();
        assert!(find_project_environment(&workspace).is_none());
        fs::write(
            scripts.join(if cfg!(windows) {
                "python.exe"
            } else {
                "python"
            }),
            b"",
        )
        .unwrap();
        assert_eq!(
            find_project_environment(&workspace),
            Some((environment.clone(), scripts.clone()))
        );
        let mut command = CommandBuilder::new("python");
        assert_eq!(
            activate_project_environment(&mut command, &workspace),
            Some(environment.clone())
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
}
