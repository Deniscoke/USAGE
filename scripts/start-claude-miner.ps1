<#
.SYNOPSIS
  Start Claude Code routed through the local USAGE Gateway.

.DESCRIPTION
  Sets ONLY session-scoped environment variables for the Claude Code process it
  launches. It does not touch ~/.claude/settings.json, the user profile, or any
  machine-level environment variable, and it never prints a secret.

  Claude Code -> USAGE Gateway -> Vercel AI Gateway -> model

  The miner token authenticates you to USAGE. The AI Gateway key stays on the
  USAGE server and is never handed to this process.

.PARAMETER GatewayUrl
  Base URL of the USAGE Gateway Anthropic surface.

.PARAMETER Model
  Optional model id to pin (keeps test spend predictable).

.EXAMPLE
  $env:USAGE_MINER_TOKEN = "usgm_..."   # from: npm run miner:token
  ./scripts/start-claude-miner.ps1
#>
[CmdletBinding()]
param(
    [string]$GatewayUrl = "http://localhost:3000/api/gateway/anthropic",
    [string]$Model = $env:USAGE_MINER_MODEL,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Stop"

$token = $env:USAGE_MINER_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host "USAGE_MINER_TOKEN is not set in this session." -ForegroundColor Yellow
    Write-Host "Mint one with:  npm run miner:token"
    Write-Host 'Then:           $env:USAGE_MINER_TOKEN = "usgm_..."'
    exit 1
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "Claude Code CLI ('claude') was not found on PATH." -ForegroundColor Yellow
    exit 1
}

Write-Host "USAGE miner mode" -ForegroundColor Cyan
Write-Host "  gateway : $GatewayUrl"
Write-Host "  token   : present (not shown)"
if ($Model) { Write-Host "  model   : $Model" }
Write-Host "  scope   : this session only; global Claude config untouched"
Write-Host ""

# Session-scoped only. These die with this PowerShell process.
$env:ANTHROPIC_BASE_URL = $GatewayUrl
$env:ANTHROPIC_AUTH_TOKEN = $token
# Claude Code checks ANTHROPIC_API_KEY first; it must be empty for the auth
# token to be used.
$env:ANTHROPIC_API_KEY = ""
# A Claude Code signed in to a Claude subscription keeps its own credential in
# Authorization and ignores ANTHROPIC_AUTH_TOKEN, so the miner token also
# travels in its own header. No logout required.
$env:ANTHROPIC_CUSTOM_HEADERS = "x-usage-miner-token: $token"
if ($Model) { $env:ANTHROPIC_MODEL = $Model }

try {
    if ($ClaudeArgs) { & claude @ClaudeArgs } else { & claude }
}
finally {
    Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_CUSTOM_HEADERS -ErrorAction SilentlyContinue
}
