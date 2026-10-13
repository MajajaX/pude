use super::*;
use crate::git_runtime::{CancellationToken, GitCommandSpec, GitCoordinator};
use serde_json::{json, Value};
use std::hint::black_box;
use std::process::Command;
use std::time::Instant;

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sample_percentiles(times: &[f64]) -> (f64, f64) {
    assert!(!times.is_empty());
    let mut ordered = times.to_vec();
    ordered.sort_by(f64::total_cmp);
    let middle = ordered.len() / 2;
    let median = if ordered.len().is_multiple_of(2) {
        (ordered[middle - 1] + ordered[middle]) / 2.0
    } else {
        ordered[middle]
    };
    (median, ordered[(ordered.len() * 95).div_ceil(100) - 1])
}

#[test]
fn sample_percentiles_use_standard_median_and_nearest_rank_p95() {
    assert_eq!(sample_percentiles(&[3.0, 1.0, 2.0]), (2.0, 3.0));
    assert_eq!(sample_percentiles(&[2.0, 1.0]), (1.5, 2.0));
    let samples: Vec<f64> = (0..20).rev().map(|value| f64::from(value * 10)).collect();
    assert_eq!(sample_percentiles(&samples), (95.0, 180.0));
}

fn measure(name: &str, size: usize, samples: usize, mut run: impl FnMut()) -> Value {
    run();
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        run();
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let (median, p95) = sample_percentiles(&times);
    json!({ "operation": name, "fixtureSize": size, "samplesMs": times,
        "medianMs": median, "p95Ms": p95 })
}

#[test]
#[ignore = "native microbenchmarks; run explicitly in release profile with PUDE_NATIVE_BENCH_REPORT"]
fn native_microbenchmarks() {
    let report_path = std::env::var_os("PUDE_NATIVE_BENCH_REPORT")
        .expect("PUDE_NATIVE_BENCH_REPORT must name an evidence file");
    let root = Fixture(std::env::temp_dir().join(format!("pude-native-bench-{}", Uuid::new_v4())));
    fs::create_dir(&root.0).unwrap();
    let git = Command::new("git")
        .arg("init")
        .arg("--quiet")
        .arg(&root.0)
        .output()
        .unwrap();
    assert!(git.status.success());
    let coordinator = GitCoordinator::new();
    let mut results = Vec::new();
    for mib in [1, 5, 20] {
        let size: usize = mib * 1024 * 1024;
        let line = b"let sample = 42;\n";
        let mut bytes = line.repeat(size.div_ceil(line.len()));
        bytes.truncate(size);
        let path = root.0.join(format!("file-{mib}MiB.txt"));
        fs::write(&path, &bytes).unwrap();
        let wire = wire_path(&path);
        results.push(measure("decode-lf", size, 20, || {
            let decoded = decode_text_bytes(black_box(&bytes)).unwrap();
            assert_eq!(decoded.0.len(), size);
            black_box(decoded);
        }));
        results.push(measure("read-decode-fingerprint", size, 5, || {
            let file = read_file_sync(wire.clone()).unwrap();
            assert_eq!(file.size, size);
            black_box(file);
        }));
        let text = String::from_utf8(bytes).unwrap();
        let locks = Arc::new(Mutex::new(HashMap::new()));
        let mut expected = read_file_sync(wire.clone()).unwrap().fingerprint;
        results.push(measure("serialize-atomic-save-verify", size, 5, || {
            let saved = save_file_sync(
                wire.clone(),
                text.clone(),
                "lf".to_string(),
                None,
                false,
                None,
                None,
                Some(expected.clone()),
                Arc::clone(&locks),
            )
            .unwrap();
            expected = saved.fingerprint;
            assert_eq!(saved.size, size);
            black_box(saved.identity);
        }));
        let mut status = Vec::with_capacity(size + 128);
        let mut records = 0;
        while status.len() < size {
            status.extend_from_slice(
                format!("? fixture-{records:08}-{}.rs\0", "x".repeat(80)).as_bytes(),
            );
            records += 1;
        }
        results.push(measure("parse-git-status", status.len(), 5, || {
            let parsed = crate::parse_git_status(black_box(&status));
            assert_eq!(parsed.files.len(), records);
            black_box(parsed);
        }));
        let object = Command::new("git")
            .current_dir(&root.0)
            .args(["hash-object", "-w"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(object.status.success());
        let oid = String::from_utf8(object.stdout).unwrap().trim().to_string();
        results.push(measure("git-process-capture", size, 5, || {
            let spec = GitCommandSpec::read(
                root.0.clone(),
                vec!["cat-file".into(), "blob".into(), oid.clone().into()],
            )
            .with_output_limits(24 * 1024 * 1024, 512 * 1024);
            let output = coordinator
                .execute(spec, &CancellationToken::new())
                .unwrap()
                .into_success()
                .unwrap();
            assert_eq!(output.stdout.len(), size);
            black_box(output);
        }));
    }
    for count in [1_000, 10_000, 100_000] {
        let directory = root.0.join(format!("entries-{count}"));
        fs::create_dir(&directory).unwrap();
        for index in 0..count {
            fs::write(directory.join(format!("file-{index:06}.txt")), b"fixture\n").unwrap();
        }
        let mut result = measure("list-directory-bounded", count, 5, || {
            let listing = list_directory_sync(wire_path(&directory)).unwrap();
            assert_eq!(
                listing.entries.len(),
                count.min(MAX_DIRECTORY_LISTING_ENTRIES)
            );
            assert!(listing.partial_error.is_none());
            assert_eq!(listing.incomplete, count > MAX_DIRECTORY_LISTING_ENTRIES);
            assert!(listing.entries_bytes <= MAX_DIRECTORY_LISTING_BYTES);
            assert!(serde_json::to_vec(&listing).unwrap().len() <= MAX_DIRECTORY_LISTING_BYTES);
            black_box(listing);
        });
        let listing = list_directory_sync(wire_path(&directory)).unwrap();
        result["returnedEntries"] = json!(listing.entries.len());
        result["scannedEntries"] = json!(listing.scanned_entries);
        result["entriesBytes"] = json!(listing.entries_bytes);
        result["ipcPayloadBytes"] = json!(serde_json::to_vec(&listing).unwrap().len());
        result["incomplete"] = json!(listing.incomplete);
        result["stopReason"] = json!(listing.stop_reason);
        results.push(result);
    }
    fs::write(
        report_path,
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1, "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "fixtureStorage": "isolated local temporary directory", "warmupRuns": 1,
            "results": results,
        }))
        .unwrap(),
    )
    .unwrap();
}
