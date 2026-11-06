local ScriptMappingState = {}
ScriptMappingState.__index = ScriptMappingState

local TERMINAL_STATES = {
    mapped = true,
    failed = true,
}

local ALLOWED_TRANSITIONS = {
    queued = { mapping = true, deferred = true, awaiting_upload = true, failed = true, removed = true },
    mapping = { queued = true, deferred = true, awaiting_upload = true, failed = true, removed = true },
    deferred = { queued = true, awaiting_upload = true, failed = true, removed = true },
    awaiting_upload = { mapped = true, failed = true, removed = true },
    mapped = { removed = true },
    failed = { queued = true, removed = true },
    removed = {},
}

function ScriptMappingState.new()
    return setmetatable({
        jobs = {},
        instances = setmetatable({}, { __mode = "v" }),
        total = 0,
        processed = 0,
        skipped = 0,
        disabled = false,
        statusDirty = false,
        clientId = nil,
        workers = nil,
        configuredWorkers = 0,
        currentWorkers = 0,
        successesSinceWorkerAdjustment = 0,
        descendantConnection = nil,
        initialScanRunning = false,
        initialScanFinished = false,
        generation = 0,
        session = nil,
        stateVersion = 0,
        upload = {
            queue = {},
            head = 1,
            tail = 0,
            bytes = 0,
            thread = nil,
        },
        bridge = nil,
        sourceCacheByHash = {},
        sourceCacheCheckedByHash = {},
        scriptHashByDebugId = {},
    }, ScriptMappingState)
end

function ScriptMappingState:IsActiveSession(session, generation, clientId)
    return (
        self.session == session and
        self.generation == generation and
        self.clientId == clientId
    )
end

function ScriptMappingState:IsFinished(processedOverride)
    local processed = processedOverride == nil and self.processed or processedOverride
    return self.disabled or (
        self.initialScanFinished and
        processed >= self.total
    )
end

function ScriptMappingState:Reset(clientId, session)
    self.generation += 1
    self.session = session
    self.stateVersion = 0
    self.currentWorkers = self.configuredWorkers
    self.successesSinceWorkerAdjustment = 0
    self.jobs = {}
    self.instances = setmetatable({}, { __mode = "v" })
    self.total = 0
    self.processed = 0
    self.skipped = 0
    self.statusDirty = true
    self.disabled = false
    self.clientId = clientId
    self.scriptHashByDebugId = {}
    self.sourceCacheCheckedByHash = {}
    self.initialScanRunning = false
    self.initialScanFinished = false
end

function ScriptMappingState:EnsureJob(debugId)
    local job = self.jobs[debugId]
    if job then return job, false end

    job = { debugId = debugId, generation = self.generation }
    self.jobs[debugId] = job
    self.total += 1
    self.stateVersion += 1
    self.statusDirty = true
    return job, true
end

function ScriptMappingState:TrackJob(debugId)
    local job = self.jobs[debugId]
    if job and job.state ~= "failed" then return nil end

    if not job then
        job = self:EnsureJob(debugId)
    else
        job.generation = self.generation
    end
    job.mappingAttempts = 0
    self:SetJobState(job, "queued")
    return job
end

function ScriptMappingState:TryStartMapping(job)
    if self.jobs[job.debugId] ~= job or job.generation ~= self.generation then return false end
    if job.state ~= "queued" then return false end
    self:SetJobState(job, "mapping")
    return true
end

function ScriptMappingState:CanDeferScanJob(job, generation)
    return (
        job ~= nil and
        job.generation == generation and
        generation == self.generation and
        job.state == "queued"
    )
end

function ScriptMappingState:SetJobState(job, nextState)
    local previousState = job.state
    if previousState == nextState then return false end
    if previousState ~= nil and not ALLOWED_TRANSITIONS[previousState][nextState] then
        error("Invalid script mapping transition: " .. tostring(previousState) .. " -> " .. tostring(nextState))
    end

    if previousState == "mapped" then
        self.processed = math.max(0, self.processed - 1)
    elseif previousState == "failed" then
        self.processed = math.max(0, self.processed - 1)
        self.skipped = math.max(0, self.skipped - 1)
    end

    if nextState == "mapped" then
        self.processed += 1
    elseif nextState == "failed" then
        self.processed += 1
        self.skipped += 1
    elseif nextState == "removed" then
        self.total = math.max(0, self.total - 1)
    end

    job.state = nextState
    if TERMINAL_STATES[previousState] or TERMINAL_STATES[nextState] or nextState == "removed" then
        self.stateVersion += 1
        self.statusDirty = true
    end
    return true
end

return ScriptMappingState
