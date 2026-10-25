// Asks macOS for Screen Recording on behalf of the app that launched this helper:
// shows the system prompt and adds the app to System Settings → Screen & System Audio Recording.
import CoreGraphics

if CGPreflightScreenCaptureAccess() {
  print("granted")
} else {
  print(CGRequestScreenCaptureAccess() ? "granted" : "requested")
}
