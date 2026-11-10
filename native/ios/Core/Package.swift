// swift-tools-version:5.9
import PackageDescription

// The iOS app's logic that needs nothing but Foundation: which links stay in the app, the bridge's
// rules and wire format, version checks. It builds and tests on Linux too (CI runs it there).
let package = Package(
    name: "StacksShellCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "StacksShellCore", targets: ["StacksShellCore"])],
    targets: [
        .target(name: "StacksShellCore"),
        .testTarget(name: "StacksShellCoreTests", dependencies: ["StacksShellCore"]),
    ]
)
