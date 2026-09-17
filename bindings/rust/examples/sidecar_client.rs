use fold_harness_schema::{Capabilities, Client, SidecarInitializeParamsClass, SidecarInitializeResultClass};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::error::Error;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[derive(Serialize)]
struct Request<T> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: T,
}

#[derive(Deserialize)]
struct Response {
    jsonrpc: String,
    id: u64,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

fn send<T: Serialize>(stdin: &mut impl Write, request: &Request<T>) -> Result<(), Box<dyn Error>> {
    serde_json::to_writer(&mut *stdin, request)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}

fn receive(reader: &mut impl BufRead, expected_id: u64) -> Result<Value, Box<dyn Error>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err("sidecar stdout ended before its response".into());
    }
    let response: Response = serde_json::from_str(&line)?;
    if response.jsonrpc != "2.0" || response.id != expected_id {
        return Err("sidecar returned an unexpected JSON-RPC envelope".into());
    }
    if let Some(error) = response.error {
        return Err(format!("sidecar returned an error: {error}").into());
    }
    response.result.ok_or_else(|| "sidecar response has no result".into())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().ok_or(
        "usage: cargo run --example sidecar_client -- <command> [args...]",
    )?;
    let mut child = Command::new(command)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut stdin = child.stdin.take().ok_or("sidecar stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout is unavailable")?;
    let mut reader = BufReader::new(stdout);

    send(&mut stdin, &Request {
        jsonrpc: "2.0",
        id: 1,
        method: "harness/initialize",
        params: SidecarInitializeParamsClass {
            protocol_version: 1,
            client: Client {
                name: "fold-harness-rust-smoke".into(),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            },
            tools: None,
        },
    })?;
    let initialized: SidecarInitializeResultClass = serde_json::from_value(receive(&mut reader, 1)?)?;
    if initialized.protocol_version != 1 || initialized.adapters.is_empty() {
        return Err("sidecar negotiation returned no usable adapter".into());
    }

    send(&mut stdin, &Request {
        jsonrpc: "2.0",
        id: 2,
        method: "harness/capabilities",
        params: serde_json::json!({ "adapterId": initialized.adapters[0] }),
    })?;
    let _: Capabilities = serde_json::from_value(receive(&mut reader, 2)?)?;

    send(&mut stdin, &Request {
        jsonrpc: "2.0",
        id: 3,
        method: "harness/shutdown",
        params: serde_json::json!({}),
    })?;
    let shutdown = receive(&mut reader, 3)?;
    if shutdown != serde_json::json!({}) {
        return Err("sidecar shutdown returned an unexpected result".into());
    }
    drop(stdin);
    if !child.wait()?.success() {
        return Err("sidecar process exited unsuccessfully".into());
    }
    println!("sidecar v1 negotiation, discovery, and shutdown passed");
    Ok(())
}
