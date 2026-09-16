<#
.SYNOPSIS
  Start Claude Code routed through the USAGE Gateway.

.DESCRIPTION
  Sets ONLY session-scoped environment variables for the Claude Code process it
  launches. It does not touch ~/.claude/settings.json, the user profile, or any
  machine-level environment variable, and it never prints a secret.

  Claude Code -> USAGE Gateway -> Vercel AI Gateway -> Anthropic

  One authentication mode: the USAGE miner token in Authorization
  (ANTHROPIC_AUTH_TOKEN), with Claude Code started on an isolated, empty
  profile (CLAUDE_CONFIG_DIR) so a saved claude.ai login can never become the
  active credential. The AI Gateway key stays on the USAGE server.

  There is no subscription mode (M17A). A claude.ai login must never be relayed
  through USAGE; the gateway refuses such a request with
  consumer_subscription_credential_not_routable. To measure subscription usage,
  use USAGE Miner's "Track only".

.PARAMETER GatewayUrl
  Base URL of the USAGE Gateway Anthropic surface.

.PARAMETER Model
  Optional model id to pin (keeps test spend predictable).

.EXAMPLE
  $env:USAGE_MINER_TOKEN = "usgm_..."   # from: npm run miner:token
  ./scripts/start-claude-miner.ps1 -GatewayUrl https://<host>/api/gateway/anthropic
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
Write-Host "  auth    : USAGE miner token (isolated Claude profile)"
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

# Isolated profile: no saved claude.ai login can outrank the miner token.
$profileDir = Join-Path $env:TEMP "usage-claude-gateway-profile"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$env:CLAUDE_CONFIG_DIR = $profileDir
$env:ANTHROPIC_AUTH_TOKEN = $token

if ($Model) { $env:ANTHROPIC_MODEL = $Model }

try {
    if ($ClaudeArgs) { & claude @ClaudeArgs } else { & claude }
}
finally {
    Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_CUSTOM_HEADERS -ErrorAction SilentlyContinue
}
