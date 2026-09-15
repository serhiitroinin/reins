import Foundation
import XCTest
@testable import FoldHarnessV1

final class BindingTests: XCTestCase {
    func testCrossStackFixtureRoundTrips() throws {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("schema/v1/fixtures/native-v1.json")
        let source = try Data(contentsOf: fixtureURL)
        let decoded = try JSONDecoder().decode(FHV1.self, from: source)

        XCTAssertEqual(decoded.event.adapterID, "xai:grok-acp")
        XCTAssertEqual(decoded.event.payload.kind, "extension")
        XCTAssertEqual(decoded.runRequest.adapterID, "openai:codex")
        XCTAssertEqual(decoded.modelCatalog.models[1].id, "grok-4")

        let expected = try JSONSerialization.jsonObject(with: source) as? NSDictionary
        let encoded = try JSONEncoder().encode(decoded)
        let actual = try JSONSerialization.jsonObject(with: encoded) as? NSDictionary
        XCTAssertEqual(actual, expected)
    }
}
