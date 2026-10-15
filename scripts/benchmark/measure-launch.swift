// Launches a macOS app once and prints one JSON line:
//   windowMs  – time until the first window is on screen
//   readyMs   – time until the window contents stop changing (visually complete)
//   memoryMB  – summed physical footprint of every process the app is responsible for
//   processes – how many processes that is
// usage: measure-launch <App.app> <settleSeconds> [app arguments...]
// Needs the Screen Recording permission for the terminal that runs it.
import AppKit
import ScreenCaptureKit
import Darwin

let appURL = URL(fileURLWithPath: CommandLine.arguments[1])
let settleSeconds = Double(CommandLine.arguments[2])!
let appArguments = Array(CommandLine.arguments.dropFirst(3))

// A frame counts as changed when more than this share of its pixels differ.
// Toasts and status-bar text stay below it; a panel filling in does not.
let changedPixelShare = 0.003
let stableMs = 1_500.0
let timeoutMs = 30_000.0

typealias ResponsibleFunction = @convention(c) (pid_t) -> pid_t
let responsiblePid = unsafeBitCast(
  dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid"),
  to: ResponsibleFunction.self)

func nowMs() -> Double { Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e6 }

func allPids() -> [pid_t] {
  var pids = [pid_t](repeating: 0, count: 8192)
  let count = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
  return Array(pids.prefix(Int(count)))
}

func parentPid(_ pid: pid_t) -> pid_t {
  var info = proc_bsdinfo()
  let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
  return size > 0 ? pid_t(info.pbi_ppid) : -1
}

func footprintBytes(_ pid: pid_t) -> UInt64 {
  var info = rusage_info_v4()
  let result = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  return result == 0 ? info.ri_phys_footprint : 0
}

// Helpers (Electron) and XPC services (WebKit) all name the app as their
// responsible process, the same attribution Activity Monitor uses.
func processesOwned(by root: pid_t) -> [pid_t] {
  var owned: Set<pid_t> = [root]
  let pids = allPids()
  var grew = true
  while grew {
    grew = false
    for pid in pids where !owned.contains(pid) && (owned.contains(responsiblePid(pid)) || owned.contains(parentPid(pid))) {
      owned.insert(pid)
      grew = true
    }
  }
  return Array(owned)
}

func onScreenWindow(of pid: pid_t) -> CGWindowID? {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let window = windows.first { window in
    let bounds = window[kCGWindowBounds as String] as? [String: Double]
    return (window[kCGWindowOwnerPID as String] as? pid_t) == pid
      && (window[kCGWindowLayer as String] as? Int) == 0
      && (bounds?["Height"] ?? 0) > 200
  }
  return window?[kCGWindowNumber as String] as? CGWindowID
}

func pixels(of image: CGImage) -> [UInt8] {
  let width = 240, height = 150
  var buffer = [UInt8](repeating: 0, count: width * height * 4)
  let context = CGContext(data: &buffer, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return buffer
}

func changedShare(_ a: [UInt8], _ b: [UInt8]) -> Double {
  var changed = 0
  for i in stride(from: 0, to: a.count, by: 4)
  where abs(Int(a[i]) - Int(b[i])) + abs(Int(a[i + 1]) - Int(b[i + 1])) + abs(Int(a[i + 2]) - Int(b[i + 2])) > 24 {
    changed += 1
  }
  return Double(changed) / Double(a.count / 4)
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("measure-launch: \(message)\n".data(using: .utf8)!)
  exit(1)
}

func measure() async throws {
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.createsNewApplicationInstance = true
  configuration.arguments = appArguments

  let start = nowMs()
  let app = try await NSWorkspace.shared.openApplication(at: appURL, configuration: configuration)
  let pid = app.processIdentifier

  var windowID = onScreenWindow(of: pid)
  while windowID == nil {
    if nowMs() - start > timeoutMs { fail("no window appeared (is another instance already running?)") }
    usleep(2_000)
    windowID = onScreenWindow(of: pid)
  }
  let windowMs = nowMs() - start

  let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  guard let window = content.windows.first(where: { $0.windowID == windowID }) else { fail("window is not capturable") }
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let captureConfiguration = SCStreamConfiguration()
  captureConfiguration.width = 480
  captureConfiguration.height = 300
  captureConfiguration.showsCursor = false

  // Visually complete: the last changed frame before the window stays unchanged for `stableMs`.
  var previousFrame: [UInt8]?
  var readyMs = windowMs
  while nowMs() - start < timeoutMs {
    let frame = pixels(of: try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: captureConfiguration))
    let capturedMs = nowMs() - start
    if let previousFrame, changedShare(previousFrame, frame) > changedPixelShare { readyMs = capturedMs }
    previousFrame = frame
    if capturedMs - readyMs >= stableMs { break }
  }

  let settleRemainingMs = settleSeconds * 1000 - (nowMs() - start)
  if settleRemainingMs > 0 { usleep(useconds_t(settleRemainingMs * 1000)) }
  var memorySamples: [Double] = []
  var processCount = 0
  for _ in 0..<3 {
    let owned = processesOwned(by: pid)
    processCount = owned.count
    memorySamples.append(Double(owned.map(footprintBytes).reduce(0, +)) / 1_000_000)
    sleep(1)
  }

  app.terminate()
  for _ in 0..<100 where !app.isTerminated { usleep(100_000) }
  if !app.isTerminated { app.forceTerminate() }
  sleep(1)

  let memoryMB = memorySamples.reduce(0, +) / Double(memorySamples.count)
  print(String(format: "{\"windowMs\":%.0f,\"readyMs\":%.0f,\"memoryMB\":%.1f,\"processes\":%d}", windowMs, readyMs, memoryMB, processCount))
}

Task {
  do { try await measure() } catch { fail("\(error)") }
  exit(0)
}
RunLoop.main.run()
