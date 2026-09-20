// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ReinsV1",
    platforms: [
        .macOS(.v13),
        .iOS(.v16)
    ],
    products: [
        .library(name: "ReinsV1", targets: ["ReinsV1"])
    ],
    targets: [
        .target(name: "ReinsV1"),
        .testTarget(name: "ReinsV1Tests", dependencies: ["ReinsV1"])
    ]
)
