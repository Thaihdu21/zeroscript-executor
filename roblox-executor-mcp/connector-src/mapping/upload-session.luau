local UploadSession = {}
UploadSession.__index = UploadSession
local lastStartedAt = 0

function UploadSession.new(id, startedAt, generation)
    local candidate = math.max(0, math.floor(tonumber(startedAt) or 0))
    local orderedStartedAt = math.max(candidate, lastStartedAt + 1)
    lastStartedAt = orderedStartedAt
    return setmetatable({
        id = id,
        startedAt = orderedStartedAt,
        generation = generation,
        revision = 0,
        started = false,
    }, UploadSession)
end

function UploadSession:NextRevision()
    self.revision += 1
    return self.revision
end

function UploadSession:MarkStarted()
    self.started = true
end

return UploadSession
