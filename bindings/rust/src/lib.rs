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

    pub inline_context: InlineContext,

    pub input_policy: InputPolicy,

    pub interaction: Interaction,

    pub interaction_response: Response,

    pub limit_snapshot: LimitSnapshot,

    pub limit_snapshot_discovery: LimitSnapshotDiscovery,

    pub model_catalog: ModelCatalog,

    pub model_catalog_discovery: ModelCatalogDiscovery,

    pub resolved_configuration: ResolvedConfiguration,

    pub run_request: RunRequest,

    pub sidecar_diagnostic_notification: SidecarDiagnosticNotificationClass,

    pub sidecar_events_list_params: SidecarEventsListParamsClass,

    pub sidecar_follow_up_params: SidecarFollowUpParamsClass,

    pub sidecar_initialize_params: SidecarInitializeParamsClass,

    pub sidecar_initialize_result: SidecarInitializeResultClass,

    pub sidecar_respond_params: SidecarRespondParamsClass,

    pub sidecar_run_settled_notification: SidecarRunSettledNotificationClass,

    pub sidecar_run_start_params: SidecarRunStartParamsClass,

    pub sidecar_stop_subagent_params: HarnessSidecarStopSubagentParams,

    pub sidecar_tool_call_params: SidecarToolCallParamsClass,

    pub sidecar_tool_call_result: SidecarToolCallResultClass,

    pub sidecar_tool_cancel_notification: SidecarToolCancelNotificationClass,

    pub tool_descriptor: ToolDescriptorElement,

    pub tool_result: ToolResultClass,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    pub cancel: Cancel,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Cancel>>,

    pub filesystem: Cancel,

    pub images: Cancel,

    pub interactions: Interactions,

    pub network: Cancel,

    pub plans: Cancel,

    pub resume: Cancel,

    pub shell: Cancel,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub steering: Option<Steering>,

    pub subagents: Subagents,

    pub thinking: Cancel,

    pub tools: Cancel,

    pub usage: Cancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cancel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<HashMap<String, Option<InputValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    pub support: Support,
}

/// A value representable by RFC 8259 JSON without coercion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InputValue {
    Bool(bool),

    Double(f64),

    PurpleString(String),

    UnionArray(Vec<Option<InputValue>>),

    UnionMap(HashMap<String, Option<InputValue>>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Experimental,

    Stable,

    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Interactions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<HashMap<String, Option<InputValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<Recovery>,

    pub support: Support,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Recovery {
    #[serde(rename = "live-only")]
    LiveOnly,

    #[serde(rename = "provider-replay")]
    ProviderReplay,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Steering {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<HashMap<String, Option<InputValue>>>,

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
pub struct Subagents {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<HashMap<String, Option<InputValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<Control>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    pub support: Support,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Control {
    Stop,
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
#[serde(rename_all = "camelCase")]
pub struct EngineProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<ControlElement>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    pub id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_policy: Option<InputPolicy>,

    pub label: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<Selection>,

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
pub struct InputPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_items: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_total_bytes: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub modalities: Option<HashMap<String, ModalityValue>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalityValue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<HashMap<String, Option<ExtensionValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_count: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_item_bytes: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_text_characters: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_total_bytes: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_types: Option<Vec<String>>,

    pub support: Support,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Selection {
    Optional,

    Required,
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
    pub code: Option<String>,

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
    pub extensions: Option<HashMap<String, Option<InputValue>>>,

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

    pub payload: Option<InputValue>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,

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
    pub metadata: Option<HashMap<String, Option<InputValue>>>,

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
    pub provider: Option<HashMap<String, Option<InputValue>>>,

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
pub struct InlineContext {
    pub records: Vec<RecordElement>,

    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<Binding>,

    pub id: String,

    pub kind: String,

    pub label: String,

    pub payload: Option<InputValue>,

    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    #[serde(rename = "type")]
    pub binding_type: BindingType,

    pub input_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingType {
    Attachment,

    Resource,
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
    pub code: Option<String>,

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

    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<Selection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability: Option<Availability>,

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

    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_policy: Option<InputPolicy>,

    pub label: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,

    Unavailable,
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
    pub code: Option<String>,

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
    pub configuration: Option<HashMap<String, Option<InputValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_context: Option<InlineContext>,

    pub input: Vec<InputClass>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<InputValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    pub schema_version: i64,

    pub session: Session,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Settings>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputClass {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<Encoding>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    #[serde(rename = "type")]
    pub protocol_schema_type: InputType,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_id: Option<String>,

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
#[serde(rename_all = "kebab-case")]
pub enum InputType {
    #[serde(rename = "context-reference")]
    ContextReference,

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
pub struct SidecarDiagnosticNotificationClass {
    pub diagnostic: Diagnostic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub adapter_id: String,

    pub code: String,

    pub message: String,

    pub phase: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,

    pub schema_version: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<Session>,

    pub severity: Severity,

    pub timestamp: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,

    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEventsListParamsClass {
    pub adapter_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<i64>,

    pub session: Session,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarFollowUpParamsClass {
    pub expected_turn_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_context: Option<InlineContext>,

    pub input: Vec<InputClass>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<InputValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<Replacement>,

    pub run_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<Preferred>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replacement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<Execution>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_binding: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDescriptorElement>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Context {
    pub sources: Vec<SourceElement>,

    pub unavailable: Vec<UnavailableElement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceElement {
    pub source_id: String,

    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Value {
    pub content: Vec<InputClass>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableElement {
    pub code: String,

    pub message: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,

    pub source_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration: Option<HashMap<String, Option<InputValue>>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Settings>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptorElement {
    pub description: String,

    pub input_schema: HashMap<String, Option<InputValue>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<InputValue>>>,

    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarInitializeParamsClass {
    pub client: Client,

    pub protocol_version: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDescriptorElement>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Client {
    pub name: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarInitializeResultClass {
    pub adapters: Vec<String>,

    pub host_methods: Vec<String>,

    pub methods: Vec<String>,

    pub notifications: Vec<String>,

    pub protocol_version: i64,

    pub server: Server,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Server {
    pub name: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRespondParamsClass {
    pub interaction_id: String,

    pub response: Response,

    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRunSettledNotificationClass {
    pub run_id: String,

    pub status: SidecarRunSettledNotificationStatus,

    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarRunSettledNotificationStatus {
    Completed,

    Error,

    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRunStartParamsClass {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,

    pub request: RunRequest,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_binding: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDescriptorElement>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSidecarStopSubagentParams {
    pub run_id: String,

    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarToolCallParamsClass {
    pub adapter_id: String,

    pub call_id: String,

    pub input: Option<InputValue>,

    pub name: String,

    pub protocol_version: i64,

    pub run_id: String,

    pub session: Session,

    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SidecarToolCallResultClass {
    pub result: ToolResultClass,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultClass {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,

    pub content: Vec<ToolResultContent>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Option<InputValue>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,

    #[serde(rename = "type")]
    pub protocol_schema_type: PurpleType,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PurpleType {
    Image,

    Resource,

    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarToolCancelNotificationClass {
    pub call_id: String,

    pub run_id: String,

    pub turn_id: String,
}
