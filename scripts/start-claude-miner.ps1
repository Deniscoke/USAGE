<#
.SYNOPSIS
  Start Claude Code routed through the USAGE Gateway.

.DESCRIPTION
  Sets ONLY session-scoped environment variables for the Claude Code process it
  launches. It does not touch ~/.claude/settings.json, the user profile, or any
  machine-level environment variable, and it never prints a secret.

  Claude Code -> USAGE Gateway -> Vercel AI Gateway -> Anthropic

  Two authentication modes, matching Vercel's two documented shapes:

    subscription  (default) Claude Code keeps its own Claude account credential
                  in Authorization. USAGE forwards it opaquely upstream and
                  authenticates itself with its own gateway key, server-side.
                  This is what gives access to modern Claude models without
                  spending AI Gateway credits on tokens.

    token         Claude Code authenticates with the USAGE miner token in
                  Authorization. Model access is then whatever the AI Gateway
                  account allows.

  In both modes the miner token identifies you to USAGE, and the AI Gateway key
  stays on the USAGE server and is never handed to this process.

.PARAMETER GatewayUrl
  Base URL of the USAGE Gateway Anthropic surface.

.PARAMETER Auth
  'subscription' (default) or 'token'.

.PARAMETER Model
  Optional model id to pin (keeps test spend predictable).

.EXAMPLE
  $env:USAGE_MINER_TOKEN = "usgm_..."   # from: npm run miner:token
  ./scripts/start-claude-miner.ps1 -GatewayUrl https://<host>/api/gateway/anthropic
#>
[CmdletBinding()]
param(
    [string]$GatewayUrl = "http://localhost:3000/api/gateway/anthropic",
    [ValidateSet("subscription", "token")]
    [string]$Auth = "subscription",
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
Write-Host "  auth    : $Auth"
Write-Host "  token   : present (not shown)"
if ($Model) { Write-Host "  model   : $Model" }
Write-Host "  scope   : this session only; global Claude config untouched"
Write-Host ""

# Session-scoped only. These die with this PowerShell process.
$env:ANTHROPIC_BASE_URL = $GatewayUrl
# Claude Code checks ANTHROPIC_API_KEY first; empty means "use something else".
$env:ANTHROPIC_API_KEY = ""
# The miner token always travels in its own header, so it is never confused with
# whatever credential Claude Code puts in Authorization.
$env:ANTHROPIC_CUSTOM_HEADERS = "x-usage-miner-token: $token"

if ($Auth -eq "subscription") {
    # Deliberately NOT set: ANTHROPIC_AUTH_TOKEN would overwrite Authorization
    # with the miner token and the Claude subscription would never be used.
    Remove-Item Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
    Write-Host "Claude Code will use its own signed-in Claude account." -ForegroundColor DarkGray
    Write-Host "If it is not signed in it will prompt; choose the subscription option." -ForegroundColor DarkGray
    Write-Host ""
}
else {
    $env:ANTHROPIC_AUTH_TOKEN = $token
}

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
