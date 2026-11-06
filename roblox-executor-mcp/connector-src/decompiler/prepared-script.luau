local DecompilerAttemptState = require("./attempt-state")

local PreparedScript = {}

function PreparedScript.MaterializeServerFallback(prepared, readBytecode)
    DecompilerAttemptState.DisableBuiltIn(prepared)
    if type(prepared.bytecode) == "string" then
        return true
    end

    local ok, bytecodeOrError = readBytecode()
    if not ok then
        return false, bytecodeOrError
    end

    prepared.bytecode = bytecodeOrError
    return true
end

return PreparedScript
