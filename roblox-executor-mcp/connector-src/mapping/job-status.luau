local JobStatus = {}
JobStatus.__index = JobStatus
local emitWarning = warn or print

function JobStatus.new(pipeline, failedResync)
    return setmetatable({
        pipeline = pipeline,
        failedResync = failedResync,
    }, JobStatus)
end

function JobStatus:Publish()
    self.pipeline.statusDirty = true
end

function JobStatus:MarkMapped(debugId, shouldPublish)
    local pipeline = self.pipeline
    local job = pipeline.jobs[debugId]
    if job and (job.state == "mapped" or job.state == "failed" or job.state == "removed") then
        return false
    end

    if not job then
        job = pipeline:EnsureJob(debugId)
    end

    pipeline:SetJobState(job, "mapped")
    if self.failedResync then self.failedResync:Cancel(job) end
    job.prepared = nil
    job.script = nil
    if shouldPublish ~= false then self:Publish() end
    return true
end

function JobStatus:MarkFailed(debugId, errorMessage, shouldPublish)
    local pipeline = self.pipeline
    local job = pipeline.jobs[debugId]
    if job and (job.state == "mapped" or job.state == "failed" or job.state == "removed") then
        return false
    end

    if not job then
        job = pipeline:EnsureJob(debugId)
    end

    pipeline:SetJobState(job, "failed")
    if self.failedResync then self.failedResync:Schedule(job) end
    job.errorMessage = tostring(errorMessage or "unknown error")
    job.prepared = nil
    job.script = nil
    emitWarning("[Roblox Executor MCP] Script mapping skipped " .. tostring(debugId) .. ": " .. tostring(errorMessage or "unknown error"))
    if shouldPublish ~= false then self:Publish() end
    return true
end

return JobStatus
