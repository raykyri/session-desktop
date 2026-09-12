// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "QmuxNativeTerminal",
    platforms: [.macOS(.v13)],
    products: [
        .library(
            name: "QmuxNativeTerminal",
            type: .static,
            targets: ["QmuxNativeTerminal"]
        ),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "QmuxNativeTerminal",
            dependencies: []
        ),
        .testTarget(
            name: "QmuxNativeTerminalTests",
            dependencies: ["QmuxNativeTerminal"]
        ),
    ]
)
