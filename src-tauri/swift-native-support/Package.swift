// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SessionNativeSupport",
    platforms: [.macOS(.v13)],
    products: [
        .library(
            name: "SessionNativeSupport",
            type: .static,
            targets: ["SessionNativeSupport"]
        ),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "SessionNativeSupport",
            dependencies: []
        ),
        .testTarget(
            name: "SessionNativeSupportTests",
            dependencies: ["SessionNativeSupport"]
        ),
    ]
)
