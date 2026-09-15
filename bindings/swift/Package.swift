// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "FoldHarnessV1",
    platforms: [
        .macOS(.v13),
        .iOS(.v16)
    ],
    products: [
        .library(name: "FoldHarnessV1", targets: ["FoldHarnessV1"])
    ],
    targets: [
        .target(name: "FoldHarnessV1"),
        .testTarget(name: "FoldHarnessV1Tests", dependencies: ["FoldHarnessV1"])
    ]
)
