// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "herdr-sim",
  platforms: [.macOS(.v15)],
  dependencies: [
    .package(url: "https://github.com/facebook/homebrew-fb", exact: "1.7.8"),
  ],
  targets: [
    .executableTarget(
      name: "herdr-sim",
      dependencies: [
        .product(name: "FBSimulatorControl", package: "homebrew-fb"),
        .product(name: "FBSimulatorAX", package: "homebrew-fb"),
      ],
      swiftSettings: [.swiftLanguageMode(.v5)],
      // CoreSimulatorStub.framework is copied beside the binary by SwiftPM but no rpath points at it.
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path"])]
    ),
  ]
)
