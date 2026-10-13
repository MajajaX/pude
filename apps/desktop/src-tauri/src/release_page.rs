use reqwest::Url;
use serde::Deserialize;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::process::{Child, Command};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::thread;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const URL_HANDLER_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const URL_HANDLER_POLL_INTERVAL: Duration = Duration::from_millis(25);
const RELEASE_METADATA_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RELEASE_METADATA_BYTES: u64 = 1024 * 1024;
const REQUIRED_RELEASE_ASSETS: [&str; 4] = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_LICENSES.md",
    "SHA256SUMS.txt",
];

#[cfg(target_os = "windows")]
const PLATFORM_RELEASE_ASSET: &str = "pude-windows-x64-setup.exe";
#[cfg(target_os = "macos")]
const PLATFORM_RELEASE_ASSET: &str = "pude-macos-arm64.dmg";

#[tauri::command]
pub async fn open_release_page(url: String) -> Result<(), String> {
    let page_url = validate_release_url(&url)?;
    check_public_release(&page_url).await?;
    let url = page_url.to_string();
    super::blocking::run(
        "Unable to open the release page",
        super::blocking::BlockingClass::Misc,
        None,
        move || open_url_with_system_handler(&url),
    )
    .await
}

#[derive(Deserialize)]
struct ReleaseMetadata {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    size: u64,
}

async fn check_public_release(page_url: &Url) -> Result<(), String> {
    super::plugin_security::ensure_tls_provider_installed();
    let api_url = release_api_url(page_url)?;
    let client = reqwest::Client::builder()
        .timeout(RELEASE_METADATA_TIMEOUT)
        .user_agent(concat!("pude/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Unable to prepare the public release check.".to_string())?;
    let response = client
        .get(api_url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The public release check timed out after 5 seconds. Please try again.".to_string()
            } else {
                "Unable to check GitHub for a public pude release. Check your connection and try again."
                    .to_string()
            }
        })?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("No public pude release is available at this link yet.".to_string());
    }
    if !status.is_success() {
        return Err(format!(
            "GitHub could not verify this release (HTTP {}). Please try again.",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RELEASE_METADATA_BYTES)
    {
        return Err("GitHub returned release metadata that is too large.".to_string());
    }
    let body = read_release_metadata_body(response).await?;
    validate_release_metadata(&body, requested_tag(page_url))
}

async fn read_release_metadata_body(mut response: reqwest::Response) -> Result<String, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            "The public release check timed out after 5 seconds. Please try again.".to_string()
        } else {
            "Unable to read the public release details. Please try again.".to_string()
        }
    })? {
        append_release_metadata_chunk(&mut body, &chunk)?;
    }
    String::from_utf8(body)
        .map_err(|_| "GitHub returned invalid public release metadata.".to_string())
}

fn append_release_metadata_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) as u64 > MAX_RELEASE_METADATA_BYTES {
        return Err("GitHub returned release metadata that is too large.".to_string());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn release_api_url(page_url: &Url) -> Result<Url, String> {
    const LATEST_PAGE: &str = "/MajajaX/pude/releases/latest";
    const TAG_PREFIX: &str = "/MajajaX/pude/releases/tag/";
    if page_url.path() == LATEST_PAGE {
        return Url::parse("https://api.github.com/repos/MajajaX/pude/releases/latest")
            .map_err(|_| "Unable to construct the GitHub release API URL.".to_string());
    }

    let Some(tag) = page_url.path().strip_prefix(TAG_PREFIX) else {
        return Err("The selected URL is not a pude release page.".to_string());
    };
    let encoded_tag = tag.replace('+', "%2B");
    Url::parse(&format!(
        "https://api.github.com/repos/MajajaX/pude/releases/tags/{encoded_tag}"
    ))
    .map_err(|_| "Unable to construct the GitHub release API URL.".to_string())
}

fn requested_tag(page_url: &Url) -> Option<&str> {
    page_url.path().strip_prefix("/MajajaX/pude/releases/tag/")
}

fn validate_release_metadata(payload: &str, expected_tag: Option<&str>) -> Result<(), String> {
    let release: ReleaseMetadata = serde_json::from_str(payload)
        .map_err(|_| "GitHub returned invalid public release metadata.".to_string())?;
    if release.draft || release.prerelease {
        return Err(
            "This draft or prerelease is not available as a published download.".to_string(),
        );
    }
    if !valid_semver_tag(&release.tag_name)
        || has_prerelease_tag(&release.tag_name)
        || expected_tag.is_some_and(|tag| tag != release.tag_name)
    {
        return Err("The public release does not match the selected version.".to_string());
    }

    let mut required_assets = REQUIRED_RELEASE_ASSETS.to_vec();
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    required_assets.push(PLATFORM_RELEASE_ASSET);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    required_assets.extend(["pude-windows-x64-setup.exe", "pude-macos-arm64.dmg"]);
    let missing_assets: Vec<_> = required_assets
        .iter()
        .filter(|name| {
            !release
                .assets
                .iter()
                .any(|asset| asset.name == **name && asset.size > 0)
        })
        .copied()
        .collect();
    if !missing_assets.is_empty() {
        return Err(format!(
            "This public release is missing usable downloads: {}.",
            missing_assets.join(", ")
        ));
    }
    Ok(())
}

fn open_url_with_system_handler(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        run_url_handler(&mut command, url, URL_HANDLER_TIMEOUT)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = url;
        Err("Opening release pages is unsupported on this platform.".to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn run_url_handler(command: &mut Command, url: &str, timeout: Duration) -> Result<(), String> {
    let mut child = command
        .arg(url)
        .spawn()
        .map_err(|error| format!("Unable to start the system URL handler: {error}"))?;
    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!("The system URL handler exited with {status}."));
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(
                    URL_HANDLER_POLL_INTERVAL
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Ok(None) => {
                return Err(terminate_and_reap(
                    child,
                    format!(
                        "The system URL handler exceeded its {} ms deadline",
                        timeout.as_millis()
                    ),
                ));
            }
            Err(error) => {
                return Err(terminate_and_reap(
                    child,
                    format!("Unable to check the system URL handler: {error}"),
                ));
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn terminate_and_reap(mut child: Child, reason: String) -> String {
    let kill_error = child.kill().err();
    tauri::async_runtime::spawn_blocking(move || child.wait());
    match kill_error {
        Some(error) => format!("{reason}; termination request failed: {error}."),
        None => format!("{reason}; the child was terminated and is being reaped."),
    }
}

fn validate_release_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Release page URL is invalid.".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != value
    {
        return Err("Only pude release pages on github.com can be opened.".to_string());
    }

    let path = url.path();
    let allowed = path == "/MajajaX/pude/releases/latest"
        || path
            .strip_prefix("/MajajaX/pude/releases/tag/")
            .is_some_and(valid_semver_tag);
    if !allowed {
        return Err(
            "Only the latest pude release or a versioned pude release can be opened.".to_string(),
        );
    }

    Ok(url)
}

fn valid_semver_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else {
        return false;
    };
    let version = match version.split_once('+') {
        Some((version, build)) if !build.is_empty() && !build.contains('+') => {
            if !valid_identifiers(build, false) {
                return false;
            }
            version
        }
        Some(_) => return false,
        None => version,
    };

    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) if !prerelease.is_empty() => (core, Some(prerelease)),
        Some(_) => return false,
        None => (version, None),
    };
    let components: Vec<_> = core.split('.').collect();
    if components.len() != 3
        || !components
            .iter()
            .all(|component| valid_core_number(component))
    {
        return false;
    }
    prerelease.is_none_or(|identifiers| valid_identifiers(identifiers, true))
}

fn has_prerelease_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else {
        return false;
    };
    let version = version
        .split_once('+')
        .map_or(version, |(version, _)| version);
    version.contains('-')
}

fn valid_core_number(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn valid_identifiers(value: &str, prerelease: bool) -> bool {
    value.split('.').all(|identifier| {
        !identifier.is_empty()
            && identifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && (!prerelease
                || !identifier.bytes().all(|byte| byte.is_ascii_digit())
                || identifier == "0"
                || !identifier.starts_with('0'))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        append_release_metadata_chunk, release_api_url, valid_semver_tag,
        validate_release_metadata, validate_release_url, MAX_RELEASE_METADATA_BYTES,
    };

    #[test]
    fn accepts_only_latest_and_semver_release_pages() {
        for value in [
            "https://github.com/MajajaX/pude/releases/latest",
            "https://github.com/MajajaX/pude/releases/tag/v0.1.0",
            "https://github.com/MajajaX/pude/releases/tag/v1.2.3-rc.1+build.4",
        ] {
            assert!(validate_release_url(value).is_ok(), "accepted URL: {value}");
        }
    }

    #[test]
    fn rejects_other_origins_urls_and_release_paths() {
        for value in [
            "http://github.com/MajajaX/pude/releases/latest",
            "https://github.com.evil.example/MajajaX/pude/releases/latest",
            "https://user@github.com/MajajaX/pude/releases/latest",
            "https://user:pass@github.com/MajajaX/pude/releases/latest",
            "https://github.com:444/MajajaX/pude/releases/latest",
            "https://github.com:443/MajajaX/pude/releases/latest",
            "https://github.com/MajajaX/pude/releases/latest?download=1",
            "https://github.com/MajajaX/pude/releases/latest#download",
            "https://github.com/MajajaX/other/releases/latest",
            "https://github.com/MajajaX/pude/releases/",
            "https://github.com/MajajaX/pude/releases/tag/v1.2.3/extra",
            "https://github.com/MajajaX/pude/releases/tag/v1.2.3%2Fextra",
            "https://github.com/MajajaX/pude/releases/tag/v1.2.3;open=bad",
        ] {
            assert!(
                validate_release_url(value).is_err(),
                "rejected URL: {value}"
            );
        }
    }

    #[test]
    fn accepts_semver_pre_and_build_metadata_and_rejects_malformed_tags() {
        for tag in ["v0.0.0", "v12.34.56", "v1.2.3-alpha.1", "v1.2.3+build.001"] {
            assert!(valid_semver_tag(tag), "accepted version tag: {tag}");
        }
        for tag in [
            "v1.2",
            "v1.2.3.4",
            "1.2.3",
            "v01.2.3",
            "v1.02.3",
            "v1.2.03",
            "v1.2.3-",
            "v1.2.3-alpha..one",
            "v1.2.3-alpha.01",
            "v1.2.3+",
            "v1.2.3+build+other",
            "v1.2.3;open=bad",
        ] {
            assert!(!valid_semver_tag(tag), "rejected version tag: {tag}");
        }
    }

    #[test]
    fn maps_release_pages_to_fixed_github_api_endpoints() {
        let latest = validate_release_url("https://github.com/MajajaX/pude/releases/latest")
            .expect("latest release page is allowed");
        assert_eq!(
            release_api_url(&latest).unwrap().as_str(),
            "https://api.github.com/repos/MajajaX/pude/releases/latest"
        );

        let version = validate_release_url(
            "https://github.com/MajajaX/pude/releases/tag/v1.2.3-rc.1+build.4",
        )
        .expect("versioned release page is allowed");
        assert_eq!(
            release_api_url(&version).unwrap().as_str(),
            "https://api.github.com/repos/MajajaX/pude/releases/tags/v1.2.3-rc.1%2Bbuild.4"
        );
    }

    #[test]
    fn accepts_only_published_releases_with_all_nonempty_downloads() {
        let payload = r#"{
            "tag_name":"v1.0.0",
            "draft":false,
            "prerelease":false,
            "assets":[
                {"name":"pude-windows-x64-setup.exe","size":1},
                {"name":"pude-macos-arm64.dmg","size":2},
                {"name":"LICENSE","size":3},
                {"name":"THIRD_PARTY_NOTICES.md","size":4},
                {"name":"THIRD_PARTY_LICENSES.md","size":5},
                {"name":"SHA256SUMS.txt","size":6}
            ]
        }"#;
        assert!(validate_release_metadata(payload, None).is_ok());
        assert!(validate_release_metadata(payload, Some("v1.0.0")).is_ok());
        assert!(validate_release_metadata(payload, Some("v1.0.1")).is_err());

        let stable_build_tag =
            payload.replace("\"tag_name\":\"v1.0.0\"", "\"tag_name\":\"v1.0.0+ci.4\"");
        assert!(valid_semver_tag("v1.0.0+ci.4"));
        assert!(validate_release_metadata(&stable_build_tag, Some("v1.0.0+ci.4")).is_ok());

        for invalid in [
            payload.replace("\"draft\":false", "\"draft\":true"),
            payload.replace("\"prerelease\":false", "\"prerelease\":true"),
            payload.replace("\"size\":1", "\"size\":0").replace("\"size\":2", "\"size\":0"),
            payload.replace(
                ",\n                {\"name\":\"SHA256SUMS.txt\",\"size\":6}",
                "",
            ),
            payload.replace(
                ",\n                {\"name\":\"THIRD_PARTY_LICENSES.md\",\"size\":5}",
                "",
            ),
        ] {
            assert!(validate_release_metadata(&invalid, None).is_err());
        }
    }

    #[test]
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    fn accepts_platform_only_release_and_requires_the_current_platform_installer() {
        let payload = serde_json::json!({
            "tag_name": "v1.0.0", "draft": false, "prerelease": false,
            "assets": super::REQUIRED_RELEASE_ASSETS.iter()
                .chain(std::iter::once(&super::PLATFORM_RELEASE_ASSET))
                .map(|name| serde_json::json!({"name": name, "size": 1}))
                .collect::<Vec<_>>()
        });
        assert!(validate_release_metadata(&payload.to_string(), None).is_ok());
        let mut missing_installer = payload;
        missing_installer["assets"].as_array_mut().unwrap().pop();
        assert!(validate_release_metadata(&missing_installer.to_string(), None).is_err());
    }

    #[test]
    fn rejects_prerelease_tag_when_github_marks_release_stable() {
        let payload = r#"{
            "tag_name":"v1.0.0-rc.1",
            "draft":false,
            "prerelease":false,
            "assets":[]
        }"#;
        assert!(valid_semver_tag("v1.0.0-rc.1"));
        assert_eq!(
            validate_release_metadata(payload, None).unwrap_err(),
            "The public release does not match the selected version."
        );
    }

    #[test]
    fn caps_release_metadata_body_even_without_content_length() {
        let mut body = Vec::new();
        let maximum = MAX_RELEASE_METADATA_BYTES as usize;
        append_release_metadata_chunk(&mut body, &vec![b'a'; maximum - 1])
            .expect("body under the limit is accepted");
        assert!(append_release_metadata_chunk(&mut body, b"ab").is_err());
        assert_eq!(body.len(), maximum - 1);
    }

    #[cfg(unix)]
    #[test]
    fn stops_a_system_handler_that_exceeds_its_deadline() {
        use super::run_url_handler;
        use std::process::Command;
        use std::time::{Duration, Instant};

        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        let started = Instant::now();
        let error = run_url_handler(
            &mut command,
            "https://github.com/MajajaX/pude/releases/latest",
            Duration::from_millis(50),
        )
        .expect_err("a long-running URL handler should time out");

        assert!(
            error.contains("50 ms deadline"),
            "unexpected error: {error}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
