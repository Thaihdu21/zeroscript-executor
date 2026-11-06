local DecompilerAttemptState = {}

function DecompilerAttemptState.CanAttemptBuiltIn(prepared, blockedBuiltinUntil, now)
    return (
        prepared.builtinAttempted ~= true and
        prepared.builtinDisabled ~= true and
        blockedBuiltinUntil <= now
    )
end

function DecompilerAttemptState.MarkBuiltInAttempted(prepared)
    prepared.builtinAttempted = true
end

function DecompilerAttemptState.DisableBuiltIn(prepared)
    prepared.builtinAttempted = true
    prepared.builtinDisabled = true
    prepared.useDirectBuiltin = false
end

return DecompilerAttemptState
