// This file was generated from JSON Schema using quicktype, do not modify it directly.
// To parse the JSON, add this file to your project and do:
//
//   let fHV1 = try? JSONDecoder().decode(FHV1.self, from: jsonData)

import Foundation

/// Generation-only reachability document for the public v1 schema roots.
// MARK: - FHV1
public struct FHV1: Codable {
    public let capabilities: FHCapabilities
    public let discoveryRequest: FHDiscovery
    public let engineProfile: FHEngineProfile
    public let engineProfileDiscovery: FHEngineProfileDiscovery
    public let event: FHEvent
    public let interaction: FHInteraction
    public let interactionResponse: FHResponse
    public let limitSnapshot: FHLimitSnapshot
    public let limitSnapshotDiscovery: FHLimitSnapshotDiscovery
    public let modelCatalog: FHModelCatalog
    public let modelCatalogDiscovery: FHModelCatalogDiscovery
    public let resolvedConfiguration: FHResolvedConfiguration
    public let runRequest: FHRunRequest
    public let toolDescriptor: FHToolDescriptor
    public let toolResult: FHToolResult

    public enum CodingKeys: String, CodingKey {
        case capabilities = "capabilities"
        case discoveryRequest = "discoveryRequest"
        case engineProfile = "engineProfile"
        case engineProfileDiscovery = "engineProfileDiscovery"
        case event = "event"
        case interaction = "interaction"
        case interactionResponse = "interactionResponse"
        case limitSnapshot = "limitSnapshot"
        case limitSnapshotDiscovery = "limitSnapshotDiscovery"
        case modelCatalog = "modelCatalog"
        case modelCatalogDiscovery = "modelCatalogDiscovery"
        case resolvedConfiguration = "resolvedConfiguration"
        case runRequest = "runRequest"
        case toolDescriptor = "toolDescriptor"
        case toolResult = "toolResult"
    }

    public init(capabilities: FHCapabilities, discoveryRequest: FHDiscovery, engineProfile: FHEngineProfile, engineProfileDiscovery: FHEngineProfileDiscovery, event: FHEvent, interaction: FHInteraction, interactionResponse: FHResponse, limitSnapshot: FHLimitSnapshot, limitSnapshotDiscovery: FHLimitSnapshotDiscovery, modelCatalog: FHModelCatalog, modelCatalogDiscovery: FHModelCatalogDiscovery, resolvedConfiguration: FHResolvedConfiguration, runRequest: FHRunRequest, toolDescriptor: FHToolDescriptor, toolResult: FHToolResult) {
        self.capabilities = capabilities
        self.discoveryRequest = discoveryRequest
        self.engineProfile = engineProfile
        self.engineProfileDiscovery = engineProfileDiscovery
        self.event = event
        self.interaction = interaction
        self.interactionResponse = interactionResponse
        self.limitSnapshot = limitSnapshot
        self.limitSnapshotDiscovery = limitSnapshotDiscovery
        self.modelCatalog = modelCatalog
        self.modelCatalogDiscovery = modelCatalogDiscovery
        self.resolvedConfiguration = resolvedConfiguration
        self.runRequest = runRequest
        self.toolDescriptor = toolDescriptor
        self.toolResult = toolResult
    }
}

// MARK: - FHCapabilities
public struct FHCapabilities: Codable {
    public let cancel: FHCancel
    public let extensions: [String: FHCancel]?
    public let filesystem: FHCancel
    public let images: FHCancel
    public let interactions: FHInteractions
    public let network: FHCancel
    public let plans: FHCancel
    public let resume: FHCancel
    public let shell: FHCancel
    public let steering: FHSteering?
    public let subagents: FHCancel
    public let thinking: FHCancel
    public let tools: FHCancel
    public let usage: FHCancel

    public enum CodingKeys: String, CodingKey {
        case cancel = "cancel"
        case extensions = "extensions"
        case filesystem = "filesystem"
        case images = "images"
        case interactions = "interactions"
        case network = "network"
        case plans = "plans"
        case resume = "resume"
        case shell = "shell"
        case steering = "steering"
        case subagents = "subagents"
        case thinking = "thinking"
        case tools = "tools"
        case usage = "usage"
    }

    public init(cancel: FHCancel, extensions: [String: FHCancel]?, filesystem: FHCancel, images: FHCancel, interactions: FHInteractions, network: FHCancel, plans: FHCancel, resume: FHCancel, shell: FHCancel, steering: FHSteering?, subagents: FHCancel, thinking: FHCancel, tools: FHCancel, usage: FHCancel) {
        self.cancel = cancel
        self.extensions = extensions
        self.filesystem = filesystem
        self.images = images
        self.interactions = interactions
        self.network = network
        self.plans = plans
        self.resume = resume
        self.shell = shell
        self.steering = steering
        self.subagents = subagents
        self.thinking = thinking
        self.tools = tools
        self.usage = usage
    }
}

// MARK: - FHCancel
public struct FHCancel: Codable {
    public let constraints: [String: FHProtocolSchema]?
    public let description: String?
    public let support: FHSupport

    public enum CodingKeys: String, CodingKey {
        case constraints = "constraints"
        case description = "description"
        case support = "support"
    }

    public init(constraints: [String: FHProtocolSchema]?, description: String?, support: FHSupport) {
        self.constraints = constraints
        self.description = description
        self.support = support
    }
}

/// A value representable by RFC 8259 JSON without coercion.
public enum FHProtocolSchema: Codable {
    case bool(Bool)
    case double(Double)
    case string(String)
    case unionArray([FHProtocolSchema])
    case unionMap([String: FHProtocolSchema])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let x = try? container.decode(Bool.self) {
            self = .bool(x)
            return
        }
        if let x = try? container.decode([FHProtocolSchema].self) {
            self = .unionArray(x)
            return
        }
        if let x = try? container.decode(Double.self) {
            self = .double(x)
            return
        }
        if let x = try? container.decode([String: FHProtocolSchema].self) {
            self = .unionMap(x)
            return
        }
        if let x = try? container.decode(String.self) {
            self = .string(x)
            return
        }
        if container.decodeNil() {
            self = .null
            return
        }
        throw DecodingError.typeMismatch(FHProtocolSchema.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Wrong type for FHProtocolSchema"))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .bool(let x):
            try container.encode(x)
        case .double(let x):
            try container.encode(x)
        case .string(let x):
            try container.encode(x)
        case .unionArray(let x):
            try container.encode(x)
        case .unionMap(let x):
            try container.encode(x)
        case .null:
            try container.encodeNil()
        }
    }
}

public enum FHSupport: String, Codable {
    case experimental = "experimental"
    case stable = "stable"
    case unsupported = "unsupported"
}

// MARK: - FHInteractions
public struct FHInteractions: Codable {
    public let constraints: [String: FHProtocolSchema]?
    public let description: String?
    public let recovery: FHRecovery?
    public let support: FHSupport

    public enum CodingKeys: String, CodingKey {
        case constraints = "constraints"
        case description = "description"
        case recovery = "recovery"
        case support = "support"
    }

    public init(constraints: [String: FHProtocolSchema]?, description: String?, recovery: FHRecovery?, support: FHSupport) {
        self.constraints = constraints
        self.description = description
        self.recovery = recovery
        self.support = support
    }
}

public enum FHRecovery: String, Codable {
    case liveOnly = "live-only"
    case providerReplay = "provider-replay"
}

// MARK: - FHSteering
public struct FHSteering: Codable {
    public let constraints: [String: FHProtocolSchema]?
    public let description: String?
    public let preferred: FHPreferred?
    public let strategies: [FHPreferred]
    public let support: FHSupport

    public enum CodingKeys: String, CodingKey {
        case constraints = "constraints"
        case description = "description"
        case preferred = "preferred"
        case strategies = "strategies"
        case support = "support"
    }

    public init(constraints: [String: FHProtocolSchema]?, description: String?, preferred: FHPreferred?, strategies: [FHPreferred], support: FHSupport) {
        self.constraints = constraints
        self.description = description
        self.preferred = preferred
        self.strategies = strategies
        self.support = support
    }
}

public enum FHPreferred: String, Codable {
    case replacementTurn = "replacement-turn"
    case sameTurn = "same-turn"
}

// MARK: - FHDiscovery
public struct FHDiscovery: Codable {
    public let accountID: String?
    public let adapterID: String
    public let modelID: String?
    public let schemaVersion: Int

    public enum CodingKeys: String, CodingKey {
        case accountID = "accountId"
        case adapterID = "adapterId"
        case modelID = "modelId"
        case schemaVersion = "schemaVersion"
    }

    public init(accountID: String?, adapterID: String, modelID: String?, schemaVersion: Int) {
        self.accountID = accountID
        self.adapterID = adapterID
        self.modelID = modelID
        self.schemaVersion = schemaVersion
    }
}

// MARK: - FHEngineProfile
public struct FHEngineProfile: Codable {
    public let controls: [FHControlElement]?
    public let description: String?
    public let extensions: [String: FHExtensionValue]?
    public let id: String
    public let label: String
    public let permissions: FHPermissions

    public enum CodingKeys: String, CodingKey {
        case controls = "controls"
        case description = "description"
        case extensions = "extensions"
        case id = "id"
        case label = "label"
        case permissions = "permissions"
    }

    public init(controls: [FHControlElement]?, description: String?, extensions: [String: FHExtensionValue]?, id: String, label: String, permissions: FHPermissions) {
        self.controls = controls
        self.description = description
        self.extensions = extensions
        self.id = id
        self.label = label
        self.permissions = permissions
    }
}

// MARK: - FHControlElement
public struct FHControlElement: Codable {
    public let defaultValue: FHSchema?
    public let description: String?
    public let extensions: [String: FHExtensionValue]?
    public let id: String
    public let kind: FHKind
    public let label: String
    public let max: Double?
    public let min: Double?
    public let options: [FHOptionElement]?
    public let scope: String
    public let step: Double?
    public let unavailableReason: String?

    public enum CodingKeys: String, CodingKey {
        case defaultValue = "defaultValue"
        case description = "description"
        case extensions = "extensions"
        case id = "id"
        case kind = "kind"
        case label = "label"
        case max = "max"
        case min = "min"
        case options = "options"
        case scope = "scope"
        case step = "step"
        case unavailableReason = "unavailableReason"
    }

    public init(defaultValue: FHSchema?, description: String?, extensions: [String: FHExtensionValue]?, id: String, kind: FHKind, label: String, max: Double?, min: Double?, options: [FHOptionElement]?, scope: String, step: Double?, unavailableReason: String?) {
        self.defaultValue = defaultValue
        self.description = description
        self.extensions = extensions
        self.id = id
        self.kind = kind
        self.label = label
        self.max = max
        self.min = min
        self.options = options
        self.scope = scope
        self.step = step
        self.unavailableReason = unavailableReason
    }
}

public enum FHSchema: Codable {
    case bool(Bool)
    case double(Double)
    case string(String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let x = try? container.decode(Bool.self) {
            self = .bool(x)
            return
        }
        if let x = try? container.decode(Double.self) {
            self = .double(x)
            return
        }
        if let x = try? container.decode(String.self) {
            self = .string(x)
            return
        }
        throw DecodingError.typeMismatch(FHSchema.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Wrong type for FHSchema"))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .bool(let x):
            try container.encode(x)
        case .double(let x):
            try container.encode(x)
        case .string(let x):
            try container.encode(x)
        }
    }
}

public enum FHExtensionValue: Codable {
    case bool(Bool)
    case double(Double)
    case string(String)
    case unionArray([FHExtensionValue])
    case unionMap([String: FHExtensionValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let x = try? container.decode(Bool.self) {
            self = .bool(x)
            return
        }
        if let x = try? container.decode([FHExtensionValue].self) {
            self = .unionArray(x)
            return
        }
        if let x = try? container.decode(Double.self) {
            self = .double(x)
            return
        }
        if let x = try? container.decode([String: FHExtensionValue].self) {
            self = .unionMap(x)
            return
        }
        if let x = try? container.decode(String.self) {
            self = .string(x)
            return
        }
        if container.decodeNil() {
            self = .null
            return
        }
        throw DecodingError.typeMismatch(FHExtensionValue.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Wrong type for FHExtensionValue"))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .bool(let x):
            try container.encode(x)
        case .double(let x):
            try container.encode(x)
        case .string(let x):
            try container.encode(x)
        case .unionArray(let x):
            try container.encode(x)
        case .unionMap(let x):
            try container.encode(x)
        case .null:
            try container.encodeNil()
        }
    }
}

public enum FHKind: String, Codable {
    case number = "number"
    case select = "select"
    case toggle = "toggle"
}

// MARK: - FHOptionElement
public struct FHOptionElement: Codable {
    public let description: String?
    public let extensions: [String: FHExtensionValue]?
    public let id: String
    public let label: String
    public let unavailableReason: String?

    public enum CodingKeys: String, CodingKey {
        case description = "description"
        case extensions = "extensions"
        case id = "id"
        case label = "label"
        case unavailableReason = "unavailableReason"
    }

    public init(description: String?, extensions: [String: FHExtensionValue]?, id: String, label: String, unavailableReason: String?) {
        self.description = description
        self.extensions = extensions
        self.id = id
        self.label = label
        self.unavailableReason = unavailableReason
    }
}

// MARK: - FHPermissions
public struct FHPermissions: Codable {
    public let defaultModeID: String
    public let description: String?
    public let kind: String
    public let modes: [FHModeElement]
    public let selectable: Bool

    public enum CodingKeys: String, CodingKey {
        case defaultModeID = "defaultModeId"
        case description = "description"
        case kind = "kind"
        case modes = "modes"
        case selectable = "selectable"
    }

    public init(defaultModeID: String, description: String?, kind: String, modes: [FHModeElement], selectable: Bool) {
        self.defaultModeID = defaultModeID
        self.description = description
        self.kind = kind
        self.modes = modes
        self.selectable = selectable
    }
}

// MARK: - FHModeElement
public struct FHModeElement: Codable {
    public let consent: FHConsent?
    public let description: String?
    public let extensions: [String: FHExtensionValue]?
    public let id: String
    public let label: String
    public let posture: String
    public let unavailableReason: String?

    public enum CodingKeys: String, CodingKey {
        case consent = "consent"
        case description = "description"
        case extensions = "extensions"
        case id = "id"
        case label = "label"
        case posture = "posture"
        case unavailableReason = "unavailableReason"
    }

    public init(consent: FHConsent?, description: String?, extensions: [String: FHExtensionValue]?, id: String, label: String, posture: String, unavailableReason: String?) {
        self.consent = consent
        self.description = description
        self.extensions = extensions
        self.id = id
        self.label = label
        self.posture = posture
        self.unavailableReason = unavailableReason
    }
}

// MARK: - FHConsent
public struct FHConsent: Codable {
    public let description: String
    public let title: String
    public let version: String

    public enum CodingKeys: String, CodingKey {
        case description = "description"
        case title = "title"
        case version = "version"
    }

    public init(description: String, title: String, version: String) {
        self.description = description
        self.title = title
        self.version = version
    }
}

// MARK: - FHEngineProfileDiscovery
public struct FHEngineProfileDiscovery: Codable {
    public let expiresAt: String?
    public let fetchedAt: String?
    public let message: String?
    public let retryable: Bool?
    public let status: FHEngineProfileDiscoveryStatus
    public let value: FHEngineProfile?

    public enum CodingKeys: String, CodingKey {
        case expiresAt = "expiresAt"
        case fetchedAt = "fetchedAt"
        case message = "message"
        case retryable = "retryable"
        case status = "status"
        case value = "value"
    }

    public init(expiresAt: String?, fetchedAt: String?, message: String?, retryable: Bool?, status: FHEngineProfileDiscoveryStatus, value: FHEngineProfile?) {
        self.expiresAt = expiresAt
        self.fetchedAt = fetchedAt
        self.message = message
        self.retryable = retryable
        self.status = status
        self.value = value
    }
}

public enum FHEngineProfileDiscoveryStatus: String, Codable {
    case available = "available"
    case unavailable = "unavailable"
    case unsupported = "unsupported"
}

// MARK: - FHEvent
public struct FHEvent: Codable {
    public let adapterID: String
    public let eventID: String
    public let payload: FHPayload
    public let runID: String
    public let schemaVersion: Int
    public let sequence: Int
    public let session: FHSession
    public let timestamp: String
    public let turnID: String

    public enum CodingKeys: String, CodingKey {
        case adapterID = "adapterId"
        case eventID = "eventId"
        case payload = "payload"
        case runID = "runId"
        case schemaVersion = "schemaVersion"
        case sequence = "sequence"
        case session = "session"
        case timestamp = "timestamp"
        case turnID = "turnId"
    }

    public init(adapterID: String, eventID: String, payload: FHPayload, runID: String, schemaVersion: Int, sequence: Int, session: FHSession, timestamp: String, turnID: String) {
        self.adapterID = adapterID
        self.eventID = eventID
        self.payload = payload
        self.runID = runID
        self.schemaVersion = schemaVersion
        self.sequence = sequence
        self.session = session
        self.timestamp = timestamp
        self.turnID = turnID
    }
}

/// A future additive core payload. Consumers must retain or safely ignore it.
// MARK: - FHPayload
public struct FHPayload: Codable {
    public let accountID: String?
    public let code: String?
    public let command: String?
    public let detail: String?
    public let error: String?
    public let exitCode: Int?
    public let extensions: [String: FHProtocolSchema]?
    public let interaction: FHInteraction?
    public let interactionID: String?
    public let kind: String
    public let message: String?
    public let model: String?
    public let name: String?
    public let namespace: String?
    public let outputAppend: String?
    public let paths: [String]?
    public let payload: FHProtocolSchema?
    public let reason: String?
    public let response: FHResponse?
    public let retryable: Bool?
    public let status: FHPayloadStatus?
    public let steps: [FHStepElement]?
    public let text: String?
    public let title: String?
    public let toolID: String?
    public let toolKind: String?
    public let truncated: Bool?
    public let usage: FHUsage?

    public enum CodingKeys: String, CodingKey {
        case accountID = "accountId"
        case code = "code"
        case command = "command"
        case detail = "detail"
        case error = "error"
        case exitCode = "exitCode"
        case extensions = "extensions"
        case interaction = "interaction"
        case interactionID = "interactionId"
        case kind = "kind"
        case message = "message"
        case model = "model"
        case name = "name"
        case namespace = "namespace"
        case outputAppend = "outputAppend"
        case paths = "paths"
        case payload = "payload"
        case reason = "reason"
        case response = "response"
        case retryable = "retryable"
        case status = "status"
        case steps = "steps"
        case text = "text"
        case title = "title"
        case toolID = "toolId"
        case toolKind = "toolKind"
        case truncated = "truncated"
        case usage = "usage"
    }

    public init(accountID: String?, code: String?, command: String?, detail: String?, error: String?, exitCode: Int?, extensions: [String: FHProtocolSchema]?, interaction: FHInteraction?, interactionID: String?, kind: String, message: String?, model: String?, name: String?, namespace: String?, outputAppend: String?, paths: [String]?, payload: FHProtocolSchema?, reason: String?, response: FHResponse?, retryable: Bool?, status: FHPayloadStatus?, steps: [FHStepElement]?, text: String?, title: String?, toolID: String?, toolKind: String?, truncated: Bool?, usage: FHUsage?) {
        self.accountID = accountID
        self.code = code
        self.command = command
        self.detail = detail
        self.error = error
        self.exitCode = exitCode
        self.extensions = extensions
        self.interaction = interaction
        self.interactionID = interactionID
        self.kind = kind
        self.message = message
        self.model = model
        self.name = name
        self.namespace = namespace
        self.outputAppend = outputAppend
        self.paths = paths
        self.payload = payload
        self.reason = reason
        self.response = response
        self.retryable = retryable
        self.status = status
        self.steps = steps
        self.text = text
        self.title = title
        self.toolID = toolID
        self.toolKind = toolKind
        self.truncated = truncated
        self.usage = usage
    }
}

// MARK: - FHInteraction
public struct FHInteraction: Codable {
    public let acceptsText: Bool?
    public let choices: [FHChoiceElement]?
    public let detail: String?
    public let expiresAt: String?
    public let id: String
    public let kind: String
    public let metadata: [String: FHProtocolSchema]?
    public let title: String

    public enum CodingKeys: String, CodingKey {
        case acceptsText = "acceptsText"
        case choices = "choices"
        case detail = "detail"
        case expiresAt = "expiresAt"
        case id = "id"
        case kind = "kind"
        case metadata = "metadata"
        case title = "title"
    }

    public init(acceptsText: Bool?, choices: [FHChoiceElement]?, detail: String?, expiresAt: String?, id: String, kind: String, metadata: [String: FHProtocolSchema]?, title: String) {
        self.acceptsText = acceptsText
        self.choices = choices
        self.detail = detail
        self.expiresAt = expiresAt
        self.id = id
        self.kind = kind
        self.metadata = metadata
        self.title = title
    }
}

// MARK: - FHChoiceElement
public struct FHChoiceElement: Codable {
    public let allow: Bool?
    public let description: String?
    public let id: String
    public let label: String

    public enum CodingKeys: String, CodingKey {
        case allow = "allow"
        case description = "description"
        case id = "id"
        case label = "label"
    }

    public init(allow: Bool?, description: String?, id: String, label: String) {
        self.allow = allow
        self.description = description
        self.id = id
        self.label = label
    }
}

// MARK: - FHResponse
public struct FHResponse: Codable {
    public let choiceID: String?
    public let labels: [String]?
    public let text: String?

    public enum CodingKeys: String, CodingKey {
        case choiceID = "choiceId"
        case labels = "labels"
        case text = "text"
    }

    public init(choiceID: String?, labels: [String]?, text: String?) {
        self.choiceID = choiceID
        self.labels = labels
        self.text = text
    }
}

public enum FHPayloadStatus: String, Codable {
    case cancelled = "cancelled"
    case completed = "completed"
    case declined = "declined"
    case error = "error"
    case failed = "failed"
    case interrupted = "interrupted"
}

// MARK: - FHStepElement
public struct FHStepElement: Codable {
    public let status: String
    public let text: String

    public enum CodingKeys: String, CodingKey {
        case status = "status"
        case text = "text"
    }

    public init(status: String, text: String) {
        self.status = status
        self.text = text
    }
}

// MARK: - FHUsage
public struct FHUsage: Codable {
    public let cachedInputTokens: Int?
    public let costUsd: Double?
    public let durationMS: Double?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let provider: [String: FHProtocolSchema]?
    public let totalTokens: Int?

    public enum CodingKeys: String, CodingKey {
        case cachedInputTokens = "cachedInputTokens"
        case costUsd = "costUsd"
        case durationMS = "durationMs"
        case inputTokens = "inputTokens"
        case outputTokens = "outputTokens"
        case provider = "provider"
        case totalTokens = "totalTokens"
    }

    public init(cachedInputTokens: Int?, costUsd: Double?, durationMS: Double?, inputTokens: Int?, outputTokens: Int?, provider: [String: FHProtocolSchema]?, totalTokens: Int?) {
        self.cachedInputTokens = cachedInputTokens
        self.costUsd = costUsd
        self.durationMS = durationMS
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.provider = provider
        self.totalTokens = totalTokens
    }
}

// MARK: - FHSession
public struct FHSession: Codable {
    public let actorID: String
    public let tenantID: String
    public let threadID: String

    public enum CodingKeys: String, CodingKey {
        case actorID = "actorId"
        case tenantID = "tenantId"
        case threadID = "threadId"
    }

    public init(actorID: String, tenantID: String, threadID: String) {
        self.actorID = actorID
        self.tenantID = tenantID
        self.threadID = threadID
    }
}

// MARK: - FHLimitSnapshot
public struct FHLimitSnapshot: Codable {
    public let extensions: [String: FHExtensionValue]?
    public let limits: [FHLimitElement]
    public let planLabel: String?

    public enum CodingKeys: String, CodingKey {
        case extensions = "extensions"
        case limits = "limits"
        case planLabel = "planLabel"
    }

    public init(extensions: [String: FHExtensionValue]?, limits: [FHLimitElement], planLabel: String?) {
        self.extensions = extensions
        self.limits = limits
        self.planLabel = planLabel
    }
}

// MARK: - FHLimitElement
public struct FHLimitElement: Codable {
    public let extensions: [String: FHExtensionValue]?
    public let id: String
    public let kind: String
    public let label: String
    public let limit: Double?
    public let modelIDS: [String]?
    public let remaining: Double?
    public let resetsAt: String?
    public let scope: String
    public let unit: String
    public let used: Double?
    public let usedPercent: Double?
    public let windowDurationMS: Double?

    public enum CodingKeys: String, CodingKey {
        case extensions = "extensions"
        case id = "id"
        case kind = "kind"
        case label = "label"
        case limit = "limit"
        case modelIDS = "modelIds"
        case remaining = "remaining"
        case resetsAt = "resetsAt"
        case scope = "scope"
        case unit = "unit"
        case used = "used"
        case usedPercent = "usedPercent"
        case windowDurationMS = "windowDurationMs"
    }

    public init(extensions: [String: FHExtensionValue]?, id: String, kind: String, label: String, limit: Double?, modelIDS: [String]?, remaining: Double?, resetsAt: String?, scope: String, unit: String, used: Double?, usedPercent: Double?, windowDurationMS: Double?) {
        self.extensions = extensions
        self.id = id
        self.kind = kind
        self.label = label
        self.limit = limit
        self.modelIDS = modelIDS
        self.remaining = remaining
        self.resetsAt = resetsAt
        self.scope = scope
        self.unit = unit
        self.used = used
        self.usedPercent = usedPercent
        self.windowDurationMS = windowDurationMS
    }
}

// MARK: - FHLimitSnapshotDiscovery
public struct FHLimitSnapshotDiscovery: Codable {
    public let expiresAt: String?
    public let fetchedAt: String?
    public let message: String?
    public let retryable: Bool?
    public let status: FHEngineProfileDiscoveryStatus
    public let value: FHLimitSnapshot?

    public enum CodingKeys: String, CodingKey {
        case expiresAt = "expiresAt"
        case fetchedAt = "fetchedAt"
        case message = "message"
        case retryable = "retryable"
        case status = "status"
        case value = "value"
    }

    public init(expiresAt: String?, fetchedAt: String?, message: String?, retryable: Bool?, status: FHEngineProfileDiscoveryStatus, value: FHLimitSnapshot?) {
        self.expiresAt = expiresAt
        self.fetchedAt = fetchedAt
        self.message = message
        self.retryable = retryable
        self.status = status
        self.value = value
    }
}

// MARK: - FHModelCatalog
public struct FHModelCatalog: Codable {
    public let defaultModelID: String?
    public let models: [FHModelElement]

    public enum CodingKeys: String, CodingKey {
        case defaultModelID = "defaultModelId"
        case models = "models"
    }

    public init(defaultModelID: String?, models: [FHModelElement]) {
        self.defaultModelID = defaultModelID
        self.models = models
    }
}

// MARK: - FHModelElement
public struct FHModelElement: Codable {
    public let contextWindowTokens: Int?
    public let controls: [FHControlElement]?
    public let description: String?
    public let effort: FHEffort?
    public let extensions: [String: FHExtensionValue]?
    public let group: FHGroup?
    public let hidden: Bool?
    public let id: String
    public let inputModalities: [String]?
    public let label: String
    public let unavailableReason: String?

    public enum CodingKeys: String, CodingKey {
        case contextWindowTokens = "contextWindowTokens"
        case controls = "controls"
        case description = "description"
        case effort = "effort"
        case extensions = "extensions"
        case group = "group"
        case hidden = "hidden"
        case id = "id"
        case inputModalities = "inputModalities"
        case label = "label"
        case unavailableReason = "unavailableReason"
    }

    public init(contextWindowTokens: Int?, controls: [FHControlElement]?, description: String?, effort: FHEffort?, extensions: [String: FHExtensionValue]?, group: FHGroup?, hidden: Bool?, id: String, inputModalities: [String]?, label: String, unavailableReason: String?) {
        self.contextWindowTokens = contextWindowTokens
        self.controls = controls
        self.description = description
        self.effort = effort
        self.extensions = extensions
        self.group = group
        self.hidden = hidden
        self.id = id
        self.inputModalities = inputModalities
        self.label = label
        self.unavailableReason = unavailableReason
    }
}

// MARK: - FHEffort
public struct FHEffort: Codable {
    public let defaultOptionID: String?
    public let options: [FHOptionElement]

    public enum CodingKeys: String, CodingKey {
        case defaultOptionID = "defaultOptionId"
        case options = "options"
    }

    public init(defaultOptionID: String?, options: [FHOptionElement]) {
        self.defaultOptionID = defaultOptionID
        self.options = options
    }
}

// MARK: - FHGroup
public struct FHGroup: Codable {
    public let id: String
    public let label: String

    public enum CodingKeys: String, CodingKey {
        case id = "id"
        case label = "label"
    }

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

// MARK: - FHModelCatalogDiscovery
public struct FHModelCatalogDiscovery: Codable {
    public let expiresAt: String?
    public let fetchedAt: String?
    public let message: String?
    public let retryable: Bool?
    public let status: FHEngineProfileDiscoveryStatus
    public let value: FHModelCatalog?

    public enum CodingKeys: String, CodingKey {
        case expiresAt = "expiresAt"
        case fetchedAt = "fetchedAt"
        case message = "message"
        case retryable = "retryable"
        case status = "status"
        case value = "value"
    }

    public init(expiresAt: String?, fetchedAt: String?, message: String?, retryable: Bool?, status: FHEngineProfileDiscoveryStatus, value: FHModelCatalog?) {
        self.expiresAt = expiresAt
        self.fetchedAt = fetchedAt
        self.message = message
        self.retryable = retryable
        self.status = status
        self.value = value
    }
}

// MARK: - FHResolvedConfiguration
public struct FHResolvedConfiguration: Codable {
    public let controls: [String: FHSchema]
    public let issues: [FHIssueElement]
    public let permission: FHResolvedConfigurationPermission

    public enum CodingKeys: String, CodingKey {
        case controls = "controls"
        case issues = "issues"
        case permission = "permission"
    }

    public init(controls: [String: FHSchema], issues: [FHIssueElement], permission: FHResolvedConfigurationPermission) {
        self.controls = controls
        self.issues = issues
        self.permission = permission
    }
}

// MARK: - FHIssueElement
public struct FHIssueElement: Codable {
    public let code: FHCode
    public let message: String
    public let path: String

    public enum CodingKeys: String, CodingKey {
        case code = "code"
        case message = "message"
        case path = "path"
    }

    public init(code: FHCode, message: String, path: String) {
        self.code = code
        self.message = message
        self.path = path
    }
}

public enum FHCode: String, Codable {
    case invalidValue = "invalid-value"
    case staleConsent = "stale-consent"
    case unknownControl = "unknown-control"
    case unknownPermission = "unknown-permission"
}

// MARK: - FHResolvedConfigurationPermission
public struct FHResolvedConfigurationPermission: Codable {
    public let consentVersion: String?
    public let modeID: String

    public enum CodingKeys: String, CodingKey {
        case consentVersion = "consentVersion"
        case modeID = "modeId"
    }

    public init(consentVersion: String?, modeID: String) {
        self.consentVersion = consentVersion
        self.modeID = modeID
    }
}

// MARK: - FHRunRequest
public struct FHRunRequest: Codable {
    public let accountID: String?
    public let adapterID: String
    /// JSON-safe adapter-specific configuration. This escape hatch is not a portable UI contract.
    public let configuration: [String: FHProtocolSchema]?
    public let effort: String?
    public let input: [FHInputElement]
    public let metadata: [String: FHProtocolSchema]?
    public let model: String?
    public let schemaVersion: Int
    public let session: FHSession
    public let settings: FHSettings?

    public enum CodingKeys: String, CodingKey {
        case accountID = "accountId"
        case adapterID = "adapterId"
        case configuration = "configuration"
        case effort = "effort"
        case input = "input"
        case metadata = "metadata"
        case model = "model"
        case schemaVersion = "schemaVersion"
        case session = "session"
        case settings = "settings"
    }

    public init(accountID: String?, adapterID: String, configuration: [String: FHProtocolSchema]?, effort: String?, input: [FHInputElement], metadata: [String: FHProtocolSchema]?, model: String?, schemaVersion: Int, session: FHSession, settings: FHSettings?) {
        self.accountID = accountID
        self.adapterID = adapterID
        self.configuration = configuration
        self.effort = effort
        self.input = input
        self.metadata = metadata
        self.model = model
        self.schemaVersion = schemaVersion
        self.session = session
        self.settings = settings
    }
}

// MARK: - FHInputElement
public struct FHInputElement: Codable {
    public let data: String?
    public let encoding: FHEncoding?
    public let mediaType: String?
    public let name: String?
    public let text: String?
    public let type: FHType
    public let uri: String?

    public enum CodingKeys: String, CodingKey {
        case data = "data"
        case encoding = "encoding"
        case mediaType = "mediaType"
        case name = "name"
        case text = "text"
        case type = "type"
        case uri = "uri"
    }

    public init(data: String?, encoding: FHEncoding?, mediaType: String?, name: String?, text: String?, type: FHType, uri: String?) {
        self.data = data
        self.encoding = encoding
        self.mediaType = mediaType
        self.name = name
        self.text = text
        self.type = type
        self.uri = uri
    }
}

public enum FHEncoding: String, Codable {
    case base64 = "base64"
}

public enum FHType: String, Codable {
    case image = "image"
    case resource = "resource"
    case text = "text"
}

// MARK: - FHSettings
public struct FHSettings: Codable {
    public let controls: [String: FHSchema]?
    public let permission: FHSettingsPermission?

    public enum CodingKeys: String, CodingKey {
        case controls = "controls"
        case permission = "permission"
    }

    public init(controls: [String: FHSchema]?, permission: FHSettingsPermission?) {
        self.controls = controls
        self.permission = permission
    }
}

// MARK: - FHSettingsPermission
public struct FHSettingsPermission: Codable {
    public let consentVersion: String?
    public let modeID: String

    public enum CodingKeys: String, CodingKey {
        case consentVersion = "consentVersion"
        case modeID = "modeId"
    }

    public init(consentVersion: String?, modeID: String) {
        self.consentVersion = consentVersion
        self.modeID = modeID
    }
}

// MARK: - FHToolDescriptor
public struct FHToolDescriptor: Codable {
    public let description: String
    public let inputSchema: [String: FHProtocolSchema]
    public let metadata: [String: FHProtocolSchema]?
    public let name: String

    public enum CodingKeys: String, CodingKey {
        case description = "description"
        case inputSchema = "inputSchema"
        case metadata = "metadata"
        case name = "name"
    }

    public init(description: String, inputSchema: [String: FHProtocolSchema], metadata: [String: FHProtocolSchema]?, name: String) {
        self.description = description
        self.inputSchema = inputSchema
        self.metadata = metadata
        self.name = name
    }
}

// MARK: - FHToolResult
public struct FHToolResult: Codable {
    public let code: String?
    public let content: [FHContentElement]
    public let isError: Bool?
    public let metadata: [String: FHProtocolSchema]?

    public enum CodingKeys: String, CodingKey {
        case code = "code"
        case content = "content"
        case isError = "isError"
        case metadata = "metadata"
    }

    public init(code: String?, content: [FHContentElement], isError: Bool?, metadata: [String: FHProtocolSchema]?) {
        self.code = code
        self.content = content
        self.isError = isError
        self.metadata = metadata
    }
}

// MARK: - FHContentElement
public struct FHContentElement: Codable {
    public let data: String?
    public let mediaType: String?
    public let text: String?
    public let type: FHType
    public let uri: String?

    public enum CodingKeys: String, CodingKey {
        case data = "data"
        case mediaType = "mediaType"
        case text = "text"
        case type = "type"
        case uri = "uri"
    }

    public init(data: String?, mediaType: String?, text: String?, type: FHType, uri: String?) {
        self.data = data
        self.mediaType = mediaType
        self.text = text
        self.type = type
        self.uri = uri
    }
}
