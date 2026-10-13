//! Adversarial bootstrap launcher fixture: never opens the payload pipe, so
//! the parent's overlapped `ConnectNamedPipe` stays pending until the startup
//! deadline expires. Used to prove the parent bounds its wait, cancels the
//! pending I/O, and terminates the job tree instead of blocking forever.

fn main() {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
