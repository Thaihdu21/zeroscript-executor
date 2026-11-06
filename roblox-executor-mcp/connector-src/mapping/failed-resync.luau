local FailedResync = {}
FailedResync.__index = FailedResync

function FailedResync.new(pipeline, options)
    options = options or {}
    return setmetatable({
        pipeline = pipeline,
        clock = options.Clock or os.clock,
        taskLibrary = options.TaskLibrary or task,
        intervalSeconds = options.IntervalSeconds or 30,
        maxDelaySeconds = options.MaxDelaySeconds or 300,
        batchSize = options.BatchSize or 8,
        thread = nil,
    }, FailedResync)
end

function FailedResync:Schedule(job)
    local rounds = math.max(0, job.resyncRounds or 0)
    local delaySeconds = math.min(
        self.intervalSeconds * (2 ^ rounds),
        self.maxDelaySeconds
    )
    job.nextResyncAt = self.clock() + delaySeconds
end

function FailedResync:Cancel(job)
    job.nextResyncAt = nil
    job.resyncRounds = nil
end

function FailedResync:Defer(job)
    job.nextResyncAt = self.clock() + self.intervalSeconds
end

function FailedResync:GetDue(now)
    now = now or self.clock()
    local due = {}
    for _, job in self.pipeline.jobs do
        if (
            job.generation == self.pipeline.generation and
            job.state == "failed" and
            type(job.nextResyncAt) == "number" and
            job.nextResyncAt <= now
        ) then
            table.insert(due, job)
        end
    end

    table.sort(due, function(left, right)
        if left.nextResyncAt == right.nextResyncAt then
            return left.debugId < right.debugId
        end
        return left.nextResyncAt < right.nextResyncAt
    end)
    while #due > self.batchSize do
        table.remove(due)
    end
    return due
end

function FailedResync:Claim(job, now)
    now = now or self.clock()
    if self.pipeline.jobs[job.debugId] ~= job then return false end
    if job.generation ~= self.pipeline.generation or job.state ~= "failed" then return false end
    if type(job.nextResyncAt) ~= "number" or job.nextResyncAt > now then return false end

    job.resyncRounds = (job.resyncRounds or 0) + 1
    job.nextResyncAt = nil
    job.errorMessage = nil
    return self.pipeline:TrackJob(job.debugId) == job
end

function FailedResync:Start(onTick)
    if self.thread then return end
    self.thread = self.taskLibrary.spawn(function()
        while true do
            self.taskLibrary.wait(self.intervalSeconds)
            pcall(onTick)
        end
    end)
end

function FailedResync:ProcessDue(onJob, onError)
    for _, job in self:GetDue() do
        local ok, errorMessage = pcall(onJob, job)
        if not ok then
            if onError then
                onError(job, errorMessage)
            else
                self:Defer(job)
            end
        end
    end
end

return FailedResync
