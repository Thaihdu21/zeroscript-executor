local Concurrency = {}
Concurrency.__index = Concurrency

function Concurrency.new(pipeline, configuredWorkers)
    pipeline.configuredWorkers = configuredWorkers
    pipeline.currentWorkers = configuredWorkers
    return setmetatable({ pipeline = pipeline }, Concurrency)
end

function Concurrency:Reduce()
    local pipeline = self.pipeline
    local nextLimit = math.max(4, math.floor(pipeline.currentWorkers / 2))
    if nextLimit >= pipeline.currentWorkers then return end

    pipeline.currentWorkers = nextLimit
    pipeline.successesSinceWorkerAdjustment = 0
    if pipeline.workers then
        pipeline.workers:SetMaxConcurrent(nextLimit)
    end
end

function Concurrency:RecordSuccess()
    local pipeline = self.pipeline
    if pipeline.currentWorkers >= pipeline.configuredWorkers then return end

    pipeline.successesSinceWorkerAdjustment += 1
    if pipeline.successesSinceWorkerAdjustment < 100 then return end

    pipeline.successesSinceWorkerAdjustment = 0
    pipeline.currentWorkers += 1
    if pipeline.workers then
        pipeline.workers:SetMaxConcurrent(pipeline.currentWorkers)
    end
end

return Concurrency
