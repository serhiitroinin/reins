use reins_schema::V1;

#[test]
fn round_trips_the_cross_stack_fixture() {
    let source = include_str!("../../../schema/v1/fixtures/native-v1.json");
    let decoded: V1 = serde_json::from_str(source).expect("fixture must decode");

    assert_eq!(decoded.event.adapter_id, "xai:grok-acp");
    assert_eq!(decoded.event.payload.kind, "extension");
    assert_eq!(decoded.run_request.adapter_id, "openai:codex");
    assert_eq!(decoded.model_catalog.models[1].id, "grok-4");

    let expected: serde_json::Value = serde_json::from_str(source).expect("fixture must be JSON");
    let encoded = serde_json::to_value(decoded).expect("binding must encode");
    assert_eq!(encoded, expected);
}
