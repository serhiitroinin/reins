use reins_schema::{
    Capabilities, Client, ControlValue, Event, Execution, InputClass, InputType, InputValue,
    LimitSnapshotDiscovery, ModelCatalogDiscovery, PayloadStatus, Preferred, PurpleType,
    Replacement, Response as InteractionResponse, RunRequest, Session, Settings,
    SettingsPermission, SidecarEventsListParamsClass, SidecarFollowUpParamsClass,
    SidecarInitializeParamsClass, SidecarInitializeResultClass, SidecarRespondParamsClass,
    SidecarRunSettledNotificationClass, SidecarRunSettledNotificationStatus,
    SidecarRunStartParamsClass, SidecarToolCallParamsClass, SidecarToolCallResult,
    SidecarToolCallResultContent, Support, ToolDescriptorElement,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const ADAPTER_ID: &str = "test:sidecar";
const SESSION_BINDING: &str = "account:native-smoke";

#[derive(Serialize)]
struct Request<T> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: T,
}

#[derive(Serialize)]
struct Success<T> {
    jsonrpc: &'static str,
    id: Value,
    result: T,
}

#[derive(Deserialize)]
struct Incoming {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Deserialize)]
struct EventNotification {
    event: Event,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunIdentity {
    run_id: String,
    turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FollowUpResult {
    run_id: String,
    turn_id: String,
    strategy: String,
}

#[derive(Deserialize)]
struct EventsListResult {
    events: Vec<Event>,
}

#[derive(Default)]
struct Observed {
    events: Vec<Event>,
    settled: Vec<SidecarRunSettledNotificationClass>,
    tool_calls: Vec<SidecarToolCallParamsClass>,
    diagnostics: Vec<Value>,
}

struct SidecarProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    observed: Observed,
}

impl SidecarProcess {
    fn spawn(command: &str, arguments: &[String]) -> Result<Self, Box<dyn Error>> {
        let mut child = Command::new(command)
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().ok_or("sidecar stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout is unavailable")?;
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            next_id: 0,
            observed: Observed::default(),
        })
    }

    fn write<T: Serialize>(&mut self, message: &T) -> Result<(), Box<dyn Error>> {
        let stdin = self.stdin.as_mut().ok_or("sidecar stdin is closed")?;
        serde_json::to_writer(&mut *stdin, message)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    fn request<T: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &'static str,
        params: T,
    ) -> Result<R, Box<dyn Error>> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(&Request {
            jsonrpc: "2.0",
            id,
            method,
            params,
        })?;
        loop {
            if let Some(result) = self.read_frame(Some(id))? {
                return Ok(serde_json::from_value(result)?);
            }
        }
    }

    fn read_frame(&mut self, expected_id: Option<u64>) -> Result<Option<Value>, Box<dyn Error>> {
        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            return Err("sidecar stdout ended before the expected frame".into());
        }
        let incoming: Incoming = serde_json::from_str(&line)?;
        if incoming.jsonrpc != "2.0" {
            return Err("sidecar returned an unexpected JSON-RPC version".into());
        }

        if let Some(method) = incoming.method.as_deref() {
            let params = incoming.params.unwrap_or(Value::Null);
            if let Some(id) = incoming.id {
                if method != "host/tool/call" {
                    return Err(
                        format!("sidecar requested an unknown host method: {method}").into(),
                    );
                }
                let call: SidecarToolCallParamsClass = serde_json::from_value(params)?;
                if call.protocol_version != 1
                    || call.adapter_id != ADAPTER_ID
                    || call.name != "lookup"
                {
                    return Err("sidecar sent an invalid host tool call".into());
                }
                self.observed.tool_calls.push(call);
                self.write(&Success {
                    jsonrpc: "2.0",
                    id,
                    result: SidecarToolCallResult {
                        code: None,
                        content: vec![SidecarToolCallResultContent {
                            data: None,
                            media_type: None,
                            protocol_schema_type: PurpleType::Text,
                            text: Some("native-ok".into()),
                            uri: None,
                        }],
                        is_error: None,
                        metadata: None,
                    },
                })?;
                return Ok(None);
            }
            match method {
                "harness/event" => {
                    let notification: EventNotification = serde_json::from_value(params)?;
                    self.observed.events.push(notification.event);
                }
                "harness/run/settled" => {
                    self.observed.settled.push(serde_json::from_value(params)?);
                }
                "harness/diagnostic" => self.observed.diagnostics.push(params),
                "host/tool/cancel" => {}
                _ => {}
            }
            return Ok(None);
        }

        let id = incoming
            .id
            .and_then(|value| value.as_u64())
            .ok_or("sidecar returned a response without a numeric id")?;
        if expected_id != Some(id) {
            return Err(format!(
                "sidecar returned response {id} while waiting for {expected_id:?}"
            )
            .into());
        }
        if let Some(error) = incoming.error {
            return Err(format!("sidecar returned an error: {error}").into());
        }
        incoming
            .result
            .map(Some)
            .ok_or_else(|| "sidecar response has no result".into())
    }

    fn wait_for(
        &mut self,
        description: &str,
        predicate: impl Fn(&Observed) -> bool,
    ) -> Result<(), Box<dyn Error>> {
        while !predicate(&self.observed) {
            self.read_frame(None)
                .map_err(|error| format!("while waiting for {description}: {error}"))?;
        }
        Ok(())
    }

    fn initialize(&mut self) -> Result<SidecarInitializeResultClass, Box<dyn Error>> {
        let mut input_schema = HashMap::new();
        input_schema.insert(
            "type".into(),
            Some(InputValue::PurpleString("object".into())),
        );
        input_schema.insert(
            "properties".into(),
            Some(InputValue::UnionMap(HashMap::new())),
        );
        input_schema.insert("additionalProperties".into(), Some(InputValue::Bool(true)));
        self.request(
            "harness/initialize",
            SidecarInitializeParamsClass {
                protocol_version: 1,
                client: Client {
                    name: "reins-rust-smoke".into(),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                },
                tools: Some(vec![ToolDescriptorElement {
                    name: "lookup".into(),
                    description: "Return deterministic native smoke data".into(),
                    input_schema,
                    metadata: None,
                }]),
            },
        )
    }

    fn start(&mut self, text: &str) -> Result<RunIdentity, Box<dyn Error>> {
        self.request(
            "harness/run/start",
            SidecarRunStartParamsClass {
                request: run_request(text, "alpha", "medium", "ask", "normal"),
                run_id: None,
                turn_id: None,
                session_binding: Some(SESSION_BINDING.into()),
                tools: None,
                context: None,
            },
        )
    }

    fn wait_settled(
        &mut self,
        run_id: &str,
        status: SidecarRunSettledNotificationStatus,
    ) -> Result<(), Box<dyn Error>> {
        self.wait_for("run settlement", |observed| {
            observed
                .settled
                .iter()
                .any(|settled| settled.run_id == run_id && settled.status == status)
        })
    }

    fn shutdown(&mut self) -> Result<(), Box<dyn Error>> {
        let result: Value = self.request("harness/shutdown", json!({}))?;
        if result != json!({}) {
            return Err("sidecar shutdown returned an unexpected result".into());
        }
        drop(self.stdin.take());
        if !self.child.wait()?.success() {
            return Err("sidecar process exited unsuccessfully".into());
        }
        Ok(())
    }
}

fn input(text: &str) -> InputClass {
    InputClass {
        context_id: None,
        data: None,
        encoding: None,
        id: None,
        media_type: None,
        name: None,
        protocol_schema_type: InputType::Text,
        reference_id: None,
        text: Some(text.into()),
        uri: None,
    }
}

fn settings(permission: &str, speed: &str) -> Settings {
    let mut controls = HashMap::new();
    controls.insert("speed".into(), ControlValue::PurpleString(speed.into()));
    Settings {
        controls: Some(controls),
        permission: Some(SettingsPermission {
            mode_id: permission.into(),
            consent_version: None,
        }),
    }
}

fn run_request(text: &str, model: &str, effort: &str, permission: &str, speed: &str) -> RunRequest {
    RunRequest {
        schema_version: 1,
        session: Session {
            tenant_id: "native".into(),
            actor_id: "rust".into(),
            thread_id: "sidecar-matrix".into(),
        },
        adapter_id: ADAPTER_ID.into(),
        input: vec![input(text)],
        inline_context: None,
        account_id: Some("account-a".into()),
        model: Some(model.into()),
        effort: Some(effort.into()),
        settings: Some(settings(permission, speed)),
        configuration: None,
        metadata: None,
    }
}

fn text_events(observed: &Observed, run_id: &str) -> Vec<String> {
    observed
        .events
        .iter()
        .filter(|event| event.run_id == run_id && event.payload.kind == "assistant-text")
        .filter_map(|event| event.payload.text.clone())
        .collect()
}

fn has_text(observed: &Observed, run_id: &str, text: &str) -> bool {
    text_events(observed, run_id)
        .iter()
        .any(|candidate| candidate == text)
}

fn assert_clean(process: &SidecarProcess) -> Result<(), Box<dyn Error>> {
    if !process.observed.diagnostics.is_empty() {
        return Err(format!(
            "sidecar emitted diagnostics: {:?}",
            process.observed.diagnostics
        )
        .into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let command = arguments
        .first()
        .ok_or("usage: cargo run --example sidecar_client -- <command> [args...]")?;
    let child_arguments = &arguments[1..];

    let mut first = SidecarProcess::spawn(command, child_arguments)?;
    let initialized = first.initialize()?;
    if initialized.protocol_version != 1 || initialized.adapters != vec![ADAPTER_ID] {
        return Err("sidecar negotiation returned an unexpected adapter set".into());
    }

    let capabilities: Capabilities =
        first.request("harness/capabilities", json!({ "adapterId": ADAPTER_ID }))?;
    if capabilities.resume.support != Support::Stable
        || capabilities.cancel.support != Support::Stable
        || capabilities.tools.support != Support::Stable
        || capabilities.interactions.support != Support::Stable
        || capabilities.steering.as_ref().map(|value| &value.support) != Some(&Support::Stable)
    {
        return Err("sidecar fixture did not expose the complete native matrix".into());
    }
    let models: ModelCatalogDiscovery = first.request(
        "harness/models",
        json!({ "schemaVersion": 1, "adapterId": ADAPTER_ID, "accountId": "account-a" }),
    )?;
    if models
        .value
        .as_ref()
        .and_then(|value| value.default_model_id.as_deref())
        != Some("alpha")
    {
        return Err("model discovery did not return the expected default".into());
    }
    let limits: LimitSnapshotDiscovery = first.request(
        "harness/limits",
        json!({ "schemaVersion": 1, "adapterId": ADAPTER_ID, "accountId": "account-a" }),
    )?;
    if limits.value.as_ref().map(|value| value.limits.len()) != Some(1) {
        return Err("limit discovery did not return the fixture quota".into());
    }

    let fresh = first.start("fresh")?;
    first.wait_settled(
        &fresh.run_id,
        SidecarRunSettledNotificationStatus::Completed,
    )?;
    if !has_text(
        &first.observed,
        &fresh.run_id,
        "fresh:alpha:medium:normal:fresh",
    ) {
        return Err("fresh streamed turn did not preserve admitted settings".into());
    }

    let tool = first.start("tool")?;
    first.wait_settled(&tool.run_id, SidecarRunSettledNotificationStatus::Completed)?;
    if !has_text(&first.observed, &tool.run_id, "tool:native-ok")
        || first.observed.tool_calls.len() != 1
    {
        return Err("bidirectional host tool call did not complete".into());
    }

    let interaction = first.start("interaction")?;
    first.wait_for("provider interaction", |observed| {
        observed.events.iter().any(|event| {
            event.run_id == interaction.run_id && event.payload.kind == "interaction-requested"
        })
    })?;
    let _: Value = first.request(
        "harness/run/respond",
        SidecarRespondParamsClass {
            run_id: interaction.run_id.clone(),
            interaction_id: "approval-1".into(),
            response: InteractionResponse {
                choice_id: None,
                labels: None,
                text: Some("approved-in-rust".into()),
            },
        },
    )?;
    first.wait_settled(
        &interaction.run_id,
        SidecarRunSettledNotificationStatus::Completed,
    )?;
    if !has_text(
        &first.observed,
        &interaction.run_id,
        "interaction:approved-in-rust",
    ) {
        return Err("provider interaction response did not return to the turn".into());
    }

    let steering = first.start("steer")?;
    first.wait_for("steer boundary", |observed| {
        has_text(observed, &steering.run_id, "waiting-for-steer")
    })?;
    let steered: FollowUpResult = first.request(
        "harness/run/follow-up",
        SidecarFollowUpParamsClass {
            run_id: steering.run_id.clone(),
            expected_turn_id: steering.turn_id.clone(),
            input: vec![input("native-follow-up")],
            inline_context: None,
            metadata: None,
            strategy: Some(Preferred::SameTurn),
            replacement: None,
        },
    )?;
    if steered.strategy != "same-turn"
        || steered.run_id != steering.run_id
        || steered.turn_id != steering.turn_id
    {
        return Err("same-turn steering changed the run identity".into());
    }
    first.wait_settled(
        &steering.run_id,
        SidecarRunSettledNotificationStatus::Completed,
    )?;
    if !has_text(
        &first.observed,
        &steering.run_id,
        "steered:native-follow-up",
    ) {
        return Err("same-turn steering input did not reach the provider".into());
    }

    let replaced = first.start("replace")?;
    first.wait_for("replacement boundary", |observed| {
        has_text(observed, &replaced.run_id, "waiting-for-replacement")
    })?;
    let replacement: FollowUpResult = first.request(
        "harness/run/follow-up",
        SidecarFollowUpParamsClass {
            run_id: replaced.run_id.clone(),
            expected_turn_id: replaced.turn_id.clone(),
            input: vec![input("after-model-change")],
            inline_context: None,
            metadata: None,
            strategy: Some(Preferred::ReplacementTurn),
            replacement: Some(Replacement {
                run_id: None,
                turn_id: None,
                execution: Some(Execution {
                    account_id: Some("account-a".into()),
                    model: Some("beta".into()),
                    effort: Some("high".into()),
                    settings: Some(settings("trusted", "fast")),
                    configuration: None,
                }),
                session_binding: Some(SESSION_BINDING.into()),
                tools: None,
                context: None,
            }),
        },
    )?;
    if replacement.strategy != "replacement-turn" || replacement.run_id == replaced.run_id {
        return Err("replacement steering did not allocate a new run".into());
    }
    first.wait_settled(
        &replaced.run_id,
        SidecarRunSettledNotificationStatus::Interrupted,
    )?;
    first.wait_settled(
        &replacement.run_id,
        SidecarRunSettledNotificationStatus::Completed,
    )?;
    if !has_text(
        &first.observed,
        &replacement.run_id,
        "fresh:beta:high:fast:after-model-change",
    ) {
        return Err("replacement model and settings were not readmitted".into());
    }

    let cancelled = first.start("cancel")?;
    first.wait_for("partial cancellation output", |observed| {
        has_text(observed, &cancelled.run_id, "partial-before-cancel")
    })?;
    let _: Value = first.request("harness/run/cancel", json!({ "runId": cancelled.run_id }))?;
    first.wait_settled(
        &cancelled.run_id,
        SidecarRunSettledNotificationStatus::Interrupted,
    )?;
    let cancelled_terminals = first
        .observed
        .events
        .iter()
        .filter(|event| {
            event.run_id == cancelled.run_id
                && event.payload.kind == "turn-completed"
                && event.payload.status == Some(PayloadStatus::Interrupted)
        })
        .count();
    if cancelled_terminals != 1 {
        return Err("cancelled turn did not produce exactly one interrupted terminal".into());
    }

    let replay: EventsListResult = first.request(
        "harness/events/list",
        SidecarEventsListParamsClass {
            session: run_request("", "alpha", "medium", "ask", "normal").session,
            adapter_id: ADAPTER_ID.into(),
            after: None,
        },
    )?;
    if replay.events != first.observed.events {
        return Err("durable replay differs from the streamed event sequence".into());
    }
    let first_last_sequence = replay
        .events
        .last()
        .map(|event| event.sequence)
        .ok_or("the first sidecar process persisted no events")?;
    assert_clean(&first)?;
    first.shutdown()?;

    let mut second = SidecarProcess::spawn(command, child_arguments)?;
    second.initialize()?;
    let resumed = second.start("resume")?;
    second.wait_settled(
        &resumed.run_id,
        SidecarRunSettledNotificationStatus::Completed,
    )?;
    if !has_text(
        &second.observed,
        &resumed.run_id,
        "resumed:alpha:medium:normal:resume",
    ) {
        return Err("the restarted sidecar did not resume its persisted checkpoint".into());
    }
    let replay_tail: EventsListResult = second.request(
        "harness/events/list",
        SidecarEventsListParamsClass {
            session: run_request("", "alpha", "medium", "ask", "normal").session,
            adapter_id: ADAPTER_ID.into(),
            after: Some(first_last_sequence),
        },
    )?;
    if replay_tail.events != second.observed.events
        || replay_tail.events.first().map(|event| event.sequence) != Some(first_last_sequence + 1)
    {
        return Err("restart replay did not continue the durable sequence".into());
    }

    let _: Value = second.request(
        "harness/session/reset",
        json!({
            "session": { "tenantId": "native", "actorId": "rust", "threadId": "sidecar-matrix" },
            "adapterId": ADAPTER_ID,
        }),
    )?;
    let after_reset = second.start("after-reset")?;
    second.wait_settled(
        &after_reset.run_id,
        SidecarRunSettledNotificationStatus::Completed,
    )?;
    if !has_text(
        &second.observed,
        &after_reset.run_id,
        "fresh:alpha:medium:normal:after-reset",
    ) {
        return Err("session reset did not clear the provider checkpoint".into());
    }
    assert_clean(&second)?;
    second.shutdown()?;

    println!(
        "sidecar v1 native matrix passed: discovery, streaming, tools, interactions, steering, model change, cancellation, replay, resume, reset, shutdown"
    );
    Ok(())
}
