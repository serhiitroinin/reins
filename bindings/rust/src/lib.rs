use serde::{Serialize, Deserialize};
use std::collections::HashMap;

/// Generation-only reachability document for the public v1 schema roots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V1 {
    pub capabilities: Capabilities,

    pub discovery_request: Discovery,

    pub engine_profile: EngineProfile,

    pub engine_profile_discovery: EngineProfileDiscovery,

    pub event: Event,

    pub interaction: Interaction,

    pub interaction_response: Response,

    pub limit_snapshot: LimitSnapshot,

    pub limit_snapshot_discovery: LimitSnapshotDiscovery,

    pub model_catalog: ModelCatalog,

    pub model_catalog_discovery: ModelCatalogDiscovery,

    pub resolved_configuration: ResolvedConfiguration,

    pub run_request: RunRequest,

    pub tool_descriptor: ToolDescriptor,

    pub tool_result: ToolResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    pub cancel: Cancel,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Cancel>>,

    pub filesystem: Cancel,

    pub images: Cancel,

    pub interactions: Cancel,

    pub network: Cancel,

    pub plans: Cancel,

    pub resume: Cancel,

    pub shell: Cancel,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub steering: Option<Steering>,

    pub subagents: Cancel,

    pub thinking: Cancel,

    pub tools: Cancel,

    pub usage: Cancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cancel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<HashMap<String, Option<ProtocolSchema>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    pub support: Support,
}

/// A value representable by RFC 8259 JSON without coercion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProtocolSchema {
    Bool(bool),

    Double(f64),

    PurpleString(String),

    UnionArray(Vec<Option<ProtocolSchema>>),

    UnionMap(HashMap<String, Option<ProtocolSchema>>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Experimental,

    Stable,

    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Steering {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<HashMap<String, Option<ProtocolSchema>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred: Option<Preferred>,

    pub strategies: Vec<Preferred>,

    pub support: Support,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Preferred {
    #[serde(rename = "replacement-turn")]
    ReplacementTurn,

    #[serde(rename = "same-turn")]
    SameTurn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,

    pub adapter_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,

    pub schema_version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<ControlElement>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    pub id: String,

    pub label: String,

    pub permissions: Permissions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlElement {
    pub default_value: Option<DefaultValueUnion>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    pub id: String,

    pub kind: Kind,

    pub label: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<OptionElement>>,

    pub scope: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DefaultValueUnion {
    Bool(bool),

    Double(f64),

    PurpleString(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExtensionValue {
    Bool(bool),

    Double(f64),

    PurpleString(String),

    UnionArray(Vec<Option<ExtensionValue>>),

    UnionMap(HashMap<String, Option<ExtensionValue>>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Number,

    Select,

    Toggle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    pub id: String,

    pub label: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub default_mode_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    pub kind: String,

    pub modes: Vec<ModeElement>,

    pub selectable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent: Option<Consent>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    pub id: String,

    pub label: String,

    pub posture: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Consent {
    pub description: String,

    pub title: String,

    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProfileDiscovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,

    pub status: EngineProfileDiscoveryStatus,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<EngineProfile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineProfileDiscoveryStatus {
    Available,

    Unavailable,

    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub adapter_id: String,

    pub event_id: String,

    pub payload: Payload,

    pub run_id: String,

    pub schema_version: i64,

    pub sequence: i64,

    pub session: Session,

    pub timestamp: String,

    pub turn_id: String,
}

/// A future additive core payload. Consumers must retain or safely ignore it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ProtocolSchema>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction: Option<Interaction>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,

    pub kind: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_append: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,

    pub payload: Option<ProtocolSchema>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<Response>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<PayloadStatus>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<StepElement>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_kind: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepts_text: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<ChoiceElement>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,

    pub id: String,

    pub kind: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<ProtocolSchema>>>,

    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChoiceElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    pub id: String,

    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadStatus {
    Cancelled,

    Completed,

    Declined,

    Error,

    Failed,

    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepElement {
    pub status: String,

    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<HashMap<String, Option<ProtocolSchema>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub actor_id: String,

    pub tenant_id: String,

    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    pub limits: Vec<LimitElement>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    pub id: String,

    pub kind: String,

    pub label: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_ids: Option<Vec<String>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,

    pub scope: String,

    pub unit: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitSnapshotDiscovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,

    pub status: EngineProfileDiscoveryStatus,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<LimitSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model_id: Option<String>,

    pub models: Vec<ModelElement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<ControlElement>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<Group>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,

    pub id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,

    pub label: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effort {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_option_id: Option<String>,

    pub options: Vec<OptionElement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub id: String,

    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogDiscovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,

    pub status: EngineProfileDiscoveryStatus,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<ModelCatalog>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedConfiguration {
    pub controls: HashMap<String, ControlValue>,

    pub issues: Vec<IssueElement>,

    pub permission: ResolvedConfigurationPermission,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlValue {
    Bool(bool),

    Double(f64),

    PurpleString(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IssueElement {
    pub code: Code,

    pub message: String,

    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Code {
    #[serde(rename = "invalid-value")]
    InvalidValue,

    #[serde(rename = "stale-consent")]
    StaleConsent,

    #[serde(rename = "unknown-control")]
    UnknownControl,

    #[serde(rename = "unknown-permission")]
    UnknownPermission,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedConfigurationPermission {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_version: Option<String>,

    pub mode_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,

    pub adapter_id: String,

    /// JSON-safe adapter-specific configuration. This escape hatch is not a portable UI contract.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration: Option<HashMap<String, Option<ProtocolSchema>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,

    pub input: Vec<InputElement>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<ProtocolSchema>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    pub schema_version: i64,

    pub session: Session,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Settings>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<Encoding>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    #[serde(rename = "type")]
    pub protocol_schema_type: Type,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    Base64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Type {
    Image,

    Resource,

    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<HashMap<String, ControlValue>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<SettingsPermission>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPermission {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_version: Option<String>,

    pub mode_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub description: String,

    pub input_schema: HashMap<String, Option<ProtocolSchema>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<ProtocolSchema>>>,

    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,

    pub content: Vec<ContentElement>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<ProtocolSchema>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,

    #[serde(rename = "type")]
    pub protocol_schema_type: Type,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}
