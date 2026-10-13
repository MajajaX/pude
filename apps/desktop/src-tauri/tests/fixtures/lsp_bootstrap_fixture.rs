//! Test helper binary that speaks the exact same Windows LSP bootstrap
//! protocol as the desktop app, built with a bare `rustc` invocation from the
//! integration tests. The production app launches its own executable with
//! `--pude-lsp-bootstrap`; the test harness binary has no such branch (libtest
//! exits with an unrecognized-option error), so tests inject this helper as
//! the bootstrap launcher instead.

#[cfg(windows)]
mod app_log {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/app_log.rs"));
}

#[cfg(windows)]
mod lsp_bootstrap_protocol {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/lsp_bootstrap_protocol.rs"
    ));
}

fn main() {
    if lsp_bootstrap_protocol::run_if_requested() {
        return;
    }
}
